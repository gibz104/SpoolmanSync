import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateHAConfig } from './ha-config-generator';
import type { HAPrinter } from './api/homeassistant';

function bambuPrinter(): HAPrinter {
  return {
    brand: 'bambu_lab',
    entity_id: 'sensor.x1c_print_status',
    name: 'X1C',
    state: 'idle',
    prefix: 'x1c',
    ams_units: [
      {
        entity_id: 'sensor.x1c_ams_1',
        name: 'AMS 1',
        ams_number: 1,
        trays: [
          { entity_id: 'sensor.x1c_ams_1_tray_1', unique_id: 'x1c_ams_1_tray_1', tray_number: 1 },
          { entity_id: 'sensor.x1c_ams_1_tray_2', unique_id: 'x1c_ams_1_tray_2', tray_number: 2 },
        ],
      },
    ],
    external_spools: [],
    current_stage_entity: 'sensor.x1c_current_stage',
    print_weight_entity: 'sensor.x1c_print_weight',
    print_progress_entity: 'sensor.x1c_print_progress',
  };
}

function crealityPrinter(): HAPrinter {
  return {
    brand: 'creality',
    entity_id: 'sensor.ender_print_status',
    name: 'Ender',
    state: 'idle',
    prefix: 'ender',
    ams_units: [],
    external_spools: [
      { entity_id: 'sensor.ender_cfs_external_filament', unique_id: 'ender_ext', tray_number: 0, is_external: true },
    ],
    print_progress_entity: 'sensor.ender_print_progress',
    used_material_entity: 'sensor.ender_used_material_length',
  };
}

describe('generateHAConfig — issue #66 (no re-deduction on power-on)', () => {
  // Since the #75 follow-up, 'offline'/'off' are deliberately ALLOWED as
  // print_end from_states: many printers blip offline for a few seconds right
  // at print completion, and excluding them silently skipped the deduction.
  // Power-on safety now rests on the meter guards (zeroed after every flush
  // and on sustained offline), not on this exclusion.
  it('Bambu print-end guard excludes restart noise but NOT offline', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    expect(automationsYaml).toContain("'unavailable', 'unknown', 'idle', 'finished', 'none'");
    expect(automationsYaml).not.toContain("'idle', 'finished', 'offline'");
  });

  it('Creality print-end guard excludes restart noise but NOT off/offline', () => {
    const { automationsYaml } = generateHAConfig([crealityPrinter()], 'http://hook', 'http://hook');
    expect(automationsYaml).toContain("'unavailable', 'unknown', 'idle', 'completed', 'none'");
    expect(automationsYaml).not.toContain("'completed', 'off', 'offline'");
  });

  it('adds an offline trigger + meter-reset branch (Bambu)', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    expect(automationsYaml).toContain('id: offline');
    expect(automationsYaml).toContain("trigger.id == 'offline'");
    expect(automationsYaml).toContain('SPOOLMANSYNC METER RESET (printer offline)');
    // the meter-reset must target the printer's own usage meter
    expect(automationsYaml).toContain('sensor.spoolmansync_x1c_filament_usage_meter');
  });

  it('adds an offline trigger + meter-reset branch (Creality)', () => {
    const { automationsYaml } = generateHAConfig([crealityPrinter()], 'http://hook', 'http://hook');
    expect(automationsYaml).toContain('id: offline');
    expect(automationsYaml).toContain("trigger.id == 'offline'");
    expect(automationsYaml).toContain('sensor.spoolmansync_ender_filament_usage_meter');
  });

  it('still deducts on a genuine print: printing is NOT in the exclusion list', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    // sanity: 'printing'/'running' must never be excluded or real prints stop deducting
    expect(automationsYaml).not.toContain("'printing'");
    expect(automationsYaml).not.toContain("'running'");
  });
});

