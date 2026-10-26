/**
 * Home Assistant Configuration Generator for SpoolmanSync
 *
 * Generates the tray-change automations, and the rest_command they call, that
 * tell SpoolmanSync when a spool is inserted or removed. Filament usage is not
 * configured in Home Assistant at all: SpoolmanSync reads the printer entities
 * itself (src/lib/usage).
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

/** Automation ids this generator writes; anything else in automations.yaml is the user's. */
const GENERATED_AUTOMATION_ID = /^spoolmansync_(?:update_spool|tray_change)_[A-Za-z0-9_]+$/;

/**
 * Generate complete HA configuration for SpoolmanSync
 */
export function generateHAConfig(
  printers: HAPrinter[],
  webhookUrl: string,
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

  const automations: string[] = [];
  const missingEntityReports: MissingEntityReport[] = [];
  let printerCount = 0;
  let trayCount = 0;

  for (const printer of printers) {
    const slots = [
      ...printer.ams_units.flatMap(ams => ams.trays.map(tray => tray.entity_id)),
      ...printer.external_spools.map(ext => ext.entity_id),
    ];
    // discoverPrinters() synthesizes a slot for single-spool printers (#68), so
    // this should be unreachable.
    if (slots.length === 0) {
      console.warn(`[SpoolmanSync] Printer ${printer.prefix} has no AMS trays or external spools; skipping config generation for it.`);
      missingEntityReports.push({ prefix: printer.prefix, name: printer.name, missing: ['tray/external spool entities'], breaksUsageTracking: true });
      continue;
    }
    printerCount++;
    trayCount += slots.length;

    if (printer.brand === 'bambu_lab') {
      // Usage is print_weight × print_progress; without either nothing is deducted.
      const missing = [
        !printer.current_stage_entity ? 'current_stage' : null,
        !printer.print_weight_entity ? 'print_weight' : null,
        !printer.print_progress_entity ? 'print_progress' : null,
      ].filter((v): v is string => v !== null);
      if (missing.length > 0) {
        console.warn(`[SpoolmanSync] Missing entities for ${printer.prefix}: ${missing.join(', ')}. Please report at https://github.com/gibz104/SpoolmanSync/issues`);
        missingEntityReports.push({
          prefix: printer.prefix,
          name: printer.name,
          missing,
          breaksUsageTracking: !printer.print_weight_entity || !printer.print_progress_entity,
        });
      }
    }

    // The slot synthesized for a single-spool printer has no entity behind it,
    // and Home Assistant refuses an automation that triggers on one.
    const watchable = slots.filter(id => id.includes('.'));
    if (watchable.length === 0) {
      automations.push(`# SpoolmanSync: ${printer.prefix} reports no tray or spool entity, so there is no tray change to watch.\n`);
      continue;
    }
    automations.push(trayChangeAutomation(
      printer.prefix,
      printer.brand === 'creality' ? 'creality' : 'bambu_lab',
      watchable,
      printer.brand === 'creality' ? printer.entity_id : printer.current_stage_entity,
    ));
  }

  return {
    automationsYaml: automations.join('\n'),
    configurationAdditions: configurationAdditions(printers.map(p => p.prefix), webhookUrl, webhookSecret),
    // Printers actually configured — differs from printers.length only when one
    // was skipped above for having no trays.
    printerCount,
    trayCount,
    missingEntities: missingEntityReports,
  };
}

/**
 * The tray-change automation: fires when a tray's spool serial or name changes,
 * so the webhook can auto-assign (Bambu serials) or clear an emptied tray.
 *
 * Creality CFS slots carry `rfid`/`color_hex` where Bambu has `tray_uuid`/`color`.
 * The `rfid` is a material-type code, not a per-spool serial, so Creality sends
 * an empty tray_uuid and serial auto-matching stays off (see src/lib/creality.ts).
 */
