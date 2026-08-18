import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { getHiddenPrinters } from '@/app/api/printers/setup/route';
import { getVirtualPrinters, virtualPrintersToHAPrinters, migrateVirtualKeys, withVirtualLock } from '@/lib/virtual-printers';
import { detectTrayMismatch } from '@/lib/tray-mismatch';
import { reconcileSpoolLocations } from '@/lib/spool-location';

export async function GET() {
  try {
    const haClient = await HomeAssistantClient.fromConnection();
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!haClient) {
      return NextResponse.json({ error: 'Home Assistant not configured' }, { status: 400 });
    }

    const allPrinters = await haClient.discoverPrinters();

    // Filter out printers removed from SpoolmanSync
    const hiddenPrintersList = await getHiddenPrinters();
    const hiddenTitles = new Set(hiddenPrintersList.map(h => h.title.toLowerCase()).filter(Boolean));

    const printers = hiddenTitles.size > 0
      ? allPrinters.filter(p => {
          const name = p.name.toLowerCase();
          const entityId = p.entity_id.toLowerCase();
          return ![...hiddenTitles].some(t => name.includes(t) || entityId.includes(t));
        })
      : allPrinters;

    // Merge in user-defined virtual printers (dry boxes / dryers, issue #67).
    // They have no HA entity and no automation record, so they're enriched with
    // spool data below and rendered like any printer, but are skipped by the
    // staleness check and never receive usage webhooks.
    const virtualPrinters = virtualPrintersToHAPrinters(await getVirtualPrinters());
    printers.push(...virtualPrinters);

    // If Spoolman is configured, enrich with spool data
    if (spoolmanConnection) {
      const spoolmanClient = new SpoolmanClient(spoolmanConnection.url);

      // One-time: migrate legacy virtual-slot keys to the friendly format before
      // we match assignments, so re-keyed spools resolve to their virtual slots.
      // Serialized so it can't clobber a concurrent virtual-printer mutation.
      await withVirtualLock(() => migrateVirtualKeys(spoolmanClient));

      const spools = await spoolmanClient.getSpools();

      // Build entity_id → unique_id map from discovered trays for migration.
      // This map includes CURRENT entity_ids only. For renamed entities,
      // the old entity_id won't be in this map — we handle that with
      // a fallback unique_id-suffix match below.
      const entityIdToUniqueId = new Map<string, string>();
      // Also build a set of all known unique_ids for fallback matching
      const allUniqueIds = new Set<string>();
      for (const printer of printers) {
        // Skip virtual printers: their friendly keys (virtual_<name>_tray_N) end
        // in _tray_N and would otherwise become a target for the renamed-real-tray
        // suffix-fallback below, which could re-point a real spool onto a dry box.
        if (printer.is_virtual) continue;
        for (const ams of printer.ams_units) {
          for (const tray of ams.trays) {
            if (tray.unique_id) {
              entityIdToUniqueId.set(tray.entity_id, tray.unique_id);
              allUniqueIds.add(tray.unique_id);
            }
          }
        }
        for (const ext of printer.external_spools) {
          if (ext.unique_id) {
            entityIdToUniqueId.set(ext.entity_id, ext.unique_id);
            allUniqueIds.add(ext.unique_id);
          }
        }
      }

      // Set up resolver so any SpoolmanClient writes also sanitize
      spoolmanClient.setEntityIdResolver(async (entityId: string) => {
        return entityIdToUniqueId.get(entityId) || entityId;
      });

      // Build tray-spool map and migrate entity_id → unique_id in one pass.
      // On upgrade, existing spools have entity_ids stored in active_tray.
      // Convert them to stable unique_ids so assignments survive entity renames.
      // After the first run, all values are already unique_ids, so the
      // startsWith('sensor.') check short-circuits and no API calls are made.
      const traySpoolMap = new Map<string, typeof spools[0]>();
      for (const spool of spools) {
        const raw = spool.extra?.['active_tray'];
        if (!raw || raw === '' || raw === 'null' || raw === '""' || raw === '\"\"') continue;
        let cleanId = raw.replace(/^"|"$/g, '');
        if (!cleanId) continue;

        // Migrate: if it's an entity_id, convert to unique_id
        if (cleanId.startsWith('sensor.')) {
          // Try exact match first (entity hasn't been renamed)
          let uniqueId = entityIdToUniqueId.get(cleanId);

          // Fallback: if the entity was renamed, the old entity_id won't be in
          // the map. Try to match by finding a unique_id whose tray suffix
          // matches the entity_id's suffix (e.g., both end with "_tray_1").
          if (!uniqueId) {
            const trayMatch = cleanId.match(/_(tray_\d+|external_spool\d*)$/);
            if (trayMatch) {
              const suffix = trayMatch[0]; // e.g., "_tray_1"
              for (const uid of allUniqueIds) {
                if (uid.endsWith(suffix)) {
                  uniqueId = uid;
                  break;
                }
              }
            }
          }

          if (uniqueId) {
            const newExtra: Record<string, string> = {};
            if (spool.extra) {
              for (const [key, value] of Object.entries(spool.extra)) {
                newExtra[key] = value;
              }
            }
            newExtra['active_tray'] = JSON.stringify(uniqueId);
            await spoolmanClient.updateSpool(spool.id, { extra: newExtra });
            spool.extra!['active_tray'] = JSON.stringify(uniqueId);
            cleanId = uniqueId;
            console.log(`[Migration] Spool #${spool.id}: active_tray converted from entity_id to unique_id`);
          }
        }

        traySpoolMap.set(cleanId, spool);
      }

      // Heal stale location labels after a printer rename in HA. Locations are
      // only written at assignment time, so without this a renamed printer left
      // every assigned spool parked under the old name until manually
      // re-assigned. Runs AFTER the entity_id → unique_id migration above so
      // just-migrated assignments resolve in the same load, and BEFORE
      // enrichment so the response carries the healed locations. Hand-set
      // locations are never touched (see reconcileSpoolLocations).
      try {
        await reconcileSpoolLocations(spoolmanClient, printers, spools);
      } catch (err) {
        console.warn('Location label reconcile failed (non-fatal):', err);
      }

      // Enrich printer data with spool info and mismatch detection
      // Match by unique_id (stable across entity renames)
      for (const printer of printers) {
        for (const ams of printer.ams_units) {
          for (const tray of ams.trays) {
            const assignedSpool = tray.unique_id ? traySpoolMap.get(tray.unique_id) : traySpoolMap.get(tray.entity_id);
            const trayRecord = tray as unknown as Record<string, unknown>;

            if (assignedSpool) {
              trayRecord.assigned_spool = assignedSpool;

              const mismatch = detectTrayMismatch(tray, assignedSpool);
              if (mismatch) {
                trayRecord.mismatch = mismatch;
              }
            }
          }
        }
        for (const extSpool of printer.external_spools) {
          const assignedSpool = extSpool.unique_id ? traySpoolMap.get(extSpool.unique_id) : traySpoolMap.get(extSpool.entity_id);
          if (assignedSpool) {
            const extRecord = extSpool as unknown as Record<string, unknown>;
            extRecord.assigned_spool = assignedSpool;
          }
        }
      }
    }

    // Check if automations are stale (entity_ids changed or new trays added)
    // Only check printers that are in-scope (not hidden) AND have automation records
    let automationsStale = false;
    try {
      const automations = await prisma.automation.findMany();
      if (automations.length > 0) {
        // Build a map of printer prefix → configured tray entity_ids
        // Automation haAutomationId format: spoolmansync_update_spool_{prefix}
        const configuredByPrefix = new Map<string, Set<string>>();
        for (const automation of automations) {
          const prefix = automation.haAutomationId.replace('spoolmansync_update_spool_', '');
          const ids = new Set<string>();
          for (const id of automation.trayId.split(',')) {
            if (id.trim()) ids.add(id.trim());
          }
          configuredByPrefix.set(prefix, ids);
        }

        // For each in-scope printer that has an automation record, compare entity_ids
        for (const printer of printers) {
          const configuredIds = configuredByPrefix.get(printer.prefix);
          if (!configuredIds) continue; // No automation record for this printer — skip

          // Collect current tray entity_ids for this printer
          const currentIds = new Set<string>();
          for (const ams of printer.ams_units) {
            for (const tray of ams.trays) {
              currentIds.add(tray.entity_id);
            }
          }
          for (const ext of printer.external_spools) {
            currentIds.add(ext.entity_id);
          }

          // Stale: a configured entity_id no longer exists (renamed or removed)
          for (const id of configuredIds) {
            if (!currentIds.has(id)) { automationsStale = true; break; }
          }
          if (automationsStale) break;

          // Missing: a current entity_id isn't covered by automations (new AMS/tray)
          for (const id of currentIds) {
            if (!configuredIds.has(id)) { automationsStale = true; break; }
          }
          if (automationsStale) break;
        }
      }
    } catch {
      // Non-critical check, don't block the response
    }

    return NextResponse.json({ printers, automationsStale });
  } catch (error) {
    console.error('Error fetching printers:', error);
    return NextResponse.json({ error: 'Failed to fetch printers' }, { status: 500 });
  }
}
