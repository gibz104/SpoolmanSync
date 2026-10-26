import prisma from '@/lib/db';
import { SpoolmanClient, Spool } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { spoolEvents, ALERT_UPDATED } from '@/lib/events';
import { processGlobal } from '@/lib/process-global';

export type ThresholdType = 'percentage' | 'grams';
export type GroupingStrategy = 'material' | 'material_name' | 'material_name_vendor';

export interface AlertConfig {
  enabled: boolean;
  thresholdType: ThresholdType;
  thresholdValue: number;
  groupingStrategy: GroupingStrategy;
  monitoredGroups?: string[];
}

export interface AvailableGroup {
  groupKey: string;
  groupLabel: string;
  spoolCount: number;
  color_hex?: string | null;
  material: string;
}

export interface ActiveAlert {
  groupKey: string;
  groupLabel: string;
  material: string;
  color_hex?: string | null;
  vendor?: string | null;
  filament_name?: string | null;
  spoolCount: number;
  belowThreshold: number;
  lowestRemaining: number;
  lowestPercentage: number;
  timestamp: number;
}

const DEFAULT_CONFIG: AlertConfig = {
  enabled: false,
  thresholdType: 'percentage',
  thresholdValue: 10,
  groupingStrategy: 'material',
};

const SETTINGS_KEY_CONFIG = 'alert_config';
const SETTINGS_KEY_ALERTS = 'active_alerts';
const HA_NOTIFICATION_PREFIX = 'spoolmansync_low_filament_';

export async function getAlertConfig(): Promise<AlertConfig> {
  const setting = await prisma.settings.findUnique({ where: { key: SETTINGS_KEY_CONFIG } });
  if (!setting) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(setting.value) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveAlertConfig(config: AlertConfig): Promise<void> {
  await prisma.settings.upsert({
    where: { key: SETTINGS_KEY_CONFIG },
    update: { value: JSON.stringify(config) },
    create: { key: SETTINGS_KEY_CONFIG, value: JSON.stringify(config) },
  });
}

export async function getActiveAlerts(): Promise<ActiveAlert[]> {
  const setting = await prisma.settings.findUnique({ where: { key: SETTINGS_KEY_ALERTS } });
  if (!setting) return [];
  try {
    const parsed = JSON.parse(setting.value);
    // Stored value must be an array of alerts; anything else is corrupt.
    if (!Array.isArray(parsed)) return [];
    return parsed as ActiveAlert[];
  } catch {
    return [];
  }
}

async function saveActiveAlerts(alerts: ActiveAlert[]): Promise<void> {
  await prisma.settings.upsert({
    where: { key: SETTINGS_KEY_ALERTS },
    update: { value: JSON.stringify(alerts) },
    create: { key: SETTINGS_KEY_ALERTS, value: JSON.stringify(alerts) },
  });
}

export function buildGroupKey(spool: Spool, strategy: GroupingStrategy): string {
  const material = (spool.filament.material || 'unknown').toLowerCase();
  switch (strategy) {
    case 'material':
      return `material:${material}`;
    case 'material_name': {
      const name = (spool.filament.name || 'unknown').toLowerCase();
      return `material_name:${material}:${name}`;
    }
    case 'material_name_vendor': {
      const name = (spool.filament.name || 'unknown').toLowerCase();
      const vendor = (spool.filament.vendor?.name || 'unknown').toLowerCase();
      return `material_name_vendor:${material}:${name}:${vendor}`;
    }
  }
}

export function buildGroupLabel(spool: Spool, strategy: GroupingStrategy): string {
  const material = spool.filament.material || 'Unknown';
  switch (strategy) {
    case 'material':
      return material;
    case 'material_name': {
      const name = spool.filament.name;
      return name ? `${material} - ${name}` : material;
    }
    case 'material_name_vendor': {
      const name = spool.filament.name;
      const vendor = spool.filament.vendor?.name;
      const parts = [material, name ? `- ${name}` : null, vendor ? `(${vendor})` : null].filter(Boolean);
      return parts.join(' ');
    }
  }
}

export async function getAvailableGroups(strategy: GroupingStrategy): Promise<AvailableGroup[]> {
  const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
  if (!spoolmanConnection) return [];

  const client = new SpoolmanClient(spoolmanConnection.url);
  const allSpools = await client.getSpools();
  const spools = allSpools.filter(s => !s.archived);

  const groups = new Map<string, { label: string; spools: Spool[] }>();
  for (const spool of spools) {
    const key = buildGroupKey(spool, strategy);
    if (!groups.has(key)) {
      groups.set(key, { label: buildGroupLabel(spool, strategy), spools: [] });
    }
    groups.get(key)!.spools.push(spool);
  }

  const result: AvailableGroup[] = [];
  for (const [groupKey, group] of groups) {
    const representative = group.spools[0];
    result.push({
      groupKey,
      groupLabel: group.label,
      spoolCount: group.spools.length,
      color_hex: representative.filament.color_hex,
      material: representative.filament.material || 'Unknown',
    });
  }

  return result.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel));
}

