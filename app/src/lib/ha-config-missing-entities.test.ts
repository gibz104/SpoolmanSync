import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateHAConfig } from './ha-config-generator';
import type { HAPrinter } from './api/homeassistant';

/**
 * Regression tests for the silent-failure path behind the forum report
 * "tray changes show up in the logs but weight is never deducted"
 * (an IDEX/no-AMS printer whose print_weight entity was never discovered).
 *
 * Discovery returning `undefined` for a printer-level entity used to be turned
 * into an empty string and interpolated straight into the generated templates,
 * producing `states('')` — a template that errors on every evaluation, so the
 * usage sensor never produced a number, the utility_meter stayed at 0, and the
 * usage webhook was never sent. Nothing anywhere told the user.
 */

/** H2D-class: dual external spools, no AMS, no print_weight entity discovered. */
function idexPrinterMissingWeight(): HAPrinter {
  return {
    brand: 'bambu_lab',
    entity_id: 'sensor.h2d_print_status',
    name: 'H2D',
    state: 'idle',
    prefix: 'h2d',
    ams_units: [],
    external_spools: [
      { entity_id: 'sensor.h2d_external_spool', unique_id: 'h2d_ext_1', tray_number: 0, is_external: true },
      { entity_id: 'sensor.h2d_external_spool_2', unique_id: 'h2d_ext_2', tray_number: 0, is_external: true },
    ],
    current_stage_entity: 'sensor.h2d_current_stage',
    print_weight_entity: undefined,
    print_progress_entity: 'sensor.h2d_print_progress',
  };
}

function healthyBambu(): HAPrinter {
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
        trays: [{ entity_id: 'sensor.x1c_ams_1_tray_1', unique_id: 'x1c_ams_1_tray_1', tray_number: 1 }],
      },
    ],
    external_spools: [],
    current_stage_entity: 'sensor.x1c_current_stage',
    print_weight_entity: 'sensor.x1c_print_weight',
    print_progress_entity: 'sensor.x1c_print_progress',
  };
}

describe('generateHAConfig — never emits an empty entity_id', () => {
  it('does not emit states(\'\') when print_weight is missing', () => {
    const { configurationAdditions, automationsYaml } = generateHAConfig(
      [idexPrinterMissingWeight()], 'http://hook', 'http://hook');

    expect(configurationAdditions).not.toContain("states('')");
    expect(automationsYaml).not.toContain("states('')");
  });

  it('does not emit states(\'\') when print_progress is missing', () => {
    const p = healthyBambu();
    p.print_progress_entity = undefined;
    const { configurationAdditions } = generateHAConfig([p], 'http://hook', 'http://hook');

    expect(configurationAdditions).not.toContain("states('')");
  });

  it('does not emit states(\'\') when a Creality used_material_length is missing', () => {
    const creality: HAPrinter = {
      brand: 'creality',
      entity_id: 'sensor.ender_print_status',
      name: 'Ender',
      state: 'idle',
      prefix: 'ender',
      ams_units: [],
      external_spools: [
        { entity_id: 'sensor.ender_ext', unique_id: 'ender_ext', tray_number: 0, is_external: true },
      ],
      print_progress_entity: 'sensor.ender_print_progress',
      used_material_entity: undefined,
    };
    const { configurationAdditions } = generateHAConfig([creality], 'http://hook', 'http://hook');

    expect(configurationAdditions).not.toContain("states('')");
  });

  it('replaces the usage sensor with an explicitly unavailable one that says why', () => {
    const { configurationAdditions } = generateHAConfig(
      [idexPrinterMissingWeight()], 'http://hook', 'http://hook');

    expect(configurationAdditions).toContain('FILAMENT USAGE TRACKING IS DISABLED');
    expect(configurationAdditions).toContain('print_weight');
    expect(configurationAdditions).toContain('availability: "{{ false }}"');
  });

  it('still declares the usage sensor so the utility_meter source resolves', () => {
    const { configurationAdditions } = generateHAConfig(
      [idexPrinterMissingWeight()], 'http://hook', 'http://hook');

    const parsed = parseYaml(configurationAdditions);
    const sensors = parsed.template[0].sensor as Array<{ name: string }>;
    expect(sensors.some(s => s.name === 'SpoolmanSync h2d Filament Usage')).toBe(true);
    expect(parsed.utility_meter.spoolmansync_h2d_filament_usage_meter.source)
      .toBe('sensor.spoolmansync_h2d_filament_usage');
  });

  it('leaves a healthy printer\'s usage sensor untouched', () => {
    const { configurationAdditions } = generateHAConfig([healthyBambu()], 'http://hook', 'http://hook');

    expect(configurationAdditions).toContain("states('sensor.x1c_print_weight')");
    expect(configurationAdditions).not.toContain('FILAMENT USAGE TRACKING IS DISABLED');
  });
});

