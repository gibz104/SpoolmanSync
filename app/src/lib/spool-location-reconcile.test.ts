import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * reconcileSpoolLocations() heals stale location labels after a printer is
 * renamed in Home Assistant (forum post 116). The dangerous failure modes are
 * (a) overwriting a location the user set by hand — including one that merely
 * LOOKS like a SpoolmanSync label — and (b) racing a concurrent assignment.
 * Most of these tests pin what the function must NOT touch.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/db', () => {
  const prisma = { settings: { findUnique, upsert } };
  return { default: prisma, prisma };
});

const { reconcileSpoolLocations, LOCATION_SYNC_KEY, LOCATION_PRINTER_NAMES_KEY } =
  await import('./spool-location');
import type { ReconcilablePrinter, ReconcilableSpool } from './spool-location';

type StoredNames = Record<string, { current: string; formers: string[] }>;

function settings({ syncEnabled, names }: { syncEnabled: boolean; names?: StoredNames }) {
  findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === LOCATION_SYNC_KEY) return { value: String(syncEnabled) };
    if (where.key === LOCATION_PRINTER_NAMES_KEY) {
      return names === undefined ? null : { value: JSON.stringify(names) };
    }
    return null;
  });
  upsert.mockResolvedValue({});
}

/** The stored-names object the last upsert persisted, or null. */
function persistedNames(): StoredNames | null {
  const call = upsert.mock.calls.at(-1);
  return call ? JSON.parse(call[0].update.value) : null;
}

function printer(name = 'X1C-Garage'): ReconcilablePrinter {
  return {
    name,
    prefix: 'x1c',
    is_virtual: false,
    ams_units: [
      {
        name: 'AMS 1',
        trays: [
          { unique_id: 'x1c_ams_1_tray_2', entity_id: 'sensor.x1c_ams_1_tray_2', tray_number: 2 },
          { unique_id: 'x1c_ams_1_tray_3', entity_id: 'sensor.x1c_ams_1_tray_3', tray_number: 3 },
        ],
      },
    ],
    external_spools: [
      { unique_id: 'x1c_external_spool', entity_id: 'sensor.x1c_external_spool', tray_number: 0 },
    ],
  };
}

function spool(overrides: Partial<ReconcilableSpool>): ReconcilableSpool {
  return { id: 1, location: '', extra: {}, ...overrides };
}

