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
 * The tray half of a real-tray label — "AMS 1 Tray 3", "Tray 2", "External".
 * Depends only on the tray itself, never on the printer name, which is what
 * lets reconcileSpoolLocations() recognize a pre-rename label as ours.
 */
export function realTraySuffix(
  amsName: string | undefined,
  trayNumber: number,
  isExternal: boolean,
): string {
  if (isExternal) return 'External';
  if (amsName && amsName.trim()) return `${amsName.trim()} Tray ${trayNumber}`;
  return `Tray ${trayNumber}`;
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
  return truncateLocation(`${name} - ${realTraySuffix(amsName, trayNumber, isExternal)}`);
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

/** Minimal structural shapes so reconcileSpoolLocations() is easy to test. */
export interface ReconcilablePrinter {
  name: string;
  prefix: string;
  is_virtual?: boolean;
  ams_units: { name?: string; trays: { unique_id?: string; entity_id?: string; tray_number: number }[] }[];
  external_spools: { unique_id?: string; entity_id?: string; tray_number: number }[];
}
export interface ReconcilableSpool {
  id: number;
  archived?: boolean;
  location?: string | null;
  extra?: Record<string, string>;
}
export interface LocationPatchClient {
  getSpool(id: number): Promise<{ location?: string | null; extra?: Record<string, string> }>;
  updateSpool(id: number, data: Record<string, unknown>): Promise<unknown>;
}

/**
 * Settings key remembering, per printer prefix, the printer name whose labels
 * SpoolmanSync last wrote, plus former names not yet fully migrated away from.
 * Value: JSON `{ [prefix]: { current: string, formers: string[] } }`.
 */
export const LOCATION_PRINTER_NAMES_KEY = 'location_sync_printer_names';
const MAX_FORMER_NAMES = 10;

type StoredNames = Record<string, { current: string; formers: string[] }>;

async function loadStoredNames(): Promise<StoredNames> {
  const s = await prisma.settings.findUnique({ where: { key: LOCATION_PRINTER_NAMES_KEY } });
  if (!s?.value) return {};
  try {
    const parsed: unknown = JSON.parse(s.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Sanitize entry-by-entry so one malformed (hand-edited) entry can never
    // throw later and take the whole reconcile down; a dropped entry simply
    // re-bootstraps.
    const out: StoredNames = {};
    for (const [prefix, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { current, formers } = value as { current?: unknown; formers?: unknown };
      if (typeof current !== 'string') continue;
      out[prefix] = {
        current,
        formers: Array.isArray(formers)
          ? formers.filter((f): f is string => typeof f === 'string').slice(0, MAX_FORMER_NAMES)
          : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function saveStoredNames(names: StoredNames): Promise<void> {
  const value = JSON.stringify(names);
  await prisma.settings.upsert({
    where: { key: LOCATION_PRINTER_NAMES_KEY },
    update: { value },
    create: { key: LOCATION_PRINTER_NAMES_KEY, value },
  });
}

/**
 * Rewrite the `location` of assigned spools whose label went stale because the
 * printer was renamed in Home Assistant. Locations are otherwise only written
 * at assignment time, so after a device rename every assigned spool kept its
 * old-name location until it was manually re-assigned (forum post 116).
 *
 * Safety model (a hand-set location must NEVER be rewritten):
 * - SpoolmanSync remembers the printer name it last wrote labels under, keyed
 *   by the rename-immune printer prefix. When the discovered name differs, the
 *   remembered name becomes a "former name", and ONLY locations that exactly
 *   equal `<former name> - <tray suffix>` for the spool's own tray are
 *   migrated. A user-typed location — even one shaped like a label — can't
 *   match a former name and is left alone, and once a former name's labels
 *   have all migrated it is forgotten, so even deliberately restoring an old
 *   label by hand sticks.
 * - The very first run for a printer (nothing remembered yet, i.e. upgrades)
 *   falls back once to shape matching: a location ending in the spool's own
 *   " - <tray suffix>" is treated as ours and migrated. This one-time pass is
 *   what heals renames that happened before this feature existed.
 * - Every write re-fetches the spool first and skips it if the assignment or
 *   location changed since the snapshot, so a concurrent webhook assign or
 *   unassign is never overwritten with a stale label.
 *
 * Virtual printers are excluded: their labels are bare names with no
 * recognizable shape, and virtual renames already migrate locations directly
 * in the virtual-printers route. Failures are per-spool and non-fatal (the
 * former name is kept for retry on the next load). Returns the number migrated.
 */
export async function reconcileSpoolLocations(
  client: LocationPatchClient,
  printers: ReconcilablePrinter[],
  spools: ReconcilableSpool[],
): Promise<number> {
  if (!(await isLocationSyncEnabled())) return 0;

  const names: StoredNames = { ...(await loadStoredNames()) };
  let namesChanged = false;
  const bootstrapPrefixes = new Set<string>();

  // trayKey (unique_id AND entity_id) → current label, tray suffix, prefix.
  const index = new Map<string, { label: string; suffix: string; prefix: string }>();
  // Prefixes whose trays were actually visible this run. Only their formers may
  // be consumed below — a printer absent from this run (hidden, or transiently
  // missing from discovery) must keep its pending retries untouched.
  const indexedPrefixes = new Set<string>();
  for (const p of printers) {
    if (p.is_virtual || !p.prefix) continue;

    // Same normalization the label itself uses, so name comparisons and label
    // construction can never disagree.
    const currentName = (p.name || 'Printer').trim();
    const entry = names[p.prefix];
    if (!entry) {
      names[p.prefix] = { current: currentName, formers: [] };
      bootstrapPrefixes.add(p.prefix);
      namesChanged = true;
    } else if (entry.current !== currentName) {
      const formers = [entry.current, ...entry.formers]
        .filter((f, i, arr) => f !== currentName && arr.indexOf(f) === i)
        .slice(0, MAX_FORMER_NAMES);
      names[p.prefix] = { current: currentName, formers };
      namesChanged = true;
    }

    for (const ams of p.ams_units) {
      for (const t of ams.trays) {
        const e = {
          label: realTrayLocationLabel(p.name, ams.name, t.tray_number, false),
          suffix: realTraySuffix(ams.name, t.tray_number, false),
          prefix: p.prefix,
        };
        if (t.unique_id) index.set(t.unique_id, e);
        if (t.entity_id) index.set(t.entity_id, e);
        if (t.unique_id || t.entity_id) indexedPrefixes.add(p.prefix);
      }
    }
    for (const ext of p.external_spools) {
      const e = {
        label: realTrayLocationLabel(p.name, undefined, ext.tray_number, true),
        suffix: realTraySuffix(undefined, ext.tray_number, true),
        prefix: p.prefix,
      };
      if (ext.unique_id) index.set(ext.unique_id, e);
      if (ext.entity_id) index.set(ext.entity_id, e);
      if (ext.unique_id || ext.entity_id) indexedPrefixes.add(p.prefix);
    }
  }

  // Former names that could not be fully migrated this run (write failed or a
  // concurrent change skipped the spool) are kept for retry on the next load.
  const retainFormer = new Map<string, Set<string>>();
  const keepFormer = (prefix: string, former: string) => {
    if (!retainFormer.has(prefix)) retainFormer.set(prefix, new Set());
    retainFormer.get(prefix)!.add(former);
  };

  let migrated = 0;
  if (index.size > 0) {
    for (const spool of spools) {
      if (spool.archived) continue;
      const raw = spool.extra?.['active_tray'];
      if (!raw) continue;
      const trayKey = raw.replace(/^"|"$/g, '');
      if (!trayKey) continue;
      const info = index.get(trayKey);
      if (!info) continue;

      const current = (spool.location ?? '').trim();
      if (!current || current === info.label) continue;

      const formers = names[info.prefix]?.formers ?? [];
      const matchedFormer = formers.find(
        f => current === truncateLocation(`${f} - ${info.suffix}`),
      );
      const isBootstrapMatch =
        bootstrapPrefixes.has(info.prefix) && current.endsWith(` - ${info.suffix}`);
      if (matchedFormer === undefined && !isBootstrapMatch) continue;

      // The name to remember for retry if this spool can't migrate now. For a
      // bootstrap match (nothing remembered yet) it is derived from the label
      // itself, so a failed first-run migration is not stranded forever.
      const retryName =
        matchedFormer ?? current.slice(0, current.length - ` - ${info.suffix}`.length);

      try {
        // Guard against a concurrent assign/unassign between our snapshot and
        // this write: only migrate if the spool is still exactly as snapshotted.
        const fresh = await client.getSpool(spool.id);
        const freshKey = (fresh.extra?.['active_tray'] ?? '').replace(/^"|"$/g, '');
        const freshLocation = (fresh.location ?? '').trim();
        if (freshKey !== trayKey || freshLocation !== current) {
          keepFormer(info.prefix, retryName);
          continue;
        }

        await client.updateSpool(spool.id, { location: info.label });
        spool.location = info.label; // keep the caller's in-memory copy fresh
        migrated++;
        console.log(`[location-sync] Migrated spool ${spool.id} location "${current}" -> "${info.label}"`);
      } catch (err) {
        keepFormer(info.prefix, retryName);
        console.warn(`[location-sync] Could not migrate spool ${spool.id} location:`, err);
      }
    }
  }

  // Forget fully-migrated former names so a user who later hand-restores an
  // old-style label is never fought over it. Names that still need a retry
  // (write failed or race-skipped) are kept — including ones derived during a
  // bootstrap run, which otherwise would never get a second chance. Prefixes
  // whose trays were not visible this run are left completely alone.
  for (const [prefix, entry] of Object.entries(names)) {
    if (!indexedPrefixes.has(prefix)) continue;
    const keep = retainFormer.get(prefix);
    const remaining = Array.from(keep ?? [])
      .filter(f => f !== entry.current)
      .slice(0, MAX_FORMER_NAMES);
    if (
      remaining.length !== entry.formers.length ||
      remaining.some((f, i) => entry.formers[i] !== f)
    ) {
      names[prefix] = { ...entry, formers: remaining };
      namesChanged = true;
    }
  }

  if (namesChanged) {
    try {
      await saveStoredNames(names);
    } catch (err) {
      console.warn('[location-sync] Could not persist printer-name history:', err);
    }
  }
  return migrated;
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
