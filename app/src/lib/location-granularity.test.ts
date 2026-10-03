import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Location label granularity (issue #85). Some users would rather file every
 * spool in an AMS under one location ("X1C - AMS 1") than give each tray its
 * own ("X1C - AMS 1 Tray 3").
 *
 * Switching has to carry the labels SpoolmanSync already wrote, in both
 * directions, without ever rewriting a location the user typed. The rule that
 * keeps those apart is that only shapes we have actually written count as ours,
 * which is what the "seen granularities" record is for.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/db', () => {
  const prisma = { settings: { findUnique, upsert } };
  return { default: prisma, prisma };
});

const discoverPrinters = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/homeassistant', () => ({
  HomeAssistantClient: { fromConnection: async () => ({ discoverPrinters }) },
}));

const {
  reconcileSpoolLocations,
  makeLocationSync,
  legacyTraySuffixes,
  realTrayLocationLabel,
  realTraySuffix,
  parseLocationGranularity,
  LOCATION_SYNC_KEY,
  LOCATION_PRINTER_NAMES_KEY,
  LOCATION_GRANULARITY_KEY,
  LOCATION_GRANULARITY_SEEN_KEY,
} = await import('./spool-location');
import type { LocationGranularity, ReconcilablePrinter, ReconcilableSpool } from './spool-location';

type StoredNames = Record<string, { current: string; formers: string[] }>;

function settings({
  syncEnabled = true,
  granularity = 'tray',
  seen,
  names = { x1c: { current: 'X1C', formers: [] } },
}: {
  syncEnabled?: boolean;
  granularity?: LocationGranularity;
  seen?: LocationGranularity[];
  names?: StoredNames;
} = {}) {
  findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === LOCATION_SYNC_KEY) return { value: String(syncEnabled) };
    if (where.key === LOCATION_GRANULARITY_KEY) return { value: granularity };
    if (where.key === LOCATION_GRANULARITY_SEEN_KEY) {
      return seen === undefined ? null : { value: JSON.stringify(seen) };
    }
    if (where.key === LOCATION_PRINTER_NAMES_KEY) return { value: JSON.stringify(names) };
    return null;
  });
  upsert.mockResolvedValue({});
}

/** An X1C with one AMS (trays 1 and 3) and an external slot. */
function printer(name = 'X1C'): ReconcilablePrinter {
  return {
    name,
    prefix: 'x1c',
    is_virtual: false,
    ams_units: [{
      name: 'AMS 1',
      trays: [
        { unique_id: 'x1c_t1', entity_id: 'sensor.x1c_ams_1_tray_1', tray_number: 1 },
        { unique_id: 'x1c_t3', entity_id: 'sensor.x1c_ams_1_tray_3', tray_number: 3 },
      ],
    }],
    external_spools: [
      { unique_id: 'x1c_ext', entity_id: 'sensor.x1c_external_spool', tray_number: 0 },
    ],
  };
}

function spool(trayKey: string, location: string | null, id = 1): ReconcilableSpool {
  return { id, location, extra: { active_tray: JSON.stringify(trayKey) } };
}

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
  discoverPrinters.mockReset();
});

describe('labels at each granularity', () => {
  it('stops at the AMS unit when asked to', () => {
    expect(realTraySuffix('AMS 1', 3, false, undefined, 'ams')).toBe('AMS 1');
    expect(realTrayLocationLabel('X1C', 'AMS 1', 3, false, undefined, 'ams')).toBe('X1C - AMS 1');
  });

  it('keeps the tray by default, so existing installs are untouched', () => {
    expect(realTraySuffix('AMS 1', 3, false)).toBe('AMS 1 Tray 3');
    expect(realTrayLocationLabel('X1C', 'AMS 1', 3, false)).toBe('X1C - AMS 1 Tray 3');
    expect(realTraySuffix('AMS 1', 3, false, undefined, 'tray')).toBe('AMS 1 Tray 3');
  });

  it('leaves external slots alone at either setting', () => {
    for (const g of ['tray', 'ams'] as const) {
      expect(realTraySuffix(undefined, 0, true, undefined, g)).toBe('External');
      expect(realTraySuffix(undefined, 0, true, 'External 2', g)).toBe('External 2');
    }
  });

  it('leaves a tray with no AMS unit alone at either setting', () => {
    for (const g of ['tray', 'ams'] as const) {
      expect(realTraySuffix(undefined, 2, false, undefined, g)).toBe('Tray 2');
      expect(realTraySuffix('   ', 2, false, undefined, g)).toBe('Tray 2');
    }
  });

  it('reads a stored value safely', () => {
    expect(parseLocationGranularity('ams')).toBe('ams');
    expect(parseLocationGranularity('tray')).toBe('tray');
    expect(parseLocationGranularity(undefined)).toBe('tray');
    expect(parseLocationGranularity('nonsense')).toBe('tray');
  });
});

