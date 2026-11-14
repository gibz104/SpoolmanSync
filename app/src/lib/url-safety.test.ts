import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes, parseServiceUrl, isPathSegment, pathSegment, positiveId } from './url-safety';

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('http://ha:8123///')).toBe('http://ha:8123');
    expect(trimTrailingSlashes('http://ha:8123/path')).toBe('http://ha:8123/path');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays fast on a long run of slashes, which /\\/+$/ is not (CodeQL js/polynomial-redos)', () => {
    const crafted = 'http://x' + '/'.repeat(200_000) + 'a';
    const start = performance.now();
    expect(trimTrailingSlashes(crafted)).toBe(crafted);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('parseServiceUrl', () => {
  it('takes http and https URLs, trimmed and without trailing slashes', () => {
    expect(parseServiceUrl('http://homeassistant:8123/')).toBe('http://homeassistant:8123');
    expect(parseServiceUrl('  https://spoolman.example.com//  ')).toBe('https://spoolman.example.com');
    expect(parseServiceUrl('http://192.168.1.5:7912')).toBe('http://192.168.1.5:7912');
    expect(parseServiceUrl('https://ha.example.com/proxy/path')).toBe('https://ha.example.com/proxy/path');
    // A reverse proxy's basic auth stays part of the address.
    expect(parseServiceUrl('http://user:pass@spoolman:7912')).toBe('http://user:pass@spoolman:7912');
  });

  it('refuses anything else', () => {
    for (const input of ['homeassistant.local:8123', '192.168.1.5:7912', 'javascript:alert(1)', 'file:///etc/passwd',
      'ftp://spoolman', 'data:text/plain,x', 'http://', '', '   ', 'http://' + 'a'.repeat(2050)]) {
      expect(parseServiceUrl(input), input.slice(0, 40)).toBeNull();
    }
    for (const input of [null, undefined, 42, { url: 'http://x' }]) expect(parseServiceUrl(input)).toBeNull();
  });
});

describe('isPathSegment and pathSegment', () => {
  it('take the IDs Home Assistant and Spoolman use', () => {
    for (const id of ['01JC3Q5Z8YB6V2N8K4M7P9R1ST', 'a3f5c2d1e4b6a7c8d9e0f1a2b3c4d5e6', 'sensor.x1c_00m09d462101575_ams_1_tray_3',
      'persistent_notification', 'active_tray', 'spoolmansync-tray-change']) {
      expect(isPathSegment(id), id).toBe(true);
    }
  });

  it('refuse anything that could lead to another endpoint', () => {
    for (const id of ['..', '.', '../../../services/lock/unlock', 'a/b', 'a\\b', 'a%2Fb', 'a?b=1', 'a#b', '', ' ', 'a b',
      'x'.repeat(129)]) {
      expect(isPathSegment(id), id.slice(0, 40)).toBe(false);
    }
    for (const id of [42, null, undefined, ['a']]) expect(isPathSegment(id)).toBe(false);
  });

  it('pathSegment names what was wrong', () => {
    expect(pathSegment('01JC3Q5Z8YB6V2N8K4M7P9R1ST', 'config flow ID')).toBe('01JC3Q5Z8YB6V2N8K4M7P9R1ST');
    expect(() => pathSegment('../x', 'config flow ID')).toThrow('Invalid config flow ID');
  });
});

describe('positiveId', () => {
  it('takes positive whole numbers, also written as digits', () => {
    expect(positiveId(1, 'spool ID')).toBe(1);
    expect(positiveId('42', 'spool ID')).toBe(42);
  });

  it('refuses anything else', () => {
    for (const id of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '1/../vendor/1', '1e3', '-2', '', null, undefined]) {
      expect(() => positiveId(id, 'spool ID'), String(id)).toThrow('Invalid spool ID');
    }
  });
});
