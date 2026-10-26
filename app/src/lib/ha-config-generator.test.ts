import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateHAConfig, mergeAutomations, stripSpoolmanSyncConfig } from './ha-config-generator';
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

/** A single-spool printer: discovery synthesizes its only slot, which has no entity (#68). */
function singleSpoolPrinter(): HAPrinter {
  return {
    ...crealityPrinter(),
    prefix: 'ke',
    entity_id: 'sensor.ke_print_status',
    external_spools: [{ entity_id: 'ke_virtual_external_spool', unique_id: 'ke_virtual_external_spool', tray_number: 0, is_external: true }],
  };
}

type Automation = { id: string; variables?: Record<string, string>; triggers: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> };

describe('generateHAConfig — usage is not configured in Home Assistant', () => {
  it('generates only tray-change automations', () => {
    const { automationsYaml } = generateHAConfig([bambuPrinter(), crealityPrinter()], 'http://hook');
    const ids = (parseYaml(automationsYaml) as Automation[]).map(a => a.id);
    expect(ids).toEqual(['spoolmansync_tray_change_x1c', 'spoolmansync_tray_change_ender']);
  });

  it('declares no usage helpers, meters or sensors', () => {
    const { configurationAdditions, automationsYaml } = generateHAConfig([bambuPrinter(), crealityPrinter()], 'http://hook');
    expect(Object.keys(parseYaml(configurationAdditions))).toEqual(['rest_command']);
    for (const text of [configurationAdditions, automationsYaml]) {
      expect(text).not.toMatch(/utility_meter|input_number|filament_usage|spool_usage|update_spool/);
    }
  });
});

describe('generateHAConfig — webhook shared secret injection', () => {
  it('injects the X-SpoolmanSync-Token header into the rest_command when a secret is provided', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook', 'SECRET123');
    const parsed = parseYaml(configurationAdditions);
    expect(parsed.rest_command.spoolmansync_tray_change.headers['X-SpoolmanSync-Token']).toBe('SECRET123');
  });

  it('omits the token header entirely when no secret is provided', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook');
    expect(configurationAdditions).not.toContain('X-SpoolmanSync-Token');
  });
});

describe('generateHAConfig — tray-change automation', () => {
  it('passes the current print state to the webhook, for both brands', () => {
    for (const printer of [bambuPrinter(), crealityPrinter()]) {
      const { automationsYaml } = generateHAConfig([printer], 'http://hook');
      const [automation] = parseYaml(automationsYaml) as Automation[];
      const rest = automation.actions.find(a => a.action === 'rest_command.spoolmansync_tray_change') as { data: Record<string, string> };
      expect(rest.data.current_print_state).toContain('states(');
    }
  });

  it('encodes every payload value with to_json, so a quote in a filament name stays valid JSON', () => {
    const { configurationAdditions } = generateHAConfig([bambuPrinter()], 'http://hook');
    const payload = parseYaml(configurationAdditions).rest_command.spoolmansync_tray_change.payload as string;
    for (const field of ['tray_entity_id', 'tray_uuid', 'name', 'material', 'color', 'current_print_state']) {
      expect(payload).toContain(`"${field}": {{ ${field} | default('') | to_json }}`);
    }
  });

  it('never triggers on the synthesized slot of a single-spool printer, which has no entity', () => {
    const cfg = generateHAConfig([singleSpoolPrinter(), bambuPrinter()], 'http://hook');
    expect(cfg.automationsYaml).not.toContain('ke_virtual_external_spool');
    expect((parseYaml(cfg.automationsYaml) as Automation[]).map(a => a.id)).toEqual(['spoolmansync_tray_change_x1c']);
    // It still counts: a spool can be assigned to it and its usage is tracked.
    expect(cfg.printerCount).toBe(2);
  });

  it('returns empty config for no printers', () => {
    const cfg = generateHAConfig([], 'http://hook');
    expect(cfg.automationsYaml).toBe('[]');
    expect(cfg.printerCount).toBe(0);
    expect(cfg.trayCount).toBe(0);
  });
});

/**
 * Creality's `rfid` attribute is a MATERIAL-TYPE code (PLA 00001, PETG 00003,
 * ...) shared by every spool of that material, not a per-spool serial. Sending
 * it as tray_uuid made SpoolmanSync auto-assign whichever spool last carried
 * that code. Bambu's tray_uuid IS a per-spool serial and must keep flowing.
 */
describe('generateHAConfig — tray_uuid is Bambu-only', () => {
  const restData = (printer: HAPrinter) => {
    const [automation] = parseYaml(generateHAConfig([printer], 'http://hook').automationsYaml) as Automation[];
    return { automation, data: (automation.actions.find(a => a.action === 'rest_command.spoolmansync_tray_change') as { data: Record<string, string> }).data };
  };

  it('Creality sends an empty tray_uuid and logs the material code only for diagnostics', () => {
    const { automation, data } = restData(crealityPrinter());
    expect(data.tray_uuid).toBe('');
    expect(automation.variables?.material_code).toContain("'rfid'");
    expect('tray_uuid' in (automation.variables ?? {})).toBe(false);
  });

  it('Bambu keeps sending its real per-spool serial', () => {
    expect(restData(bambuPrinter()).data.tray_uuid).toBe('{{ tray_uuid }}');
  });
});