describe('generateHAConfig — webhook shared secret injection', () => {
  it('injects the X-SpoolmanSync-Token header into both rest_commands when a secret is provided', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook', 'SECRET123');
    const occurrences = configurationAdditions.split('X-SpoolmanSync-Token: "SECRET123"').length - 1;
    expect(occurrences).toBe(2); // spoolmansync_update_spool + spoolmansync_tray_change
  });

  it('omits the token header entirely when no secret is provided', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    expect(configurationAdditions).not.toContain('X-SpoolmanSync-Token');
  });
});

describe('generateHAConfig — output is well-formed YAML', () => {
  it('configurationAdditions parses and has the expected top-level keys', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook', 'SECRET123');
    const parsed = parseYaml(configurationAdditions);
    expect(parsed).toHaveProperty('input_number');
    expect(parsed).toHaveProperty('utility_meter');
    expect(parsed).toHaveProperty('rest_command');
    expect(parsed).toHaveProperty('template');
    // the token must live under the rest_command headers
    expect(parsed.rest_command.spoolmansync_update_spool.headers['X-SpoolmanSync-Token']).toBe('SECRET123');
    expect(parsed.rest_command.spoolmansync_tray_change.headers['X-SpoolmanSync-Token']).toBe('SECRET123');
  });

  it('automationsYaml parses to a list of automations with the offline trigger', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml);
    expect(Array.isArray(parsed)).toBe(true);
    const updateSpool = parsed.find((a: { id: string }) => a.id === 'spoolmansync_update_spool_x1c');
    expect(updateSpool).toBeTruthy();
    const triggerIds = updateSpool.triggers.map((t: { id?: string }) => t.id);
    expect(triggerIds).toContain('tray');
    expect(triggerIds).toContain('print_end');
    expect(triggerIds).toContain('offline');
  });

  it('tray trigger ignores unavailable/unknown availability flickers (#69)', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml);
      const updateSpool = parsed.find((a: { id: string }) => a.id === `spoolmansync_update_spool_${printer.prefix}`);
      const trayTrigger = updateSpool.triggers.find((t: { id?: string }) => t.id === 'tray');
      // A mid-print MQTT blip (N -> unavailable -> N) must not run the automation,
      // which would otherwise reset the usage meter and under-count the print.
      expect(trayTrigger.not_from).toEqual(['unavailable', 'unknown']);
      expect(trayTrigger.not_to).toEqual(['unavailable', 'unknown']);
    }
  });

  it('tray trigger passes the current print state to the tray-change webhook', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml, configurationAdditions } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml);
      const trayChange = parsed.find((a: { id: string }) => a.id === `spoolmansync_tray_change_${printer.prefix}`);
      const restAction = trayChange.actions.find((a: { action?: string }) => a.action === 'rest_command.spoolmansync_tray_change');

      expect(restAction.data.current_print_state).toContain('states(');
      expect(configurationAdditions).toContain('"current_print_state": "{{ current_print_state }}"');
    }
  });

  it('returns empty config for no printers', () => {
    const cfg = generateHAConfig([], 'http://hook', 'http://hook');
    expect(cfg.automationsYaml).toBe('[]');
    expect(cfg.printerCount).toBe(0);
    expect(cfg.trayCount).toBe(0);
  });
});

describe('generateHAConfig — issue #75 (MQTT flickers must not zero the usage meter)', () => {
  it('offline trigger fires only after a sustained offline, for both brands', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml);
      const updateSpool = parsed.find((a: { id: string }) => a.id === `spoolmansync_update_spool_${printer.prefix}`);
      const offlineTrigger = updateSpool.triggers.find((t: { id?: string }) => t.id === 'offline');
      // A brief stage bounce through offline (e.g. Panda Touch MQTT slot
      // contention) used to calibrate the meter to 0 mid-print, so the print's
      // deduction shrank to only what accrued after the last flicker (#75).
      // The for-timer restarts on any bounce, so only a real power-off fires.
      expect(offlineTrigger.for).toBe('00:02:00');
    }
  });

  it('print_end trigger has no for-delay (deductions stay prompt)', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml);
    const updateSpool = parsed.find((a: { id: string }) => a.id === 'spoolmansync_update_spool_x1c');
    const printEnd = updateSpool.triggers.find((t: { id?: string }) => t.id === 'print_end');
    expect(printEnd.for).toBeUndefined();
  });

  it('Bambu usage sensor availability covers BOTH print_weight and print_progress', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    const parsed = parseYaml(configurationAdditions);
    const sensors = parsed.template[0].sensor as Array<{ name: string; availability: string }>;
    const usage = sensors.find(s => s.name === 'SpoolmanSync x1c Filament Usage')!;
    // If print_progress alone flickers unavailable, float(0) would make the
    // state a VALID 0: the meter discards the dip but re-adds the recovery
    // climb, over-counting. Unavailability makes the meter skip the gap.
    expect(usage.availability).toContain('sensor.x1c_print_weight');
    expect(usage.availability).toContain('sensor.x1c_print_progress');
  });
});

