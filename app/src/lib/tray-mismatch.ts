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
import type { HATray } from './api/homeassistant';
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
 */
export function normalizeHexColor(color: string | undefined | null): string {
  return (color || '').replace('#', '').toLowerCase().substring(0, 6);
}

/**
 * Detect if the printer's RFID data doesn't match the assigned spool.
 *
 * Returns null when the tray carries no usable RFID data, when the tray is
 * empty, or when everything matches. Only meaningful for spools with RFID tags —
 * third-party spools have no printer-reported data to compare against.
 */
export function detectTrayMismatch(tray: HATray, assignedSpool: Spool): MismatchInfo | null {
  // Skip mismatch detection for non-RFID spools. ha-bambulab reports tray_uuid
  // as all zeros for third-party spools without RFID tags. The color/material
  // data for these is user-configured in Bambu Studio (not from RFID), so it
  // won't reliably match Spoolman's vendor data and would cause false warnings.
  // Shares isValidTrayUuid with the webhook so 'unknown' is rejected too.
  if (!isValidTrayUuid(tray.tray_uuid)) {
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

  const colorMismatch = !!rfidColor && !!spoolColor && rfidColor !== spoolColor;

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
