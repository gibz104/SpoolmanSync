import { describe, it, expect } from 'vitest';
import type { HomeAssistantClient } from '@/lib/api/homeassistant';
import { removeLegacyEntities } from './legacy-cleanup';

/** Registry rows as HA lists them, measured against a real instance. */
const registry = [
  { entity_id: 'automation.spoolmansync_update_spool_x1c', platform: 'automation', unique_id: 'spoolmansync_update_spool_x1c' },
  { entity_id: 'automation.spoolmansync_tray_change_x1c', platform: 'automation', unique_id: 'spoolmansync_tray_change_x1c' },
  { entity_id: 'input_number.spoolmansync_x1c_last_tray', platform: 'input_number', unique_id: 'spoolmansync_x1c_last_tray' },
  { entity_id: 'sensor.spoolmansync_x1c_filament_usage', platform: 'template', unique_id: 'spoolmansync-x1c-filament-usage' },
  { entity_id: 'sensor.spoolmansync_x1c_active_tray', platform: 'template', unique_id: 'spoolmansync-x1c-active-tray' },
  { entity_id: 'sensor.spoolmansync_x1c_filament_usage_meter', platform: 'utility_meter', unique_id: 'spoolmansync-x1c-filament-usage-meter_single_tariff' },
  // The user's own, named after us.
  { entity_id: 'sensor.spoolmansync_my_dashboard_total', platform: 'template', unique_id: 'my-dashboard-total' },
  { entity_id: 'automation.spoolmansync_notify_me', platform: 'automation', unique_id: 'spoolmansync_notify_me' },
];

function fakeHA(restored: string[]) {
  const removed: string[] = [];
  const ha = {
    getStates: async () => registry.map(r => ({
      entity_id: r.entity_id, state: restored.includes(r.entity_id) ? 'unavailable' : 'on',
      attributes: restored.includes(r.entity_id) ? { restored: true } : {}, last_changed: '', last_updated: '',
    })),
    getEntityAndDeviceRegistry: async () => ({ entities: registry, devices: [] }),
    removeRegistryEntities: async (ids: string[]) => { removed.push(...ids); },
  };
  return { ha: ha as unknown as HomeAssistantClient, removed };
}

describe('removeLegacyEntities', () => {
  it('removes the orphaned helpers, sensors, meter and automations the old YAML created', async () => {
    const { ha, removed } = fakeHA(registry.map(r => r.entity_id));
    expect(await removeLegacyEntities(ha)).toEqual(registry.slice(0, 6).map(r => r.entity_id));
    expect(removed).toHaveLength(6);
  });

  it('leaves them alone while the old YAML is still loaded', async () => {
    const { ha, removed } = fakeHA([]);
    expect(await removeLegacyEntities(ha)).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('never removes the user\'s own entities, even orphaned ones named after SpoolmanSync', async () => {
    const { ha } = fakeHA(['sensor.spoolmansync_my_dashboard_total', 'automation.spoolmansync_notify_me']);
    expect(await removeLegacyEntities(ha)).toEqual([]);
  });
});
