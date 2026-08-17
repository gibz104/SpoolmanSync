/**
 * Home Assistant Configuration Generator for SpoolmanSync
 *
 * Generates automations.yaml and configuration.yaml additions
 * for automatic spool tracking with Bambu Lab and Creality printers.
 *
 * Supports multiple AMS/CFS units per printer.
 */

import { HAPrinter } from './api/homeassistant';

/**
 * A printer-level entity SpoolmanSync needs but could not find in HA.
 * Surfaced to the caller (and on to the UI / activity log) rather than only
 * warned to stdout — a missing `print_weight` silently disables all weight
 * deduction for that printer, which is otherwise indistinguishable from
 * "everything is configured and nothing is printing".
 */
export interface MissingEntityReport {
  prefix: string;
  name: string;
  /** Translation keys we looked for, e.g. ['print_weight', 'print_progress']. */
  missing: string[];
  /** True when the miss disables filament-usage deduction entirely. */
  breaksUsageTracking: boolean;
}

export interface GeneratedConfig {
  automationsYaml: string;
  configurationAdditions: string;
  printerCount: number;
  trayCount: number;
  missingEntities: MissingEntityReport[];
}

/**
 * Tray info extracted from printer discovery
 */
interface TrayInfo {
  entityId: string;
  amsNumber: number;  // 0 for external spool, 1+ for AMS units
  trayNumber: number; // 0 for external, 1-4 for AMS trays
  compositeId: number; // Encoded as amsNumber * 10 + trayNumber (0 for external, 11-14 for AMS1, 21-24 for AMS2, etc.)
}

/**
 * Per-printer config collected during discovery
 */
interface PrinterConfig {
  brand: 'bambu_lab' | 'creality';
  prefix: string;
  name: string;
  allTrays: TrayInfo[];
  discoveredEntities: LocalizedEntities;
}

/**
 * Generate complete HA configuration for SpoolmanSync
 */
export function generateHAConfig(
  printers: HAPrinter[],
  webhookUrl: string,
  spoolmanUrl: string,
  webhookSecret: string = ''
): GeneratedConfig {
  if (printers.length === 0) {
    return {
      automationsYaml: '[]',
      configurationAdditions: '',
      printerCount: 0,
      trayCount: 0,
      missingEntities: [],
    };
  }

  // Process each printer
  const printerConfigs: PrinterConfig[] = [];
  const automationsYamlParts: string[] = [];
  const missingEntityReports: MissingEntityReport[] = [];
  let totalTrayCount = 0;

  for (const printer of printers) {
    const prefix = printer.prefix;

    // A printer with no trays at all has nothing to track, and generating for it
    // emits triggers with an empty entity_id list — which Home Assistant rejects,
    // taking the other printers' automations in the same file down with it.
    // discoverPrinters() synthesizes a slot for single-spool printers (#68) so
    // this should be unreachable; guard anyway rather than emit invalid YAML.
    if (collectTrays(printer).length === 0) {
      console.warn(`[SpoolmanSync] Printer ${prefix} has no AMS trays or external spools; skipping config generation for it.`);
      missingEntityReports.push({
        prefix,
        name: printer.name,
        missing: ['tray/external spool entities'],
        breaksUsageTracking: true,
      });
      continue;
    }

    if (printer.brand === 'creality') {
      // Creality printer — different entity structure
      const missingEntities: string[] = [];
      if (!printer.used_material_entity) {
        missingEntities.push('used_material_length');
        console.warn(`[SpoolmanSync] Could not find used_material_length entity for Creality printer ${prefix}. Filament usage tracking may not work.`);
      }
      if (!printer.print_progress_entity) {
        missingEntities.push('print_progress');
        console.warn(`[SpoolmanSync] Could not find print_progress entity for Creality printer ${prefix}.`);
      }
      if (missingEntities.length > 0) {
        console.warn(`[SpoolmanSync] Missing entities for ${prefix}: ${missingEntities.join(', ')}. Please report at https://github.com/gibz104/SpoolmanSync/issues`);
        missingEntityReports.push({
          prefix,
          name: printer.name,
          missing: missingEntities,
          breaksUsageTracking: !printer.used_material_entity,
        });
      }

      const discoveredEntities: LocalizedEntities = {
        current_stage: printer.entity_id, // Creality uses print_status for completion
        print_weight: '', // Creality doesn't have print_weight
        print_progress: printer.print_progress_entity || '',
        used_material_length: printer.used_material_entity || '',
        external_spools: printer.external_spools.map(es => es.entity_id),
      };

      const allTrays = collectTrays(printer);
      totalTrayCount += allTrays.length;
      printerConfigs.push({ brand: 'creality', prefix, name: printer.name, allTrays, discoveredEntities });
      automationsYamlParts.push(generateCrealityAutomationsYaml(prefix, allTrays, webhookUrl, discoveredEntities));
    } else {
      // Bambu Lab printer — original logic
      const missingEntities: string[] = [];
      if (!printer.current_stage_entity) {
        missingEntities.push('current_stage');
        console.warn(`[SpoolmanSync] Could not find current_stage entity for printer ${prefix}. Automation triggers may not work.`);
      }
      if (!printer.print_weight_entity) {
        missingEntities.push('print_weight');
        console.warn(`[SpoolmanSync] Could not find print_weight entity for printer ${prefix}. Filament usage tracking may not work.`);
      }
      if (!printer.print_progress_entity) {
        missingEntities.push('print_progress');
        console.warn(`[SpoolmanSync] Could not find print_progress entity for printer ${prefix}. Filament usage tracking may not work.`);
      }
      if (missingEntities.length > 0) {
        console.warn(`[SpoolmanSync] Missing entities for ${prefix}: ${missingEntities.join(', ')}. Please report at https://github.com/gibz104/SpoolmanSync/issues`);
        missingEntityReports.push({
          prefix,
          name: printer.name,
          missing: missingEntities,
          // Usage is print_weight × print_progress — either one missing means
          // no weight can ever be computed, so nothing is ever deducted.
          breaksUsageTracking: !printer.print_weight_entity || !printer.print_progress_entity,
        });
      }

      const discoveredEntities: LocalizedEntities = {
        current_stage: printer.current_stage_entity || '',
        print_weight: printer.print_weight_entity || '',
        print_progress: printer.print_progress_entity || '',
        external_spools: printer.external_spools.map(es => es.entity_id),
      };

      const allTrays = collectTrays(printer);
      totalTrayCount += allTrays.length;
      printerConfigs.push({ brand: 'bambu_lab', prefix, name: printer.name, allTrays, discoveredEntities });
      automationsYamlParts.push(generateAutomationsYaml(prefix, allTrays, webhookUrl, discoveredEntities));
    }
  }

  const automationsYaml = automationsYamlParts.join('\n');
  const configurationAdditions = generateConfigurationAdditions(printerConfigs, spoolmanUrl, webhookSecret);

  return {
    automationsYaml,
    configurationAdditions,
    // Printers actually configured — differs from printers.length only when one
    // was skipped above for having no trays.
    printerCount: printerConfigs.length,
    trayCount: totalTrayCount,
    missingEntities: missingEntityReports,
  };
}

