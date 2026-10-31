import { describe, it, expect } from 'vitest';
import type { Spool } from './api/spoolman';
import { shouldStoreTagOnAssign, suggestCandidateSpools } from './tag-learning';

const UUID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

function spool(
  id: number,
  o: { tag?: string; rawTag?: string; tray?: string; material?: string; color?: string; archived?: boolean } = {},
): Spool {
  const extra: Record<string, string> = {};
  if (o.tag !== undefined) extra.tag = JSON.stringify(o.tag);
  if (o.rawTag !== undefined) extra.tag = o.rawTag;
  if (o.tray !== undefined) extra.active_tray = JSON.stringify(o.tray);
  return {
    id,
    archived: o.archived,
    filament: { id, name: `F${id}`, material: o.material ?? 'PLA', color_hex: o.color },
    extra,
  } as unknown as Spool;
}

describe('shouldStoreTagOnAssign', () => {
  const red = { tray_uuid: UUID, material: 'PLA', color: 'FF0000FF' };
  const redSpool = (id: number, o = {}) => spool(id, { color: 'ff0000', ...o });

  it('stores a real serial on an untagged spool nobody else owns', () => {
    const s = redSpool(1);
    expect(shouldStoreTagOnAssign(red, s, [s, redSpool(2, { tag: 'OTHER' })])).toBe(true);
  });

  it.each(['', 'unknown', '00000000000000000000000000000000', undefined])('ignores invalid serial %s', (v) => {
    const s = redSpool(1);
    expect(shouldStoreTagOnAssign({ ...red, tray_uuid: v }, s, [s])).toBe(false);
  });

  it('does not overwrite an existing tag on the spool', () => {
    const s = redSpool(1, { tag: 'EXISTING' });
    expect(shouldStoreTagOnAssign(red, s, [s])).toBe(false);
  });

  it('does not steal a serial owned by another spool (case-insensitive)', () => {
    const s = redSpool(1);
    expect(shouldStoreTagOnAssign(red, s, [s, redSpool(2, { tag: UUID.toLowerCase() })])).toBe(false);
  });

  it('does not steal a hand-entered bare (non-JSON) owner tag', () => {
    const s = redSpool(1);
    expect(shouldStoreTagOnAssign(red, s, [s, redSpool(2, { rawTag: ` ${UUID.toLowerCase()} ` })])).toBe(false);
  });

  it('skips the store when the tray still reports a different spool (assign before swap)', () => {
    const s = spool(1, { color: '0000ff' });
    expect(shouldStoreTagOnAssign(red, s, [s])).toBe(false);
    const petg = spool(1, { material: 'PETG', color: 'ff0000' });
    expect(shouldStoreTagOnAssign(red, petg, [petg])).toBe(false);
  });

  it('skips the store when the tray reports no material or colour', () => {
    const s = redSpool(1);
    expect(shouldStoreTagOnAssign({ tray_uuid: UUID }, s, [s])).toBe(false);
    expect(shouldStoreTagOnAssign({ ...red, color: '' }, s, [s])).toBe(false);
  });

  it('matches compound materials by base token', () => {
    const s = redSpool(1, { material: 'PLA Matte' });
    expect(shouldStoreTagOnAssign(red, s, [s])).toBe(true);
  });
});

describe('suggestCandidateSpools', () => {
  const tray = { material: 'PLA', color: '#FF0000FF' };

  it('ranks same-material spools by closest colour', () => {
    const out = suggestCandidateSpools(tray, [
      spool(1, { color: '0000ff' }),
      spool(2, { color: 'ee1111' }),
      spool(3, { color: 'ff0000' }),
    ]);
    expect(out.map(c => c.spoolId)).toEqual([3, 2, 1]);
  });

  it('excludes other materials, archived, tagged and already-loaded spools', () => {
    const out = suggestCandidateSpools(tray, [
      spool(1, { material: 'PETG', color: 'ff0000' }),
      spool(2, { archived: true, color: 'ff0000' }),
      spool(3, { tag: 'X', color: 'ff0000' }),
      spool(4, { tray: 'ams_1_tray_1', color: 'ff0000' }),
      spool(5, { tray: '', color: 'ff0000' }),
    ]);
    expect(out.map(c => c.spoolId)).toEqual([5]);
  });

  it('treats compound materials as base material and sorts unknown colour last', () => {
    const out = suggestCandidateSpools(tray, [spool(1, { material: 'PLA Matte' }), spool(2, { color: 'ff0000' })]);
    expect(out.map(c => c.spoolId)).toEqual([2, 1]);
    expect(out[1].colorDistance).toBeNull();
  });

  it('respects the limit', () => {
    const many = [1, 2, 3, 4, 5].map(i => spool(i, { color: 'ff0000' }));
    expect(suggestCandidateSpools(tray, many, 2)).toHaveLength(2);
  });
});
