import { describe, it, expect, vi } from 'vitest';
import type { Spool } from '@/lib/api/spoolman';
import { normalizeTagUid, parseScanLink, slotPath } from './scan-codes';
import { resolveScanCode } from './scan-resolve';

const spool = (id: number, extra: Record<string, string> = {}) => ({ id, extra, archived: false }) as unknown as Spool;

describe('parseScanLink', () => {
  it('reads SpoolmanSync and Spoolman spool links', () => {
    expect(parseScanLink('https://sync.example.com/scan/spool/12')).toEqual({ kind: 'spool', id: 12 });
    expect(parseScanLink('web+spoolman:s-7')).toEqual({ kind: 'spool', id: 7 });
    expect(parseScanLink('http://192.168.1.5:7912/spool/show/31')).toEqual({ kind: 'spool', id: 31 });
  });

  it('reads slot links, whatever the slot key holds', () => {
    expect(parseScanLink('https://sync.example.com/scan/tray/X1C_00M09A_AMS_1_tray_2')).toEqual({ kind: 'slot', key: 'X1C_00M09A_AMS_1_tray_2' });
    const key = 'virtual_Dry Box/1 #2_tray_3';
    expect(parseScanLink(`http://host:3000${slotPath(key)}`)).toEqual({ kind: 'slot', key });
  });

  it('leaves anything else to the server', () => {
    expect(parseScanLink('12')).toBeNull();
    expect(parseScanLink('04:a2:b3:c4')).toBeNull();
    expect(parseScanLink('https://example.com/other/12')).toBeNull();
    expect(parseScanLink('https://sync.example.com/scan/tray/%E0%A4%A')).toBeNull();
  });
});

describe('normalizeTagUid', () => {
  it('spells a UID the way Spoolman stores it, whatever the reader used', () => {
    expect(normalizeTagUid('04:a2:b3:c4:d5:e6:f7')).toBe('04A2B3C4D5E6F7');
    expect(normalizeTagUid('04-A2-B3-C4')).toBe('04A2B3C4');
    expect(normalizeTagUid(' 0x04a2b3c4 ')).toBe('04A2B3C4');
  });

  it('rejects text that is not a whole number of hex bytes', () => {
    expect(normalizeTagUid('hello')).toBe('');
    expect(normalizeTagUid('04A2B')).toBe('');
    expect(normalizeTagUid('')).toBe('');
    expect(normalizeTagUid('AB'.repeat(33))).toBe('');
  });
});

describe('resolveScanCode', () => {
  const spools = [spool(3), spool(12, { barcode: JSON.stringify('4006381333931') }), spool(20, { barcode: 'RAW-CODE' })];
  const deps = (tagged: Record<string, number> = {}) => ({
    spools: vi.fn(async () => spools),
    spoolByTagUid: vi.fn(async (uid: string) => (tagged[uid] ? spool(tagged[uid]) : null)),
  });

  it('follows a link without looking anything up', async () => {
    const d = deps();
    expect(await resolveScanCode(' web+spoolman:s-99 ', d)).toEqual({ kind: 'spool', id: 99 });
    expect(await resolveScanCode('/scan/tray/abc', d)).toEqual({ kind: 'slot', key: 'abc' });
    expect(d.spools).not.toHaveBeenCalled();
  });

  it('takes a number as a spool id when a spool has it', async () => {
    expect(await resolveScanCode('12', deps())).toEqual({ kind: 'spool', id: 12 });
  });

  it('matches a barcode, stored JSON-encoded or raw', async () => {
    expect(await resolveScanCode('4006381333931', deps())).toEqual({ kind: 'spool', id: 12 });
    expect(await resolveScanCode('RAW-CODE', deps())).toEqual({ kind: 'spool', id: 20 });
  });

  it('looks a tag UID up in Spoolman, in any spelling', async () => {
    const d = deps({ '04A2B3C4': 3 });
    expect(await resolveScanCode('04:a2:b3:c4', d)).toEqual({ kind: 'spool', id: 3 });
    expect(d.spoolByTagUid).toHaveBeenCalledWith('04A2B3C4');
  });

  it('looks up a number no spool has as a UID typed in digits', async () => {
    expect(await resolveScanCode('04123456', deps({ '04123456': 3 }))).toEqual({ kind: 'spool', id: 3 });
  });

  it('finds nothing for an unknown code, and asks Spoolman only about real UIDs', async () => {
    const d = deps();
    expect(await resolveScanCode('not a code', d)).toBeNull();
    expect(d.spoolByTagUid).not.toHaveBeenCalled();
    expect(await resolveScanCode('', d)).toBeNull();
  });
});
