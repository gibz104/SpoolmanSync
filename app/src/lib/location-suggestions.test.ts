import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildLocationSuggestions } from './spool-location';
import { SpoolmanClient, type Spool } from './api/spoolman';

/**
 * Location suggestions shown in Settings (virtual-printer creation).
 *
 * These used to be derived from spool rows alone, with archived spools included.
 * That produced two visible defects at once, reported together on the forum:
 * newly created Spoolman locations appeared only once a spool was moved into
 * them, and deleted locations lingered forever whenever an archived spool still
 * carried the string.
 */

function spool(location: string | undefined, archived = false): Pick<Spool, 'location' | 'archived'> {
  return { location, archived } as Pick<Spool, 'location' | 'archived'>;
}

describe('buildLocationSuggestions', () => {
  it("includes Spoolman's managed locations even when no spool is in them", () => {
    expect(buildLocationSuggestions(['Dry Box A', 'Shelf 1'], [])).toEqual(['Dry Box A', 'Shelf 1']);
  });

  it("preserves Spoolman's ordering, then appends spool-only locations", () => {
    const result = buildLocationSuggestions(
      ['Zeta', 'Alpha'],
      [spool('Middle'), spool('Alpha')],
    );
    expect(result).toEqual(['Zeta', 'Alpha', 'Middle']);
  });

  it('sorts spool-only locations so the tail of the list is stable', () => {
    // Spool order from the API is arbitrary; the suggestion list must not be.
    const result = buildLocationSuggestions([], [
      spool('Zeta shelf'), spool('alpha shelf'), spool('Middle shelf'),
    ]);
    expect(result).toEqual(['alpha shelf', 'Middle shelf', 'Zeta shelf']);
  });

  it('excludes archived spools, so a deleted location does not linger', () => {
    const result = buildLocationSuggestions([], [
      spool('Retired Shelf', true),
      spool('Active Shelf', false),
    ]);
    expect(result).toEqual(['Active Shelf']);
  });

  it('still lists a location the user deleted while spools remain in it', () => {
    // Matches Spoolman's own behaviour: it shows the orphan group too, so the
    // two UIs agree instead of disagreeing.
    expect(buildLocationSuggestions([], [spool('Orphaned')])).toEqual(['Orphaned']);
  });

  it('deduplicates and trims', () => {
    const result = buildLocationSuggestions(
      ['  Shelf 1  ', 'Shelf 1'],
      [spool('Shelf 1'), spool(' Shelf 1 ')],
    );
    expect(result).toEqual(['Shelf 1']);
  });

  it('drops empty and whitespace-only values', () => {
    expect(buildLocationSuggestions(['', '   '], [spool(''), spool(undefined), spool('   ')]))
      .toEqual([]);
  });

  it('returns an empty list when there is nothing to suggest', () => {
    expect(buildLocationSuggestions([], [])).toEqual([]);
  });
});

describe('SpoolmanClient.getConfiguredLocations', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const stub = (response: unknown, ok = true) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok,
      json: async () => response,
      text: async () => 'error',
    } as unknown as Response)));
  };

  it("parses Spoolman's JSON-encoded locations setting", async () => {
    stub({ value: JSON.stringify(['Dry Box A', 'Shelf 1']), is_set: true, type: 'array' });
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations())
      .toEqual(['Dry Box A', 'Shelf 1']);
  });

  it('trims entries and drops blanks', async () => {
    stub({ value: JSON.stringify(['  Shelf 1  ', '', '   ']) });
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations())
      .toEqual(['Shelf 1']);
  });

  it('returns [] for the default empty setting', async () => {
    stub({ value: '[]' });
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations()).toEqual([]);
  });

  it('returns [] on older Spoolman versions with no such setting (404)', async () => {
    stub({ message: 'Unknown setting' }, false);
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations()).toEqual([]);
  });

  it('returns [] rather than throwing on malformed values', async () => {
    for (const value of ['not json', JSON.stringify({ a: 1 }), 42, undefined]) {
      stub({ value });
      expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations()).toEqual([]);
    }
  });

  it('ignores non-string array entries', async () => {
    stub({ value: JSON.stringify(['Shelf 1', 7, null, { x: 1 }]) });
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations())
      .toEqual(['Shelf 1']);
  });

  it('never throws when Spoolman is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await new SpoolmanClient('http://spoolman').getConfiguredLocations()).toEqual([]);
  });
});
