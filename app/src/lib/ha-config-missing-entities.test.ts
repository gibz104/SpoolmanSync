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
 * producing `states('')`. A missing entity must instead be reported, and must
 * never produce YAML Home Assistant refuses to load.
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
  it('does not emit states(\'\') when printer-level entities are missing', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    p.print_progress_entity = undefined;
    for (const printers of [[idexPrinterMissingWeight()], [p]]) {
      const { configurationAdditions, automationsYaml } = generateHAConfig(printers, 'http://hook');
      expect(configurationAdditions).not.toContain("states('')");
      expect(automationsYaml).not.toContain("states('')");
    }
  });
});

describe('generateHAConfig — missing current_stage must not break the whole automation', () => {
  it('sends a neutral current_print_state instead of states(\'\')', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    const { automationsYaml } = generateHAConfig([p], 'http://hook');

    const parsed = parseYaml(automationsYaml) as Array<{ id: string; actions: Array<Record<string, { current_print_state?: string }>> }>;
    const trayChange = parsed.find(a => a.id === 'spoolmansync_tray_change_x1c')!;
    const restCall = trayChange.actions.find(a => a.data?.current_print_state !== undefined)!;
    // 'unknown' is not an active print state, so runout preservation behaves as
    // it did before the stage entity existed — it never wrongly blocks a clear.
    expect(restCall.data.current_print_state).toBe('unknown');
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
      const cfg = generateHAConfig(printers, 'http://hook', 'secret');

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

  }

  it('skips a tray-less printer entirely rather than emitting a broken automation', () => {
    const cfg = generateHAConfig(
      [{ ...healthyBambu(), ams_units: [], external_spools: [] }], 'http://hook');

    expect(cfg.printerCount).toBe(0);
    expect(cfg.trayCount).toBe(0);
    expect(cfg.missingEntities[0]).toMatchObject({ prefix: 'x1c', breaksUsageTracking: true });
  });

  it('a tray-less printer does not take a healthy one down with it', () => {
    const cfg = generateHAConfig(
      [{ ...healthyBambu(), prefix: 'dead', ams_units: [], external_spools: [] }, healthyBambu()],
      'http://hook');

    expect(cfg.printerCount).toBe(1);
    const automations = parseYaml(cfg.automationsYaml) as Array<{ id: string }>;
    expect(automations.some(a => a.id === 'spoolmansync_tray_change_x1c')).toBe(true);
    expect(automations.some(a => a.id.includes('dead'))).toBe(false);
  });
});

describe('generateHAConfig — missingEntities is reported, not swallowed', () => {
  it('reports the missing entity and that usage tracking is broken', () => {
    const { missingEntities } = generateHAConfig(
      [idexPrinterMissingWeight()], 'http://hook');

    expect(missingEntities).toHaveLength(1);
    expect(missingEntities[0]).toMatchObject({
      prefix: 'h2d',
      name: 'H2D',
      breaksUsageTracking: true,
    });
    expect(missingEntities[0].missing).toContain('print_weight');
  });

  it('is empty for a fully-discovered printer', () => {
    const { missingEntities } = generateHAConfig([healthyBambu()], 'http://hook');
    expect(missingEntities).toEqual([]);
  });

  it('reports a missing current_stage without claiming usage tracking is broken', () => {
    const p = healthyBambu();
    p.current_stage_entity = undefined;
    const { missingEntities } = generateHAConfig([p], 'http://hook');

    expect(missingEntities[0].missing).toEqual(['current_stage']);
    expect(missingEntities[0].breaksUsageTracking).toBe(false);
  });

  it('reports per printer when several are configured', () => {
    const { missingEntities } = generateHAConfig(
      [healthyBambu(), idexPrinterMissingWeight()], 'http://hook');

    expect(missingEntities.map(m => m.prefix)).toEqual(['h2d']);
  });

  it('returns an empty report when there are no printers', () => {
    expect(generateHAConfig([], 'http://hook').missingEntities).toEqual([]);
  });
});