/**
 * Build Jinja2 template to find active tray entity ID from composite tray number
 * Returns the full entity ID based on the composite number
 */
function buildTrayEntityLookup(allTrays: TrayInfo[]): string {
  // Build a Jinja2 conditional that maps composite ID to entity ID
  const conditions: string[] = [];

  for (const tray of allTrays) {
    conditions.push(`{% if tray_composite == ${tray.compositeId} %}${tray.entityId}{% endif %}`);
  }

  // Join with elif logic - but since Jinja doesn't have elif in this form, we use nested ifs
  // Actually, we can output all and only one will match
  return conditions.join('');
}

/**
 * Collect all trays from a printer's AMS/CFS units and external spools
 */
function collectTrays(printer: HAPrinter): TrayInfo[] {
  const allTrays: TrayInfo[] = [];

  // External spools: compositeId 0, 1, 2, ... (backward compatible — first is 0)
  for (let i = 0; i < printer.external_spools.length; i++) {
    allTrays.push({
      entityId: printer.external_spools[i].entity_id,
      amsNumber: 0,
      trayNumber: 0,
      compositeId: i,
    });
  }

  for (const ams of printer.ams_units) {
    const amsNumber = ams.ams_number;
    for (const tray of ams.trays) {
      allTrays.push({
        entityId: tray.entity_id,
        amsNumber,
        trayNumber: tray.tray_number,
        compositeId: amsNumber * 10 + tray.tray_number,
      });
    }
  }

  return allTrays;
}

/**
 * Entity references for automation generation
 */
interface LocalizedEntities {
  current_stage: string;
  print_weight: string;
  print_progress: string;
  used_material_length?: string;  // Creality only (cm)
  external_spools: string[];
}

/**
 * Generate automations.yaml content
 * Supports multiple AMS units
 */
