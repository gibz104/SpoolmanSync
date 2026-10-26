import { describe, it, expect } from 'vitest';
import { HomeAssistantClient } from './api/homeassistant';

/**
 * Creality printers are found by entity_id pattern, so a pattern that misses an
 * id is a printer that silently does not exist. Home Assistant appends _2, _3
 * when an object_id is taken, e.g. two K1Cs that both fell back to "k1c".
 */
function printerEntities(object: string, device: string, suffix = '') {
  return [
    `sensor.${object}_print_status${suffix}`,
    `sensor.${object}_used_material_length${suffix}`,
    `sensor.${object}_print_progress${suffix}`,
    `sensor.${object}_cfs_box_1_slot_1_filament${suffix}`,
    `sensor.${object}_cfs_external_filament${suffix}`,
  ].map(entity_id => ({
    entity_id, platform: 'ha_creality_ws', device_id: device, translation_key: null,
    translation_placeholders: null, disabled_by: null, unique_id: `${device}-${entity_id}`,
  }));
}

async function discover(entities: ReturnType<typeof printerEntities>) {
  const ha = new HomeAssistantClient('http://ha.local:8123', 'token');
  const devices = [...new Set(entities.map(e => e.device_id))].map(id => ({
    id, identifiers: [], via_device_id: null, manufacturer: 'Creality', model: 'K1C', name: 'K1C', name_by_user: null,
  }));
  Object.assign(ha, {
    getEntityAndDeviceRegistry: async () => ({ entities, devices }),
    getStates: async () => entities.map(e => ({ entity_id: e.entity_id, state: 'idle', attributes: {}, last_changed: '', last_updated: '' })),
  });
  return ha.discoverPrinters();
}

describe('Creality discovery', () => {
  it('finds a printer whose entity ids carry a collision suffix, under its own prefix', async () => {
    const printers = await discover([...printerEntities('k1c', 'dev1'), ...printerEntities('k1c', 'dev2', '_2')]);
    expect(printers.map(p => p.prefix).sort()).toEqual(['k1c', 'k1c_2']);
    const second = printers.find(p => p.prefix === 'k1c_2')!;
    expect(second.used_material_entity).toBe('sensor.k1c_used_material_length_2');
    expect(second.print_progress_entity).toBe('sensor.k1c_print_progress_2');
    expect(second.ams_units[0].trays.map(t => t.entity_id)).toEqual(['sensor.k1c_cfs_box_1_slot_1_filament_2']);
  });
});