describe('generateHAConfig — issue #75 follow-up (print end arriving via offline must deduct)', () => {
  /**
   * Many printers' MQTT connection blips for a few seconds at print completion,
   * so the stage sequence is printing -> offline -> idle. The print_end guard
   * used to exclude from_state 'offline', silently skipping the deduction on
   * every such print (no log line of any kind, since the top-level choose has
   * no default). These tests pin the guard semantics by evaluating the actual
   * generated Jinja membership list.
   */
  const printEndExclusions = (yaml: string, prefix: string): string[] => {
    const parsed = parseYaml(yaml) as Array<{
      id: string;
      actions: Array<{ choose?: Array<{ conditions: Array<{ value_template: string }> }> }>;
    }>;
    const automation = parsed.find(a => a.id === `spoolmansync_update_spool_${prefix}`)!;
    const chooseAction = automation.actions.find(a => a.choose)!;
    const printEndBranch = chooseAction.choose!.find(b =>
      b.conditions[0].value_template.includes("trigger.id == 'print_end'"))!;
    const listMatch = printEndBranch.conditions[0].value_template.match(/not in \[([^\]]+)\]/)!;
    return listMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  };

  it('Bambu: offline/off are allowed from_states; restart noise stays excluded', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    const exclusions = printEndExclusions(automationsYaml, 'x1c');
    expect(exclusions).not.toContain('offline');
    expect(exclusions).not.toContain('off');
    expect(exclusions).toEqual(expect.arrayContaining(['unavailable', 'unknown', 'idle', 'finished', 'none']));
    expect(exclusions).not.toContain('printing');
  });

  it('Creality: off/offline are allowed from_states; restart noise stays excluded', () => {
    const { automationsYaml } = generateHAConfig([crealityPrinter()], 'http://hook', 'http://hook');
    const exclusions = printEndExclusions(automationsYaml, 'ender');
    expect(exclusions).not.toContain('offline');
    expect(exclusions).not.toContain('off');
    expect(exclusions).toEqual(expect.arrayContaining(['unavailable', 'unknown', 'idle', 'completed', 'none']));
  });

  it('the from_state None guard survives (restart edge)', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      expect(automationsYaml).toContain('trigger.from_state is not none');
    }
  });

  it('the power-cycle guards the exclusion relied on remain in place', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml) as Array<{ id: string; triggers: Array<{ id?: string; for?: string }> }>;
    const updateSpool = parsed.find(a => a.id === 'spoolmansync_update_spool_x1c')!;
    // Sustained-offline meter zero still guarded by the 2-minute for-timer
    expect(updateSpool.triggers.find(t => t.id === 'offline')!.for).toBe('00:02:00');
    // Meter is always reset after a print-end flush
    expect(automationsYaml).toContain('SPOOLMANSYNC METER RESET after print end');
  });

  it('the skipped-flush log stays quiet on a benign power-on, but warns if grams are lost', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml) as Array<{
        id: string;
        actions: Array<{ choose?: Array<{
          conditions: Array<{ value_template: string }>;
          sequence: Array<{ default?: Array<{ data?: { message?: string; level?: string } }> }>;
        }> }>;
      }>;
      const automation = parsed.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
      const chooseAction = automation.actions.find(a => a.choose)!;
      const printEndBranch = chooseAction.choose!.find(b =>
        b.conditions[0].value_template.includes("trigger.id == 'print_end'"))!;
      const innerDefault = printEndBranch.sequence.find(s => s.default)!.default!;
      const skippedLog = innerDefault.find(a => a.data?.message?.includes('skipped'))!;
      // Conditional, not a literal: an empty meter on power-on must stay 'info'
      // (this branch fires every time a printer is switched on), while real
      // discarded usage must be visible as a warning (#78).
      const level = skippedLog.data!.level!;
      expect(level, printer.prefix).toContain("'info'");
      expect(level, printer.prefix).toContain("'warning'");
      expect(level, printer.prefix).toMatch(/>=\s*0\.01/);
    }
  });
});

