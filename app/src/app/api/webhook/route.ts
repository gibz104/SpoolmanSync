import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { spoolEvents, SPOOL_UPDATED, SpoolUpdateEvent } from '@/lib/events';
import { createActivityLog } from '@/lib/activity-log';
import { checkAndUpdateAlerts } from '@/lib/alerts';
import { getWebhookSecret, isWebhookAuthEnabled, tokensMatch, WEBHOOK_TOKEN_HEADER } from '@/lib/webhook-secret';
import { isValidTrayUuid, lengthToWeight, classifyTrayState, isActivePrintState } from '@/lib/webhook-helpers';
import { applyLocationSync } from '@/lib/spool-location';

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

export async function POST(request: NextRequest) {
  try {
    // Webhook authentication: only enforce once token-carrying automations have
    // actually been applied (see isWebhookAuthEnabled). This prevents previewing
    // automations from prematurely rejecting still-deployed tokenless ones, which
    // would silently halt deductions. Fail open if the flag is set but no secret
    // exists (an inconsistent state) rather than blocking legitimate usage.
    if (await isWebhookAuthEnabled()) {
      const configuredSecret = await getWebhookSecret();
      if (configuredSecret) {
        const provided = request.headers.get(WEBHOOK_TOKEN_HEADER);
        if (!tokensMatch(provided, configuredSecret)) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }
    }

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

    // Wire up location sync (no-op unless the user enabled it). When enabled,
    // auto-assign/auto-clear will also keep Spoolman's native location field in
    // step with the tray the spool is on.
    await applyLocationSync(client);

    // Handle spool_usage event - deduct filament weight from spool
    if (event === 'spool_usage') {
      const { used_weight, used_length, active_tray_id, tray_uuid, material } = body;

      // Determine weight to deduct: either directly provided (Bambu) or converted from length (Creality)
      let weightToDeduct = used_weight;
      let lengthConverted = false;
      if ((!weightToDeduct || weightToDeduct <= 0) && used_length && used_length > 0) {
        weightToDeduct = lengthToWeight(used_length, material);
        lengthConverted = true;
        console.log(`Converted ${used_length}cm to ${weightToDeduct.toFixed(2)}g (material: ${material || 'PLA default'})`);
      }

      if (!weightToDeduct || weightToDeduct <= 0) {
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

      // If we have a matched spool and converted from length, try to use the spool's
      // actual filament density for a more accurate conversion
      if (lengthConverted && matchedSpool.filament?.material) {
        const betterWeight = lengthToWeight(used_length, matchedSpool.filament.material);
        if (betterWeight !== weightToDeduct) {
          console.log(`Refined conversion using spool material ${matchedSpool.filament.material}: ${weightToDeduct.toFixed(2)}g -> ${betterWeight.toFixed(2)}g`);
          weightToDeduct = betterWeight;
        }
      }

      // NOTE: We intentionally do NOT dedup spool_usage events here. A single
      // print legitimately produces many small same-tray deductions (e.g. a
      // dual-nozzle/multi-material print emits a run of ~0.6g increments as the
      // active tray sensor recomputes — see issue #54), so any "same spool + tray
      // + weight within N seconds" guard would silently drop real usage and
      // under-count. Power-on re-deduction (issue #66) is instead prevented at the
      // source: the usage meter is zeroed after every flush and after a sustained
      // (2 minute) offline, and the usage sensor cannot re-accumulate across an
      // outage — so a boot-time print-end flush carries 0g and deducts nothing.

      // Deduct the used weight from the spool
      await client.useWeight(matchedSpool.id, weightToDeduct);

      // Check low filament alerts (fire-and-forget)
      checkAndUpdateAlerts().catch(err => console.error('Alert check failed:', err));

      const deductionNote = lengthConverted ? ` (converted from ${used_length}cm)` : '';
      console.log(`Deducted ${weightToDeduct.toFixed(2)}g${deductionNote} from spool #${matchedSpool.id} (${matchedSpool.filament.name})`);

      // Store the spool serial/RFID if we have a valid one
      // This enables future auto-matching when the same spool is reinserted
      // For Bambu: tray_uuid is the spool serial (unique per physical spool)
      // For Creality: rfid is a numeric RFID tag ID
      let tagStored = false;
      if (isValidTrayUuid(tray_uuid)) {
        // Rewrite unless the stored value is already byte-identical to what we
        // would write. Matching is normalized elsewhere (see normalizeTag), but
        // this check must stay exact: a tag that is normalized-equal yet stored
        // in a different encoding still needs one canonicalizing write, because
        // setSpoolTag is also what clears the same serial off any OTHER spool.
        // Skipping the write on a normalized match would leave a duplicate
        // serial in place permanently. After that single rewrite the stored form
        // is canonical and this stops firing.
        const alreadyHasTag = matchedSpool.extra?.['tag'] === JSON.stringify(tray_uuid);

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
        deducted: weightToDeduct,
        newWeight: matchedSpool.remaining_weight - weightToDeduct,
        trayId: active_tray_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      await createActivityLog({
        type: 'spool_usage',
        message: `Deducted ${weightToDeduct.toFixed(2)}g${deductionNote} from spool #${matchedSpool.id} (${matchedSpool.filament.name})`,
        details: {
          spoolId: matchedSpool.id,
          usedWeight: weightToDeduct,
          ...(lengthConverted && { usedLengthCm: used_length }),
          trayId: active_tray_id,
          tagStored,
        },
      });

      return NextResponse.json({
        status: 'success',
        spoolId: matchedSpool.id,
        deducted: weightToDeduct,
        newRemainingWeight: matchedSpool.remaining_weight - weightToDeduct,
        tagStored,
      });
    }

    // Handle tray_change event - auto-assign spool by serial number or handle empty tray
    if (event === 'tray_change') {
      const { tray_entity_id, tray_uuid, name, material, current_print_state } = body;
      const spools = await client.getSpools();

      // Resolve entity_id to unique_id for matching and assignment
      const trayUniqueId = await resolveToUniqueId(tray_entity_id);

      // Classify the reported tray state (issue #65) — see classifyTrayState.
      const trayState = classifyTrayState(name);

      if (trayState === 'transient') {
        await createActivityLog({
          type: 'tray_change_ignored',
          message: `Ignored transient tray state for ${tray_entity_id} (name="${name}") — assignment preserved`,
          details: { trayId: tray_entity_id, reason: 'transient_state', name },
        });
        return NextResponse.json({ status: 'ignored', reason: 'transient_state' });
      }

      if (trayState === 'empty') {
        // Opt-out: users with flaky AMS reporting can disable auto-clear entirely.
        const neverClearSetting = await prisma.settings.findUnique({ where: { key: 'never_auto_clear_tray' } });
        if (neverClearSetting?.value === 'true') {
          await createActivityLog({
            type: 'tray_empty_detected',
            message: `Detected empty tray ${tray_entity_id} but auto-clear is disabled — assignment preserved`,
            details: { trayId: tray_entity_id, reason: 'auto_clear_disabled' },
          });
          return NextResponse.json({ status: 'ignored', reason: 'auto_clear_disabled' });
        }

        // During an active print, an empty tray can be a real AMS runout event.
        // Preserve the assignment so the Update Spool automation can flush the
        // old active tray's accumulated usage against the ran-out spool before
        // any cleanup happens. Otherwise an auto-unassign here makes the
        // subsequent spool_usage webhook unable to find the old spool.
        if (isActivePrintState(current_print_state)) {
          await createActivityLog({
            type: 'tray_change_ignored',
            message: `Detected empty tray ${tray_entity_id} while printer is ${current_print_state} — assignment preserved for usage accounting`,
            details: { trayId: tray_entity_id, reason: 'active_print_empty_tray', currentPrintState: current_print_state },
          });
          return NextResponse.json({ status: 'ignored', reason: 'active_print_empty_tray' });
        }

        // Defense-in-depth: re-query the live HA state before unassigning. A 4-5s
        // empty flicker (issue #65) will already have reverted to filament by the
        // time we process this event, so we can detect and ignore it. Fail safe:
        // if HA can't confirm the tray is truly empty, preserve the assignment.
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) {
            const live = await haClient.getState(tray_entity_id);
            const liveName = (live?.attributes?.name ?? '').toString();
            const liveNameLower = liveName.toLowerCase();
            const liveState = (live?.state ?? '').toString().toLowerCase();
            const stillEmpty = (liveNameLower === 'empty' || liveName === '')
              && liveState !== 'unavailable' && liveState !== 'unknown';
            if (!stillEmpty) {
              await createActivityLog({
                type: 'tray_change_ignored',
                message: `Tray ${tray_entity_id} reported empty but live state no longer empty — assignment preserved`,
                details: { trayId: tray_entity_id, reason: 'tray_no_longer_empty', liveName, liveState },
              });
              return NextResponse.json({ status: 'ignored', reason: 'tray_no_longer_empty' });
            }
          } else {
            await createActivityLog({
              type: 'tray_change_ignored',
              message: `Could not confirm empty state for ${tray_entity_id} (HA not connected) — assignment preserved`,
              details: { trayId: tray_entity_id, reason: 'ha_unavailable' },
            });
            return NextResponse.json({ status: 'ignored', reason: 'ha_unavailable' });
          }
        } catch (err) {
          console.warn('Could not re-query live HA state before unassign; preserving assignment:', err);
          await createActivityLog({
            type: 'tray_change_ignored',
            message: `Could not confirm empty state for ${tray_entity_id} (HA unreachable) — assignment preserved`,
            details: { trayId: tray_entity_id, reason: 'ha_unreachable' },
          });
          return NextResponse.json({ status: 'ignored', reason: 'ha_unreachable' });
        }

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

      // No serial auto-match. This is NOT the same as "no spool is assigned":
      // the only lookup above is by RFID serial (extra.tag), which SpoolmanSync
      // learns on a spool's first tracked print. A spool that is correctly
      // assigned by hand but has never finished a print reaches this branch too,
      // so the message must say what was actually checked — the old wording
      // ("no matching spool") read as a contradiction of the dashboard.
      const assignedSpool =
        spools.find(s => s.extra?.['active_tray'] === JSON.stringify(trayUniqueId)) ??
        spools.find(s => s.extra?.['active_tray'] === JSON.stringify(tray_entity_id));

      const taggedSpoolCount = client.countTaggedSpools(spools);
      const serialState = !isValidTrayUuid(tray_uuid)
        ? 'no_serial_reported'
        : taggedSpoolCount === 0
          ? 'no_spools_have_serials_yet'
          : 'serial_did_not_match_any_spool';

      // Keep RFID/serial language out of the visible message: non-Bambu spools
      // have no serial at all, so "no serial match" reads as a failure where
      // nothing was even attempted. The serialMatch field in details carries
      // the distinction for debugging.
      const message = assignedSpool
        ? `Tray change: ${tray_entity_id}; spool #${assignedSpool.id} remains assigned.`
        : `Tray change: ${tray_entity_id} has filament but no spool is assigned. Assign a spool in SpoolmanSync to track usage.`;

      console.log(`${message} Printer reports: name="${name}", material="${material}", tray_uuid="${tray_uuid}" (${serialState})`);

      // Log to activity log so users can see all tray changes in the webapp
      await createActivityLog({
        type: 'tray_change_detected',
        message,
        details: {
          trayId: tray_entity_id,
          printerReports: { name, material, tray_uuid },
          // Makes the "is this contradicting the dashboard?" question answerable
          // straight from the log entry.
          assignedSpoolId: assignedSpool?.id ?? null,
          serialMatch: serialState,
          taggedSpoolCount,
          action: assignedSpool ? 'existing_assignment_kept' : 'manual_assignment_required',
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
        message: assignedSpool
          ? `Spool #${assignedSpool.id} remains assigned to this tray.`
          : 'No spool is assigned to this tray. Assign a spool in SpoolmanSync to track usage.',
        assignedSpoolId: assignedSpool?.id ?? null,
        serialMatch: serialState,
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
          current_print_state: 'printing',
        },
      },
    },
  });
}