function isSpoolBelowThreshold(spool: Spool, config: AlertConfig): boolean {
  if (config.thresholdType === 'grams') {
    return spool.remaining_weight <= config.thresholdValue;
  }
  // Percentage mode
  if (!spool.initial_weight || spool.initial_weight <= 0) {
    // Can't calculate percentage without initial weight — skip this spool
    return false;
  }
  const percentage = (spool.remaining_weight / spool.initial_weight) * 100;
  return percentage <= config.thresholdValue;
}

function sanitizeForNotificationId(key: string): string {
  return key.replace(/[^a-z0-9_]/g, '_');
}

// Serializes all alert checks. The read (getActiveAlerts) and write
// (saveActiveAlerts) are separated by external Spoolman/HA HTTP calls, so two
// concurrent runs could read the same previous state and clobber each other's
// diff. A DB transaction can't span those external calls, so we serialize at
// the module level with a promise chain. Each run waits for the previous to
// settle (success or failure) before starting. Process-global so the usage
// tracker and the route handlers share one chain.
const alertChain = processGlobal('alerts', () => ({ tail: Promise.resolve() as Promise<unknown> }));

export function checkAndUpdateAlerts(): Promise<ActiveAlert[]> {
  const next = alertChain.tail.then(runCheck, runCheck);
  // Keep the chain alive regardless of this run's outcome.
  alertChain.tail = next.catch(() => {});
  return next;
}

