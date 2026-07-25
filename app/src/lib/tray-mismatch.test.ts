import { describe, it, expect } from 'vitest';
import { detectTrayMismatch, baseMaterialToken, normalizeHexColor } from './tray-mismatch';
import type { HATray } from './api/homeassistant';
import type { Spool } from './api/spoolman';

/**
 * The "possible wrong spool" dashboard banner. False positives matter: a warning
 * users learn to ignore stops working as a warning, and two of the comparisons
 * here previously flagged correctly-assigned spools — a '#'-prefixed Spoolman
 * colour (compared against a stripped RFID colour) and common material variants
 * like "PLA+" / "PLA_Basic" against ha-bambulab's "PLA".
 */

const REAL_UUID = 'A1B2C3D4E5F60718';

function tray(overrides: Partial<HATray> = {}): HATray {
  return {
    entity_id: 'sensor.x1c_ams_1_tray_1',
    unique_id: 'x1c_ams_1_tray_1',
    tray_number: 1,
    tray_uuid: REAL_UUID,
    name: 'Bambu PLA Basic',
    material: 'PLA',
    color: '#042f56ff',
    ...overrides,
  } as HATray;
}

function spool(material: string, colorHex: string | null): Spool {
  return {
    id: 1,
    filament: { id: 1, name: 'F', material, color_hex: colorHex },
    extra: {},
  } as unknown as Spool;
}

describe('normalizeHexColor', () => {
  it('strips a leading # and an RFID alpha channel, and case-folds', () => {
    expect(normalizeHexColor('#042f56ff')).toBe('042f56');
    expect(normalizeHexColor('042F56')).toBe('042f56');
    expect(normalizeHexColor('#042F56')).toBe('042f56');
  });

  it('returns empty for missing values', () => {
    expect(normalizeHexColor(undefined)).toBe('');
    expect(normalizeHexColor(null)).toBe('');
    expect(normalizeHexColor('')).toBe('');
  });
});

describe('baseMaterialToken', () => {
  it('reduces common Spoolman variants to the printer-reported base', () => {
    expect(baseMaterialToken('PLA Matte')).toBe('PLA');
    expect(baseMaterialToken('PLA Silk+')).toBe('PLA');
    expect(baseMaterialToken('PLA+')).toBe('PLA');
    expect(baseMaterialToken('PLA_Basic')).toBe('PLA');
    expect(baseMaterialToken('  pla  ')).toBe('PLA');
  });

  it('keeps compound materials distinct (deliberate)', () => {
    expect(baseMaterialToken('PLA-CF')).toBe('PLA-CF');
    expect(baseMaterialToken('PA-GF')).toBe('PA-GF');
  });

  it('returns empty for missing values', () => {
    expect(baseMaterialToken(undefined)).toBe('');
    expect(baseMaterialToken('')).toBe('');
  });
});

describe('detectTrayMismatch — no warning when things actually agree', () => {
  it('matching material and colour', () => {
    expect(detectTrayMismatch(tray(), spool('PLA', '042f56'))).toBeNull();
  });

  it('Spoolman colour stored WITH a leading # (regression)', () => {
    expect(detectTrayMismatch(tray(), spool('PLA', '#042f56'))).toBeNull();
  });

  it('material variants: PLA+ / PLA_Basic / PLA Matte vs PLA', () => {
    expect(detectTrayMismatch(tray(), spool('PLA+', '042f56'))).toBeNull();
    expect(detectTrayMismatch(tray(), spool('PLA_Basic', '042f56'))).toBeNull();
    expect(detectTrayMismatch(tray(), spool('PLA Matte', '042f56'))).toBeNull();
  });

  it('a side with no value is unknown, not a disagreement', () => {
    expect(detectTrayMismatch(tray({ material: undefined }), spool('PLA', '042f56'))).toBeNull();
    expect(detectTrayMismatch(tray(), spool('', '042f56'))).toBeNull();
    expect(detectTrayMismatch(tray({ color: undefined }), spool('PLA', '042f56'))).toBeNull();
    expect(detectTrayMismatch(tray(), spool('PLA', null))).toBeNull();
  });
});

describe('detectTrayMismatch — skipped entirely without usable RFID data', () => {
  it('all-zero tray_uuid (third-party spool)', () => {
    expect(detectTrayMismatch(
      tray({ tray_uuid: '0000000000000000' }), spool('PETG', 'ff0000'))).toBeNull();
  });

  it("literal 'unknown' tray_uuid", () => {
    expect(detectTrayMismatch(
      tray({ tray_uuid: 'unknown' }), spool('PETG', 'ff0000'))).toBeNull();
  });

  it('missing tray_uuid', () => {
    expect(detectTrayMismatch(
      tray({ tray_uuid: undefined }), spool('PETG', 'ff0000'))).toBeNull();
  });

  it('empty tray', () => {
    expect(detectTrayMismatch(tray({ name: 'Empty' }), spool('PETG', 'ff0000'))).toBeNull();
    expect(detectTrayMismatch(tray({ name: '' }), spool('PETG', 'ff0000'))).toBeNull();
  });
});

describe('detectTrayMismatch — still catches genuine mismatches', () => {
  it('different material', () => {
    const m = detectTrayMismatch(tray(), spool('PETG', '042f56'));
    expect(m?.type).toBe('material');
  });

  it('PLA-CF is not PLA', () => {
    expect(detectTrayMismatch(tray(), spool('PLA-CF', '042f56'))?.type).toBe('material');
  });

  it('different colour', () => {
    const m = detectTrayMismatch(tray(), spool('PLA', 'ff0000'));
    expect(m?.type).toBe('color');
    expect(m?.printerReports.color).toBe('#042f56');
    expect(m?.spoolmanHas.color).toBe('#ff0000');
  });

  it('both', () => {
    expect(detectTrayMismatch(tray(), spool('ABS', 'ff0000'))?.type).toBe('both');
  });
});