function generateAutomationsYaml(
  prefix: string,
  allTrays: TrayInfo[],
  webhookUrl: string,
  entities: LocalizedEntities
): string {
  // Build list of all tray entity IDs for triggers
  const trayEntityIds = allTrays.map(t => t.entityId);

  // Build the tray_sensor lookup template
  const trayEntityLookup = buildTrayEntityLookup(allTrays);

  // Print-end / offline triggers depend on the printer's stage entity. If it
  // wasn't discovered, emitting `entity_id:` with nothing after it produces an
  // invalid trigger and Home Assistant refuses to load the WHOLE automation —
  // taking tray-change tracking down with it. Omit them instead: the automation
  // still loads and tray-change flushes keep working.
  const printerStateTriggers = entities.current_stage
    ? `
    - entity_id: ${entities.current_stage}
      to:
        - finished
        - idle
      id: print_end
      trigger: state
    - entity_id: ${entities.current_stage}
      to:
        - offline
      # Only treat a SUSTAINED offline as a power-off. Brief MQTT flickers (e.g.
      # Panda Touch competing for the printer's client slots) bounce the stage
      # through offline for seconds; zeroing the usage meter on every such blip
      # silently discarded the filament tracked so far, so a print's deduction
      # shrank to only what accrued after the last flicker (#75). The for-timer
      # restarts on any bounce, so flickers never fire this trigger, while a
      # real power-off still resets the meter (#66).
      for: "00:02:00"
      id: offline
      trigger: state`
    : `
    # NOTE: no print-stage entity was discovered for this printer, so the
    # print-end and offline triggers are omitted. Usage is then only flushed on
    # tray changes, never at print end.`;

  return `# =============================================================================
# SpoolmanSync Automation: Track Spool Usage
#
# Auto-generated by SpoolmanSync for printer: ${prefix}
# Supports ${allTrays.length} tray(s) across ${new Set(allTrays.map(t => t.amsNumber)).size} AMS unit(s)
#
# This automation tracks:
# 1. Tray changes - when the AMS switches to a different tray (or external spool)
# 2. Print completion - to log final filament usage
#
# Tray encoding: composite_id = ams_number * 10 + tray_number
# - 0 = external spool
# - 11-14 = AMS1 trays 1-4
# - 21-24 = AMS2 trays 1-4
# - etc.
# =============================================================================
- id: 'spoolmansync_update_spool_${prefix}'
  alias: SpoolmanSync - Update Spool (${prefix})
  description: Track spool usage and sync with Spoolman
  triggers:
    - entity_id: sensor.spoolmansync_${prefix}_active_tray
      id: tray
      # Ignore transient availability flickers (e.g. MQTT reconnects). A blip to
      # 'unavailable' and back is not a real tray change and must not run this
      # automation — the from-tray edge would otherwise hit the flush branch and
      # post a spurious early deduction (#69). Empty-string blips are handled
      # differently: '' is the sensor's normal idle state, so it stays
      # triggerable and the meter is preserved in the actions instead (#77).
      not_from:
        - unavailable
        - unknown
      not_to:
        - unavailable
        - unknown
      trigger: state${printerStateTriggers}
  variables:
    # For tray trigger: get the old tray composite ID (what we're switching FROM)
    old_tray: |-
      {% if trigger.id == 'tray' and trigger.from_state is not none and trigger.from_state.state not in [None, '', 'unknown', 'unavailable'] %}
        {{ trigger.from_state.state | int(-1) }}
      {% else %}
        -1
      {% endif %}
    # For tray trigger: get the new tray composite ID (what we're switching TO)
    new_tray: |-
      {% if trigger.id == 'tray' and trigger.to_state is not none and trigger.to_state.state not in [None, '', 'unknown', 'unavailable'] %}
        {{ trigger.to_state.state | int(-1) }}
      {% else %}
        -1
      {% endif %}
    # Last tray this automation knew was in use. The active-tray sensor renders
    # '' whenever no tray reports active, so every blip passes through '' and
    # the from-state often names no tray (#77) — the helper is the flush target
    # for those cases.
    helper_tray: "{{ states('input_number.spoolmansync_${prefix}_last_tray') | int(-1) }}"
    # For print_end: use the helper. For tray triggers: the from-state's tray,
    # falling back to the helper when the from-state names none.
    tray_composite: |-
      {% if trigger.id == 'print_end' %}
        {{ helper_tray }}
      {% else %}
        {{ old_tray if old_tray >= 0 else helper_tray }}
      {% endif %}
    # Build sensor entity ID for the tray we're logging
    tray_sensor: "${trayEntityLookup}"
    tray_weight: "{{ states('sensor.spoolmansync_${prefix}_filament_usage_meter') | float(0) | round(2) }}"
    tray_uuid: "{{ state_attr(tray_sensor, 'tray_uuid') | default('') }}"
    material: "{{ state_attr(tray_sensor, 'type') | default('') }}"
    name: "{{ state_attr(tray_sensor, 'name') | default('') }}"
    color: "{{ state_attr(tray_sensor, 'color') | default('') }}"
  actions:
    - choose:
        # =====================================================================
        # TRAY CHANGE - Flush usage to the outgoing (or last known) tray,
        # then update the helper when a new tray is active
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'tray' }}"
          sequence:
            # Flush accumulated usage when we know which tray it belongs to:
            # - a known tray goes inactive (old_tray >= 0, the pre-#77 case), or
            # - a DIFFERENT tray becomes active after a gap (old_tray < 0 because
            #   the from-state was '' or the inactive edge was missed): flush to
            #   the last known tray (helper) before tracking the new one (#77).
            # Note: We don't check current stage because accumulated weight on the
            # utility meter represents real filament consumption that should be logged.
            # This handles cancelled prints where the user unloads filament while idle.
            - choose:
                - conditions:
                    - condition: template
                      value_template: >-
                        {{ tray_composite >= 0 and tray_weight >= 0.01 and tray_sensor != ''
                           and (old_tray >= 0 or (new_tray >= 0 and new_tray != tray_composite)) }}
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE | Old tray {{ old_tray }} -> New tray {{ new_tray }} |
                          Flush tray {{ tray_composite }} |
                          Sensor: {{ tray_sensor }} |
                          Spool: {{ name }} ({{ material }}) |
                          Weight used: {{ tray_weight }}g |
                          Spool Serial: {{ tray_uuid }}
                        level: info
                    - action: rest_command.spoolmansync_update_spool
                      data:
                        filament_name: "{{ name }}"
                        filament_material: "{{ material }}"
                        filament_tray_uuid: "{{ tray_uuid }}"
                        filament_used_weight: "{{ tray_weight }}"
                        filament_color: "{{ color }}"
                        filament_active_tray_id: "{{ tray_sensor }}"
                    - action: utility_meter.calibrate
                      target:
                        entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                      data:
                        value: "0"
                # A known tray went inactive with nothing to flush: reset so no
                # stale value accumulates (unchanged pre-#77 behavior).
                - conditions:
                    - condition: template
                      value_template: "{{ old_tray >= 0 }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE (no usage logged) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                          Weight: {{ tray_weight }}g |
                          Reason: {{ 'no weight to log' if tray_weight < 0.01 else 'tray sensor not found' }}
                        level: debug
                    - action: utility_meter.calibrate
                      target:
                        entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                      data:
                        value: "0"
              # No tray in the from-state and nothing owed to a different tray
              # (same-tray blip, or no last tray known): PRESERVE the meter.
              # Zeroing here is what silently discarded mid-print usage on
              # '' round-trips (#77, follow-up to #69).
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC TRAY CHANGE (meter preserved) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                      Weight: {{ tray_weight }}g | Last tray: {{ helper_tray }}
                    level: info
            # Update helper to the new tray composite ID (when one is active)
            - condition: template
              value_template: "{{ new_tray >= 0 }}"
            - action: input_number.set_value
              target:
                entity_id: input_number.spoolmansync_${prefix}_last_tray
              data:
                value: "{{ new_tray }}"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC HELPER UPDATED | input_number.spoolmansync_${prefix}_last_tray -> {{ new_tray }}"
                level: info

        # =====================================================================
        # PRINT END - Log final tray usage from helper
        #
        # 'offline' is deliberately NOT excluded from from_state: many printers'
        # connection blips for a few seconds right at print completion, so the
        # stage arrives at idle FROM offline and the deduction was silently
        # skipped (#75 follow-up). Power-on re-deduction (#66) is guarded
        # elsewhere: the meter is zeroed after every flush, a sustained offline
        # zeroes it too, and the usage sensor cannot re-accumulate across the
        # outage, so a boot-time print_end flushes 0g and does nothing.
        # =====================================================================
        - conditions:
            - condition: template
              value_template: >-
                {{ trigger.id == 'print_end'
                   and trigger.from_state is not none
                   and trigger.from_state.state not in ['unavailable', 'unknown', 'idle', 'finished', 'none'] }}
          sequence:
            - choose:
                - conditions:
                    - condition: template
                      value_template: "{{ tray_composite >= 0 and tray_weight >= 0.01 and tray_sensor != '' }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC PRINT END | Tray {{ tray_composite }} |
                          Sensor: {{ tray_sensor }} |
                          Spool: {{ name }} ({{ material }}) |
                          Weight used: {{ tray_weight }}g |
                          Spool Serial: {{ tray_uuid }}
                        level: info
                    - action: rest_command.spoolmansync_update_spool
                      data:
                        filament_name: "{{ name }}"
                        filament_material: "{{ material }}"
                        filament_tray_uuid: "{{ tray_uuid }}"
                        filament_used_weight: "{{ tray_weight }}"
                        filament_color: "{{ color }}"
                        filament_active_tray_id: "{{ tray_sensor }}"
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC PRINT END (skipped) | Tray: {{ tray_composite }} | Weight: {{ tray_weight }}g |
                      Reason: {{ 'no tray in helper' if tray_composite < 0 else 'no weight' }}
                    # info, not warning: with 'offline' allowed as a from_state
                    # this fires benignly on every printer power-on (meter is 0).
                    level: info
            # Always reset meter after print
            - action: utility_meter.calibrate
              target:
                entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
              data:
                value: "0"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC METER RESET after print end"
                level: info

        # =====================================================================
        # PRINTER OFFLINE - Reset meter so no phantom weight survives power-off
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'offline' }}"
          sequence:
            - action: utility_meter.calibrate
              target:
                entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
              data:
                value: "0"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC METER RESET (printer offline) | ${prefix}"
                level: info
  mode: single

# =============================================================================
# SpoolmanSync Automation: Tray Change Detection
#
# Detects physical spool changes (insert/remove) and syncs with Spoolman.
# Triggers when any AMS tray or external spool sensor changes state.
# =============================================================================
- id: 'spoolmansync_tray_change_${prefix}'
  alias: SpoolmanSync - Tray Change (${prefix})
  description: Detect physical spool changes and auto-assign/unassign in Spoolman
  triggers:
    # Trigger on any state or attribute change for tray sensors
    - entity_id:
${trayEntityIds.map(id => `        - ${id}`).join('\n')}
      trigger: state
  conditions:
    # Only trigger if the entity is actually available
    - condition: template
      value_template: "{{ trigger.to_state is not none and trigger.to_state.state not in ['unavailable', 'unknown'] }}"
    # Debounce: only trigger if tray_uuid or name actually changed between old and new state
    - condition: template
      value_template: >-
        {{ trigger.from_state is none or trigger.to_state is none or
           trigger.to_state.attributes.get('tray_uuid', '') != trigger.from_state.attributes.get('tray_uuid', '') or
           trigger.to_state.attributes.get('name', '') != trigger.from_state.attributes.get('name', '') }}
  variables:
    tray_entity_id: "{{ trigger.entity_id }}"
    tray_uuid: "{{ state_attr(trigger.entity_id, 'tray_uuid') | default('') }}"
    name: "{{ state_attr(trigger.entity_id, 'name') | default('') }}"
    material: "{{ state_attr(trigger.entity_id, 'type') | default('') }}"
    color: "{{ state_attr(trigger.entity_id, 'color') | default('') }}"
  actions:
    - action: system_log.write
      data:
        message: >-
          SPOOLMANSYNC TRAY CHANGE DETECTED | {{ tray_entity_id }} |
          Name: {{ name }} | Material: {{ material }} |
          Spool Serial: {{ tray_uuid }} | Color: {{ color }}
        level: info
    - action: rest_command.spoolmansync_tray_change
      data:
        tray_entity_id: "{{ tray_entity_id }}"
        tray_uuid: "{{ tray_uuid }}"
        name: "{{ name }}"
        material: "{{ material }}"
        color: "{{ color }}"
        current_print_state: ${entities.current_stage
          ? `"{{ states('${entities.current_stage}') }}"`
          : `"unknown"  # no print-stage entity discovered`}
  mode: queued
  max: 10
`;
}

/**
 * Generate automations.yaml content for Creality printers (ha_creality_ws)
 *
 * Key differences from Bambu:
 * - Uses print_status → completed instead of current_stage → finished
 * - Uses used_material_length (cm) instead of print_weight * progress
 * - Uses 'selected' attribute (0/1) instead of 'active' for tray detection
 * - CFS slot attributes: name, color_hex, type, rfid (vs Bambu's name, color, type, tray_uuid)
 */
function generateCrealityAutomationsYaml(
  prefix: string,
  allTrays: TrayInfo[],
  webhookUrl: string,
  entities: LocalizedEntities,
): string {
  const trayEntityIds = allTrays.map(t => t.entityId);
  const trayEntityLookup = buildTrayEntityLookup(allTrays);

  // Same guard as the Bambu generator: a trigger with a blank entity_id makes
  // Home Assistant reject the entire automation. Creality's stage entity is the
  // printer's own print_status entity, so this is defensive rather than expected.
  const printerStateTriggers = entities.current_stage
    ? `
    - entity_id: ${entities.current_stage}
      to:
        - completed
        - idle
      id: print_end
      trigger: state
    - entity_id: ${entities.current_stage}
      to:
        - 'off'
        - offline
      # Sustained offline only — brief connection flickers must not zero the
      # usage meter (#75); the for-timer restarts on any bounce.
      for: "00:02:00"
      id: offline
      trigger: state`
    : `
    # NOTE: no print-status entity was discovered for this printer, so the
    # print-end and offline triggers are omitted. Usage is then only flushed on
    # slot changes, never at print end.`;

  return `# =============================================================================
# SpoolmanSync Automation: Track Spool Usage (Creality)
#
# Auto-generated by SpoolmanSync for Creality printer: ${prefix}
# Supports ${allTrays.length} slot(s) across ${new Set(allTrays.map(t => t.amsNumber)).size} CFS box(es)
#
# Slot encoding: composite_id = box_number * 10 + slot_number
# - 0 = external spool
# - 11-14 = CFS Box 1 slots 1-4
# - 21-24 = CFS Box 2 slots 1-4
# - etc.
# =============================================================================
- id: 'spoolmansync_update_spool_${prefix}'
  alias: SpoolmanSync - Update Spool (${prefix})
  description: Track spool usage and sync with Spoolman (Creality)
  triggers:
    - entity_id: sensor.spoolmansync_${prefix}_active_tray
      id: tray
      # Ignore transient availability flickers (e.g. MQTT reconnects). A blip to
      # 'unavailable' and back is not a real tray change and must not run this
      # automation — the from-slot edge would otherwise hit the flush branch and
      # post a spurious early deduction (#69). Empty-string blips are handled
      # differently: '' is the sensor's normal idle state, so it stays
      # triggerable and the meter is preserved in the actions instead (#77).
      not_from:
        - unavailable
        - unknown
      not_to:
        - unavailable
        - unknown
      trigger: state${printerStateTriggers}
  variables:
    old_tray: |-
      {% if trigger.id == 'tray' and trigger.from_state is not none and trigger.from_state.state not in [None, '', 'unknown', 'unavailable'] %}
        {{ trigger.from_state.state | int(-1) }}
      {% else %}
        -1
      {% endif %}
    new_tray: |-
      {% if trigger.id == 'tray' and trigger.to_state is not none and trigger.to_state.state not in [None, '', 'unknown', 'unavailable'] %}
        {{ trigger.to_state.state | int(-1) }}
      {% else %}
        -1
      {% endif %}
    # Last slot this automation knew was in use — flush target when the
    # from-state names no slot (the sensor renders '' between changes, #77).
    helper_tray: "{{ states('input_number.spoolmansync_${prefix}_last_tray') | int(-1) }}"
    tray_composite: |-
      {% if trigger.id == 'print_end' %}
        {{ helper_tray }}
      {% else %}
        {{ old_tray if old_tray >= 0 else helper_tray }}
      {% endif %}
    tray_sensor: "${trayEntityLookup}"
    tray_usage_cm: "{{ states('sensor.spoolmansync_${prefix}_filament_usage_meter') | float(0) | round(2) }}"
    tray_uuid: "{{ state_attr(tray_sensor, 'rfid') | default('') }}"
    material: "{{ state_attr(tray_sensor, 'type') | default('') }}"
    name: "{{ state_attr(tray_sensor, 'name') | default('') }}"
    color: "{{ state_attr(tray_sensor, 'color_hex') | default('') }}"
  actions:
    - choose:
        # =====================================================================
        # TRAY CHANGE - Flush usage to the outgoing (or last known) tray,
        # then update the helper when a new tray is active
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'tray' }}"
          sequence:
            # Same #77 structure as the Bambu automation: flush to a known slot
            # (from-state, or the helper on cross-slot recovery), reset only on
            # a known slot going inactive with nothing to flush, and PRESERVE
            # the meter on ''-blip arrivals.
            - choose:
                - conditions:
                    - condition: template
                      value_template: >-
                        {{ tray_composite >= 0 and tray_usage_cm >= 0.01 and tray_sensor != ''
                           and (old_tray >= 0 or (new_tray >= 0 and new_tray != tray_composite)) }}
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE (Creality) | Old tray {{ old_tray }} -> New tray {{ new_tray }} |
                          Flush tray {{ tray_composite }} |
                          Sensor: {{ tray_sensor }} |
                          Spool: {{ name }} ({{ material }}) |
                          Length used: {{ tray_usage_cm }}cm |
                          RFID: {{ tray_uuid }}
                        level: info
                    - action: rest_command.spoolmansync_update_spool
                      data:
                        filament_name: "{{ name }}"
                        filament_material: "{{ material }}"
                        filament_tray_uuid: "{{ tray_uuid }}"
                        filament_used_length: "{{ tray_usage_cm }}"
                        filament_color: "{{ color }}"
                        filament_active_tray_id: "{{ tray_sensor }}"
                    - action: utility_meter.calibrate
                      target:
                        entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                      data:
                        value: "0"
                - conditions:
                    - condition: template
                      value_template: "{{ old_tray >= 0 }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE (Creality, no usage logged) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                          Length: {{ tray_usage_cm }}cm |
                          Reason: {{ 'no length to log' if tray_usage_cm < 0.01 else 'slot sensor not found' }}
                        level: debug
                    - action: utility_meter.calibrate
                      target:
                        entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                      data:
                        value: "0"
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC TRAY CHANGE (Creality, meter preserved) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                      Length: {{ tray_usage_cm }}cm | Last tray: {{ helper_tray }}
                    level: info
            - condition: template
              value_template: "{{ new_tray >= 0 }}"
            - action: input_number.set_value
              target:
                entity_id: input_number.spoolmansync_${prefix}_last_tray
              data:
                value: "{{ new_tray }}"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC HELPER UPDATED | input_number.spoolmansync_${prefix}_last_tray -> {{ new_tray }}"
                level: info

        # =====================================================================
        # PRINT END - Log final tray usage from helper
        #
        # 'off'/'offline' deliberately NOT excluded from from_state — kept in
        # step with the Bambu automation (#75 follow-up). ha_creality_ws
        # surfaces disconnects as 'unavailable' (still excluded), so this is
        # symmetry rather than a live fix; the #66 guards (meter zeroed after
        # every flush and on sustained offline) hold here identically.
        # =====================================================================
        - conditions:
            - condition: template
              value_template: >-
                {{ trigger.id == 'print_end'
                   and trigger.from_state is not none
                   and trigger.from_state.state not in ['unavailable', 'unknown', 'idle', 'completed', 'none'] }}
          sequence:
            - choose:
                - conditions:
                    - condition: template
                      value_template: "{{ tray_composite >= 0 and tray_usage_cm >= 0.01 and tray_sensor != '' }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC PRINT END (Creality) | Tray {{ tray_composite }} |
                          Sensor: {{ tray_sensor }} |
                          Spool: {{ name }} ({{ material }}) |
                          Length used: {{ tray_usage_cm }}cm |
                          RFID: {{ tray_uuid }}
                        level: info
                    - action: rest_command.spoolmansync_update_spool
                      data:
                        filament_name: "{{ name }}"
                        filament_material: "{{ material }}"
                        filament_tray_uuid: "{{ tray_uuid }}"
                        filament_used_length: "{{ tray_usage_cm }}"
                        filament_color: "{{ color }}"
                        filament_active_tray_id: "{{ tray_sensor }}"
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC PRINT END (Creality, skipped) | Tray: {{ tray_composite }} | Length: {{ tray_usage_cm }}cm |
                      Reason: {{ 'no tray in helper' if tray_composite < 0 else 'no length' }}
                    # info, not warning: fires benignly on power-on now that
                    # 'off'/'offline' are allowed as from_states.
                    level: info
            - action: utility_meter.calibrate
              target:
                entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
              data:
                value: "0"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC METER RESET after print end (Creality)"
                level: info

        # =====================================================================
        # PRINTER OFFLINE - Reset meter so no phantom weight survives power-off
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'offline' }}"
          sequence:
            - action: utility_meter.calibrate
              target:
                entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
              data:
                value: "0"
            - action: system_log.write
              data:
                message: "SPOOLMANSYNC METER RESET (printer offline) | ${prefix}"
                level: info
  mode: single

# =============================================================================
# SpoolmanSync Automation: Tray Change Detection (Creality)
#
# Detects physical spool changes (insert/remove) in CFS slots.
# Triggers when any CFS slot sensor changes state.
# =============================================================================
- id: 'spoolmansync_tray_change_${prefix}'
  alias: SpoolmanSync - Tray Change (${prefix})
  description: Detect physical spool changes in CFS and auto-assign/unassign in Spoolman
  triggers:
    - entity_id:
${trayEntityIds.map(id => `        - ${id}`).join('\n')}
      trigger: state
  conditions:
    - condition: template
      value_template: "{{ trigger.to_state is not none and trigger.to_state.state not in ['unavailable', 'unknown'] }}"
    # Debounce: only trigger if rfid or name actually changed
    - condition: template
      value_template: >-
        {{ trigger.from_state is none or trigger.to_state is none or
           trigger.to_state.attributes.get('rfid', '') != trigger.from_state.attributes.get('rfid', '') or
           trigger.to_state.attributes.get('name', '') != trigger.from_state.attributes.get('name', '') }}
  variables:
    tray_entity_id: "{{ trigger.entity_id }}"
    tray_uuid: "{{ state_attr(trigger.entity_id, 'rfid') | default('') }}"
    name: "{{ state_attr(trigger.entity_id, 'name') | default('') }}"
    material: "{{ state_attr(trigger.entity_id, 'type') | default('') }}"
    color: "{{ state_attr(trigger.entity_id, 'color_hex') | default('') }}"
  actions:
    - action: system_log.write
      data:
        message: >-
          SPOOLMANSYNC TRAY CHANGE DETECTED (Creality) | {{ tray_entity_id }} |
          Name: {{ name }} | Material: {{ material }} |
          RFID: {{ tray_uuid }} | Color: {{ color }}
        level: info
    - action: rest_command.spoolmansync_tray_change
      data:
        tray_entity_id: "{{ tray_entity_id }}"
        tray_uuid: "{{ tray_uuid }}"
        name: "{{ name }}"
        material: "{{ material }}"
        color: "{{ color }}"
        current_print_state: ${entities.current_stage
          ? `"{{ states('${entities.current_stage}') }}"`
          : `"unknown"  # no print-stage entity discovered`}
  mode: queued
  max: 10
`;
}

/**
 * Build Jinja2 template to detect active tray from all AMS/CFS units
 * Returns composite ID: 0 = external, 11-14 = AMS1/CFS1, 21-24 = AMS2/CFS2, etc.
 *
 * For Bambu: uses 'active' attribute (requires ha-bambulab 2.0.29+)
 * For Creality: uses 'selected' attribute (0/1)
 */
function buildActiveTrayDetection(allTrays: TrayInfo[], brand: 'bambu_lab' | 'creality' = 'bambu_lab'): string {
  const checks: string[] = [];

  const externalTrays = allTrays.filter(t => t.amsNumber === 0);
  const amsTrays = allTrays.filter(t => t.amsNumber > 0).sort((a, b) => a.compositeId - b.compositeId);

  // Creality uses 'selected' attribute (int 0/1), Bambu uses 'active' (bool)
  const activeCheck = brand === 'creality'
    ? `state_attr('%ENTITY%', 'selected') | int(0) == 1`
    : `state_attr('%ENTITY%', 'active') in [true, 'true', 'True']`;

  if (externalTrays.length > 0) {
    checks.push(`
          {# Check external spool(s) #}`);
    for (const ext of externalTrays) {
      checks.push(`
          {% if ${activeCheck.replace('%ENTITY%', ext.entityId)} %}
            ${ext.compositeId}
          {% endif %}`);
    }
  }

  if (amsTrays.length > 0) {
    const amsNumbers = [...new Set(amsTrays.map(t => t.amsNumber))].sort((a, b) => a - b);

    for (const amsNumber of amsNumbers) {
      const traysForAms = amsTrays.filter(t => t.amsNumber === amsNumber);
      const displayName = brand === 'creality'
        ? `CFS Box ${amsNumber}`
        : (amsNumber >= 128 ? 'AMS HT' : `AMS${amsNumber}`);
      checks.push(`
          {# Check ${displayName} ${brand === 'creality' ? 'slots' : 'trays'} #}`);

      for (const tray of traysForAms) {
        checks.push(`
          {% if ${activeCheck.replace('%ENTITY%', tray.entityId)} %}
            ${tray.compositeId}
          {% endif %}`);
      }
    }
  }

  return checks.join('');
}