function trayChangeAutomation(prefix: string, brand: 'bambu_lab' | 'creality', trayEntityIds: string[], stageEntity?: string): string {
  const creality = brand === 'creality';
  const idAttribute = creality ? 'rfid' : 'tray_uuid';
  return `# =============================================================================
# SpoolmanSync Automation: Tray Change Detection${creality ? ' (Creality)' : ''}
#
# Detects physical spool changes (insert/remove) and syncs with Spoolman.
# Triggers when any ${creality ? 'CFS slot' : 'AMS tray or external spool'} sensor changes state.
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
    # Debounce: only trigger if ${idAttribute} or name actually changed between old and new state
    - condition: template
      value_template: >-
        {{ trigger.from_state is none or trigger.to_state is none or
           trigger.to_state.attributes.get('${idAttribute}', '') != trigger.from_state.attributes.get('${idAttribute}', '') or
           trigger.to_state.attributes.get('name', '') != trigger.from_state.attributes.get('name', '') }}
  variables:
    tray_entity_id: "{{ trigger.entity_id }}"
${creality
    ? `    # Material-type code, logged for diagnostics only — never a spool serial.
    material_code: "{{ state_attr(trigger.entity_id, 'rfid') | default('') }}"`
    : `    tray_uuid: "{{ state_attr(trigger.entity_id, 'tray_uuid') | default('') }}"`}
    name: "{{ state_attr(trigger.entity_id, 'name') | default('') }}"
    material: "{{ state_attr(trigger.entity_id, 'type') | default('') }}"
    color: "{{ state_attr(trigger.entity_id, '${creality ? 'color_hex' : 'color'}') | default('') }}"
  actions:
    - action: system_log.write
      data:
        message: >-
          SPOOLMANSYNC TRAY CHANGE DETECTED${creality ? ' (Creality)' : ''} | {{ tray_entity_id }} |
          Name: {{ name }} | Material: {{ material }} |
          ${creality ? 'Material code: {{ material_code }}' : 'Spool Serial: {{ tray_uuid }}'} | Color: {{ color }}
        level: info
    - action: rest_command.spoolmansync_tray_change
      data:
        tray_entity_id: "{{ tray_entity_id }}"
${creality
    ? `        # Empty on purpose: no per-spool serial exists for Creality, so serial
        # auto-matching stays off rather than matching on a material code.
        tray_uuid: ""`
    : `        tray_uuid: "{{ tray_uuid }}"`}
        name: "{{ name }}"
        material: "{{ material }}"
        color: "{{ color }}"
        current_print_state: ${stageEntity
    ? `"{{ states('${stageEntity}') }}"`
    : `"unknown"  # no print-stage entity discovered`}
  mode: queued
  max: 10
`;
}

/**
 * The rest_command the tray-change automations call.
 */
function configurationAdditions(prefixes: string[], webhookUrl: string, webhookSecret: string = ''): string {
  const secretHeader = webhookSecret ? `\n      X-SpoolmanSync-Token: "${webhookSecret}"` : '';
  return `
# =============================================================================
# SpoolmanSync Configuration
# Auto-generated for printer(s): ${prefixes.join(', ')}
# =============================================================================

# REST command the tray-change automations use to notify SpoolmanSync
rest_command:
  spoolmansync_tray_change:
    url: "${webhookUrl}"
    method: POST
    headers:
      Content-Type: "application/json"${secretHeader}
    # to_json quotes and escapes each value, so a filament name containing a
    # double quote still produces valid JSON.
    payload: >
      {
        "event": "tray_change",
        "tray_entity_id": {{ tray_entity_id | default('') | to_json }},
        "tray_uuid": {{ tray_uuid | default('') | to_json }},
        "name": {{ name | default('') | to_json }},
        "material": {{ material | default('') | to_json }},
        "color": {{ color | default('') | to_json }},
        "current_print_state": {{ current_print_state | default('') | to_json }}
      }
`;
}

/**
 * Merge generated automations into existing automations.yaml content.
 * Replaces the automations this generator writes (by exact id shape) and the
 * banner comments above them, preserving all user-created automations.
 */
export function mergeAutomations(existingContent: string, newAutomations: string): string {
  const trimmed = existingContent.trim();
  const ours = newAutomations.trim() ? newAutomations : '';

  // Empty file or empty array marker — just use our automations
  if (!trimmed || trimmed === '[]') {
    return ours || '[]\n';
  }

  // Split content into individual automation entries.
  // Each automation starts with "- id:" at column 0, and the banner comment
  // above one of ours ends up at the end of the part before it, so it is cut
  // from there (and only there: what follows belongs to the next automation).
  const parts = trimmed
    .split(/\n(?=- id:)/)
    .filter(part => !GENERATED_AUTOMATION_ID.test(/^- id:\s*['"]?([^'"\s]+)/.exec(part)?.[1] ?? ''))
    .map(part => part.replace(/(?:^|\n)# =+\n# SpoolmanSync[^\n]*(?:\n#[^\n]*)*\s*$/, ''));

  const result = parts.join('\n').trim();
  if (!result) return ours || '[]\n';
  return ours ? result + '\n\n' + ours : result + '\n';
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

/** The only top-level keys the block older versions appended to configuration.yaml ever held. */
const LEGACY_KEYS = new Set(['input_number', 'utility_meter', 'rest_command', 'template']);

/** Whether a legacy top-level block holds nothing but SpoolmanSync's own entries. */
function legacyBlockIsOurs(key: string, body: string[]): boolean {
  if (key === 'template') {
    const ids = body.map(line => /unique_id:\s*["']?([^"'\s]+)/.exec(line)?.[1]).filter(Boolean);
    return ids.length > 0 && ids.every(id => id!.startsWith('spoolmansync-'));
  }
  const entries = body.filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const indent = Math.min(...entries.map(line => line.length - line.trimStart().length));
  const children = entries.filter(line => line.length - line.trimStart().length === indent);
  return children.length > 0 && children.every(line => /^\s*spoolmansync_[\w-]*\s*:/.test(line));
}

/**
 * Remove the block versions before packages appended to configuration.yaml
 * (embedded mode, and older add-on installs).
 *
 * It runs from its heading through SpoolmanSync's own top-level keys, each
 * checked to hold only our entries. The first key that is not ours ends it, so
 * anything the user added below is kept — the old merge deleted it.
 */
export function stripSpoolmanSyncConfig(configContent: string): string {
  const eol = configContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = configContent.split(/\r?\n/);
  const keyAt = (i: number) => /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i])?.[1];
  let changed = false;

  for (let heading = lines.findIndex(isLegacyHeading); heading !== -1; heading = lines.findIndex(isLegacyHeading)) {
    const start = heading > 0 && /^#\s*=+\s*$/.test(lines[heading - 1]) ? heading - 1 : heading;
    let end = heading + 1;
    for (let i = heading + 1; i < lines.length; i++) {
      const key = keyAt(i);
      if (key === undefined) continue;
      let next = i + 1;
      while (next < lines.length && keyAt(next) === undefined) next++;
      if (!LEGACY_KEYS.has(key) || !legacyBlockIsOurs(key, lines.slice(i + 1, next))) break;
      end = next;
      i = next - 1;
    }
    // Comments and blank lines just above the user's next key are theirs.
    while (end > heading + 1 && end < lines.length && (!lines[end - 1].trim() || lines[end - 1].startsWith('#'))) end--;
    lines.splice(start, end - start);
    changed = true;
  }
  return changed ? lines.join(eol).trimEnd() + eol : configContent;
}

function isLegacyHeading(line: string): boolean {
  return /^#\s*SpoolmanSync Configuration\s*$/.test(line);
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
