import { describe, it, expect } from 'vitest';
import {
  realTrayLocationLabel,
  virtualLocationLabel,
  truncateLocation,
  SPOOLMAN_LOCATION_MAX,
} from './spool-location';

describe('realTrayLocationLabel', () => {
  it('formats an AMS tray', () => {
    expect(realTrayLocationLabel('X1C', 'AMS 1', 3, false)).toBe('X1C - AMS 1 Tray 3');
  });

  it('formats an external spool', () => {
    expect(realTrayLocationLabel('P1S', 'AMS 1', 0, true)).toBe('P1S - External');
    // AMS name is ignored for external
    expect(realTrayLocationLabel('P1S', undefined, 0, true)).toBe('P1S - External');
  });

  it('falls back to "<Printer> - Tray N" when no AMS name', () => {
    expect(realTrayLocationLabel('Ender 3', undefined, 1, false)).toBe('Ender 3 - Tray 1');
    expect(realTrayLocationLabel('Ender 3', '  ', 1, false)).toBe('Ender 3 - Tray 1');
  });

  it('handles a missing printer name', () => {
    expect(realTrayLocationLabel('', 'AMS 1', 2, false)).toBe('Printer - AMS 1 Tray 2');
  });

  it('handles an external tray with a slot name', () => {
    expect(realTrayLocationLabel('X2D', undefined, 0, true, 'Left spool')).toBe('X2D - Left spool');
  });

  it('handles a missing external tray name', () => {
    expect(realTrayLocationLabel('X2D', undefined, 0, true)).toBe('X2D - External');
  });

  it('never exceeds Spoolman max length', () => {
    const longName = 'P'.repeat(200);
    const label = realTrayLocationLabel(longName, 'AMS 1', 3, false);
    expect(label.length).toBe(SPOOLMAN_LOCATION_MAX);
  });
});

describe('virtualLocationLabel', () => {
  it('is just the trimmed printer name', () => {
    expect(virtualLocationLabel('Dry Box A')).toBe('Dry Box A');
    expect(virtualLocationLabel('  Shelf 2  ')).toBe('Shelf 2');
  });

  it('truncates to max length', () => {
    expect(virtualLocationLabel('D'.repeat(100)).length).toBe(SPOOLMAN_LOCATION_MAX);
  });
});

describe('truncateLocation', () => {
  it('leaves short strings unchanged', () => {
    expect(truncateLocation('Shelf A')).toBe('Shelf A');
  });
  it('clamps to 64 chars', () => {
    expect(truncateLocation('x'.repeat(80))).toHaveLength(64);
  });
});