/**
 * Placeholder for the filament-usage sensor when the entity it would be computed
 * from doesn't exist in Home Assistant.
 *
 * The sensor is still declared so the utility_meter's `source:` resolves and the
 * rest of the config loads unchanged, but it is permanently unavailable and says
 * why — instead of a template that silently errors on every state change.
 */
function unavailableUsageSensor(prefix: string, missing: string[]): string {
  return `      # ${prefix}: FILAMENT USAGE TRACKING IS DISABLED
      #
      # SpoolmanSync could not find this printer's ${missing.join(' / ')} entity in
      # Home Assistant, and filament usage cannot be calculated without it. This
      # sensor is intentionally unavailable so the rest of the config still loads;
      # spool assignment and tray-change detection are unaffected, but no weight
      # will be deducted from Spoolman.
      #
      # If your printer does expose an equivalent sensor, please report it at
      # https://github.com/gibz104/SpoolmanSync/issues so it can be discovered.
      - name: "SpoolmanSync ${prefix} Filament Usage"
        unique_id: spoolmansync-${prefix}-filament-usage
        state: "0"
        availability: "{{ false }}"`;
}

/**
 * Generate configuration.yaml additions for all printers
 * Aggregates entries under single YAML top-level keys (no duplicate keys)
 */
function generateConfigurationAdditions(
  printerConfigs: PrinterConfig[],
  spoolmanUrl: string,
  webhookSecret: string = ''
): string {
  const secretHeader = webhookSecret ? `\n      X-SpoolmanSync-Token: "${webhookSecret}"` : '';
  const printerList = printerConfigs.map(p => p.prefix).join(', ');
  const totalTrays = printerConfigs.reduce((sum, p) => sum + p.allTrays.length, 0);

  // Build per-printer input_number entries.
  //
  // Printers with AMS/CFS trays start the helper at -1 ("no tray known yet") so
  // a fresh install can't flush usage to composite 0 — the external spool — by
  // default (#77). External-spool-only printers must keep min 0: their
  // active-tray sensor never changes state (single constant slot, or the
  // virtual slot with no backing entity, #68), so the helper is never written
  // and 0 is the only value that lets print_end flush their one slot. Existing
  // installs are unaffected either way: input_number restores its last value
  // when it is within the new min/max range.
  const inputNumberEntries = printerConfigs.map(p => {
    const maxCompositeId = Math.max(...p.allTrays.map(t => t.compositeId), 99);
    const minValue = p.allTrays.some(t => t.amsNumber > 0) ? -1 : 0;
    return `  spoolmansync_${p.prefix}_last_tray:
    name: "SpoolmanSync ${p.prefix} Last Tray"
    min: ${minValue}
    max: ${maxCompositeId}
    step: 1`;
  }).join('\n');

  // Build per-printer utility_meter entries
  const utilityMeterEntries = printerConfigs.map(p =>
    `  spoolmansync_${p.prefix}_filament_usage_meter:
    unique_id: spoolmansync-${p.prefix}-filament-usage-meter
    source: sensor.spoolmansync_${p.prefix}_filament_usage`
  ).join('\n');

  // Build per-printer template sensor entries (filament usage + active tray)
  const templateSensorEntries = printerConfigs.map(p => {
    const activeTrayDetection = buildActiveTrayDetection(p.allTrays, p.brand);
    const availabilityEntities = p.allTrays.map(t => `'${t.entityId}'`);

    // Filament usage sensor differs by brand.
    //
    // IMPORTANT: never interpolate an empty entity_id here. When discovery can't
    // find a printer-level entity it used to yield `states('')`, which produces a
    // template that errors on every evaluation, leaves the sensor unavailable,
    // and therefore leaves the utility_meter at 0 forever — so no usage webhook
    // is ever sent, with no signal anywhere that this is what happened. We now
    // emit an explicitly-unavailable sensor that names the missing entity.
    let filamentUsageSensor: string;
    if (p.brand === 'creality') {
      // Creality: used_material_length is a running total in cm
      filamentUsageSensor = p.discoveredEntities.used_material_length
        ? `      # ${p.prefix}: Track filament usage during print (Creality - cm)
      - name: "SpoolmanSync ${p.prefix} Filament Usage"
        unique_id: spoolmansync-${p.prefix}-filament-usage
        unit_of_measurement: "cm"
        state: >
          {{ states('${p.discoveredEntities.used_material_length}') | float(0) }}
        availability: >
          {{ states('${p.discoveredEntities.used_material_length}') not in ['unknown', 'unavailable'] }}`
        : unavailableUsageSensor(p.prefix, ['used_material_length']);
    } else {
      // Bambu: calculate from print_weight * progress
      const missingForUsage = [
        !p.discoveredEntities.print_weight ? 'print_weight' : null,
        !p.discoveredEntities.print_progress ? 'print_progress' : null,
      ].filter((v): v is string => v !== null);

      filamentUsageSensor = missingForUsage.length === 0
        ? `      # ${p.prefix}: Calculate filament usage during print
      - name: "SpoolmanSync ${p.prefix} Filament Usage"
        unique_id: spoolmansync-${p.prefix}-filament-usage
        state: >
          {{ states('${p.discoveredEntities.print_weight}') | float(0) / 100 *
             states('${p.discoveredEntities.print_progress}') | float(0) }}
        # Availability must cover BOTH inputs. If print_progress flickers
        # unavailable alone, float(0) makes this a VALID 0: the utility meter
        # discards the dip but re-adds the recovery climb, over-counting usage.
        # Going unavailable instead makes the meter skip the gap cleanly (#75).
        availability: >
          {{ states('${p.discoveredEntities.print_weight}') not in ['unknown', 'unavailable']
             and states('${p.discoveredEntities.print_progress}') not in ['unknown', 'unavailable'] }}`
        : unavailableUsageSensor(p.prefix, missingForUsage);
    }

    const unitLabel = p.brand === 'creality' ? 'CFS slot' : 'AMS tray';

    return `${filamentUsageSensor}

      # ${p.prefix}: Detect active ${unitLabel} from all sensors
      - name: "SpoolmanSync ${p.prefix} Active Tray"
        unique_id: spoolmansync-${p.prefix}-active-tray
        state: >${activeTrayDetection}
        availability: >
          {{ expand([
            ${availabilityEntities.join(',\n            ')}
          ]) | rejectattr('state', 'eq', 'unavailable') | list | count > 0 }}`;
  }).join('\n\n');

  return `
# =============================================================================
# SpoolmanSync Configuration
# Auto-generated for printer(s): ${printerList}
# Supports ${totalTrays} tray(s) across ${printerConfigs.length} printer(s)
#
# Tray encoding: composite_id = ams_number * 10 + tray_number
# - 0 = external spool
# - 11-14 = AMS1 trays 1-4
# - 21-24 = AMS2 trays 1-4
# - etc.
# =============================================================================

# Helper to track last active tray per printer
input_number:
${inputNumberEntries}

# Utility meter to track filament usage per printer
utility_meter:
${utilityMeterEntries}

# REST commands to send updates to SpoolmanSync webhook
rest_command:
  spoolmansync_update_spool:
    url: "${spoolmanUrl}"
    method: POST
    headers:
      Content-Type: "application/json"${secretHeader}
    payload: >
      {
        "event": "spool_usage",
        "name": "{{ filament_name }}",
        "material": "{{ filament_material }}",
        "tray_uuid": "{{ filament_tray_uuid }}",
        "used_weight": {{ filament_used_weight | default(0) | round(2) }},
        "used_length": {{ filament_used_length | default(0) | round(2) }},
        "color": "{{ filament_color }}",
        "active_tray_id": "{{ filament_active_tray_id }}"
      }

  spoolmansync_tray_change:
    url: "${spoolmanUrl}"
    method: POST
    headers:
      Content-Type: "application/json"${secretHeader}
    payload: >
      {
        "event": "tray_change",
        "tray_entity_id": "{{ tray_entity_id }}",
        "tray_uuid": "{{ tray_uuid }}",
        "name": "{{ name }}",
        "material": "{{ material }}",
        "color": "{{ color }}",
        "current_print_state": "{{ current_print_state }}"
      }

# Template sensors for filament tracking
template:
  - sensor:
${templateSensorEntries}
`;
}

