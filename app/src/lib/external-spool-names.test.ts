import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ default: {} }));

const { HomeAssistantClient } = await import('./api/homeassistant');

/**
 * Dual-nozzle printers (H2D, X2D, ...) expose two external spool slots. Both
 * used to render as "External" and share one Spoolman location, so they were
 * indistinguishable (PR #87).
 *
 * The naming rule these pin:
 *   - a slot the user renamed in HA keeps that name
 *   - otherwise two slots become "External 1" / "External 2"
 *   - a printer with a single slot gets no name at all, so everything that
 *     renders it keeps saying "External" and no existing label changes
 *
 * The device name must NOT be used on its own: ha-bambulab always sets it
 * ("X2D_<serial>_ExternalSpool"), which would put the serial in the dashboard
 * and in Spoolman locations for every user who never renamed anything.
 */

type Registry = { entities: Record<string, unknown>[]; devices: Record<string, unknown>[] };

const SERIAL = '01P00A000000001';

function printerRegistry(externals: { suffix: string; name_by_user?: string | null }[]): Registry {
  const entities: Record<string, unknown>[] = [{
    entity_id: 'sensor.x2d_print_status',
    unique_id: `X2D_${SERIAL}_print_status`,
    device_id: 'devP',
    platform: 'bambu_lab',
    translation_key: 'print_status',
    translation_placeholders: null,
    disabled_by: null,
  }];
  const devices: Record<string, unknown>[] = [{
    id: 'devP', identifiers: [], via_device_id: null, manufacturer: 'Bambu Lab',
    model: 'X2D', name: 'X2D', name_by_user: null, config_entry_id: 'entry_x2d',
  }];

  externals.forEach(({ suffix, name_by_user = null }, i) => {
    const deviceId = `devE${i}`;
    entities.push({
      entity_id: `sensor.x2d_external_spool${suffix}`,
      unique_id: `X2D_${SERIAL}_ExternalSpool${suffix}_external_spool`,
      device_id: deviceId,
      platform: 'bambu_lab',
      translation_key: 'external_spool',
      translation_placeholders: null,
      disabled_by: null,
    });
    devices.push({
      id: deviceId, identifiers: [], via_device_id: 'devP', manufacturer: 'Bambu Lab',
      model: 'External Spool',
      // Exactly what ha-bambulab names these devices (coordinator.py).
      name: `X2D_${SERIAL}_ExternalSpool${suffix}`,
      name_by_user,
      config_entry_id: 'entry_x2d',
    });
  });

  return { entities, devices };
}

async function discover(registry: Registry) {
  const client = new HomeAssistantClient('http://ha.test', 'token');
  const stub = client as unknown as {
    getEntityAndDeviceRegistry: () => Promise<unknown>;
    getStates: () => Promise<unknown>;
  };
  stub.getEntityAndDeviceRegistry = async () => registry;
  stub.getStates = async () => registry.entities.map(e => ({ entity_id: e.entity_id, state: 'idle', attributes: {} }));
  return client.discoverPrinters();
}

const slotNames = (printers: { external_spools: { slot_name?: string }[] }[]) =>
  printers[0].external_spools.map(e => e.slot_name);

describe('external spool slot names', () => {
  it('numbers the two slots of a dual-nozzle printer', async () => {
    const printers = await discover(printerRegistry([{ suffix: '' }, { suffix: '2' }]));
    expect(slotNames(printers)).toEqual(['External 1', 'External 2']);
  });

  it('leaves a single slot unnamed, so nothing about it changes', async () => {
    const printers = await discover(printerRegistry([{ suffix: '' }]));
    expect(slotNames(printers)).toEqual([undefined]);
  });

  it('never falls back to the device name ha-bambulab generated', async () => {
    for (const registry of [printerRegistry([{ suffix: '' }]), printerRegistry([{ suffix: '' }, { suffix: '2' }])]) {
      const printers = await discover(registry);
      for (const name of slotNames(printers)) {
        expect(name ?? '').not.toContain(SERIAL);
      }
    }
  });

  it('uses the name when the user renamed the device in HA', async () => {
    const printers = await discover(printerRegistry([
      { suffix: '', name_by_user: 'Left spool' },
      { suffix: '2', name_by_user: 'Right spool' },
    ]));
    expect(slotNames(printers)).toEqual(['Left spool', 'Right spool']);
  });

  it('mixes a renamed slot with a numbered one', async () => {
    const printers = await discover(printerRegistry([
      { suffix: '', name_by_user: 'Left spool' },
      { suffix: '2' },
    ]));
    expect(slotNames(printers)).toEqual(['Left spool', 'External 2']);
  });

  it('honours a rename on a single-slot printer', async () => {
    const printers = await discover(printerRegistry([{ suffix: '', name_by_user: '  Dry box  ' }]));
    expect(slotNames(printers)).toEqual(['Dry box']);
  });

  it('numbers by the slot index, not by discovery order', async () => {
    // The registry lists the second slot first; names must still follow the
    // index in the unique_id, which is also the order the UI shows them in.
    const reversed = printerRegistry([{ suffix: '2' }, { suffix: '' }]);
    const printers = await discover(reversed);
    expect(printers[0].external_spools.map(e => [e.unique_id, e.slot_name])).toEqual([
      [`X2D_${SERIAL}_ExternalSpool_external_spool`, 'External 1'],
      [`X2D_${SERIAL}_ExternalSpool2_external_spool`, 'External 2'],
    ]);
  });

  it('leaves the synthesized slot of a non-AMS printer unnamed', async () => {
    const printers = await discover(printerRegistry([]));
    expect(printers[0].external_spools.map(e => [e.unique_id, e.slot_name])).toEqual([
      ['x2d_01p00a000000001_virtual_external_spool', undefined],
    ]);
  });
});