describe('generateHAConfig — missing current_stage must not break the whole automation', () => {
  it('omits print-end/offline triggers rather than emitting a blank entity_id', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    const { automationsYaml } = generateHAConfig([p], 'http://hook', 'http://hook');

    expect(automationsYaml).not.toContain('id: print_end');

    // The automation must still parse and the tray trigger must survive.
    const parsed = parseYaml(automationsYaml) as Array<{
      id: string;
      triggers: Array<{ entity_id?: string | string[] }>;
    }>;
    const updateAutomation = parsed.find(a => a.id === 'spoolmansync_update_spool_x1c')!;
    expect(updateAutomation.triggers).toHaveLength(1);

    // A trigger whose entity_id is null/empty makes HA reject the whole
    // automation, taking tray-change tracking down with it.
    for (const automation of parsed) {
      for (const trigger of automation.triggers) {
        const ids = Array.isArray(trigger.entity_id) ? trigger.entity_id : [trigger.entity_id];
        for (const id of ids) {
          expect(id).toBeTruthy();
        }
      }
    }

    // Tray-change detection is independent and must keep working.
    expect(parsed.some(a => a.id === 'spoolmansync_tray_change_x1c')).toBe(true);
  });

  it('sends a neutral current_print_state instead of states(\'\')', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    const { automationsYaml } = generateHAConfig([p], 'http://hook', 'http://hook');

    const parsed = parseYaml(automationsYaml) as Array<{ id: string; actions: Array<Record<string, { current_print_state?: string }>> }>;
    const trayChange = parsed.find(a => a.id === 'spoolmansync_tray_change_x1c')!;
    const restCall = trayChange.actions.find(a => a.data?.current_print_state !== undefined)!;
    // 'unknown' is not an active print state, so runout preservation behaves as
    // it did before the stage entity existed — it never wrongly blocks a clear.
    expect(restCall.data.current_print_state).toBe('unknown');
  });

  it('keeps both triggers when current_stage IS discovered', () => {
    const { automationsYaml } = generateHAConfig([healthyBambu()], 'http://hook', 'http://hook');
    const parsed = parseYaml(automationsYaml) as Array<{ id: string; triggers: unknown[] }>;
    const updateAutomation = parsed.find(a => a.id === 'spoolmansync_update_spool_x1c')!;
    expect(updateAutomation.triggers).toHaveLength(3);
  });
});

