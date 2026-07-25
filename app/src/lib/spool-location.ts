/**
 * Spoolman `location` sync (issue: sync physical location into Spoolman).
 *
 * Spoolman has a native top-level `location` string field (max 64 chars). This
 * module keeps that field in step with where a spool physically is:
 *   - assigned to a real AMS/CFS tray  → "<Printer> - <AMS> Tray <N>" / "… - External"
 *   - assigned to a virtual printer    → the virtual printer's name (dry box/shelf)
 *
 * Design notes:
 * - OPT-IN. Everything here is a no-op unless the `sync_spoolman_location`
 *   setting is enabled, so existing users who manage locations manually are
 *   never touched until they turn it on.
 * - The write happens through an injected resolver on SpoolmanClient (mirroring
 *   the existing entityIdResolver), so every assign/unassign path — webhook
 *   auto-assign/clear and manual UI assign/unassign — inherits it from one place.
 * - Clearing on unassign is GUARDED: the client only wipes `location` if it still
 *   equals the label we would have set for the tray being left. A location a user
 *   changed by hand is left alone.
 */
import prisma from '@/lib/db';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { getVirtualPrinters, virtualSlotKey } from '@/lib/virtual-printers';
import {
  SPOOLMAN_LOCATION_MAX,
  type LocationResolver,
  type Spool,
  type SpoolmanClient,
} from '@/lib/api/spoolman';

/** Settings key for the opt-in toggle. */
export const LOCATION_SYNC_KEY = 'sync_spoolman_location';
/**
 * Settings key for the optional "location when unassigned" holding pen.
 *
 * Empty (the default) keeps the original behavior of unsetting `location`. Only
 * consulted when LOCATION_SYNC_KEY is on — SpoolmanSync never touches `location`
 * at all otherwise, so this setting is inert on its own.
 */
export const UNASSIGNED_LOCATION_KEY = 'unassigned_spool_location';
/** Spoolman's `location` field is `str | None` with max_length 64. */
export { SPOOLMAN_LOCATION_MAX } from '@/lib/api/spoolman';

export async function isLocationSyncEnabled(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { key: LOCATION_SYNC_KEY } });
  return s?.value === 'true';
}

/**
 * The location to park a spool in when it is unassigned, or '' to clear the
 * field as before.
 *
 * Gated on location sync being enabled so the value can never take effect on its
 * own — a user who turns sync off gets the untouched-location behavior back
 * without having to also clear this box.
 */
export async function getUnassignedLocation(): Promise<string> {
  if (!(await isLocationSyncEnabled())) return '';
  const s = await prisma.settings.findUnique({ where: { key: UNASSIGNED_LOCATION_KEY } });
  const value = (s?.value ?? '').trim();
  return value ? truncateLocation(value) : '';
}

/** Clamp any location string to Spoolman's 64-char limit. */
export function truncateLocation(value: string): string {
  return value.length > SPOOLMAN_LOCATION_MAX ? value.slice(0, SPOOLMAN_LOCATION_MAX) : value;
}

/**
 * Human-readable location label for a real printer tray, e.g.
 *   "X1C - AMS 1 Tray 3", "P1S - External".
 * Falls back to "<Printer> - Tray <N>" when no AMS name is available.
 */
export function realTrayLocationLabel(
  printerName: string,
  amsName: string | undefined,
  trayNumber: number,
  isExternal: boolean,
): string {
  const name = (printerName || 'Printer').trim();
  let label: string;
  if (isExternal) {
    label = `${name} - External`;
  } else if (amsName && amsName.trim()) {
    label = `${name} - ${amsName.trim()} Tray ${trayNumber}`;
  } else {
    label = `${name} - Tray ${trayNumber}`;
  }
  return truncateLocation(label);
}

/**
 * Build the location suggestion list, mirroring how Spoolman's own Locations
 * page builds its list: the user-managed `locations` setting first (in the
 * user's order), then any extra locations found on non-archived spools.
 *
 * Both halves matter, and getting either wrong produced a visibly stale list:
 *  - Without the setting, a location created in Spoolman is invisible here until
 *    a spool is actually moved into it — so new locations appear "slowly".
 *  - Counting archived spools keeps deleted locations alive forever, because
 *    archiving a spool never clears its `location`. That is why deleting a
 *    location worked for some entries and not others.
 */