describe('which shapes count as ours', () => {
  it('claims the tray shape once AMS labels are in use', () => {
    expect(legacyTraySuffixes('AMS 1', 3, false, undefined, 'ams', ['tray', 'ams']))
      .toEqual(['AMS 1 Tray 3']);
  });

  it('claims the AMS shape after switching back to trays', () => {
    expect(legacyTraySuffixes('AMS 1', 3, false, undefined, 'tray', ['tray', 'ams']))
      .toEqual(['AMS 1']);
  });

  it('claims nothing extra for an install that never used AMS labels', () => {
    // This is what protects a hand-typed "X1C - AMS 1" on such an install.
    expect(legacyTraySuffixes('AMS 1', 3, false, undefined, 'tray', ['tray'])).toEqual([]);
  });

  it('still claims the old external shape at either setting', () => {
    for (const g of ['tray', 'ams'] as const) {
      expect(legacyTraySuffixes(undefined, 0, true, 'External 2', g, ['tray', 'ams']))
        .toEqual(['External']);
    }
  });
});

describe('switching granularity migrates existing locations', () => {
  it('collapses each tray label onto the AMS', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const spools = [
      spool('x1c_t1', 'X1C - AMS 1 Tray 1', 1),
      spool('x1c_t3', 'X1C - AMS 1 Tray 3', 2),
    ];
    const c = client(spools);

    const migrated = await reconcileSpoolLocations(c, [printer()], spools);

    expect(migrated).toBe(2);
    expect(c.updates).toEqual([
      { id: 1, location: 'X1C - AMS 1' },
      { id: 2, location: 'X1C - AMS 1' },
    ]);
  });

  it('splits the shared label back out when switching to trays', async () => {
    settings({ granularity: 'tray', seen: ['tray', 'ams'] });
    const spools = [
      spool('x1c_t1', 'X1C - AMS 1', 1),
      spool('x1c_t3', 'X1C - AMS 1', 2),
    ];
    const c = client(spools);

    await reconcileSpoolLocations(c, [printer()], spools);

    expect(c.updates).toEqual([
      { id: 1, location: 'X1C - AMS 1 Tray 1' },
      { id: 2, location: 'X1C - AMS 1 Tray 3' },
    ]);
  });

  it('migrates across a printer rename at the same time', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'], names: { x1c: { current: 'Old Name', formers: [] } } });
    const spools = [spool('x1c_t3', 'Old Name - AMS 1 Tray 3')];
    const c = client(spools);

    await reconcileSpoolLocations(c, [printer('X1C')], spools);

    expect(c.updates).toEqual([{ id: 1, location: 'X1C - AMS 1' }]);
  });

  it('leaves the external slot where it is', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const spools = [spool('x1c_ext', 'X1C - External')];
    const c = client(spools);

    await reconcileSpoolLocations(c, [printer()], spools);

    expect(c.updates).toEqual([]);
  });

  it('is a no-op once migrated', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const spools = [spool('x1c_t3', 'X1C - AMS 1')];
    const c = client(spools);

    expect(await reconcileSpoolLocations(c, [printer()], spools)).toBe(0);
    expect(c.updates).toEqual([]);
  });

  it('never rewrites a location the user typed', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    for (const location of ['My dry box', 'AMS 1', 'X1C AMS 1', 'Shelf - AMS 1']) {
      const spools = [spool('x1c_t3', location)];
      const c = client(spools);

      await reconcileSpoolLocations(c, [printer()], spools);

      expect(c.updates, `location=${location}`).toEqual([]);
    }
  });

  it('leaves a hand-typed AMS label alone on an install that never used AMS labels', async () => {
    settings({ granularity: 'tray', seen: ['tray'] });
    const spools = [spool('x1c_t3', 'X1C - AMS 1')];
    const c = client(spools);

    expect(await reconcileSpoolLocations(c, [printer()], spools)).toBe(0);
    expect(c.updates).toEqual([]);
  });

  it('records the granularity in use so a later switch can migrate back', async () => {
    settings({ granularity: 'ams', seen: ['tray'] });
    const spools = [spool('x1c_t3', 'X1C - AMS 1 Tray 3')];

    await reconcileSpoolLocations(client(spools), [printer()], spools);

    const wrote = upsert.mock.calls.find(c => c[0].where.key === LOCATION_GRANULARITY_SEEN_KEY);
    expect(JSON.parse(wrote![0].update.value)).toEqual(['tray', 'ams']);
  });
});

describe('assign and unassign at AMS granularity', () => {
  beforeEach(() => discoverPrinters.mockResolvedValue([printer()]));

  it('writes the AMS label on assignment', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const sync = (await makeLocationSync())!;

    expect(await sync.resolver('x1c_t3')).toBe('X1C - AMS 1');
    expect(await sync.resolver('sensor.x1c_ams_1_tray_1')).toBe('X1C - AMS 1');
    expect(await sync.resolver('x1c_ext')).toBe('X1C - External');
  });

  it('still clears a tray label written before the switch', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const sync = (await makeLocationSync())!;

    expect(await sync.matcher('x1c_t3', 'X1C - AMS 1')).toBe(true);
    expect(await sync.matcher('x1c_t3', 'X1C - AMS 1 Tray 3')).toBe(true);
  });

  it('refuses to clear anything else', async () => {
    settings({ granularity: 'ams', seen: ['tray', 'ams'] });
    const sync = (await makeLocationSync())!;

    expect(await sync.matcher('x1c_t3', 'My dry box')).toBe(false);
    expect(await sync.matcher('x1c_t3', 'X1C - AMS 1 Tray 1')).toBe(false);
    expect(await sync.matcher('unknown_tray', 'X1C - AMS 1')).toBe(false);
  });

  it('wires nothing while location sync is off', async () => {
    settings({ syncEnabled: false, granularity: 'ams' });
    expect(await makeLocationSync()).toBeNull();
  });
});