describe('generateHAConfig — every printer shape produces loadable YAML', () => {
  const crealityPrinter = (over: Partial<HAPrinter> = {}): HAPrinter => ({
    brand: 'creality',
    entity_id: 'sensor.k1_print_status',
    name: 'K1',
    state: 'idle',
    prefix: 'k1',
    ams_units: [{
      entity_id: 'sensor.k1_cfs_1',
      name: 'CFS 1',
      ams_number: 1,
      trays: [{ entity_id: 'sensor.k1_cfs_box_1_slot_1', unique_id: 'c1', tray_number: 1 }],
    }],
    external_spools: [
      { entity_id: 'sensor.k1_cfs_external', unique_id: 'ce', tray_number: 0, is_external: true },
    ],
    print_progress_entity: 'sensor.k1_print_progress',
    used_material_entity: 'sensor.k1_used_material_length',
    ...over,
  });

  const shapes: Array<[string, HAPrinter[]]> = [
    ['healthy bambu', [healthyBambu()]],
    ['bambu missing print_weight', [idexPrinterMissingWeight()]],
    ['bambu missing everything', [{
      ...healthyBambu(),
      current_stage_entity: undefined,
      print_weight_entity: undefined,
      print_progress_entity: undefined,
    }]],
    ['creality healthy', [crealityPrinter()]],
    ['creality missing used_material_length', [crealityPrinter({ used_material_entity: undefined })]],
    ['creality missing stage entity', [crealityPrinter({ entity_id: '' })]],
    ['printer with no trays at all', [{ ...healthyBambu(), ams_units: [], external_spools: [] }]],
    ['mixed fleet, one degraded', [
      healthyBambu(),
      crealityPrinter({ used_material_entity: undefined }),
      { ...healthyBambu(), prefix: 'p1s', name: 'P1S', current_stage_entity: undefined },
    ]],
  ];

  for (const [label, printers] of shapes) {
    it(`${label}: parses, and no trigger has a blank entity_id`, () => {
      const cfg = generateHAConfig(printers, 'http://hook', 'http://hook', 'secret');

      const automations = parseYaml(cfg.automationsYaml) as Array<{
        id: string;
        triggers: Array<{ entity_id?: string | string[] | null }>;
      }> | null;

      for (const automation of automations ?? []) {
        for (const trigger of automation.triggers ?? []) {
          const ids = Array.isArray(trigger.entity_id) ? trigger.entity_id : [trigger.entity_id];
          for (const id of ids) {
            expect(id, `${label} / ${automation.id}`).toBeTruthy();
          }
        }
      }
    });

    it(`${label}: every template sensor has a non-empty state and a resolvable meter source`, () => {
      const cfg = generateHAConfig(printers, 'http://hook', 'http://hook', 'secret');
      if (!cfg.configurationAdditions.trim()) return; // nothing generated (all printers skipped)

      const parsed = parseYaml(cfg.configurationAdditions) as {
        template?: Array<{ sensor: Array<{ name: string; state: unknown }> }>;
        utility_meter?: Record<string, { source: string }>;
      };
      const sensors = parsed.template?.[0]?.sensor ?? [];

      for (const sensor of sensors) {
        expect(String(sensor.state ?? '').trim(), `${label} / ${sensor.name}`).not.toBe('');
      }

      const sensorIds = sensors.map(s => `sensor.${s.name.toLowerCase().replace(/\s+/g, '_')}`);
      for (const [meter, cfgEntry] of Object.entries(parsed.utility_meter ?? {})) {
        expect(sensorIds, `${label} / ${meter}`).toContain(cfgEntry.source);
      }
    });
  }

  it('skips a tray-less printer entirely rather than emitting a broken automation', () => {
    const cfg = generateHAConfig(
      [{ ...healthyBambu(), ams_units: [], external_spools: [] }], 'http://hook', 'http://hook');

    expect(cfg.printerCount).toBe(0);
    expect(cfg.trayCount).toBe(0);
    expect(cfg.missingEntities[0]).toMatchObject({ prefix: 'x1c', breaksUsageTracking: true });
  });

  it('a tray-less printer does not take a healthy one down with it', () => {
    const cfg = generateHAConfig(
      [{ ...healthyBambu(), prefix: 'dead', ams_units: [], external_spools: [] }, healthyBambu()],
      'http://hook', 'http://hook');

    expect(cfg.printerCount).toBe(1);
    const automations = parseYaml(cfg.automationsYaml) as Array<{ id: string }>;
    expect(automations.some(a => a.id === 'spoolmansync_update_spool_x1c')).toBe(true);
    expect(automations.some(a => a.id.includes('dead'))).toBe(false);
  });
});

describe('generateHAConfig — missingEntities is reported, not swallowed', () => {
  it('reports the missing entity and that usage tracking is broken', () => {
    const { missingEntities } = generateHAConfig(
      [idexPrinterMissingWeight()], 'http://hook', 'http://hook');

    expect(missingEntities).toHaveLength(1);
    expect(missingEntities[0]).toMatchObject({
      prefix: 'h2d',
      name: 'H2D',
      breaksUsageTracking: true,
    });
    expect(missingEntities[0].missing).toContain('print_weight');
  });

  it('is empty for a fully-discovered printer', () => {
    const { missingEntities } = generateHAConfig([healthyBambu()], 'http://hook', 'http://hook');
    expect(missingEntities).toEqual([]);
  });

  it('reports a missing current_stage without claiming usage tracking is broken', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    const { missingEntities } = generateHAConfig([p], 'http://hook', 'http://hook');

    expect(missingEntities[0].missing).toEqual(['current_stage']);
    expect(missingEntities[0].breaksUsageTracking).toBe(false);
  });

  it('reports per printer when several are configured', () => {
    const { missingEntities } = generateHAConfig(
      [healthyBambu(), idexPrinterMissingWeight()], 'http://hook', 'http://hook');

    expect(missingEntities.map(m => m.prefix)).toEqual(['h2d']);
  });

  it('returns an empty report when there are no printers', () => {
    expect(generateHAConfig([], 'http://hook', 'http://hook').missingEntities).toEqual([]);
  });
});
