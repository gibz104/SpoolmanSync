import { describe, it, expect } from 'vitest';
import { classifyTrayState, filamentWeight, isValidTrayUuid, isActivePrintState, isPhantomSerialReport, MATERIAL_DENSITY } from './webhook-helpers';

describe('classifyTrayState (issue #65 — never clear on transient states)', () => {
  it('treats unavailable/unknown/missing as transient (must NOT clear assignment)', () => {
    expect(classifyTrayState(undefined)).toBe('transient');
    expect(classifyTrayState(null)).toBe('transient');
    expect(classifyTrayState('unavailable')).toBe('transient');
    expect(classifyTrayState('unknown')).toBe('transient');
    expect(classifyTrayState('Unavailable')).toBe('transient'); // case-insensitive
    expect(classifyTrayState('UNKNOWN')).toBe('transient');
    expect(classifyTrayState('?')).toBe('transient'); // AMS still reading the RFID tag
  });

  it('treats literal Empty and blank name as empty', () => {
    expect(classifyTrayState('Empty')).toBe('empty');
    expect(classifyTrayState('empty')).toBe('empty');
    expect(classifyTrayState('')).toBe('empty'); // Creality empty slot
  });

  it('treats a real filament name as present', () => {
    expect(classifyTrayState('PLA')).toBe('present');
    expect(classifyTrayState('Matte Dark Blue')).toBe('present');
    expect(classifyTrayState('PETG-CF')).toBe('present');
  });
});

describe('filamentWeight (Creality cm → g conversion)', () => {
  it('uses the density and diameter Spoolman has for the filament', () => {
    // volume = π * 0.0875^2 * 100 = 2.40528 cm³; * 1.24 = 2.9825 g
    expect(filamentWeight(100, { density: 1.24, diameter: 1.75 })).toBeCloseTo(2.9825, 3);
    expect(filamentWeight(100, { density: 1.24, diameter: 2.85 })).toBeCloseTo(Math.PI * 0.1425 ** 2 * 100 * 1.24, 3);
  });

  it('falls back to the material table, then PLA, and to 1.75mm', () => {
    expect(filamentWeight(100, { material: 'abs' })).toBeCloseTo(2.40528 * MATERIAL_DENSITY.ABS, 3);
    expect(filamentWeight(100, { material: 'WoodFill' })).toBeCloseTo(2.9825, 3);
    expect(filamentWeight(100)).toBeCloseTo(2.9825, 3);
  });

  it('scales linearly with length and is zero at zero', () => {
    expect(filamentWeight(0)).toBe(0);
    expect(filamentWeight(200)).toBeCloseTo(2 * filamentWeight(100), 6);
  });
});

describe('isValidTrayUuid', () => {
  it('rejects empty / unknown / all-zero ids (non-Bambu spools)', () => {
    expect(isValidTrayUuid(undefined)).toBe(false);
    expect(isValidTrayUuid(null)).toBe(false);
    expect(isValidTrayUuid('')).toBe(false);
    expect(isValidTrayUuid('unknown')).toBe(false);
    expect(isValidTrayUuid('0000000000000000')).toBe(false);
  });

  it('accepts a real serial', () => {
    expect(isValidTrayUuid('A1B2C3D4')).toBe(true);
    expect(isValidTrayUuid('0000A0000')).toBe(true); // not all zeros
  });
});

describe('isActivePrintState', () => {
  it('treats terminal/unknown states as inactive', () => {
    for (const state of [undefined, null, '', 'idle', 'finished', 'completed', 'complete', 'offline', 'off', 'none', 'unknown', 'unavailable']) {
      expect(isActivePrintState(state)).toBe(false);
    }
  });

  it('treats printing/pausing style states as active', () => {
    for (const state of ['printing', 'running', 'paused', 'pause', 'prepare', 'slicing', 'auto_bed_leveling']) {
      expect(isActivePrintState(state)).toBe(true);
    }
  });
});

describe('isPhantomSerialReport', () => {
  const UUID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

  it('rejects a serial on a slot that reports empty', () => {
    expect(isPhantomSerialReport(UUID, { attributes: { empty: true, tray_uuid: UUID } })).toBe(true);
  });

  it('rejects a serial the slot no longer reports', () => {
    expect(isPhantomSerialReport(UUID, { attributes: { empty: false, tray_uuid: '0000000000000000' } })).toBe(true);
  });

  it('accepts a serial the slot still reports, ignoring case', () => {
    expect(isPhantomSerialReport(UUID, { attributes: { empty: false, tray_uuid: UUID.toLowerCase() } })).toBe(false);
  });

  it('fails open without live state', () => {
    expect(isPhantomSerialReport(UUID, null)).toBe(false);
    expect(isPhantomSerialReport(UUID, {})).toBe(false);
    expect(isPhantomSerialReport(UUID, { attributes: { tray_uuid: '' } })).toBe(false);
  });
});
