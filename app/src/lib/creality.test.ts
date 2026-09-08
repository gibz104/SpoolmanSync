import { describe, it, expect } from 'vitest';
import { normalizeCrealityColorHex, trayCarriesSpoolSerial } from './creality';

/**
 * Creality encodes colour as `#0rrggbb` — seven hex chars, RGB in the LAST six.
 * Reading the first six shifted every colour by a nibble, which made every
 * non-black Creality spool trip the "possible wrong spool" banner permanently.
 */
describe('normalizeCrealityColorHex', () => {
  it('drops the leading alpha nibble from the printer 7-char form', () => {
    // Values taken from real printer dumps and ha_creality_ws issue #113.
    expect(normalizeCrealityColorHex('#0ffffff')).toBe('ffffff');
    expect(normalizeCrealityColorHex('#0000000')).toBe('000000');
    expect(normalizeCrealityColorHex('#0c12e1f')).toBe('c12e1f');
    expect(normalizeCrealityColorHex('#0ffa800')).toBe('ffa800');
    expect(normalizeCrealityColorHex('#01b04ae')).toBe('1b04ae');
  });

  it('accepts the bare (no #) and upper-case forms', () => {
    expect(normalizeCrealityColorHex('0FFFFFF')).toBe('ffffff');
    expect(normalizeCrealityColorHex('  #0FFA800  ')).toBe('ffa800');
  });

  it('passes a plain 6-char RGB value through unchanged', () => {
    // A 6-char value starting with 0 is RGB, not a truncated 7-char value —
    // length is what disambiguates.
    expect(normalizeCrealityColorHex('#0ffa80')).toBe('0ffa80');
    expect(normalizeCrealityColorHex('1b04ae')).toBe('1b04ae');
  });

  it('returns undefined for anything unrecognisable', () => {
    // Unknown beats guessing: an invented colour can never match, and the
    // resulting mismatch warning would be unclearable.
    expect(normalizeCrealityColorHex(undefined)).toBeUndefined();
    expect(normalizeCrealityColorHex(null)).toBeUndefined();
    expect(normalizeCrealityColorHex('')).toBeUndefined();
    expect(normalizeCrealityColorHex('-1')).toBeUndefined();       // empty CFS slot
    expect(normalizeCrealityColorHex('#fff')).toBeUndefined();     // shorthand
    expect(normalizeCrealityColorHex('#0ffffffff')).toBeUndefined();
    expect(normalizeCrealityColorHex('#0gggggg')).toBeUndefined();
    expect(normalizeCrealityColorHex(2)).toBeUndefined();
  });
});

/**
 * Backstop for installs still running automations generated before Creality
 * stopped sending its material-type code as a tray_uuid.
 */
describe('trayCarriesSpoolSerial', () => {
  it('rejects Creality trays, whose rfid attribute is a material code', () => {
    expect(trayCarriesSpoolSerial('ha_creality_ws')).toBe(false);
  });

  it('accepts Bambu trays, whose tray_uuid is a real per-spool serial', () => {
    expect(trayCarriesSpoolSerial('bambu_lab')).toBe(true);
  });

  it('fails open when the platform is unknown', () => {
    // The registry can be unreachable, or the entity absent from it. Failing
    // closed would silently disable Bambu auto-matching on any HA hiccup — a
    // worse outcome than briefly leaving the stale-automation backstop off.
    expect(trayCarriesSpoolSerial(undefined)).toBe(true);
    expect(trayCarriesSpoolSerial(null)).toBe(true);
    expect(trayCarriesSpoolSerial('')).toBe(true);
    expect(trayCarriesSpoolSerial('some_other_integration')).toBe(true);
  });
});
