import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { spoolEvents, SPOOL_UPDATED, SpoolUpdateEvent } from '@/lib/events';
import { createActivityLog } from '@/lib/activity-log';
import { checkAndUpdateAlerts } from '@/lib/alerts';

/**
 * Webhook endpoint for Home Assistant automations
 *
 * This endpoint receives tray change events from HA and syncs with Spoolman.
 *
 * Expected payload:
 * {
 *   event: "tray_change",
 *   tray_entity_id: "sensor.x1c_..._tray_1_2",
 *   tray_uuid: "...",  // Bambu spool serial number (unique per spool)
 *   color: "#FFFFFF",
 *   material: "PLA",
 *   remaining_weight: 800
 * }
 */

/** Returns true if tray_uuid is a real Bambu spool serial (not empty, unknown, or all zeros) */
function isValidTrayUuid(tray_uuid: string | undefined | null): boolean {
  if (!tray_uuid || tray_uuid === 'unknown' || tray_uuid === '') return false;
  // ha-bambulab reports all zeros for non-Bambu spools without RFID tags
  if (tray_uuid.replace(/0/g, '') === '') return false;
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { event } = body;

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      console.warn('Webhook received but Spoolman not configured');
      return NextResponse.json({ status: 'ignored', reason: 'spoolman not configured' });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Resolve entity_id → unique_id for tray matching.
    // Spool assignments are stored by unique_id (stable across entity renames),
    // but HA automations send entity_ids. This mapping bridges the two.
    let entityIdToUniqueId: Map<string, string> | null = null;
    const resolveToUniqueId = async (entityId: string): Promise<string> => {
      if (!entityIdToUniqueId) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) {
            entityIdToUniqueId = await haClient.getEntityIdToUniqueIdMap();
          }
        } catch (err) {
          console.warn('Could not fetch entity registry for unique_id mapping:', err);
        }
        if (!entityIdToUniqueId) entityIdToUniqueId = new Map();
      }
      return entityIdToUniqueId.get(entityId) || entityId;
    };

    // Wire up the resolver so all SpoolmanClient write paths defensively
    // convert any entity_id in active_tray to a stable unique_id.
    // This prevents race conditions where concurrent Spoolman API calls
    // revert extra fields to stale data containing entity_ids.
    client.setEntityIdResolver(resolveToUniqueId);

    // Handle spool_usage event - deduct filament weight from spool
    if (event === 'spool_usage') {
      const { used_weight, active_tray_id, tray_uuid } = body;

      if (!used_weight || used_weight <= 0) {
        return NextResponse.json({ status: 'ignored', reason: 'no weight to deduct' });
      }

      if (!active_tray_id) {
        return NextResponse.json({ status: 'ignored', reason: 'no active_tray_id provided' });
      }

      const spools = await client.getSpools();

      // Match by unique_id (resolved from entity_id sent by HA automation)
      const trayUniqueId = await resolveToUniqueId(active_tray_id);
      const jsonTrayId = JSON.stringify(trayUniqueId);
      let matchedSpool = spools.find(s => s.extra?.['active_tray'] === jsonTrayId);

      // Fallback: try matching by entity_id directly (for pre-migration spools)
      if (!matchedSpool) {
        const jsonEntityId = JSON.stringify(active_tray_id);
        matchedSpool = spools.find(s => s.extra?.['active_tray'] === jsonEntityId);
      }

      if (!matchedSpool) {
        console.warn(`No spool assigned to tray ${active_tray_id}`);
        return NextResponse.json({
          status: 'no_match',
          message: `No spool assigned to tray ${active_tray_id}. Assign a spool in SpoolmanSync first.`,
        });
      }

      // Deduct the used weight from the spool
      await client.useWeight(matchedSpool.id, used_weight);

      // Check low filament alerts (fire-and-forget)
      checkAndUpdateAlerts().catch(err => console.error('Alert check failed:', err));

      console.log(`Deducted ${used_weight}g from spool #${matchedSpool.id} (${matchedSpool.filament.name})`);

      // Store the spool serial number (tray_uuid) if we have a valid one
      // This enables future auto-matching when the same spool is reinserted
      // tray_uuid is the Bambu spool serial number, unique per physical spool
      // (unlike tag_uid which differs per RFID tag - each spool has 2 tags)
      let tagStored = false;
      if (isValidTrayUuid(tray_uuid)) {
        // Check if this spool already has this serial number stored
        const existingTagRaw = matchedSpool.extra?.['tag'];
        let alreadyHasTag = false;
        if (existingTagRaw) {
          try {
            const parsed = JSON.parse(existingTagRaw);
            alreadyHasTag = parsed === tray_uuid;
          } catch {
            // If parsing fails, assume tag not stored
          }
        }

        if (!alreadyHasTag) {
          console.log(`Storing spool serial "${tray_uuid}" on spool #${matchedSpool.id}`);
          await client.setSpoolTag(matchedSpool.id, tray_uuid);
          tagStored = true;

          await createActivityLog({
            type: 'tag_stored',
            message: `Stored spool serial on spool #${matchedSpool.id} (${matchedSpool.filament.name})`,
            details: {
              spoolId: matchedSpool.id,
              trayUuid: tray_uuid,
            },
          });
        }
      }

      // Emit real-time update event for dashboard
      const updateEvent: SpoolUpdateEvent = {
        type: 'usage',
        spoolId: matchedSpool.id,
        spoolName: matchedSpool.filament.name,
        deducted: used_weight,
        newWeight: matchedSpool.remaining_weight - used_weight,
        trayId: active_tray_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      await createActivityLog({
        type: 'spool_usage',
        message: `Deducted ${used_weight}g from spool #${matchedSpool.id} (${matchedSpool.filament.name})`,
        details: {
          spoolId: matchedSpool.id,
          usedWeight: used_weight,
          trayId: active_tray_id,
          tagStored,
        },
      });

      return NextResponse.json({
        status: 'success',
        spoolId: matchedSpool.id,
        deducted: used_weight,
        newRemainingWeight: matchedSpool.remaining_weight - used_weight,
        tagStored,
      });
    }

    // Handle tray_change event - auto-assign spool by serial number or handle empty tray
    if (event === 'tray_change') {
      const { tray_entity_id, tray_uuid, name, material } = body;
      const spools = await client.getSpools();

      // Resolve entity_id to unique_id for matching and assignment
      const trayUniqueId = await resolveToUniqueId(tray_entity_id);

      // Check if tray is now empty (no filament, or explicitly "Empty")
      // ha-bambulab reports name="Empty" when tray has no filament
      const trayIsEmpty = !name || name.toLowerCase() === 'empty' || name === '';

      if (trayIsEmpty) {
        // Auto-unassign any spool currently assigned to this tray
        const jsonTrayId = JSON.stringify(trayUniqueId);
        let assignedSpool = spools.find(s => s.extra?.['active_tray'] === jsonTrayId);
        // Fallback: try matching by entity_id directly (pre-migration)
        if (!assignedSpool) {
          const jsonEntityId = JSON.stringify(tray_entity_id);
          assignedSpool = spools.find(s => s.extra?.['active_tray'] === jsonEntityId);
        }

        if (assignedSpool) {
          console.log(`Tray ${tray_entity_id} is now empty, unassigning spool #${assignedSpool.id}`);
          await client.unassignSpoolFromTray(assignedSpool.id);

          // Emit real-time update event
          const updateEvent: SpoolUpdateEvent = {
            type: 'unassign',
            spoolId: assignedSpool.id,
            spoolName: assignedSpool.filament.name,
            trayId: tray_entity_id,
            timestamp: Date.now(),
          };
          spoolEvents.emit(SPOOL_UPDATED, updateEvent);

          await createActivityLog({
            type: 'spool_unassign',
            message: `Auto-unassigned spool #${assignedSpool.id} from ${tray_entity_id} (tray empty)`,
            details: { spoolId: assignedSpool.id, trayId: tray_entity_id, reason: 'tray_empty' },
          });

          return NextResponse.json({
            status: 'success',
            action: 'unassigned',
            spoolId: assignedSpool.id,
            reason: 'tray_empty',
          });
        }

        // Log the empty tray detection even though no action was taken
        await createActivityLog({
          type: 'tray_empty_detected',
          message: `Detected empty tray: ${tray_entity_id} (no spool was assigned)`,
          details: { trayId: tray_entity_id, reason: 'no_spool_assigned' },
        });

        return NextResponse.json({
          status: 'ignored',
          reason: 'tray empty and no spool was assigned',
        });
      }

      // Tray has filament - try to auto-match by spool serial number
      // Uses the `tag` field (stored on first spool_usage)
      if (isValidTrayUuid(tray_uuid)) {
        const matchedSpool = await client.findSpoolByTag(tray_uuid);

        if (matchedSpool) {
          await client.assignSpoolToTray(matchedSpool.id, trayUniqueId);

          // Emit real-time update event
          const updateEvent: SpoolUpdateEvent = {
            type: 'assign',
            spoolId: matchedSpool.id,
            spoolName: matchedSpool.filament.name,
            trayId: tray_entity_id,
            timestamp: Date.now(),
          };
          spoolEvents.emit(SPOOL_UPDATED, updateEvent);

          await createActivityLog({
            type: 'spool_change',
            message: `Auto-assigned spool #${matchedSpool.id} to ${tray_entity_id} (matched by spool serial)`,
            details: { spoolId: matchedSpool.id, trayId: tray_entity_id, matchedBy: 'spool_serial', trayUuid: tray_uuid },
          });

          return NextResponse.json({
            status: 'success',
            spool: matchedSpool,
            matchedBy: 'spool_serial',
          });
        }
      }

      // No serial match — try fuzzy match by color + material + name hint
      const { color } = body;
      if (color && material) {
        const fuzzyResult = await client.findSpoolByColorAndMaterial(color, material, name);

        if (fuzzyResult) {
          const { spool: matchedSpool, confidence } = fuzzyResult;
          await client.assignSpoolToTray(matchedSpool.id, trayUniqueId);

          const updateEvent: SpoolUpdateEvent = {
            type: 'assign',
            spoolId: matchedSpool.id,
            spoolName: matchedSpool.filament.name,
            trayId: tray_entity_id,
            timestamp: Date.now(),
          };
          spoolEvents.emit(SPOOL_UPDATED, updateEvent);

          console.log(
            `[SpoolmanSync] Fuzzy-matched spool #${matchedSpool.id} (${matchedSpool.filament.name}) to ${tray_entity_id} [${confidence}] via color=${color} material=${material} name="${name}"`,
          );

          await createActivityLog({
            type: 'spool_change',
            message: `Auto-assigned spool #${matchedSpool.id} to ${tray_entity_id} (fuzzy match: color+material${confidence === 'fuzzy' ? '+name' : ''})`,
            details: {
              spoolId: matchedSpool.id,
              trayId: tray_entity_id,
              matchedBy: `fuzzy_${confidence}`,
              printerReports: { name, material, color, tray_uuid },
            },
          });

          return NextResponse.json({
            status: 'success',
            spool: matchedSpool,
            matchedBy: `fuzzy_${confidence}`,
          });
        }
      }

      // No auto-match - user needs to manually assign spool
      // Log what the printer detected for debugging
      console.log(`Tray ${tray_entity_id} changed but no matching spool found. Printer reports: name="${name}", material="${material}", color="${color}", tray_uuid="${tray_uuid}"`);

      // Log to activity log so users can see all tray changes in the webapp
      await createActivityLog({
        type: 'tray_change_detected',
        message: `Tray change detected: ${tray_entity_id} has filament but no matching spool`,
        details: {
          trayId: tray_entity_id,
          printerReports: { name, material, color, tray_uuid },
          action: 'manual_assignment_required',
        },
      });

      // Emit tray_change event so dashboard can refresh and show warning banner
      const updateEvent: SpoolUpdateEvent = {
        type: 'tray_change',
        trayId: tray_entity_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      return NextResponse.json({
        status: 'no_match',
        message: 'No spool assigned to this tray. Please assign a spool manually in SpoolmanSync.',
        printerReports: { name, material, tray_uuid },
      });
    }

    return NextResponse.json({ status: 'ignored', reason: 'unknown event type' });
  } catch (error) {
    console.error('Webhook error:', error);

    await createActivityLog({
      type: 'error',
      message: 'Webhook processing failed',
      details: { error: error instanceof Error ? error.message : String(error) },
    });

    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

// GET endpoint for testing/verification
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'SpoolmanSync webhook endpoint',
    events: {
      spool_usage: {
        description: 'Deduct filament weight from spool after print',
        payload: {
          event: 'spool_usage',
          name: 'Filament Name',
          material: 'PLA',
          tray_uuid: '...',
          used_weight: 3.91,
          color: '#FFFFFF',
          active_tray_id: 'sensor.x1c_..._tray_1',
        },
      },
      tray_change: {
        description: 'Auto-assign spool by tray_uuid (Bambu spools only)',
        payload: {
          event: 'tray_change',
          tray_entity_id: 'sensor.x1c_..._tray_1',
          tray_uuid: '...',
          color: '#FFFFFF',
          material: 'PLA',
        },
      },
    },
  });
}
