import { describe, it, expect, vi, afterEach } from 'vitest';
import { linkTag, lookUpScanCode } from './scan-client';

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body?: unknown) =>
  vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as unknown as Response);

describe('lookUpScanCode', () => {
  it('opens a link without asking the server', async () => {
    const fetch = reply(500);
    vi.stubGlobal('fetch', fetch);
    expect(await lookUpScanCode('https://sync.example.com/scan/spool/7')).toEqual({ kind: 'spool', id: 7 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks the server about anything else', async () => {
    const fetch = reply(200, { target: { kind: 'spool', id: 3 } });
    vi.stubGlobal('fetch', fetch);
    expect(await lookUpScanCode(' 04:a2:b3:c4 ')).toEqual({ kind: 'spool', id: 3 });
    expect(fetch).toHaveBeenCalledWith('/api/spools/resolve?code=04%3Aa2%3Ab3%3Ac4');
  });

  it('gives null when nothing matches, and throws when the lookup fails', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'No spool found' }));
    expect(await lookUpScanCode('zzz')).toBeNull();
    vi.stubGlobal('fetch', reply(500));
    await expect(lookUpScanCode('zzz')).rejects.toThrow('Failed to look up the code');
  });
});

describe('linkTag', () => {
  it('asks the server to link the tag, leaving one Spoolman knows alone when only read', async () => {
    const fetch = reply(200, { supported: true, linked: false, heldBy: 2 });
    vi.stubGlobal('fetch', fetch);
    expect(await linkTag(3, '04A2B3C4', { move: false })).toEqual({ supported: true, linked: false, movedFrom: null });
    expect(fetch).toHaveBeenCalledWith('/api/spools/tag', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ spoolId: 3, uid: '04A2B3C4', move: false }),
    }));
  });

  it('says where a moved link came from', async () => {
    vi.stubGlobal('fetch', reply(200, { supported: true, linked: true, movedFrom: 1 }));
    expect(await linkTag(3, '04A2B3C4')).toEqual({ supported: true, linked: true, movedFrom: 1 });
  });

  it('tells an older Spoolman apart from a failure', async () => {
    vi.stubGlobal('fetch', reply(200, { supported: false }));
    expect(await linkTag(3, '04A2B3C4')).toMatchObject({ supported: false, linked: false });
    vi.stubGlobal('fetch', reply(409, { error: 'Tag 04A2B3C4 is linked to filament #4' }));
    expect(await linkTag(3, '04A2B3C4')).toMatchObject({ supported: true, linked: false, error: 'Tag 04A2B3C4 is linked to filament #4' });
  });

  it('never throws, even when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await linkTag(3, '04A2B3C4')).toMatchObject({ linked: false, error: 'SpoolmanSync could not be reached' });
  });
});
