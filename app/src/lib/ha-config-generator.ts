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
      # 'unavailable' and back is not a real tray change, and must not run this
      # automation — otherwise the tray-change default branch resets the usage
      # meter mid-print and the filament tracked so far is lost (#69).
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
    # For print_end: use the helper
    tray_composite: |-
      {% if trigger.id == 'print_end' %}
        {{ states('input_number.spoolmansync_${prefix}_last_tray') | int(-1) }}
      {% else %}
        {{ old_tray }}
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
        # TRAY CHANGE - Log old tray usage (if valid), ALWAYS update helper
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'tray' }}"
          sequence:
            # Log usage from OLD tray if:
            # 1. old_tray was valid (>= 0)
            # 2. we have weight to log (>= 0.01g)
            # 3. tray_sensor resolved to a valid entity (defense-in-depth)
            # Note: We don't check current stage because accumulated weight on the
            # utility meter represents real filament consumption that should be logged.
            # This handles cancelled prints where the user unloads filament while idle.
            - choose:
                - conditions:
                    - condition: template
                      value_template: "{{ old_tray >= 0 and tray_weight >= 0.01 and tray_sensor != '' }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE | Old tray {{ old_tray }} -> New tray {{ new_tray }} |
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
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC TRAY CHANGE (no usage logged) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                      Weight: {{ tray_weight }}g |
                      Reason: {{ 'old_tray invalid' if old_tray < 0 else 'no weight to log' }}
                    level: debug
                # Reset meter anyway to prevent stale values from accumulating
                - action: utility_meter.calibrate
                  target:
                    entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                  data:
                    value: "0"
            # ALWAYS update helper to new tray composite ID
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
        # =====================================================================
        - conditions:
            - condition: template
              value_template: >-
                {{ trigger.id == 'print_end'
                   and trigger.from_state is not none
                   and trigger.from_state.state not in ['unavailable', 'unknown', 'idle', 'finished', 'offline', 'off', 'none'] }}
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
                    level: warning
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
      # 'unavailable' and back is not a real tray change, and must not run this
      # automation — otherwise the tray-change default branch resets the usage
      # meter mid-print and the filament tracked so far is lost (#69).
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
    tray_composite: |-
      {% if trigger.id == 'print_end' %}
        {{ states('input_number.spoolmansync_${prefix}_last_tray') | int(-1) }}
      {% else %}
        {{ old_tray }}
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
        # TRAY CHANGE - Log old tray usage (if valid), ALWAYS update helper
        # =====================================================================
        - conditions:
            - condition: template
              value_template: "{{ trigger.id == 'tray' }}"
          sequence:
            - choose:
                - conditions:
                    - condition: template
                      value_template: "{{ old_tray >= 0 and tray_usage_cm >= 0.01 and tray_sensor != '' }}"
                  sequence:
                    - action: system_log.write
                      data:
                        message: >-
                          SPOOLMANSYNC TRAY CHANGE (Creality) | Old tray {{ old_tray }} -> New tray {{ new_tray }} |
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
              default:
                - action: system_log.write
                  data:
                    message: >-
                      SPOOLMANSYNC TRAY CHANGE (Creality, no usage logged) | Old: {{ old_tray }} -> New: {{ new_tray }} |
                      Length: {{ tray_usage_cm }}cm |
                      Reason: {{ 'old_tray invalid' if old_tray < 0 else 'no length to log' }}
                    level: debug
                - action: utility_meter.calibrate
                  target:
                    entity_id: sensor.spoolmansync_${prefix}_filament_usage_meter
                  data:
                    value: "0"
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
        # =====================================================================
        - conditions:
            - condition: template
              value_template: >-
                {{ trigger.id == 'print_end'
                   and trigger.from_state is not none
                   and trigger.from_state.state not in ['unavailable', 'unknown', 'idle', 'completed', 'off', 'offline', 'none'] }}
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
                    level: warning
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

  // Build per-printer input_number entries
  const inputNumberEntries = printerConfigs.map(p => {
    const maxCompositeId = Math.max(...p.allTrays.map(t => t.compositeId), 99);
    return `  spoolmansync_${p.prefix}_last_tray:
    name: "SpoolmanSync ${p.prefix} Last Tray"
    min: 0
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
        availability: >
          {{ states('${p.discoveredEntities.print_weight}') not in ['unknown', 'unavailable'] }}`
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
 * Detect how packages are configured in configuration.yaml.
 * Parses as text (not YAML) since !include directives aren't standard YAML.
 */
export function detectPackagesConfig(configContent: string): PackagesConfig {
  const lines = configContent.split('\n');

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

    // Style B: !include_dir_named or !include_dir_merge_named
    const dirMatch = restOfLine.match(/^!include_dir_(?:named|merge_named)\s+(.+)$/);
    if (dirMatch) {
      return {
        style: 'directory',
        directoryPath: dirMatch[1].trim(),
      };
    }

    // Style C (or A with no value): named entries on subsequent lines
    // Scan forward to find entries and the end of the packages block
    const entryIndentLevel = packagesIndent + 2;
    const entryIndent = ' '.repeat(entryIndentLevel);
    let lastEntryEndIndex = i; // default: right after packages: line
    let hasSpoolmansync = false;

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

      // Check for existing spoolmansync entry
      if (entryTrimmed.startsWith('spoolmansync:') || entryTrimmed.startsWith('spoolmansync :')) {
        hasSpoolmansync = true;
      }
    }

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

/**
 * Add `packages: !include_dir_named packages` under homeassistant: in configuration.yaml.
 * If homeassistant: doesn't exist, adds it at the top.
 */
export function addPackagesDirective(configContent: string): string {
  const lines = configContent.split('\n');

  // Find homeassistant: line
  for (let i = 0; i < lines.length; i++) {
    if (/^homeassistant\s*:/.test(lines[i].trimStart()) && (lines[i].length - lines[i].trimStart().length) === 0) {
      // Insert packages directive after homeassistant: line
      lines.splice(i + 1, 0, '  packages: !include_dir_named packages');
      return lines.join('\n');
    }
  }

  // No homeassistant: key found — add it at the top
  return 'homeassistant:\n  packages: !include_dir_named packages\n\n' + configContent;
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
