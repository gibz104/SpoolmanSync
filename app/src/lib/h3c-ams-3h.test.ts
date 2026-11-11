import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ default: {} }));

const { HomeAssistantClient, AMS_3H_NAME, AMS_3H_NUMBER } = await import('./api/homeassistant');
const { watchFor } = await import('./usage/printers');
import type { HAPrinter } from './api/homeassistant';

/**
 * The H3C uses ha-bambulab's nine-tray AMS 3H. It is a distinct device type
 * (model "AMS 3H", original device name suffix "_AMS_3H") and must be surfaced
 * as "AMS 3H" with the stable numeric id 33, never as "AMS 1" (which is what
 * parseAmsNumber would return for a name like "..._AMS_3H" because the "_AMS_3H"
 * suffix is not read as "_AMS_<digits>").
 *
 * These pin:
 *   - all nine trays are discovered, across the placeholder, unique_id fallback
 *     and legacy null-translation_key resolution paths, and sorted 1-9
 *   - the AMS 3H is recognized by model OR original-device-name suffix
 *   - invalid tray numbers (0, >9) are rejected
 *   - normal AMS and AMS HT discovery and naming are untouched
 *   - watchFor registers both the display-name label ("AMS 3H Tray N") and the
 *     upstream index-based alias ("AMS 33 Tray N") for the same tray key
 */

type Registry = { entities: Record<string, unknown>[]; devices: Record<string, unknown>[] };
type TrayMode = 'placeholder' | 'unique_id' | 'legacy';

const SERIAL = '01P00A000000001';
// ha-bambulab's upstream tray unique_ids are "_AMS_<AMS-serial>_tray_N", not the
// literal "_AMS_3H" that an early fixture used. The device name suffix "_AMS_3H"
// (set in amsRegistry below, not the unique_id) is what identifies the unit.
const AMS_SERIAL = '01P00A000000002';

function trayEntity(n: number, mode: TrayMode, deviceId: string): Record<string, unknown> {
  const base = {
    entity_id: `sensor.h3c_ams_3h_tray_${n}`,
    unique_id: `H3C_${SERIAL}_AMS_${AMS_SERIAL}_tray_${n}`,
    device_id: deviceId,
    platform: 'bambu_lab',
    translation_placeholders: null,
    disabled_by: null,
  };
  if (mode === 'placeholder') {
    // Newer ha-bambulab sets translation_key="tray" with tray_number placeholders.
    return { ...base, translation_key: 'tray', translation_placeholders: { tray_number: String(n) } };
  }
  if (mode === 'unique_id') {
    // translation_key="tray" but the placeholders are absent from the WS response;
    // getEffectiveTranslationKey falls back to parsing the tray number from unique_id.
    return { ...base, translation_key: 'tray' };
  }
  // Legacy ha-bambulab versions set no translation_key at all; the key is read
  // from the unique_id suffix, and that fallback must cover trays 5-9 too.
  return { ...base, translation_key: null };
}

