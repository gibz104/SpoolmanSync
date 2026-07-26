import { describe, it, expect } from 'vitest';
import {
  detectPackagesConfig,
  addPackagesDirective,
  repairDuplicatePackagesDirective,
  SPOOLMANSYNC_PACKAGES_DIRECTIVE,
} from './ha-config-generator';

/**
 * Regression tests for issue #73: a user's existing
 * `packages: !include_dir_named integrations` line was invisible to detection
 * (their configuration.yaml was CRLF), so auto-configure inserted a SECOND
 * packages: key under homeassistant:. YAML keeps the last duplicate key, the
 * SpoolmanSync package file was never loaded, and everything reported success
 * while rest_command.spoolmansync_* didn't exist at runtime.
 */

const LF_DIRECTORY_CONFIG = [
  'default_config:',
  '',
  'homeassistant:',
  '  packages: !include_dir_named integrations',
  '',
  'automation: !include automations.yaml',
].join('\n');

const toCRLF = (s: string) => s.split('\n').join('\r\n');

describe('detectPackagesConfig', () => {
  it('detects a directory style with a non-"packages" directory name (LF)', () => {
    expect(detectPackagesConfig(LF_DIRECTORY_CONFIG)).toEqual({
      style: 'directory',
      directoryPath: 'integrations',
    });
  });

  it('detects the same config with CRLF line endings (issue #73 regression)', () => {
    expect(detectPackagesConfig(toCRLF(LF_DIRECTORY_CONFIG))).toEqual({
      style: 'directory',
      directoryPath: 'integrations',
    });
  });

  it('detects with a UTF-8 BOM before the first line', () => {
    expect(detectPackagesConfig('﻿' + LF_DIRECTORY_CONFIG.replace('default_config:\n\n', ''))).toMatchObject({
      style: 'directory',
    });
    // BOM directly on a leading homeassistant: line
    expect(detectPackagesConfig('﻿homeassistant:\n  packages: !include_dir_named packages\n')).toEqual({
      style: 'directory',
      directoryPath: 'packages',
    });
  });

  it('detects include_dir_merge_named', () => {
    const config = 'homeassistant:\n  packages: !include_dir_merge_named my_packages\n';
    expect(detectPackagesConfig(config)).toEqual({ style: 'directory', directoryPath: 'my_packages' });
  });

  it('strips surrounding quotes from the directory path', () => {
    expect(detectPackagesConfig('homeassistant:\n  packages: !include_dir_named "integrations"\n'))
      .toEqual({ style: 'directory', directoryPath: 'integrations' });
    expect(detectPackagesConfig("homeassistant:\n  packages: !include_dir_named 'integrations'\n"))
      .toEqual({ style: 'directory', directoryPath: 'integrations' });
  });

  it('ignores a trailing comment after the directory path', () => {
    expect(detectPackagesConfig('homeassistant:\n  packages: !include_dir_named integrations  # my custom sensors\n'))
      .toEqual({ style: 'directory', directoryPath: 'integrations' });
  });

  it('detects named style with entries, including an existing spoolmansync entry', () => {
    const config = [
      'homeassistant:',
      '  packages:',
      '    pack1: !include pack1.yaml',
      '    spoolmansync: !include spoolmansync_package.yaml',
      '',
      'automation: !include automations.yaml',
    ].join('\n');
    expect(detectPackagesConfig(config)).toMatchObject({ style: 'named', hasSpoolmansync: true });
    expect(detectPackagesConfig(toCRLF(config))).toMatchObject({ style: 'named', hasSpoolmansync: true });
  });

  it('treats an empty packages block as none (LF and CRLF)', () => {
    const config = 'homeassistant:\n  packages:\n\nautomation: !include automations.yaml';
    expect(detectPackagesConfig(config)).toEqual({ style: 'none' });
    expect(detectPackagesConfig(toCRLF(config))).toEqual({ style: 'none' });
  });

  it('returns none when there is no homeassistant block', () => {
    expect(detectPackagesConfig('default_config:\n\nautomation: !include automations.yaml\n'))
      .toEqual({ style: 'none' });
  });

  it('finds the homeassistant block mid-file with comments interleaved', () => {
    const config = [
      'default_config:',
      '',
      '# main settings',
      'homeassistant:',
      '  name: Home',
      '  # packages live elsewhere',
      '  packages: !include_dir_named integrations',
    ].join('\n');
    expect(detectPackagesConfig(config)).toEqual({ style: 'directory', directoryPath: 'integrations' });
  });
});