describe('mergeAutomations', () => {
  const ours = generateHAConfig([bambuPrinter()], 'http://hook').automationsYaml;
  const user = (id: string) => `- id: '${id}'\n  alias: ${id}\n  triggers: []\n  actions: []`;

  it('replaces our automations and keeps the user\'s, including ones written after ours', () => {
    const before = [user('mine_1'), ours.trim(), user('mine_2')].join('\n');
    const ids = (parseYaml(mergeAutomations(before, ours)) as Automation[]).map(a => a.id);
    expect(ids).toEqual(['mine_1', 'mine_2', 'spoolmansync_tray_change_x1c']);
  });

  it('drops the usage automation older versions generated, and its banner', () => {
    const legacy = `# =============================================================================\n# SpoolmanSync Automation: Track Spool Usage\n# =============================================================================\n- id: 'spoolmansync_update_spool_x1c'\n  alias: old\n  triggers: []\n  actions: []`;
    const merged = mergeAutomations(`${user('mine_1')}\n${legacy}`, ours);
    expect(merged).not.toContain('update_spool');
    expect(merged).not.toContain('Track Spool Usage');
    expect((parseYaml(merged) as Automation[]).map(a => a.id)).toEqual(['mine_1', 'spoolmansync_tray_change_x1c']);
  });

  it('keeps a user automation whose id merely starts with spoolmansync_', () => {
    const merged = mergeAutomations(user('spoolmansync_my_own'), ours);
    expect((parseYaml(merged) as Automation[]).map(a => a.id)).toContain('spoolmansync_my_own');
  });

  it('leaves a valid empty list when nothing is generated', () => {
    expect(parseYaml(mergeAutomations('', ''))).toEqual([]);
    expect(parseYaml(mergeAutomations(ours, ''))).toEqual([]);
  });
});

describe('stripSpoolmanSyncConfig', () => {
  // The block versions before packages appended (embedded mode, older add-ons).
  const legacy = `
# =============================================================================
# SpoolmanSync Configuration
# Auto-generated for printer(s): x1c
# =============================================================================

# Helper to track last active tray per printer
input_number:
  spoolmansync_x1c_last_tray:
    name: "SpoolmanSync x1c Last Tray"
    min: -1
    max: 99
    step: 1

# Utility meter to track filament usage per printer
utility_meter:
  spoolmansync_x1c_filament_usage_meter:
    unique_id: spoolmansync-x1c-filament-usage-meter
    source: sensor.spoolmansync_x1c_filament_usage
    always_available: true

# REST commands to send updates to SpoolmanSync webhook
rest_command:
  spoolmansync_update_spool:
    url: "http://hook"
    method: POST
  spoolmansync_tray_change:
    url: "http://hook"
    method: POST

# Template sensors for filament tracking
template:
  - sensor:
      # x1c: Calculate filament usage during print
      - name: "SpoolmanSync x1c Filament Usage"
        unique_id: spoolmansync-x1c-filament-usage
        state: >
          {{ states('sensor.x1c_print_weight') | float(0) }}
      - name: "SpoolmanSync x1c Active Tray"
        unique_id: spoolmansync-x1c-active-tray
        state: >
          {# Check AMS1 trays #}
          11
`;
  const base = 'homeassistant:\n  name: Home\n\nfrontend:\n';

  it('removes the whole block', () => {
    expect(stripSpoolmanSyncConfig(base + legacy)).toBe(base);
  });

  it('keeps the user\'s own keys written after it, including ones named like ours', () => {
    const userBlocks = '# My own helpers\ninput_number:\n  bedroom_fan:\n    min: 0\n    max: 3\n\ntemplate:\n  - sensor:\n      - name: Mine\n        unique_id: my-sensor\n        state: "1"\n';
    const stripped = stripSpoolmanSyncConfig(base + legacy + '\n' + userBlocks);
    expect(stripped).not.toContain('spoolmansync');
    expect(stripped).toContain(userBlocks.trim());
    expect(parseYaml(stripped)).toMatchObject({ input_number: { bedroom_fan: { max: 3 } } });
  });

  it('preserves CRLF line endings', () => {
    const crlf = (base + legacy + 'sensor: []\n').replace(/\n/g, '\r\n');
    expect(stripSpoolmanSyncConfig(crlf)).toBe((base + '\nsensor: []\n').replace(/\n/g, '\r\n'));
  });

  it('leaves a config without the block untouched', () => {
    expect(stripSpoolmanSyncConfig(base)).toBe(base);
  });
});