async function runCheck(): Promise<ActiveAlert[]> {
  const config = await getAlertConfig();
  const previousAlerts = await getActiveAlerts();

  if (!config.enabled) {
    // Disabled — clear all alerts
    if (previousAlerts.length > 0) {
      await saveActiveAlerts([]);
      spoolEvents.emit(ALERT_UPDATED, []);
      // Dismiss all HA notifications
      await dismissHANotifications(previousAlerts);
      await createActivityLog({
        type: 'alerts_cleared',
        message: 'Low filament alerts disabled, cleared all alerts',
      });
    }
    return [];
  }

  // Fetch all non-archived spools
  const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
  if (!spoolmanConnection) return previousAlerts;

  const client = new SpoolmanClient(spoolmanConnection.url);
  const allSpools = await client.getSpools();
  const spools = allSpools.filter(s => !s.archived);

  // Group spools by strategy
  const groups = new Map<string, { label: string; spools: Spool[] }>();
  for (const spool of spools) {
    const key = buildGroupKey(spool, config.groupingStrategy);
    if (!groups.has(key)) {
      groups.set(key, { label: buildGroupLabel(spool, config.groupingStrategy), spools: [] });
    }
    groups.get(key)!.spools.push(spool);
  }

  // Filter to monitored groups if configured
  const monitoredSet = config.monitoredGroups && config.monitoredGroups.length > 0
    ? new Set(config.monitoredGroups)
    : null;

  // Check each group — alert when only one spool remains and it's below threshold
  const newAlerts: ActiveAlert[] = [];
  for (const [groupKey, group] of groups) {
    if (monitoredSet && !monitoredSet.has(groupKey)) continue;
    if (group.spools.length === 1 && isSpoolBelowThreshold(group.spools[0], config)) {
      const lowestSpool = group.spools[0];
      const lowestPercentage = lowestSpool.initial_weight > 0
        ? (lowestSpool.remaining_weight / lowestSpool.initial_weight) * 100
        : 0;

      newAlerts.push({
        groupKey,
        groupLabel: group.label,
        material: lowestSpool.filament.material || 'Unknown',
        color_hex: lowestSpool.filament.color_hex,
        vendor: lowestSpool.filament.vendor?.name,
        filament_name: lowestSpool.filament.name,
        spoolCount: 1,
        belowThreshold: 1,
        lowestRemaining: Math.round(lowestSpool.remaining_weight * 10) / 10,
        lowestPercentage: Math.round(lowestPercentage * 10) / 10,
        timestamp: Date.now(),
      });
    }
  }

  // Diff: find new and resolved alerts
  const previousKeys = new Set(previousAlerts.map(a => a.groupKey));
  const newKeys = new Set(newAlerts.map(a => a.groupKey));
  const addedAlerts = newAlerts.filter(a => !previousKeys.has(a.groupKey));
  const resolvedAlerts = previousAlerts.filter(a => !newKeys.has(a.groupKey));

  // Send HA notifications for new alerts, dismiss resolved ones
  await sendHANotifications(addedAlerts);
  await dismissHANotifications(resolvedAlerts);

  // Save and emit
  await saveActiveAlerts(newAlerts);
  spoolEvents.emit(ALERT_UPDATED, newAlerts);

  // Log changes
  if (addedAlerts.length > 0) {
    await createActivityLog({
      type: 'low_filament_alert',
      message: `Low filament alert: ${addedAlerts.map(a => a.groupLabel).join(', ')}`,
      details: { alerts: addedAlerts.map(a => ({ group: a.groupLabel, remaining: a.lowestRemaining })) },
    });
  }
  if (resolvedAlerts.length > 0) {
    await createActivityLog({
      type: 'alert_resolved',
      message: `Filament alert resolved: ${resolvedAlerts.map(a => a.groupLabel).join(', ')}`,
      details: { resolved: resolvedAlerts.map(a => a.groupLabel) },
    });
  }

  return newAlerts;
}

async function sendHANotifications(alerts: ActiveAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  try {
    const ha = await HomeAssistantClient.fromConnection();
    if (!ha) return;

    for (const alert of alerts) {
      const notificationId = `${HA_NOTIFICATION_PREFIX}${sanitizeForNotificationId(alert.groupKey)}`;
      const remaining = alert.lowestPercentage > 0
        ? `${alert.lowestRemaining}g (${alert.lowestPercentage}%)`
        : `${alert.lowestRemaining}g`;
      const message = `Your last ${alert.groupLabel} spool has ${remaining} remaining. Time to reorder!`;

      await ha.callService('persistent_notification', 'create', {
        title: `Low Filament: ${alert.groupLabel}`,
        message,
        notification_id: notificationId,
      });
    }
  } catch (err) {
    console.error('Failed to send HA notifications:', err);
  }
}

async function dismissHANotifications(alerts: ActiveAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  try {
    const ha = await HomeAssistantClient.fromConnection();
    if (!ha) return;

    for (const alert of alerts) {
      const notificationId = `${HA_NOTIFICATION_PREFIX}${sanitizeForNotificationId(alert.groupKey)}`;
      await ha.callService('persistent_notification', 'dismiss', {
        notification_id: notificationId,
      });
    }
  } catch (err) {
    console.error('Failed to dismiss HA notifications:', err);
  }
}