function amsRegistry(opts: {
  printer?: { model?: string | null; name?: string };
  ams: { model?: string | null; name?: string; trays: Array<{ n: number; mode: TrayMode }> };
}): Registry {
  const printerModel = opts.printer?.model ?? 'H3C';
  const printerName = opts.printer?.name ?? 'H3C';
  const entities: Record<string, unknown>[] = [{
    entity_id: 'sensor.h3c_print_status',
    unique_id: `H3C_${SERIAL}_print_status`,
    device_id: 'devP',
    platform: 'bambu_lab',
    translation_key: 'print_status',
    translation_placeholders: null,
    disabled_by: null,
  }];
  const devices: Record<string, unknown>[] = [{
    id: 'devP', identifiers: [], via_device_id: null, manufacturer: 'Bambu Lab',
    model: printerModel, name: printerName, name_by_user: null, config_entry_id: 'entry_h3c',
  }];

  const amsDeviceId = 'devAMS';
  devices.push({
    id: amsDeviceId, identifiers: [], via_device_id: 'devP', manufacturer: 'Bambu Lab',
    model: opts.ams.model ?? null,
    name: opts.ams.name ?? '',
    name_by_user: null, config_entry_id: 'entry_h3c',
  });

  for (const tray of opts.ams.trays) {
    entities.push(trayEntity(tray.n, tray.mode, amsDeviceId));
  }

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

describe('AMS 3H discovery', () => {
  it('discovers all nine trays by placeholder, unique-id fallback and legacy keys, sorted', async () => {
    const registry = amsRegistry({
      ams: {
        model: AMS_3H_NAME,
        name: `H3C_${SERIAL}_AMS_3H`,
        // Deliberately unsorted: discovery must order them by tray number.
        trays: [
          { n: 9, mode: 'legacy' },
          { n: 1, mode: 'placeholder' },
          { n: 7, mode: 'placeholder' },
          { n: 3, mode: 'unique_id' },
          { n: 5, mode: 'legacy' },
          { n: 2, mode: 'unique_id' },
          { n: 8, mode: 'placeholder' },
          { n: 4, mode: 'legacy' },
          { n: 6, mode: 'unique_id' },
        ],
      },
    });

    const printers = await discover(registry);
    expect(printers).toHaveLength(1);
    expect(printers[0].ams_units).toHaveLength(1);

    const ams = printers[0].ams_units[0];
    expect(ams.name).toBe(AMS_3H_NAME);
    expect(ams.name).toBe('AMS 3H');
    expect(ams.ams_number).toBe(AMS_3H_NUMBER);
    expect(ams.ams_number).toBe(33);

    expect(ams.trays.map(t => t.tray_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Every tray keeps its stable unique_id.
    expect(ams.trays.map(t => t.unique_id)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `H3C_${SERIAL}_AMS_${AMS_SERIAL}_tray_${n}`),
    );
  });

  it('recognizes the AMS 3H by its device model even without the name suffix', async () => {
    const registry = amsRegistry({
      ams: {
        model: AMS_3H_NAME,
        // A name like this would parse as AMS 1; the model must win.
        name: `H3C_${SERIAL}_AMS_1`,
        trays: [{ n: 1, mode: 'placeholder' }, { n: 2, mode: 'legacy' }],
      },
    });

    const printers = await discover(registry);
    const ams = printers[0].ams_units[0];
    expect(ams.name).toBe('AMS 3H');
    expect(ams.ams_number).toBe(33);
  });

  it('recognizes the AMS 3H by the original device name suffix', async () => {
    const registry = amsRegistry({
      ams: {
        model: null,
        name: `H3C_${SERIAL}_AMS_3H`,
        trays: [{ n: 1, mode: 'placeholder' }, { n: 2, mode: 'unique_id' }, { n: 3, mode: 'legacy' }],
      },
    });

    const printers = await discover(registry);
    const ams = printers[0].ams_units[0];
    expect(ams.name).toBe('AMS 3H');
    expect(ams.ams_number).toBe(33);
  });

  it('rejects invalid tray numbers (0 and >9)', async () => {
    const registry = amsRegistry({
      ams: {
        model: AMS_3H_NAME,
        name: `H3C_${SERIAL}_AMS_3H`,
        trays: [
          ...Array.from({ length: 9 }, (_, i) => ({ n: i + 1, mode: 'placeholder' as TrayMode })),
          { n: 10, mode: 'placeholder' },
          { n: 0, mode: 'placeholder' },
          { n: 11, mode: 'legacy' },
        ],
      },
    });

    const printers = await discover(registry);
    const ams = printers[0].ams_units[0];
    expect(ams.trays.map(t => t.tray_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('leaves a normal AMS numbered and named as before', async () => {
    const registry = amsRegistry({
      ams: {
        model: null,
        name: `H3C_${SERIAL}_AMS_1`,
        trays: [1, 2, 3, 4].map(n => ({ n, mode: 'legacy' as TrayMode })),
      },
    });

    const printers = await discover(registry);
    const ams = printers[0].ams_units[0];
    expect(ams.name).toBe('AMS 1');
    expect(ams.ams_number).toBe(1);
    expect(ams.trays.map(t => t.tray_number)).toEqual([1, 2, 3, 4]);
  });

  it('leaves an AMS HT numbered and named as before, never overridden', async () => {
    const registry = amsRegistry({
      ams: {
        model: null,
        name: `H3C_${SERIAL}_AMS_128`,
        trays: [{ n: 1, mode: 'placeholder' }],
      },
    });

    const printers = await discover(registry);
    const ams = printers[0].ams_units[0];
    expect(ams.name).toBe('AMS HT');
    expect(ams.ams_number).toBe(128);
  });
});

describe('watchFor / AMS 3H slicer names', () => {
  it('maps the AMS 3H display-name label and the AMS 33 alias to the right tray keys', () => {
    const printer: HAPrinter = {
      brand: 'bambu_lab',
      entity_id: 'sensor.h3c_print_status',
      name: 'H3C',
      state: 'idle',
      prefix: 'h3c_serial',
      ams_units: [{
        entity_id: 'sensor.h3c_ams_3h_humidity',
        name: AMS_3H_NAME,
        ams_number: AMS_3H_NUMBER,
        trays: [1, 2, 3].map(n => ({
          entity_id: `sensor.h3c_ams_3h_tray_${n}`,
          unique_id: `H3C_${SERIAL}_AMS_${AMS_SERIAL}_tray_${n}`,
          tray_number: n,
        })),
      }],
      external_spools: [],
    };

    const watch = watchFor(printer)!;
    expect(watch.trays.map(t => t.label)).toEqual(['AMS 3H Tray 1', 'AMS 3H Tray 2', 'AMS 3H Tray 3']);

    for (const n of [1, 2, 3]) {
      const key = `H3C_${SERIAL}_AMS_${AMS_SERIAL}_tray_${n}`;
      expect(watch.slicerNames[`AMS 3H Tray ${n}`]).toBe(key);
      expect(watch.slicerNames[`AMS 33 Tray ${n}`]).toBe(key);
    }
  });

  it('keeps the normal AMS and AMS HT slicer names for other units', () => {
    const printer: HAPrinter = {
      brand: 'bambu_lab',
      entity_id: 'sensor.h2d_print_status',
      name: 'H2D',
      state: 'idle',
      prefix: 'h2d_serial',
      ams_units: [
        {
          entity_id: 'sensor.h2d_ams_1_humidity',
          name: 'AMS 1',
          ams_number: 1,
          trays: [1, 2].map(n => ({
            entity_id: `sensor.h2d_ams_1_tray_${n}`,
            unique_id: `H2D_SERIAL_AMS_1_tray_${n}`,
            tray_number: n,
          })),
        },
        {
          entity_id: 'sensor.h2d_ams_128_humidity',
          name: 'AMS HT',
          ams_number: 128,
          trays: [{ entity_id: 'sensor.h2d_ams_128_tray_1', unique_id: 'H2D_SERIAL_AMS_128_tray_1', tray_number: 1 }],
        },
      ],
      external_spools: [],
    };

    const watch = watchFor(printer)!;
    expect(watch.slicerNames['AMS 1 Tray 1']).toBe('H2D_SERIAL_AMS_1_tray_1');
    expect(watch.slicerNames['AMS 1 Tray 2']).toBe('H2D_SERIAL_AMS_1_tray_2');
    expect(watch.slicerNames['AMS HT 1']).toBe('H2D_SERIAL_AMS_128_tray_1');
  });

  it('keeps a Creality CFS box numbered 33 from being named as an AMS 3H', () => {
    const printer: HAPrinter = {
      brand: 'creality',
      entity_id: 'sensor.k2_print_status',
      name: 'K2',
      state: 'idle',
      prefix: 'k2_serial',
      ams_units: [{
        entity_id: 'sensor.k2_cfs_box_33_humidity',
        name: 'CFS Box 33',
        ams_number: 33,
        trays: [1, 2].map(n => ({
          entity_id: `sensor.k2_cfs_box_33_slot_${n}`,
          unique_id: `K2_SERIAL_cfs_box_33_slot_${n}`,
          tray_number: n,
        })),
      }],
      external_spools: [],
    };

    const watch = watchFor(printer)!;
    // Creality trays keep a 'Slot' label, so the box number must not surface as "AMS 3H".
    expect(watch.trays.map(t => t.label)).toEqual(['CFS Box 33 Slot 1', 'CFS Box 33 Slot 2']);
    // The CFS box falls through to the generic AMS numbering style...
    expect(watch.slicerNames['AMS 33 Tray 1']).toBe('K2_SERIAL_cfs_box_33_slot_1');
    expect(watch.slicerNames['AMS 33 Tray 2']).toBe('K2_SERIAL_cfs_box_33_slot_2');
    // ...and registers no AMS 3H alias for it.
    expect(watch.slicerNames['AMS 3H Tray 1']).toBeUndefined();
  });

  it('keeps a Bambu generic AMS numbered 33 from being named as an AMS 3H', () => {
    const printer: HAPrinter = {
      brand: 'bambu_lab',
      entity_id: 'sensor.h2d_print_status',
      name: 'H2D',
      state: 'idle',
      prefix: 'h2d_serial',
      ams_units: [{
        entity_id: 'sensor.h2d_ams_33_humidity',
        name: 'AMS 33',
        ams_number: 33,
        trays: [1].map(n => ({
          entity_id: `sensor.h2d_ams_33_tray_${n}`,
          unique_id: `H2D_SERIAL_AMS_33_tray_${n}`,
          tray_number: n,
        })),
      }],
      external_spools: [],
    };

    const watch = watchFor(printer)!;
    // A Bambu unit that is genuinely named "AMS 33" keeps its generic numbering.
    expect(watch.slicerNames['AMS 33 Tray 1']).toBe('H2D_SERIAL_AMS_33_tray_1');
    expect(watch.slicerNames['AMS 3H Tray 1']).toBeUndefined();
  });
});