describe('generateHAConfig — issue #77 (empty-string blips must not zero the usage meter)', () => {
  // The Bambu fixture is external-only for Creality, so #77's CFS coverage
  // needs a Creality printer that actually has box slots.
  function crealityCfsPrinter(): HAPrinter {
    return {
      brand: 'creality',
      entity_id: 'sensor.k2_print_status',
      name: 'K2 Plus',
      state: 'idle',
      prefix: 'k2',
      ams_units: [
        {
          entity_id: 'sensor.k2_cfs_1',
          name: 'CFS 1',
          ams_number: 1,
          trays: [
            { entity_id: 'sensor.k2_cfs_1_slot_1', unique_id: 'k2_cfs_1_slot_1', tray_number: 1 },
            { entity_id: 'sensor.k2_cfs_1_slot_2', unique_id: 'k2_cfs_1_slot_2', tray_number: 2 },
          ],
        },
      ],
      external_spools: [],
      print_progress_entity: 'sensor.k2_print_progress',
      used_material_entity: 'sensor.k2_used_material_length',
    };
  }

  type ChooseStep = {
    choose: Array<{ conditions: Array<{ value_template: string }>; sequence: unknown[] }>;
    default: unknown[];
  };

  // The inner choose of the Update Spool automation's tray branch:
  // [flush, departure-reset] + preserve default.
  function trayBranchInnerChoose(printer: HAPrinter): ChooseStep {
    const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml) as Array<{
      id: string;
      actions: Array<{ choose: Array<{ conditions: Array<{ value_template: string }>; sequence: ChooseStep[] }> }>;
    }>;
    const updateSpool = parsed.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
    const trayBranch = updateSpool.actions[0].choose.find(b =>
      b.conditions[0].value_template.includes("trigger.id == 'tray'"))!;
    return trayBranch.sequence[0];
  }

  it('a blip arrival (no from-tray, same tray as helper) PRESERVES the meter, both brands', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter()]) {
      const inner = trayBranchInnerChoose(printer);
      // The default branch handles old_tray < 0 arrivals; it must not calibrate.
      expect(JSON.stringify(inner.default), printer.prefix).not.toContain('utility_meter.calibrate');
      expect(JSON.stringify(inner.default), printer.prefix).toContain('meter preserved');
    }
  });

  it('only a KNOWN tray going inactive still resets an unflushable meter, both brands', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter()]) {
      const inner = trayBranchInnerChoose(printer);
      const resetBranch = inner.choose[1];
      expect(resetBranch.conditions[0].value_template.trim(), printer.prefix).toBe('{{ old_tray >= 0 }}');
      expect(JSON.stringify(resetBranch.sequence), printer.prefix).toContain('utility_meter.calibrate');
    }
  });

  it('flush gate covers departures and cross-tray recoveries but not same-tray blips, both brands', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter()]) {
      const inner = trayBranchInnerChoose(printer);
      const gate = inner.choose[0].conditions[0].value_template;
      expect(gate, printer.prefix).toContain('tray_composite >= 0');
      expect(gate, printer.prefix).toContain('old_tray >= 0 or (new_tray >= 0 and new_tray != tray_composite)');
      // Flush still posts to Spoolman before the meter reset
      expect(JSON.stringify(inner.choose[0].sequence), printer.prefix).toContain('rest_command.spoolmansync_update_spool');
      expect(JSON.stringify(inner.choose[0].sequence), printer.prefix).toContain('utility_meter.calibrate');
    }
  });

  it('tray triggers fall back to the last_tray helper as the flush target', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml) as Array<{ id: string; variables: Record<string, string> }>;
      const updateSpool = parsed.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
      expect(updateSpool.variables.helper_tray, printer.prefix)
        .toContain(`input_number.spoolmansync_${printer.prefix}_last_tray`);
      expect(updateSpool.variables.tray_composite, printer.prefix)
        .toContain('old_tray if old_tray >= 0 else helper_tray');
      // helper_tray must be declared before tray_composite (variables render top-down)
      const keys = Object.keys(updateSpool.variables);
      expect(keys.indexOf('helper_tray'), printer.prefix).toBeLessThan(keys.indexOf('tray_composite'));
    }
  });

  it('last_tray helper starts at -1 for tray printers but 0 for external-spool-only printers', () => {
    const tray = parseYaml(generateHAConfig([bambuPrinter()], 'http://hook', 'http://hook').configurationAdditions);
    expect(tray.input_number.spoolmansync_x1c_last_tray.min).toBe(-1);

    const cfs = parseYaml(generateHAConfig([crealityCfsPrinter()], 'http://hook', 'http://hook').configurationAdditions);
    expect(cfs.input_number.spoolmansync_k2_last_tray.min).toBe(-1);

    // External-only printers never fire the tray branch, so the helper is never
    // written; min 0 = composite 0 is their only print_end flush path (#68).
    const ext = parseYaml(generateHAConfig([crealityPrinter()], 'http://hook', 'http://hook').configurationAdditions);
    expect(ext.input_number.spoolmansync_ender_last_tray.min).toBe(0);
  });

  it('the #69 trigger guard is unchanged (empty string deliberately NOT blocked)', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const parsed = parseYaml(automationsYaml) as Array<{ id: string; triggers: Array<{ id?: string; not_from?: string[]; not_to?: string[] }> }>;
      const updateSpool = parsed.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
      const trayTrigger = updateSpool.triggers.find(t => t.id === 'tray')!;
      expect(trayTrigger.not_from, printer.prefix).toEqual(['unavailable', 'unknown']);
      expect(trayTrigger.not_to, printer.prefix).toEqual(['unavailable', 'unknown']);
    }
  });

  it('generated automations still parse as valid YAML with the new structure', () => {
    for (const printer of [bambuPrinter(), crealityCfsPrinter(), crealityPrinter()]) {
      const { automationsYaml, configurationAdditions } = generateHAConfig([printer], 'http://hook', 'http://hook');
      expect(() => parseYaml(automationsYaml), printer.prefix).not.toThrow();
      expect(() => parseYaml(configurationAdditions), printer.prefix).not.toThrow();
    }
  });
});