/**
 * Merge generated automations into existing automations.yaml content.
 * Finds and replaces existing SpoolmanSync automation blocks (by id prefix),
 * preserving all user-created automations.
 */
export function mergeAutomations(existingContent: string, newAutomations: string): string {
  const trimmed = existingContent.trim();

  // Empty file or empty array marker — just use our automations
  if (!trimmed || trimmed === '[]') {
    return newAutomations;
  }

  // Split content into individual automation entries.
  // Each automation starts with "- id:" at column 0.
  // The split keeps "- id:" at the start of each part (except possible preamble in part 0).
  const parts = trimmed.split(/\n(?=- id:)/);

  // Filter out SpoolmanSync automations
  const filtered = parts.filter(part => {
    return !part.match(/^- id:\s*['"]?spoolmansync_/);
  });

  // Rejoin remaining blocks
  let result = filtered.join('\n');

  // Clean up any trailing SpoolmanSync comment headers that were left
  // attached to the end of the previous block (comments precede their automation)
  result = result.replace(/\n*# ={10,}[^\n]*\n#[^\n]*SpoolmanSync[\s\S]*$/, '');

  result = result.trim();

  if (!result) {
    return newAutomations;
  }

  return result + '\n\n' + newAutomations;
}

/**
 * Merge configuration additions into existing configuration.yaml content
 */
export function mergeConfiguration(existingConfig: string, additions: string): string {
  // Check if SpoolmanSync config already exists
  if (existingConfig.includes('# SpoolmanSync Configuration')) {
    // Remove existing SpoolmanSync section and add new one
    const spoolmanSyncStart = existingConfig.indexOf('# =============================================================================\n# SpoolmanSync Configuration');
    if (spoolmanSyncStart !== -1) {
      // Find the end of the SpoolmanSync section (next major section or end of file)
      let spoolmanSyncEnd = existingConfig.length;
      const nextSection = existingConfig.indexOf('\n# ===', spoolmanSyncStart + 10);
      if (nextSection !== -1 && !existingConfig.substring(spoolmanSyncStart, nextSection).includes('SpoolmanSync')) {
        spoolmanSyncEnd = nextSection;
      }
      existingConfig = existingConfig.substring(0, spoolmanSyncStart) + existingConfig.substring(spoolmanSyncEnd);
    }
  }

  // Append the new configuration
  return existingConfig.trim() + '\n' + additions;
}

// =============================================================================
// HA Packages support for add-on mode
// =============================================================================

export interface PackagesConfig {
  style: 'none' | 'directory' | 'named';
  directoryPath?: string;       // For 'directory' style — the path from the !include_dir directive
  insertAfterLineIndex?: number; // For 'named' style — line index to insert after
  entryIndent?: string;         // For 'named' style — indentation string for entries
  hasSpoolmansync?: boolean;    // Whether a spoolmansync entry already exists
}

/**
 * Normalize lines for PARSING ONLY: strip a UTF-8 BOM from the first line and a
 * trailing \r from every line.
 *
 * Real-world configuration.yaml files are frequently CRLF (edited on Windows
 * over Samba) or carry a BOM. The parsing regexes here use `.` and `$`, neither
 * of which tolerates a trailing \r — which made an existing
 * `packages: !include_dir_named <dir>` line invisible and led auto-configure to
 * insert a DUPLICATE packages: key, silently breaking the user's setup
 * (issue #73). Indices into the returned array align 1:1 with the original
 * lines, so callers parse the normalized copy and splice into the original.
 */
function normalizeConfigLines(lines: string[]): string[] {
  return lines.map((line, i) => {
    let normalized = i === 0 && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
    if (normalized.endsWith('\r')) normalized = normalized.slice(0, -1);
    return normalized;
  });
}

/**
 * Detect how packages are configured in configuration.yaml.
 * Parses as text (not YAML) since !include directives aren't standard YAML.
 */
export function detectPackagesConfig(configContent: string): PackagesConfig {
  const lines = normalizeConfigLines(configContent.split('\n'));

  // Find the homeassistant: block and packages: line within it
  let inHomeassistant = false;
  let homeassistantIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Detect homeassistant: top-level key
    if (/^homeassistant\s*:/.test(trimmed) && (line.length - trimmed.length) === 0) {
      inHomeassistant = true;
      homeassistantIndent = 0;
      continue;
    }

    if (!inHomeassistant) continue;

    // Check if we've left the homeassistant block (same or lower indentation, non-empty, non-comment)
    const currentIndent = line.length - trimmed.length;
    if (trimmed && !trimmed.startsWith('#') && currentIndent <= homeassistantIndent) {
      inHomeassistant = false;
      continue;
    }

    // Look for packages: within homeassistant:
    const packagesMatch = trimmed.match(/^packages\s*:\s*(.*)$/);
    if (!packagesMatch) continue;

    const packagesIndent = currentIndent;
    const restOfLine = packagesMatch[1].trim();

    // Style B: !include_dir_named or !include_dir_merge_named.
    // Tolerate a trailing comment and surrounding quotes on the path — both are
    // valid in HA configs, and capturing them verbatim previously sent the
    // package file into a directory HA never loads.
    const dirMatch = restOfLine.match(/^!include_dir_(?:named|merge_named)\s+([^#]+?)\s*(?:#.*)?$/);
    if (dirMatch) {
      // Normalize the spelling: strip quotes, a leading './' and trailing
      // slashes. 'packages/', './packages' and 'packages' are the same
      // directory, and callers compare the resulting file path against other
      // paths — a cosmetic spelling difference must not defeat that.
      const directoryPath = dirMatch[1]
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      return { style: 'directory', directoryPath };
    }

    // Style C (or A with no value): named entries on subsequent lines
    // Scan forward to find entries and the end of the packages block
    let lastEntryEndIndex = i; // default: right after packages: line
    let hasSpoolmansync = false;
    // Match the indentation of the entries that actually exist — assuming
    // packagesIndent+2 misindents the inserted entry (and breaks the YAML)
    // for configs indented with 4 spaces or tabs.
    let observedEntryIndent: string | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const entryLine = lines[j];
      const entryTrimmed = entryLine.trimStart();
      const entryCurrentIndent = entryLine.length - entryTrimmed.length;

      // Skip empty lines and comments
      if (!entryTrimmed || entryTrimmed.startsWith('#')) {
        continue;
      }

      // If indentation is at or below packages level, we've left the block
      if (entryCurrentIndent <= packagesIndent) {
        break;
      }

      // This line is inside the packages block
      lastEntryEndIndex = j;
      if (observedEntryIndent === null) {
        observedEntryIndent = entryLine.slice(0, entryCurrentIndent);
      }

      // Check for existing spoolmansync entry
      if (entryTrimmed.startsWith('spoolmansync:') || entryTrimmed.startsWith('spoolmansync :')) {
        hasSpoolmansync = true;
      }
    }

    const entryIndent = observedEntryIndent ?? ' '.repeat(packagesIndent + 2);

    // If rest of line is empty and no entries found → treat as 'none' (empty packages block)
    if (!restOfLine && lastEntryEndIndex === i) {
      return { style: 'none' };
    }

    return {
      style: 'named',
      insertAfterLineIndex: lastEntryEndIndex,
      entryIndent,
      hasSpoolmansync,
    };
  }

  return { style: 'none' };
}

/** The exact directive line SpoolmanSync inserts. Also matched by the repair helper. */
export const SPOOLMANSYNC_PACKAGES_DIRECTIVE = '  packages: !include_dir_named packages';

export interface AddDirectiveResult {
  content: string;
  /** Human-readable reason the directive was NOT added; null on success. */
  conflict: string | null;
}

/**
 * Add `packages: !include_dir_named packages` under homeassistant: in configuration.yaml.
 * If homeassistant: doesn't exist, adds it at the top.
 *
 * REFUSES (returns a conflict instead of inserting) when the homeassistant:
 * block already contains a packages: key in any form, or when homeassistant: has
 * a scalar value (e.g. `homeassistant: !include x.yaml`) that a child key can't
 * be nested under. Inserting anyway used to create a duplicate packages: key;
 * YAML keeps the last one, so the SpoolmanSync package silently never loaded
 * while every check reported success (issue #73). A loud failure the user can
 * act on beats a silent misconfiguration.
 */
export function addPackagesDirective(configContent: string): AddDirectiveResult {
  const rawLines = configContent.split('\n');
  const lines = normalizeConfigLines(rawLines);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const match = trimmed.match(/^homeassistant\s*:(.*)$/);
    if (!match || (lines[i].length - trimmed.length) !== 0) continue;

    const value = match[1].replace(/#.*$/, '').trim();
    if (value) {
      return {
        content: configContent,
        conflict: `configuration.yaml has "homeassistant: ${value}" — its settings live in another file, so SpoolmanSync cannot add a packages entry under it automatically`,
      };
    }

    // Scan the homeassistant: block for an existing packages: key.
    for (let j = i + 1; j < lines.length; j++) {
      const blockTrimmed = lines[j].trimStart();
      const blockIndent = lines[j].length - blockTrimmed.length;
      if (blockTrimmed && !blockTrimmed.startsWith('#') && blockIndent === 0) break; // left the block
      if (/^packages\s*:/.test(blockTrimmed)) {
        return {
          content: configContent,
          conflict: 'configuration.yaml already has a packages: entry under homeassistant: that SpoolmanSync could not use',
        };
      }
    }

    // Insert packages directive after homeassistant: line
    rawLines.splice(i + 1, 0, SPOOLMANSYNC_PACKAGES_DIRECTIVE);
    return { content: rawLines.join('\n'), conflict: null };
  }

  // No homeassistant: key found — add it at the top
  return {
    content: `homeassistant:\n${SPOOLMANSYNC_PACKAGES_DIRECTIVE}\n\n` + configContent,
    conflict: null,
  };
}

/**
 * Repair the broken state issue #73 left behind: a SpoolmanSync-inserted
 * packages: directive sitting in the same homeassistant: block as the user's
 * own packages: line (duplicate key; YAML keeps the user's, ours never loads).
 *
 * Deliberately narrow: removes ONLY the exact literal SpoolmanSync inserts, and
 * only when at least one OTHER packages: line exists in the same block. A lone
 * packages: line is never touched, whoever wrote it.
 */
export function repairDuplicatePackagesDirective(configContent: string): { content: string; repaired: boolean } {
  const rawLines = configContent.split('\n');
  const lines = normalizeConfigLines(rawLines);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!/^homeassistant\s*:/.test(trimmed) || (lines[i].length - trimmed.length) !== 0) continue;

    const ourLineIndexes: number[] = [];
    let otherPackagesLines = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const blockTrimmed = lines[j].trimStart();
      const blockIndent = lines[j].length - blockTrimmed.length;
      if (blockTrimmed && !blockTrimmed.startsWith('#') && blockIndent === 0) break;
      if (!/^packages\s*:/.test(blockTrimmed)) continue;
      if (lines[j] === SPOOLMANSYNC_PACKAGES_DIRECTIVE) {
        ourLineIndexes.push(j);
      } else {
        otherPackagesLines++;
      }
    }

    if (ourLineIndexes.length > 0 && otherPackagesLines > 0) {
      for (let k = ourLineIndexes.length - 1; k >= 0; k--) {
        rawLines.splice(ourLineIndexes[k], 1);
      }
      return { content: rawLines.join('\n'), repaired: true };
    }
  }

  return { content: configContent, repaired: false };
}

/**
 * Add a spoolmansync package entry under an existing named packages: block.
 */
export function addPackageEntry(configContent: string, config: PackagesConfig): string {
  if (config.style !== 'named' || config.insertAfterLineIndex === undefined || !config.entryIndent) {
    return configContent;
  }

  const lines = configContent.split('\n');
  const newLine = `${config.entryIndent}spoolmansync: !include spoolmansync_package.yaml`;
  lines.splice(config.insertAfterLineIndex + 1, 0, newLine);
  return lines.join('\n');
}

/**
 * Remove any existing SpoolmanSync block from configuration.yaml.
 * Uses the existing mergeConfiguration logic with empty additions.
 */
export function stripSpoolmanSyncConfig(configContent: string): string {
  if (!configContent.includes('# SpoolmanSync Configuration')) {
    return configContent;
  }
  // mergeConfiguration with empty additions removes the old block and appends nothing meaningful
  return mergeConfiguration(configContent, '').trim() + '\n';
}

/**
 * Convert configurationAdditions output into a standalone package file.
 * Strips the leading comment block and adds a package header.
 */
export function toPackageFileContent(configurationAdditions: string): string {
  const lines = configurationAdditions.split('\n');
  let firstKeyIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('=')) {
      firstKeyIndex = i;
      break;
    }
  }

  return '# SpoolmanSync package — auto-generated, do not edit manually\n' +
    lines.slice(firstKeyIndex).join('\n');
}
