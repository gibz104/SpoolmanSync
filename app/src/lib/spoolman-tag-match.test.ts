import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpoolmanClient, normalizeTag, type Spool } from './api/spoolman';

/**
 * Tag (RFID serial / tray_uuid) matching.
 *
 * Auto-assignment used to compare the raw stored value with JSON.parse and a
 * strict ===, silently skipping any spool whose tag wasn't stored in exactly the
 * format SpoolmanSync writes. A tag entered by hand in Spoolman — bare, or with
 * different casing or stray whitespace — never matched, and the only symptom was
 * a log line claiming no matching spool existed.
 */

function spoolWithTag(id: number, tag: string | undefined): Spool {
  return {
    id,
    filament: { id, name: `F${id}`, material: 'PLA' },
    extra: tag === undefined ? {} : { tag },
  } as unknown as Spool;
}

function installFetch(spools: Spool[]): { url: string; method: string; body: Record<string, unknown> | null }[] {
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body as string) : null });
    if (method === 'GET' && /\/spool(\?.*)?$/.test(url)) {
      return { ok: true, json: async () => spools } as unknown as Response;
    }
    if (method === 'GET' && /\/spool\/\d+$/.test(url)) {
      return { ok: true, json: async () => spools[0] } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  return calls;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('normalizeTag', () => {
  it('unwraps the JSON encoding SpoolmanSync writes', () => {
    expect(normalizeTag('"A1B2C3D4"')).toBe('a1b2c3d4');
  });

  it('passes through a bare, hand-entered value', () => {
    expect(normalizeTag('A1B2C3D4')).toBe('a1b2c3d4');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeTag('  "a1b2c3d4" ')).toBe(normalizeTag('"A1B2C3D4"'));
    expect(normalizeTag('" A1B2C3D4 "')).toBe('a1b2c3d4');
  });

  it('treats empty, cleared and missing tags as no tag', () => {
    expect(normalizeTag(undefined)).toBe('');
    expect(normalizeTag(null)).toBe('');
    expect(normalizeTag('')).toBe('');
    expect(normalizeTag('""')).toBe('');
    expect(normalizeTag('   ')).toBe('');
  });

  it('does not mangle numeric-looking serials (Creality RFID ids)', () => {
    expect(normalizeTag('"123456"')).toBe('123456');
    expect(normalizeTag('123456')).toBe('123456');
  });

  it('never coerces an all-numeric serial through JS number parsing', () => {
    // A 32-digit serial must survive verbatim in BOTH storage formats, or the
    // stored tag and the printer-reported tray_uuid stop agreeing.
    const serial = '12345678901234567890123456789012';
    expect(normalizeTag(JSON.stringify(serial))).toBe(serial);
    expect(normalizeTag(serial)).toBe(serial);
    expect(normalizeTag(JSON.stringify(serial))).toBe(normalizeTag(serial));

    // Exponent- and decimal-shaped values are identifiers too, not numbers.
    expect(normalizeTag('"1e5"')).toBe('1e5');
    expect(normalizeTag('1e5')).toBe('1e5');
    expect(normalizeTag('"0012"')).toBe('0012');
    expect(normalizeTag('0012')).toBe('0012');
  });
});

describe('findSpoolByTag', () => {
  it('matches the tag SpoolmanSync stored itself', async () => {
    installFetch([spoolWithTag(1, '"A1B2C3D4"')]);
    const client = new SpoolmanClient('http://spoolman');
    expect((await client.findSpoolByTag('A1B2C3D4'))?.id).toBe(1);
  });

  it('matches a hand-entered bare tag (previously never matched)', async () => {
    installFetch([spoolWithTag(35, 'A1B2C3D4')]);
    const client = new SpoolmanClient('http://spoolman');
    expect((await client.findSpoolByTag('A1B2C3D4'))?.id).toBe(35);
  });

  it('matches regardless of case reported by the printer', async () => {
    installFetch([spoolWithTag(35, '"a1b2c3d4"')]);
    const client = new SpoolmanClient('http://spoolman');
    expect((await client.findSpoolByTag('A1B2C3D4'))?.id).toBe(35);
  });

  it('returns null when nothing matches', async () => {
    installFetch([spoolWithTag(1, '"OTHER"')]);
    const client = new SpoolmanClient('http://spoolman');
    expect(await client.findSpoolByTag('A1B2C3D4')).toBeNull();
  });

  it('never matches on an empty/cleared tag', async () => {
    installFetch([spoolWithTag(1, '""'), spoolWithTag(2, undefined)]);
    const client = new SpoolmanClient('http://spoolman');
    expect(await client.findSpoolByTag('')).toBeNull();
    expect(await client.findSpoolByTag('   ')).toBeNull();
  });

  it('skips spools with no tag rather than throwing', async () => {
    installFetch([spoolWithTag(1, undefined), spoolWithTag(2, '"A1B2C3D4"')]);
    const client = new SpoolmanClient('http://spoolman');
    expect((await client.findSpoolByTag('A1B2C3D4'))?.id).toBe(2);
  });
});

describe('clearDuplicateTags', () => {
  it('clears the serial from other spools regardless of stored format', async () => {
    const calls = installFetch([
      spoolWithTag(1, 'a1b2c3d4'),    // bare + lowercase
      spoolWithTag(2, '"A1B2C3D4"'),  // JSON-encoded
      spoolWithTag(3, '"SOMETHING"'), // unrelated — must be untouched
    ]);
    const client = new SpoolmanClient('http://spoolman');

    await client.clearDuplicateTags('A1B2C3D4', 99);

    const patched = calls.filter(c => c.method === 'PATCH');
    expect(patched.map(c => c.url)).toEqual([
      'http://spoolman/api/v1/spool/1',
      'http://spoolman/api/v1/spool/2',
    ]);
    for (const call of patched) {
      expect((call.body!.extra as Record<string, string>).tag).toBe('""');
    }
  });

  it('never clears the spool we are assigning the serial to', async () => {
    const calls = installFetch([spoolWithTag(7, '"A1B2C3D4"')]);
    const client = new SpoolmanClient('http://spoolman');

    await client.clearDuplicateTags('A1B2C3D4', 7);

    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });

  it('does nothing for an empty serial (would otherwise wipe every blank tag)', async () => {
    const calls = installFetch([spoolWithTag(1, '""'), spoolWithTag(2, '')]);
    const client = new SpoolmanClient('http://spoolman');

    await client.clearDuplicateTags('', 99);

    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('countTaggedSpools (diagnostic)', () => {
  it('counts only spools carrying a real serial', () => {
    const client = new SpoolmanClient('http://spoolman');
    expect(client.countTaggedSpools([
      spoolWithTag(1, '"A1B2"'),
      spoolWithTag(2, 'BARE'),
      spoolWithTag(3, '""'),
      spoolWithTag(4, undefined),
    ])).toBe(2);
  });
});
