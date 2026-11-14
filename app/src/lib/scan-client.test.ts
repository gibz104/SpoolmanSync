import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookUpScanCode } from './scan-client';

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