/** Client whose getSpool echoes the snapshot (no concurrent writer). */
function makeClient(spools: ReconcilableSpool[]) {
  return {
    getSpool: vi.fn(async (id: number) => {
      const s = spools.find(x => x.id === id)!;
      return { location: s.location, extra: { ...s.extra } };
    }),
    updateSpool: vi.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe('reconcileSpoolLocations — first run (nothing remembered yet)', () => {
  it('bootstraps: migrates label-shaped locations once and seeds the name history', async () => {
    settings({ syncEnabled: true });
    const s = spool({ id: 7, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(1);
    expect(client.updateSpool).toHaveBeenCalledWith(7, { location: 'X1C-Garage - AMS 1 Tray 2' });
    expect(s.location).toBe('X1C-Garage - AMS 1 Tray 2');
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: [] } });
  });

  it('bootstrap still never touches a location without our label shape', async () => {
    settings({ syncEnabled: true });
    const s = spool({ location: 'Dry Box 3', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
    expect(s.location).toBe('Dry Box 3');
  });

  it('resolves assignments stored as entity_ids and external-spool labels', async () => {
    settings({ syncEnabled: true });
    const a = spool({ id: 4, location: 'Old - AMS 1 Tray 3', extra: { active_tray: '"sensor.x1c_ams_1_tray_3"' } });
    const b = spool({ id: 5, location: 'Old - External', extra: { active_tray: '"x1c_external_spool"' } });
    const client = makeClient([a, b]);
    expect(await reconcileSpoolLocations(client, [printer()], [a, b])).toBe(2);
    expect(client.updateSpool).toHaveBeenCalledWith(4, { location: 'X1C-Garage - AMS 1 Tray 3' });
    expect(client.updateSpool).toHaveBeenCalledWith(5, { location: 'X1C-Garage - External' });
  });
});

describe('reconcileSpoolLocations — steady state (name already remembered)', () => {
  it('a hand-set location that mimics our label shape is NOT rewritten', async () => {
    // This is the poll-safety promise: after the first run, shape matching is
    // off, so the dashboard polling this every few seconds cannot fight a user
    // who deliberately typed a label-shaped location.
    settings({ syncEnabled: true, names: { x1c: { current: 'X1C-Garage', formers: [] } } });
    const s = spool({ location: 'Upstairs - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('skips current labels, empty locations, archived, unassigned, and unknown trays', async () => {
    settings({ syncEnabled: true, names: { x1c: { current: 'X1C-Garage', formers: [] } } });
    const spools = [
      spool({ id: 1, location: 'X1C-Garage - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } }),
      spool({ id: 2, location: '', extra: { active_tray: '"x1c_ams_1_tray_2"' } }),
      spool({ id: 3, location: 'Old - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' }, archived: true }),
      spool({ id: 4, location: 'Old - AMS 1 Tray 2', extra: {} }),
      spool({ id: 5, location: 'Old - AMS 1 Tray 2', extra: { active_tray: '""' } }),
      spool({ id: 6, location: 'Old - AMS 1 Tray 2', extra: { active_tray: '"unknown_key"' } }),
    ];
    const client = makeClient(spools);
    expect(await reconcileSpoolLocations(client, [printer()], spools)).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
  });
});

describe('reconcileSpoolLocations — rename detected', () => {
  const remembered: StoredNames = { x1c: { current: 'X1C_0123456789', formers: [] } };

  it('migrates exact former-name labels and then forgets the former name', async () => {
    settings({ syncEnabled: true, names: remembered });
    const stale = spool({ id: 1, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    // Same shape, but not the remembered former name: must be left alone.
    const mimic = spool({ id: 2, location: 'Upstairs - AMS 1 Tray 3', extra: { active_tray: '"x1c_ams_1_tray_3"' } });
    const client = makeClient([stale, mimic]);
    expect(await reconcileSpoolLocations(client, [printer('X1C-Garage')], [stale, mimic])).toBe(1);
    expect(client.updateSpool).toHaveBeenCalledTimes(1);
    expect(client.updateSpool).toHaveBeenCalledWith(1, { location: 'X1C-Garage - AMS 1 Tray 2' });
    expect(mimic.location).toBe('Upstairs - AMS 1 Tray 3');
    // Former name consumed: restoring an old-style label by hand now sticks.
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: [] } });
  });

  it('keeps the former name for retry when a write fails, and retries next run', async () => {
    settings({ syncEnabled: true, names: remembered });
    const s = spool({ id: 1, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    client.updateSpool.mockRejectedValueOnce(new Error('spoolman down'));
    expect(await reconcileSpoolLocations(client, [printer('X1C-Garage')], [s])).toBe(0);
    expect(s.location).toBe('X1C_0123456789 - AMS 1 Tray 2');
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: ['X1C_0123456789'] } });

    // Next load: the persisted state is re-read and the migration succeeds.
    settings({ syncEnabled: true, names: persistedNames()! });
    const client2 = makeClient([s]);
    expect(await reconcileSpoolLocations(client2, [printer('X1C-Garage')], [s])).toBe(1);
    expect(s.location).toBe('X1C-Garage - AMS 1 Tray 2');
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: [] } });
  });

  it('skips the write when the spool changed since the snapshot (concurrent assign race)', async () => {
    settings({ syncEnabled: true, names: remembered });
    const s = spool({ id: 1, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    // A webhook re-assigned the spool to another tray between snapshot and write.
    client.getSpool.mockResolvedValueOnce({
      location: 'X1C-Garage - AMS 1 Tray 3',
      extra: { active_tray: '"x1c_ams_1_tray_3"' },
    });
    expect(await reconcileSpoolLocations(client, [printer('X1C-Garage')], [s])).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
    // Former kept so any other stragglers still heal later.
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: ['X1C_0123456789'] } });
  });
});

