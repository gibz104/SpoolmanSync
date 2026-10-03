import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Numbering the two external slots of a dual-nozzle printer changes the Spoolman
 * location label those spools carry, from "<printer> - External" to
 * "<printer> - External 1" / "External 2".
 *
 * Both halves of that move are pinned here: reconcileSpoolLocations() has to
 * migrate the labels it wrote before, and the guarded clear on unassign has to
 * still recognize an un-migrated one as ours. A location the user typed must
 * survive both.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/db', () => {
  const prisma = { settings: { findUnique, upsert } };
  return { default: prisma, prisma };
});

const {
  reconcileSpoolLocations,
  legacyTraySuffixes,
  realTrayLocationLabel,
  realTraySuffix,
  LOCATION_SYNC_KEY,
  LOCATION_PRINTER_NAMES_KEY,
} = await import('./spool-location');
import type { ReconcilablePrinter, ReconcilableSpool } from './spool-location';

type StoredNames = Record<string, { current: string; formers: string[] }>;

function settings({ syncEnabled = true, names }: { syncEnabled?: boolean; names?: StoredNames } = {}) {
  findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === LOCATION_SYNC_KEY) return { value: String(syncEnabled) };
    if (where.key === LOCATION_PRINTER_NAMES_KEY) {
      return names === undefined ? null : { value: JSON.stringify(names) };
    }
    return null;
  });
  upsert.mockResolvedValue({});
}

/** An X2D whose two external slots are now numbered. */
function dualExternalPrinter(name = 'X2D'): ReconcilablePrinter {
  return {
    name,
    prefix: 'x2d',
    is_virtual: false,
    ams_units: [],
    external_spools: [
      { unique_id: 'x2d_ext_1', entity_id: 'sensor.x2d_external_spool', tray_number: 0, slot_name: 'External 1' },
      { unique_id: 'x2d_ext_2', entity_id: 'sensor.x2d_external_spool_2', tray_number: 0, slot_name: 'External 2' },
    ],
  };
}

/** A P1S with one slot, which stays unnamed. */
function singleExternalPrinter(): ReconcilablePrinter {
  return {
    name: 'P1S',
    prefix: 'p1s',
    is_virtual: false,
    ams_units: [],
    external_spools: [
      { unique_id: 'p1s_ext', entity_id: 'sensor.p1s_external_spool', tray_number: 0 },
    ],
  };
}

function spool(trayKey: string, location: string | null, id = 1): ReconcilableSpool {
  return { id, location, extra: { active_tray: JSON.stringify(trayKey) } };
}

/** A client that records the writes and never races. */
function client(spools: ReconcilableSpool[]) {
  const updates: { id: number; location: unknown }[] = [];
  return {
    updates,
    getSpool: async (id: number) => {
      const s = spools.find(x => x.id === id)!;
      return { location: s.location, extra: s.extra };
    },
    updateSpool: async (id: number, data: Record<string, unknown>) => {
      updates.push({ id, location: data.location });
    },
  };
}

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe('labels for a named external slot', () => {
  it('uses the slot name in place of "External"', () => {
    expect(realTraySuffix(undefined, 0, true, 'External 2')).toBe('External 2');
    expect(realTrayLocationLabel('X2D', undefined, 0, true, 'External 2')).toBe('X2D - External 2');
  });

  it('still says "External" for an unnamed slot', () => {
    expect(realTraySuffix(undefined, 0, true)).toBe('External');
    expect(realTrayLocationLabel('P1S', undefined, 0, true)).toBe('P1S - External');
  });

  it('only treats "External" as a legacy shape once a slot is named', () => {
    expect(legacyTraySuffixes(true, 'External 2')).toEqual(['External']);
    expect(legacyTraySuffixes(true)).toEqual([]);
    expect(legacyTraySuffixes(true, 'External')).toEqual([]);
    expect(legacyTraySuffixes(false)).toEqual([]);
  });
});

describe('migrating an existing external location', () => {
  it('moves each spool from the shared label to its own slot', async () => {
    settings({ names: { x2d: { current: 'X2D', formers: [] } } });
    const spools = [spool('x2d_ext_1', 'X2D - External', 1), spool('x2d_ext_2', 'X2D - External', 2)];
    const c = client(spools);

    const migrated = await reconcileSpoolLocations(c, [dualExternalPrinter()], spools);

    expect(migrated).toBe(2);
    expect(c.updates).toEqual([
      { id: 1, location: 'X2D - External 1' },
      { id: 2, location: 'X2D - External 2' },
    ]);
  });

  it('migrates a label left over from a printer rename as well', async () => {
    settings({ names: { x2d: { current: 'Old Name', formers: [] } } });
    const spools = [spool('x2d_ext_2', 'Old Name - External', 1)];
    const c = client(spools);

    await reconcileSpoolLocations(c, [dualExternalPrinter('X2D')], spools);

    expect(c.updates).toEqual([{ id: 1, location: 'X2D - External 2' }]);
  });

  it('leaves a location the user typed alone', async () => {
    settings({ names: { x2d: { current: 'X2D', formers: [] } } });
    for (const location of ['My dry box', 'X2D external', 'External', 'Shelf - External 2']) {
      const spools = [spool('x2d_ext_1', location)];
      const c = client(spools);

      await reconcileSpoolLocations(c, [dualExternalPrinter()], spools);

      expect(c.updates, `location=${location}`).toEqual([]);
    }
  });

  it('touches nothing on a printer with one slot', async () => {
    settings({ names: { p1s: { current: 'P1S', formers: [] } } });
    const spools = [spool('p1s_ext', 'P1S - External')];
    const c = client(spools);

    const migrated = await reconcileSpoolLocations(c, [singleExternalPrinter()], spools);

    expect(migrated).toBe(0);
    expect(c.updates).toEqual([]);
  });

  it('is a no-op once migrated', async () => {
    settings({ names: { x2d: { current: 'X2D', formers: [] } } });
    const spools = [spool('x2d_ext_2', 'X2D - External 2')];
    const c = client(spools);

    await reconcileSpoolLocations(c, [dualExternalPrinter()], spools);

    expect(c.updates).toEqual([]);
  });

  it('does nothing at all when location sync is off', async () => {
    settings({ syncEnabled: false, names: { x2d: { current: 'X2D', formers: [] } } });
    const spools = [spool('x2d_ext_1', 'X2D - External')];
    const c = client(spools);

    expect(await reconcileSpoolLocations(c, [dualExternalPrinter()], spools)).toBe(0);
    expect(c.updates).toEqual([]);
  });
});
