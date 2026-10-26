/**
 * Entities the YAML usage tracking of earlier versions created in Home
 * Assistant. Once that YAML is gone they stay in HA's entity registry as
 * unavailable "restored" entries that look like something to repair, so they
 * are removed. Only orphans are touched: while the old YAML is still loaded
 * the entities are live and left alone.
 */
import type { HomeAssistantClient } from '@/lib/api/homeassistant';

const LEGACY: Array<[platform: string, uniqueId: RegExp]> = [
  ['automation', /^spoolmansync_(?:update_spool|tray_change)_\w+$/],
  ['input_number', /^spoolmansync_\w+_last_tray$/],
  ['template', /^spoolmansync-.+-(?:filament-usage|active-tray)$/],
  ['utility_meter', /^spoolmansync-.+-filament-usage-meter/],
];

/** Returns the entity ids removed. */
export async function removeLegacyEntities(ha: HomeAssistantClient): Promise<string[]> {
  const orphans = new Set((await ha.getStates())
    .filter(s => s.attributes?.restored === true && s.entity_id.includes('spoolmansync'))
    .map(s => s.entity_id));
  if (orphans.size === 0) return [];
  const { entities } = await ha.getEntityAndDeviceRegistry();
  const ids = entities
    .filter(e => orphans.has(e.entity_id) && LEGACY.some(([platform, uid]) => e.platform === platform && uid.test(e.unique_id)))
    .map(e => e.entity_id);
  await ha.removeRegistryEntities(ids);
  return ids;
}
