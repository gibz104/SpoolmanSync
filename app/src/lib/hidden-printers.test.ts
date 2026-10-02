import { describe, expect, it } from 'vitest';
import {
  type HiddenPrinterRecord,
  filterHiddenPrinters,
  isPrinterHidden,
} from './hidden-printers';

/**
 * Removing a printer from SpoolmanSync must hide that printer and nothing else.
 * These pin the cases from issue #86, where matching the config entry title as a
 * substring hid unrelated printers (and, for Creality, hid nothing at all).
 */

// The reporter's fleet. Bambu serials routinely contain the letters of another
// printer's model name.
const fleet = [
  { name: 'H2S', entity_id: 'sensor.h2s_0938bc5a2300433_print_status', entry_id: 'entry_h2s' },
  { name: 'P2S', entity_id: 'sensor.p2s_22e8bj5b0501577_print_status', entry_id: 'entry_p2s' },
  { name: 'X2D', entity_id: 'sensor.x2d_20p8bj5a1500474_print_status', entry_id: 'entry_x2d' },
  { name: 'A2L', entity_id: 'sensor.a2l_26a19a01b651501261_print_status', entry_id: 'entry_a2l' },
  { name: 'A1', entity_id: 'sensor.a1_01p00a000000001_print_status', entry_id: 'entry_a1' },
  { name: 'K1C', entity_id: 'sensor.k1c_print_status', entry_id: 'entry_k1c' },
];
const names = (printers: { name: string }[]) => printers.map(p => p.name);

describe('hidden printer matching (#86)', () => {
  it('hides only the removed printer, not serials containing its title', () => {
    const hidden: HiddenPrinterRecord[] = [{ entryId: 'entry_a1', title: 'A1' }];
    expect(names(filterHiddenPrinters(fleet, hidden))).toEqual(['H2S', 'P2S', 'X2D', 'A2L', 'K1C']);
  });

  it('hides a Creality printer whose title appears in no entity_id', () => {
    // ha_creality_ws titles its entry "Creality Printer (WS) (<ip>)", which the
    // old title match never found — the printer stayed on the dashboard.
    const hidden: HiddenPrinterRecord[] = [
      { entryId: 'entry_k1c', title: 'Creality Printer (WS) (192.168.1.10)' },
    ];
    expect(names(filterHiddenPrinters(fleet, hidden))).toEqual(['H2S', 'P2S', 'X2D', 'A2L', 'A1']);
  });

  it('hides several removed printers at once', () => {
    const hidden: HiddenPrinterRecord[] = [
      { entryId: 'entry_a1', title: 'A1' },
      { entryId: 'entry_p2s', title: 'P2S' },
    ];
    expect(names(filterHiddenPrinters(fleet, hidden))).toEqual(['H2S', 'X2D', 'A2L', 'K1C']);
  });

  it('returns every printer when nothing is hidden', () => {
    expect(names(filterHiddenPrinters(fleet, []))).toEqual(names(fleet));
  });

  it('ignores a stored title that matches another printer by name', () => {
    // The entry was removed and re-added in HA, so the stored id is stale. The
    // stale record must not fall back to hiding a same-named printer.
    const hidden: HiddenPrinterRecord[] = [{ entryId: 'entry_gone', title: 'A1' }];
    expect(names(filterHiddenPrinters(fleet, hidden))).toEqual(names(fleet));
  });

  it('keeps a printer whose entry id is simply not in the hidden list', () => {
    expect(isPrinterHidden(fleet[2], [{ entryId: 'entry_a1', title: 'A1' }])).toBe(false);
  });

  it('compares entry ids ignoring case and surrounding space', () => {
    const printer = { name: 'X1C', entity_id: 'sensor.x1c_print_status', entry_id: 'AbC123' };
    expect(isPrinterHidden(printer, [{ entryId: ' abc123 ', title: '' }])).toBe(true);
  });
});

describe('printers discovered without a config entry id', () => {
  // Only reachable on an HA core that sends none of the config-entry fields.
  const legacy = { name: 'A1', entity_id: 'sensor.a1_01p00a000000001_print_status' };

  it('falls back to an exact name match', () => {
    expect(isPrinterHidden(legacy, [{ entryId: 'entry_a1', title: 'A1' }])).toBe(true);
    expect(isPrinterHidden(legacy, [{ entryId: 'entry_a1', title: ' a1 ' }])).toBe(true);
  });

  it('does not fall back to substring matching', () => {
    const x2d = { name: 'X2D', entity_id: 'sensor.x2d_20p8bj5a1500474_print_status' };
    expect(isPrinterHidden(x2d, [{ entryId: 'entry_a1', title: 'A1' }])).toBe(false);
  });

  it('is not hidden by an empty stored title', () => {
    // Legacy hidden records (stored as bare ids) carry title: ''.
    expect(isPrinterHidden(legacy, [{ entryId: 'entry_other', title: '' }])).toBe(false);
    expect(isPrinterHidden({ name: '', entity_id: 'sensor.x' }, [{ entryId: 'e', title: '' }])).toBe(false);
  });
});
