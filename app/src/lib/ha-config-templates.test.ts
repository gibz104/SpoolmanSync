import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateHAConfig } from './ha-config-generator';
import type { HAPrinter } from './api/homeassistant';

/**
 * Structural guards on the generated Jinja templates.
 *
 * Home Assistant only surfaces an undefined template variable at RUNTIME, as a
 * logged error on a template that then renders empty — so a renamed automation
 * variable (or a rest_command placeholder no caller supplies) silently disables
 * tracking with nothing failing at config-check time. These walk the generated
 * YAML instead of asserting on strings, so they keep holding as the templates
 * are edited.
 */

const bambu: HAPrinter = {
  brand: 'bambu_lab', entity_id: 'sensor.x1c_print_status', name: 'X1C', state: 'idle', prefix: 'x1c',
  ams_units: [{ entity_id: 'sensor.x1c_ams_1', name: 'AMS 1', ams_number: 1, trays: [
    { entity_id: 'sensor.x1c_ams_1_tray_1', unique_id: 'u1', tray_number: 1 }] }],
  external_spools: [{ entity_id: 'sensor.x1c_ext', unique_id: 'ue', tray_number: 0, is_external: true }],
  current_stage_entity: 'sensor.x1c_stage', print_weight_entity: 'sensor.x1c_w', print_progress_entity: 'sensor.x1c_p',
};

const cfs: HAPrinter = {
  brand: 'creality', entity_id: 'sensor.k2_print_status', name: 'K2', state: 'idle', prefix: 'k2',
  ams_units: [{ entity_id: 'sensor.k2_cfs_1', name: 'CFS 1', ams_number: 1, trays: [
    { entity_id: 'sensor.k2_cfs_1_slot_1', unique_id: 'k1', tray_number: 1 },
    { entity_id: 'sensor.k2_cfs_1_slot_2', unique_id: 'k2s', tray_number: 2 }] }],
  external_spools: [{ entity_id: 'sensor.k2_ext', unique_id: 'ke', tray_number: 0, is_external: true }],
  current_stage_entity: 'sensor.k2_print_status', print_progress_entity: 'sensor.k2_pp', used_material_entity: 'sensor.k2_uml',
};

/** Single-spool Creality (#68): no AMS units at all. */
const crealityExternalOnly: HAPrinter = { ...cfs, prefix: 'ender', name: 'Ender', ams_units: [] };

/** Discovery found no print-stage entity, so triggers/branches are omitted. */
const bambuNoStage: HAPrinter = { ...bambu, prefix: 'x1c_nostage', current_stage_entity: undefined };

const PRINTERS: Array<[string, HAPrinter]> = [
  ['bambu', bambu],
  ['bambu without a stage entity', bambuNoStage],
  ['creality cfs', cfs],
  ['creality external-only', crealityExternalOnly],
];

/** Names that are legitimately unqualified inside an HA Jinja template. */
const BUILTINS = new Set([
  'trigger', 'states', 'state_attr', 'now', 'none', 'true', 'false', 'float', 'int',
  'default', 'is_defined', 'as_timestamp', 'this', 'repeat', 'wait', 'range', 'iif',
  'has_value', 'is_number', 'expand',
]);

/** Every bare identifier a template opens with, e.g. `{{ tray_uuid }}` or `{% if old_tray %}`. */
function templateRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/\{\{-?\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.add(m[1]);
    for (const m of node.matchAll(/\{%-?\s*(?:if|elif)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.add(m[1]);
  } else if (Array.isArray(node)) {
    node.forEach(n => templateRefs(n, out));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(n => templateRefs(n, out));
  }
  return out;
}

type Automation = {
  id: string;
  variables?: Record<string, string>;
  triggers?: unknown;
  conditions?: unknown;
  actions?: unknown;
};

describe('generated automations', () => {
  it.each(PRINTERS)('%s: every variable a template references is declared', (_label, printer) => {
    const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
    const automations = parseYaml(automationsYaml) as Automation[];
    expect(automations.length).toBeGreaterThan(0);

    for (const automation of automations) {
      const declared = new Set(Object.keys(automation.variables ?? {}));
      // Variables reference each other, so the whole body is in scope.
      const referenced = templateRefs([
        automation.variables, automation.triggers, automation.conditions, automation.actions,
      ]);
      const undeclared = [...referenced].filter(r => !declared.has(r) && !BUILTINS.has(r));
      expect(undeclared, `${automation.id}`).toEqual([]);
    }
  });

  it.each(PRINTERS)('%s: every rest_command placeholder is supplied or defaulted', (_label, printer) => {
    const { automationsYaml, configurationAdditions } = generateHAConfig([printer], 'http://hook', 'http://hook');
    const config = parseYaml(configurationAdditions) as { rest_command: Record<string, { payload: string }> };

    // Each rest_command call site, with the data keys it actually passes.
    const callSites: Array<{ command: string; supplied: Set<string> }> = [];
    (function walk(node: unknown) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.action === 'string' && record.action.startsWith('rest_command.')) {
        callSites.push({
          command: record.action.slice('rest_command.'.length),
          supplied: new Set(Object.keys((record.data ?? {}) as object)),
        });
      }
      Object.values(record).forEach(walk);
    })(parseYaml(automationsYaml));
    expect(callSites.length).toBeGreaterThan(0);

    for (const { command, supplied } of callSites) {
      const payload = config.rest_command[command].payload;
      const required = [...templateRefs(payload)].filter(placeholder =>
        !BUILTINS.has(placeholder)
        // `| default(...)` makes a placeholder optional — Bambu deliberately
        // omits filament_used_length, and Creality omits filament_used_weight.
        && !new RegExp(`\\{\\{\\s*${placeholder}\\s*\\|\\s*default\\(`).test(payload)
      );
      const missing = required.filter(p => !supplied.has(p));
      expect(missing, `${printer.prefix} / ${command}`).toEqual([]);
    }
  });
});
