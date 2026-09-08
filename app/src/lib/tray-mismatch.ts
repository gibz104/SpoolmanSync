/**
 * Tray/spool mismatch detection.
 *
 * Compares what the printer's RFID reports for a tray against the spool the user
 * assigned to it, so an obviously-wrong assignment can be surfaced on the
 * dashboard before a print starts.
 *
 * Kept out of the API route so the comparison rules are unit-testable — false
 * positives here are worse than silence, since a warning users learn to ignore
 * is a warning that no longer works.
 */
import type { HATray, PrinterBrand } from './api/homeassistant';
import type { Spool } from './api/spoolman';
import { isValidTrayUuid } from './webhook-helpers';

export interface MismatchInfo {
  type: 'material' | 'color' | 'both';
  printerReports: {
    material?: string;
    color?: string;
  };
  spoolmanHas: {
    material: string;
    color: string;
  };
  message: string;
}

/**
 * Reduce a material string to the token we compare on.
 *
 * ha-bambulab reports "PLA", while Spoolman commonly holds "PLA Matte", "PLA+"
 * or "PLA_Basic" for the same filament — those are the same base material and
 * must not warn. Compound materials keep their hyphen ("PLA-CF" stays distinct
 * from "PLA"), which is deliberate: those really are different filaments.
 */
export function baseMaterialToken(material: string | undefined | null): string {
  return (material || '')
    .toUpperCase()
    .trim()
    .split(/[\s_]+/)[0]
    .replace(/\+$/, '');
}

/**
 * Bare 6-char RGB hex for comparison.
 *
 * Tolerates a leading '#' on either side and an RFID alpha suffix
 * (e.g. "#042f56ff" and "042F56" must compare equal). Spoolman's `color_hex` is
 * usually bare but is not guaranteed to be — comparing a '#'-prefixed value
 * against a stripped one shifted the window by a character and flagged every
 * such spool as a colour mismatch.
 *
 * Anything that is NOT a recognisable 6- or 8-char hex value returns '', which
 * callers treat as unknown and skip. This deliberately replaces a blind
 * `substring(0, 6)`: truncating an unrecognised value invents a colour that can
 * never match anything, producing a mismatch warning no user can clear. Brand
 * quirks are decoded before they reach here (see normalizeCrealityColorHex).
 */
export function normalizeHexColor(color: string | undefined | null): string {
  const hex = (color || '').trim().replace(/^#/, '').toLowerCase();

  if (/^[0-9a-f]{6}$/.test(hex)) return hex;
  // RRGGBBAA — ha-bambulab appends an alpha channel; the RGB is the first six.
  if (/^[0-9a-f]{8}$/.test(hex)) return hex.slice(0, 6);

  return '';
}

export interface MismatchOptions {
  /**
   * The printer's brand, which decides how "is this data trustworthy?" is
   * answered. Defaults to the Bambu rule (require a serial) when omitted.
   */
  brand?: PrinterBrand;
  /**
   * Compare material only, skipping color. Opt-in setting for users whose tags
   * report a color that doesn't describe the physical spool — third-party
   * Creality stickers commonly carry a default color, and there is no value the
   * user could enter in Spoolman that would ever match one (issue #79).
   */
  ignoreColor?: boolean;
}

/**
 * Detect if the printer's reported filament doesn't match the assigned spool.
 *
 * Returns null when the tray's data can't be trusted, when the tray is empty, or
 * when everything matches.
 */
export function detectTrayMismatch(
  tray: HATray,
  assignedSpool: Spool,
  options: MismatchOptions = {},
): MismatchInfo | null {
  // Is the tray's reported filament trustworthy enough to compare?
  //
  // Bambu: only when a real RFID serial is present. ha-bambulab reports an
  // all-zeros tray_uuid for third-party spools without tags, whose color and
  // material are whatever the user picked in Bambu Studio — comparing those
  // against Spoolman's vendor data caused false warnings. Shares
  // isValidTrayUuid with the webhook so 'unknown' is rejected too.
  //
  // Creality: always. Its CFS exposes no per-spool serial at all (see
  // src/lib/creality.ts), so gating on one would disable the check entirely.
  // The values are what the printer believes is loaded whether they came from a
  // tag or were entered on the printer, which is exactly what's worth comparing.
  if (options.brand !== 'creality' && !isValidTrayUuid(tray.tray_uuid)) {
    return null;
  }

  // If the tray has no material reported by printer, can't detect mismatch
  const trayName = tray.name?.toLowerCase().trim() || '';
  if (!trayName || trayName === 'empty') {
    return null;
  }

  const basePrinterMaterial = baseMaterialToken(tray.material);
  const baseSpoolMaterial = baseMaterialToken(assignedSpool.filament?.material);

  const rfidColor = normalizeHexColor(tray.color);
  const spoolColor = normalizeHexColor(assignedSpool.filament?.color_hex);

  // Only compare when BOTH sides have a value — a missing value is unknown,
  // not a disagreement.
  const materialMismatch =
    !!basePrinterMaterial &&
    !!baseSpoolMaterial &&
    basePrinterMaterial !== baseSpoolMaterial;

  const colorMismatch = !options.ignoreColor && !!rfidColor && !!spoolColor && rfidColor !== spoolColor;

  if (!materialMismatch && !colorMismatch) {
    return null;
  }

  const mismatchType: 'material' | 'color' | 'both' =
    materialMismatch && colorMismatch ? 'both' :
    materialMismatch ? 'material' : 'color';

  return {
    type: mismatchType,
    printerReports: {
      material: tray.material,
      color: `#${rfidColor}`,
    },
    spoolmanHas: {
      material: assignedSpool.filament?.material || '',
      color: `#${spoolColor}`,
    },
    message: `Mismatch detected: ${mismatchType}`,
  };
}
