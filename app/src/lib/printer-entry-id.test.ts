import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ default: {} }));

const { HomeAssistantClient, deviceConfigEntryId } = await import('./api/homeassistant');

/**
 * Hiding a printer matches on its HA config entry id (issue #86), so discovery
 * has to carry that id for every brand. HA sends it under three keys —
 * config_entry_id today, primary_config_entry and config_entries kept for
 * backwards compatibility — and these pin that each is picked up.
 */

type Device = Record<string, unknown>;
type Entity = Record<string, unknown>;

function discoverWith(entities: Entity[], devices: Device[]) {
  const client = new HomeAssistantClient('http://ha.test', 'token');
  const stub = client as unknown as {
    getEntityAndDeviceRegistry: () => Promise<unknown>;
    getStates: () => Promise<unknown>;
  };
  stub.getEntityAndDeviceRegistry = async () => ({ entities, devices });
  stub.getStates = async () => entities.map(e => ({ entity_id: e.entity_id, state: 'idle', attributes: {} }));
  return client.discoverPrinters();
}

const bambuEntity = (suffix: string, deviceId: string) => ({
  entity_id: `sensor.${suffix}_print_status`,
  unique_id: `${suffix.toUpperCase()}_SERIAL_print_status`,
  device_id: deviceId,
  platform: 'bambu_lab',
  translation_key: 'print_status',
  translation_placeholders: null,
  disabled_by: null,
});

const device = (id: string, name: string, extra: Device) => ({
  id,
  identifiers: [],
  via_device_id: null,
  manufacturer: 'Bambu Lab',
  model: name,
  name,
  name_by_user: null,
  ...extra,
});

describe('deviceConfigEntryId', () => {
  it('prefers the current field, then the compatibility ones', () => {
    expect(deviceConfigEntryId({ config_entry_id: 'new', primary_config_entry: 'old', config_entries: ['older'] })).toBe('new');
    expect(deviceConfigEntryId({ primary_config_entry: 'old', config_entries: ['older'] })).toBe('old');
    expect(deviceConfigEntryId({ config_entries: ['older'] })).toBe('older');
  });

  it('returns undefined when HA sends no config entry at all', () => {
    expect(deviceConfigEntryId({})).toBeUndefined();
    expect(deviceConfigEntryId({ config_entry_id: null, primary_config_entry: null, config_entries: [] })).toBeUndefined();
    expect(deviceConfigEntryId(undefined)).toBeUndefined();
  });
});

describe('discoverPrinters carries the config entry id', () => {
  it('reads it for Bambu Lab printers from any of the fields HA sends', async () => {
    const printers = await discoverWith(
      [bambuEntity('x1c', 'devA'), bambuEntity('p1s', 'devB'), bambuEntity('a1', 'devC')],
      [
        device('devA', 'X1C', { config_entry_id: 'entry_x1c' }),
        device('devB', 'P1S', { primary_config_entry: 'entry_p1s' }),
        device('devC', 'A1', { config_entries: ['entry_a1'] }),
      ],
    );
    expect(printers.map(p => [p.name, p.entry_id])).toEqual([
      ['X1C', 'entry_x1c'],
      ['P1S', 'entry_p1s'],
      ['A1', 'entry_a1'],
    ]);
  });

  it('reads it for Creality printers', async () => {
    const printers = await discoverWith(
      [{
        entity_id: 'sensor.k1c_print_status',
        unique_id: 'k1c_print_status',
        device_id: 'devK',
        platform: 'ha_creality_ws',
        translation_key: null,
        translation_placeholders: null,
        disabled_by: null,
      }],
      [device('devK', 'K1C', { config_entry_id: 'entry_k1c', manufacturer: 'Creality' })],
    );
    expect(printers.map(p => [p.brand, p.entry_id])).toEqual([['creality', 'entry_k1c']]);
  });

  it('leaves entry_id undefined when HA sends no config entry', async () => {
    const printers = await discoverWith([bambuEntity('x1c', 'devA')], [device('devA', 'X1C', {})]);
    expect(printers[0].entry_id).toBeUndefined();
  });
});