/**
 * Creality's CFS `rfid` attribute is a material-type code (PLA 00001,
 * PETG 00003, ...) shared by every spool of that material, not a per-spool
 * serial. Sending it as tray_uuid made SpoolmanSync auto-assign whichever spool
 * last carried that code, and permanently flagged correct assignments as
 * "possible wrong spool". Bambu's tray_uuid IS a per-spool serial and must keep
 * flowing.
 */
describe('generateHAConfig — tray_uuid is Bambu-only', () => {
  type Automation = {
    id: string;
    variables: Record<string, string>;
    actions: unknown[];
  };

  /** A CFS printer with real slots (the external-only fixture has none). */
  function cfsPrinter(): HAPrinter {
    return {
      brand: 'creality',
      entity_id: 'sensor.k2_print_status',
      name: 'K2 Plus',
      state: 'idle',
      prefix: 'k2',
      ams_units: [
        {
          entity_id: 'sensor.k2_cfs_1',
          name: 'CFS 1',
          ams_number: 1,
          trays: [
            { entity_id: 'sensor.k2_cfs_1_slot_1', unique_id: 'k2_cfs_1_slot_1', tray_number: 1 },
            { entity_id: 'sensor.k2_cfs_1_slot_2', unique_id: 'k2_cfs_1_slot_2', tray_number: 2 },
          ],
        },
      ],
      external_spools: [],
      print_progress_entity: 'sensor.k2_print_progress',
      used_material_entity: 'sensor.k2_used_material_length',
    };
  }

  function automationsFor(printer: HAPrinter): Automation[] {
    const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
    return parseYaml(automationsYaml) as Automation[];
  }

  /** Every `data:` payload sent to a rest_command, at any nesting depth. */
  function restCommandPayloads(node: unknown): Record<string, unknown>[] {
    if (Array.isArray(node)) return node.flatMap(restCommandPayloads);
    if (node === null || typeof node !== 'object') return [];
    const record = node as Record<string, unknown>;
    const found = typeof record.action === 'string'
      && record.action.startsWith('rest_command.spoolmansync_')
      && record.data && typeof record.data === 'object'
      ? [record.data as Record<string, unknown>]
      : [];
    return [...found, ...Object.values(record).flatMap(restCommandPayloads)];
  }

  it('Creality sends an empty tray_uuid, so serial auto-matching stays off', () => {
    for (const printer of [cfsPrinter(), crealityPrinter()]) {
      const payloads = automationsFor(printer).flatMap(a => restCommandPayloads(a.actions));
      expect(payloads.length, printer.prefix).toBeGreaterThan(0);

      for (const payload of payloads) {
        const sent = 'tray_uuid' in payload ? payload.tray_uuid : payload.filament_tray_uuid;
        expect(sent, `${printer.prefix}: ${JSON.stringify(payload)}`).toBe('');
      }
    }
  });

  it('Creality still logs the material code for diagnostics', () => {
    for (const printer of [cfsPrinter(), crealityPrinter()]) {
      const automations = automationsFor(printer);
      const usesRfid = automations.filter(a => a.variables?.material_code?.includes("'rfid'"));
      expect(usesRfid.length, printer.prefix).toBeGreaterThan(0);
      // The old name must be gone: leaving it would put a material code back
      // into the webhook payload the moment someone reuses the variable.
      expect(automations.some(a => 'tray_uuid' in (a.variables ?? {})), printer.prefix).toBe(false);
    }
  });

  it('Bambu keeps sending its real per-spool serial', () => {
    const payloads = automationsFor(bambuPrinter()).flatMap(a => restCommandPayloads(a.actions));
    expect(payloads.length).toBeGreaterThan(0);

    for (const payload of payloads) {
      const sent = 'tray_uuid' in payload ? payload.tray_uuid : payload.filament_tray_uuid;
      expect(sent, JSON.stringify(payload)).toBe('{{ tray_uuid }}');
    }
  });
});