describe('reconcileSpoolLocations — gating', () => {
  it('is a complete no-op when location sync is disabled', async () => {
    settings({ syncEnabled: false });
    const s = spool({ location: 'Old - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('ignores virtual printers entirely (their renames migrate elsewhere)', async () => {
    settings({ syncEnabled: true });
    const virtual: ReconcilablePrinter = {
      name: 'Dry Box',
      prefix: 'virtual_abc',
      is_virtual: true,
      ams_units: [{ name: 'AMS 1', trays: [{ unique_id: 'virtual_dry box_tray_1', tray_number: 1 }] }],
      external_spools: [],
    };
    const s = spool({ location: 'Old - AMS 1 Tray 1', extra: { active_tray: '"virtual_dry box_tray_1"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [virtual], [s])).toBe(0);
    expect(client.updateSpool).not.toHaveBeenCalled();
  });
});

describe('reconcileSpoolLocations — bootstrap failure retry', () => {
  it('a failed bootstrap write is remembered as a former name and retried next run', async () => {
    settings({ syncEnabled: true });
    const s = spool({ id: 1, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    client.updateSpool.mockRejectedValueOnce(new Error('spoolman down'));
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(0);
    // The label's own prefix half is derived and remembered for retry.
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: ['X1C_0123456789'] } });

    // Next run is no longer a bootstrap, but the derived former name matches.
    settings({ syncEnabled: true, names: persistedNames()! });
    const client2 = makeClient([s]);
    expect(await reconcileSpoolLocations(client2, [printer()], [s])).toBe(1);
    expect(s.location).toBe('X1C-Garage - AMS 1 Tray 2');
    expect(persistedNames()).toEqual({ x1c: { current: 'X1C-Garage', formers: [] } });
  });
});

describe('reconcileSpoolLocations — absent printers and corrupted state', () => {
  it('a printer absent from this run keeps its pending retry formers untouched', async () => {
    settings({
      syncEnabled: true,
      names: {
        x1c: { current: 'X1C_0123456789', formers: [] },
        p1s: { current: 'P1S-Shed', formers: ['P1S_987'] },
      },
    });
    // Only the x1c printer is discovered this run (p1s hidden or offline).
    const s = spool({ id: 1, location: 'X1C_0123456789 - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    expect(await reconcileSpoolLocations(client, [printer('X1C-Garage')], [s])).toBe(1);
    // p1s's pending former survives for when it reappears.
    expect(persistedNames()).toEqual({
      x1c: { current: 'X1C-Garage', formers: [] },
      p1s: { current: 'P1S-Shed', formers: ['P1S_987'] },
    });
  });

  it('tolerates malformed stored name entries by re-bootstrapping them', async () => {
    findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === LOCATION_SYNC_KEY) return { value: 'true' };
      if (where.key === LOCATION_PRINTER_NAMES_KEY) {
        return { value: '{"x1c":"garbage","other":{"current":5},"ok":{"current":"A","formers":"nope"}}' };
      }
      return null;
    });
    upsert.mockResolvedValue({});
    const s = spool({ id: 1, location: 'X1C_old - AMS 1 Tray 2', extra: { active_tray: '"x1c_ams_1_tray_2"' } });
    const client = makeClient([s]);
    // x1c's entry was invalid, so it re-bootstraps: shape migration runs once.
    expect(await reconcileSpoolLocations(client, [printer()], [s])).toBe(1);
    expect(s.location).toBe('X1C-Garage - AMS 1 Tray 2');
  });
});