export function buildLocationSuggestions(
  configured: string[],
  spools: Pick<Spool, 'location' | 'archived'>[],
): string[] {
  const locations: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string | undefined | null) => {
    const loc = (raw ?? '').trim();
    if (!loc || seen.has(loc)) return;
    seen.add(loc);
    locations.push(loc);
  };

  // Spoolman's own ordering first — it is the order the user arranged.
  configured.forEach(add);

  // Then locations that only exist on spools, sorted so the tail of the list is
  // stable rather than following whatever order Spoolman returned spools in.
  const fromSpools = spools
    // Defense-in-depth: Spoolman already omits archived spools unless asked,
    // but an archived spool must never resurrect a location either way.
    .filter(spool => !spool.archived)
    .map(spool => (spool.location ?? '').trim())
    .filter(location => location.length > 0)
    .sort((a, b) => a.localeCompare(b));

  fromSpools.forEach(add);

  return locations;
}

/** Location label for a virtual printer (dry box / shelf) — just its name. */
export function virtualLocationLabel(printerName: string): string {
  return truncateLocation((printerName || '').trim());
}

/**
 * Build a resolver mapping a tray key (unique_id, entity_id, or virtual slot key)
 * to its location label. Returns null when location sync is disabled, which tells
 * SpoolmanClient to leave the `location` field untouched entirely.
 *
 * Discovery (virtual printers + HA printers) runs lazily on first lookup and is
 * cached for the lifetime of the resolver, so a single webhook/request only pays
 * the cost once regardless of how many spools it touches.
 */
export async function makeLocationResolver(): Promise<LocationResolver | null> {
  if (!(await isLocationSyncEnabled())) return null;

  let cache: Map<string, string> | null = null;

  const build = async (): Promise<Map<string, string>> => {
    const map = new Map<string, string>();

    // Virtual printers (dry boxes / shelves) — keyed by the friendly slot key.
    try {
      const vps = await getVirtualPrinters();
      for (const vp of vps) {
        const label = virtualLocationLabel(vp.name);
        if (!label) continue;
        for (const slot of vp.slots) {
          map.set(virtualSlotKey(vp.name, slot.number), label);
        }
      }
    } catch (err) {
      console.warn('[location-sync] Could not load virtual printers:', err);
    }

    // Real printers — keyed by BOTH unique_id and entity_id so we resolve
    // regardless of which form a caller passes (assignments are stored by
    // unique_id, but pre-migration spools and some paths use entity_ids).
    try {
      const ha = await HomeAssistantClient.fromConnection();
      if (ha) {
        const printers = await ha.discoverPrinters();
        for (const p of printers) {
          if (p.is_virtual) continue; // handled above
          for (const ams of p.ams_units) {
            for (const t of ams.trays) {
              const label = realTrayLocationLabel(p.name, ams.name, t.tray_number, false);
              if (t.unique_id) map.set(t.unique_id, label);
              if (t.entity_id) map.set(t.entity_id, label);
            }
          }
          for (const ext of p.external_spools) {
            const label = realTrayLocationLabel(p.name, undefined, ext.tray_number, true);
            if (ext.unique_id) map.set(ext.unique_id, label);
            if (ext.entity_id) map.set(ext.entity_id, label);
          }
        }
      }
    } catch (err) {
      console.warn('[location-sync] Could not discover HA printers for location labels:', err);
    }

    return map;
  };

  return async (trayKey: string): Promise<string> => {
    if (!cache) cache = await build();
    return cache.get(trayKey) ?? '';
  };
}

/**
 * Wire location sync onto a SpoolmanClient. Single entry point for every caller
 * that assigns or unassigns spools, so a new call site can't wire the resolver
 * and silently forget the holding-pen setting (they must move together — the
 * holding pen is only consulted when a resolver is present).
 *
 * No-op when location sync is disabled, leaving `location` untouched entirely.
 * Returns whether sync is active, for callers that want to know.
 */
export async function applyLocationSync(client: SpoolmanClient): Promise<boolean> {
  const resolver = await makeLocationResolver();
  if (!resolver) return false;

  client.setLocationResolver(resolver);
  client.setUnassignedLocation(await getUnassignedLocation());
  return true;
}
