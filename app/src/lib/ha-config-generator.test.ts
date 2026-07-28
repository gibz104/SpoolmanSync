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

  it('the skipped-flush log is info level (fires benignly on every power-on now)', () => {
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
      expect(skippedLog.data!.level, printer.prefix).toBe('info');
    }
  });
});