describe('addPackagesDirective', () => {
  it('inserts under an existing bare homeassistant: block', () => {
    const result = addPackagesDirective('default_config:\n\nhomeassistant:\n  name: Home\n');
    expect(result.conflict).toBeNull();
    expect(result.content).toContain(`homeassistant:\n${SPOOLMANSYNC_PACKAGES_DIRECTIVE}\n  name: Home`);
  });

  it('inserts into a CRLF file without corrupting it', () => {
    const result = addPackagesDirective('default_config:\r\n\r\nhomeassistant:\r\n  name: Home\r\n');
    expect(result.conflict).toBeNull();
    const lines = result.content.split('\n');
    expect(lines).toContain(SPOOLMANSYNC_PACKAGES_DIRECTIVE);
    // Original lines untouched
    expect(lines[0]).toBe('default_config:\r');
  });

  it('prepends a homeassistant block when none exists', () => {
    const result = addPackagesDirective('default_config:\n');
    expect(result.conflict).toBeNull();
    expect(result.content.startsWith(`homeassistant:\n${SPOOLMANSYNC_PACKAGES_DIRECTIVE}\n`)).toBe(true);
  });

  it('REFUSES when a packages: key already exists (the issue #73 guard)', () => {
    const result = addPackagesDirective(LF_DIRECTORY_CONFIG);
    expect(result.conflict).not.toBeNull();
    expect(result.content).toBe(LF_DIRECTORY_CONFIG);
  });

  it('REFUSES on a CRLF file with an existing packages: key', () => {
    const crlf = toCRLF(LF_DIRECTORY_CONFIG);
    const result = addPackagesDirective(crlf);
    expect(result.conflict).not.toBeNull();
    expect(result.content).toBe(crlf);
  });

  it('REFUSES when homeassistant: has a scalar value (split config)', () => {
    const result = addPackagesDirective('homeassistant: !include ha_settings.yaml\n');
    expect(result.conflict).not.toBeNull();
    expect(result.content).toBe('homeassistant: !include ha_settings.yaml\n');
  });

  it('does not treat a commented-out packages line as a conflict', () => {
    const config = 'homeassistant:\n  # packages: !include_dir_named old\n  name: Home\n';
    const result = addPackagesDirective(config);
    expect(result.conflict).toBeNull();
  });

  it('a homeassistant: line with only a trailing comment is not scalar-valued', () => {
    const result = addPackagesDirective('homeassistant:  # core settings\n  name: Home\n');
    expect(result.conflict).toBeNull();
    expect(result.content).toContain(SPOOLMANSYNC_PACKAGES_DIRECTIVE);
  });
});

describe('repairDuplicatePackagesDirective', () => {
  /** The exact broken state issue #73 produced: our line first, user's last. */
  const BROKEN = [
    'homeassistant:',
    SPOOLMANSYNC_PACKAGES_DIRECTIVE,
    '  packages: !include_dir_named integrations',
    '',
    'automation: !include automations.yaml',
  ].join('\n');

  it('removes only the SpoolmanSync directive from the duplicate state', () => {
    const result = repairDuplicatePackagesDirective(BROKEN);
    expect(result.repaired).toBe(true);
    expect(result.content).not.toContain(SPOOLMANSYNC_PACKAGES_DIRECTIVE);
    expect(result.content).toContain('  packages: !include_dir_named integrations');
    // And the repaired config now detects the user's directory
    expect(detectPackagesConfig(result.content)).toEqual({ style: 'directory', directoryPath: 'integrations' });
  });

  it('repairs when the user line carries a \\r (CRLF file our LF line was spliced into)', () => {
    const mixed = [
      'homeassistant:\r',
      SPOOLMANSYNC_PACKAGES_DIRECTIVE, // ours was inserted LF-only
      '  packages: !include_dir_named integrations\r',
      '\r',
    ].join('\n');
    const result = repairDuplicatePackagesDirective(mixed);
    expect(result.repaired).toBe(true);
    expect(result.content).not.toContain(SPOOLMANSYNC_PACKAGES_DIRECTIVE + '\n');
    expect(result.content).toContain('integrations');
  });

  it('never touches a lone user packages line', () => {
    const result = repairDuplicatePackagesDirective(LF_DIRECTORY_CONFIG);
    expect(result.repaired).toBe(false);
    expect(result.content).toBe(LF_DIRECTORY_CONFIG);
  });

  it('never touches a lone SpoolmanSync directive (legitimate install)', () => {
    const config = `homeassistant:\n${SPOOLMANSYNC_PACKAGES_DIRECTIVE}\n  name: Home\n`;
    const result = repairDuplicatePackagesDirective(config);
    expect(result.repaired).toBe(false);
    expect(result.content).toBe(config);
  });

  it('removes multiple copies of our directive if repeated runs stacked them', () => {
    const config = [
      'homeassistant:',
      SPOOLMANSYNC_PACKAGES_DIRECTIVE,
      SPOOLMANSYNC_PACKAGES_DIRECTIVE,
      '  packages: !include_dir_named integrations',
    ].join('\n');
    const result = repairDuplicatePackagesDirective(config);
    expect(result.repaired).toBe(true);
    expect(result.content).not.toContain(SPOOLMANSYNC_PACKAGES_DIRECTIVE);
    expect(result.content).toContain('integrations');
  });

  it('ignores packages lines outside the homeassistant block', () => {
    const config = [
      'homeassistant:',
      SPOOLMANSYNC_PACKAGES_DIRECTIVE,
      '',
      'some_integration:',
      '  packages: whatever',
    ].join('\n');
    // Only OUR line is in the homeassistant block; nothing to repair.
    expect(repairDuplicatePackagesDirective(config).repaired).toBe(false);
  });
});