/**
 * Issue #78: the offline branch zeroed the usage meter without deducting, so a
 * network dropout longer than the 2-minute trigger delay silently destroyed
 * every gram accumulated before it (105g for the reporter, reconciled against a
 * physical weigh-in).
 *
 * The reset itself is load-bearing — it is what makes a power-on print_end find
 * an empty meter (#66) — so the fix banks the usage first rather than removing
 * it. These tests pin both halves: the flush must exist, and it must come
 * BEFORE the calibrate.
 */
describe('generateHAConfig — issue #78 (offline must deduct before resetting)', () => {
  type Action = {
    action?: string;
    data?: Record<string, unknown>;
    choose?: Array<{ conditions: Array<{ value_template: string }>; sequence: Action[] }>;
    default?: Action[];
  };
  type Automation = { id: string; actions: Array<{ choose?: Array<{ conditions: Array<{ value_template: string }>; sequence: Action[] }> }> };

  function offlineBranch(printer: HAPrinter): Action[] {
    const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml) as Automation[];
    const automation = parsed.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
    const chooseAction = automation.actions.find(a => a.choose)!;
    return chooseAction.choose!.find(b =>
      b.conditions[0].value_template.includes("trigger.id == 'offline'"))!.sequence;
  }

  /** Flattened action list in execution order, descending into choose/default. */
  function flatten(actions: Action[]): Action[] {
    return actions.flatMap(a => [
      a,
      ...(a.choose ?? []).flatMap(c => flatten(c.sequence)),
      ...flatten(a.default ?? []),
    ]);
  }

  const printers: Array<[string, HAPrinter, string]> = [
    ['bambu', bambuPrinter(), 'filament_used_weight'],
    ['creality', crealityPrinter(), 'filament_used_length'],
  ];

  it.each(printers)('%s: offline deducts the accumulated usage', (_l, printer, usageField) => {
    const flush = flatten(offlineBranch(printer)).find(a => a.action === 'rest_command.spoolmansync_update_spool');
    expect(flush, printer.prefix).toBeDefined();
    // The tray comes from the helper, so it resolves even with the printer away.
    expect(flush!.data!.filament_active_tray_id).toBe('{{ tray_sensor }}');
    expect(flush!.data![usageField]).toBeTruthy();
  });

  it.each(printers)('%s: the deduction happens BEFORE the meter is zeroed', (_l, printer) => {
    const flat = flatten(offlineBranch(printer));
    const flushAt = flat.findIndex(a => a.action === 'rest_command.spoolmansync_update_spool');
    const resetAt = flat.findIndex(a => a.action === 'utility_meter.calibrate');
    expect(flushAt, printer.prefix).toBeGreaterThanOrEqual(0);
    expect(resetAt, printer.prefix).toBeGreaterThanOrEqual(0);
    expect(flushAt, printer.prefix).toBeLessThan(resetAt);
  });

  it.each(printers)('%s: the reset is KEPT, so a power-on still finds an empty meter (#66)', (_l, printer) => {
    const reset = flatten(offlineBranch(printer)).find(a => a.action === 'utility_meter.calibrate')!;
    expect(reset, printer.prefix).toBeDefined();
    expect(reset.data!.value).toBe('0');
  });

  it.each(printers)('%s: an unidentifiable tray warns instead of silently discarding', (_l, printer) => {
    const skipped = flatten(offlineBranch(printer)).find(a =>
      a.action === 'system_log.write' && String(a.data?.message).includes('skipped'))!;
    expect(skipped, printer.prefix).toBeDefined();
    const level = String(skipped.data!.level);
    expect(level, printer.prefix).toContain("'warning'");
    expect(level, printer.prefix).toMatch(/>=\s*0\.01/);
  });

  it('the meter stays readable while the printer is away (always_available)', () => {
    // Without this the meter goes unavailable with its source and the float(0)
    // fallback reads 0g, so the flush above would deduct nothing.
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { configurationAdditions } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const cfg = parseYaml(configurationAdditions) as {
        utility_meter: Record<string, { always_available?: boolean; source: string }>;
      };
      const meter = cfg.utility_meter[`spoolmansync_${printer.prefix}_filament_usage_meter`];
      expect(meter, printer.prefix).toBeDefined();
      expect(meter.always_available, printer.prefix).toBe(true);
    }
  });

  it('every reset-without-deduction path is now either flushed or warned about', () => {
    // The root cause behind #66/#75/#77/#78 was zeroing the meter on paths that
    // never deducted. Assert no calibrate is reachable without either a flush
    // before it or a warning-capable log in the same branch.
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook', 'http://hook');
      const automations = parseYaml(automationsYaml) as Automation[];
      const automation = automations.find(a => a.id === `spoolmansync_update_spool_${printer.prefix}`)!;
      const chooseAction = automation.actions.find(a => a.choose)!;

      for (const branch of chooseAction.choose!) {
        const flat = flatten(branch.sequence);
        if (!flat.some(a => a.action === 'utility_meter.calibrate')) continue;
        const flushes = flat.some(a => a.action === 'rest_command.spoolmansync_update_spool');
        const warns = flat.some(a =>
          a.action === 'system_log.write' && String(a.data?.level).includes("'warning'"));
        expect(flushes || warns, `${printer.prefix}: ${branch.conditions[0].value_template}`).toBe(true);
      }
    }
  });
});
