import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The holding-pen setting is opt-in ON TOP of an already opt-in feature: it must
 * be completely inert unless location sync is enabled. These tests pin that
 * gating, because getting it wrong would start writing locations into Spoolman
 * for users who never asked for location sync at all.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db', () => {
  const prisma = { settings: { findUnique } };
  return { default: prisma, prisma };
});

const { getUnassignedLocation, applyLocationSync, LOCATION_SYNC_KEY, UNASSIGNED_LOCATION_KEY } =
  await import('./spool-location');

/** Stub the two settings rows this code reads. */
function settings({ syncEnabled, unassigned }: { syncEnabled: boolean; unassigned?: string }) {
  findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === LOCATION_SYNC_KEY) return { value: String(syncEnabled) };
    if (where.key === UNASSIGNED_LOCATION_KEY) {
      return unassigned === undefined ? null : { value: unassigned };
    }
    return null;
  });
}

// Block body on purpose: an arrow returning mockReset()'s value would hand
// vitest the mock itself as a teardown callback, which it then invokes with no
// arguments after every test.
beforeEach(() => {
  findUnique.mockReset();
});

describe('getUnassignedLocation', () => {
  it('returns the configured value when location sync is on', async () => {
    settings({ syncEnabled: true, unassigned: 'Holding Pen' });
    expect(await getUnassignedLocation()).toBe('Holding Pen');
  });

  it('returns empty when location sync is OFF, even if a value is stored', async () => {
    settings({ syncEnabled: false, unassigned: 'Holding Pen' });
    expect(await getUnassignedLocation()).toBe('');
  });

  it('returns empty when sync has never been configured at all', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getUnassignedLocation()).toBe('');
  });

  it('returns empty for an unset or whitespace-only value', async () => {
    settings({ syncEnabled: true });
    expect(await getUnassignedLocation()).toBe('');

    settings({ syncEnabled: true, unassigned: '   ' });
    expect(await getUnassignedLocation()).toBe('');
  });

  it('trims and clamps to Spoolman\'s 64-char limit', async () => {
    settings({ syncEnabled: true, unassigned: `  ${'P'.repeat(100)}  ` });
    const value = await getUnassignedLocation();
    expect(value).toBe('P'.repeat(64));
  });
});

describe('applyLocationSync', () => {
  it('wires nothing when location sync is disabled', async () => {
    settings({ syncEnabled: false, unassigned: 'Holding Pen' });
    const client = {
      setLocationResolver: vi.fn(),
      setUnassignedLocation: vi.fn(),
    };

    const active = await applyLocationSync(client as never);

    expect(active).toBe(false);
    expect(client.setLocationResolver).not.toHaveBeenCalled();
    expect(client.setUnassignedLocation).not.toHaveBeenCalled();
  });

  it('wires the resolver AND the holding pen together when enabled', async () => {
    settings({ syncEnabled: true, unassigned: 'Holding Pen' });
    const client = {
      setLocationResolver: vi.fn(),
      setUnassignedLocation: vi.fn(),
    };

    const active = await applyLocationSync(client as never);

    expect(active).toBe(true);
    expect(client.setLocationResolver).toHaveBeenCalledTimes(1);
    expect(client.setUnassignedLocation).toHaveBeenCalledWith('Holding Pen');
  });

  it('wires an empty holding pen when none is configured (clear-on-unassign)', async () => {
    settings({ syncEnabled: true });
    const client = {
      setLocationResolver: vi.fn(),
      setUnassignedLocation: vi.fn(),
    };

    await applyLocationSync(client as never);

    expect(client.setUnassignedLocation).toHaveBeenCalledWith('');
  });
});
