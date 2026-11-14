import { describe, it, expect } from 'vitest';
import type { Spool } from '@/lib/api/spoolman';
import { slotLabel, slotOptions, type SlotPrinter } from './slot-options';

const spool = { id: 4 } as Spool;

describe('slotOptions', () => {
  it('lists AMS trays, external spools and storage slots by their assignment keys', () => {
    const printers: SlotPrinter[] = [
      {
        name: 'X1C',
        ams_units: [{ name: 'AMS 1', trays: [
          { entity_id: 'sensor.x1c_ams_1_tray_1', unique_id: 'X1C_S_AMS_1_tray_1', tray_number: 1, assigned_spool: spool },
          { entity_id: 'sensor.x1c_ams_1_tray_2', tray_number: 2 },
        ] }],
        external_spools: [{ entity_id: 'sensor.x1c_external_spool', unique_id: 'X1C_S_ExternalSpool_external_spool', tray_number: 0 }],
      },
      {
        name: 'Dry Box', is_virtual: true,
        ams_units: [{ name: 'Dry Box', trays: [{ entity_id: 'virtual_Dry Box_tray_3', unique_id: 'virtual_Dry Box_tray_3', tray_number: 3 }] }],
        external_spools: [],
      },
    ];
    expect(slotOptions(printers)).toEqual([
      { key: 'X1C_S_AMS_1_tray_1', printer: 'X1C', group: 'AMS 1', label: 'Tray 1', spool },
      { key: 'sensor.x1c_ams_1_tray_2', printer: 'X1C', group: 'AMS 1', label: 'Tray 2', spool: undefined },
      { key: 'X1C_S_ExternalSpool_external_spool', printer: 'X1C', label: 'External Spool', spool: undefined },
      { key: 'virtual_Dry Box_tray_3', printer: 'Dry Box', group: undefined, label: 'Tray 3', spool: undefined },
    ]);
  });

  it('numbers two external spools unless they were named', () => {
    const printers: SlotPrinter[] = [{
      name: 'H2D',
      external_spools: [
        { entity_id: 'a', tray_number: 0 },
        { entity_id: 'b', tray_number: 0, slot_name: 'Right nozzle' },
      ],
    }];
    expect(slotOptions(printers).map(s => s.label)).toEqual(['External Spool 1', 'Right nozzle']);
  });
});

describe('slotLabel', () => {
  it('puts the unit before the tray', () => {
    expect(slotLabel({ group: 'AMS 3H', label: 'Tray 9' })).toBe('AMS 3H - Tray 9');
    expect(slotLabel({ label: 'External Spool' })).toBe('External Spool');
  });
});
