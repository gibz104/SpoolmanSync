/**
 * Pure helpers for the HA webhook. Kept dependency-free (no DB / no network) so
 * the deduction- and assignment-critical logic can be unit-tested in isolation.
 */

/** Returns true if tray_uuid is a real spool identifier (not empty, unknown, or all zeros). */
export function isValidTrayUuid(tray_uuid: string | undefined | null): boolean {
  if (!tray_uuid || tray_uuid === 'unknown' || tray_uuid === '') return false;
  // ha-bambulab reports all zeros for non-Bambu spools without RFID tags
  if (tray_uuid.replace(/0/g, '') === '') return false;
  return true;
}

/**
 * Material density lookup (g/cm³) for converting filament length to weight.
 * Used when Creality printers report usage in cm instead of grams.
 * Standard filament diameter: 1.75mm
 */
export const MATERIAL_DENSITY: Record<string, number> = {
  PLA: 1.24,
  'PLA+': 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PC: 1.20,
  PA: 1.14,    // Nylon
  'PA-CF': 1.35,
  'PA-GF': 1.36,
  PVA: 1.23,
  HIPS: 1.04,
};

/**
 * Convert filament length (cm) to weight (grams).
 * Uses filament diameter of 1.75mm and material-specific density.
 */
export function lengthToWeight(lengthCm: number, material?: string): number {
  const radiusCm = 0.0875; // 1.75mm / 2, converted to cm
  const volumeCm3 = Math.PI * radiusCm * radiusCm * lengthCm;
  const density = (material && MATERIAL_DENSITY[material.toUpperCase()]) || MATERIAL_DENSITY.PLA;
  return volumeCm3 * density;
}

/**
 * Classify a printer-reported tray `name` into how the webhook should treat it
 * (issue #65). This is the single guard that decides whether a spool assignment
 * may be cleared:
 *  - 'transient': HA doesn't know yet (unavailable/unknown) or sent no name.
 *    NEVER clear an assignment on this — it's a reconnect/resync glitch.
 *  - 'empty': a real empty-slot signal — literal "Empty" (ha-bambulab) or a blank
 *    name (ha_creality_ws). The webhook still re-queries live HA state before
 *    actually unassigning.
 *  - 'present': filament is loaded.
 */
export function classifyTrayState(name: string | null | undefined): 'transient' | 'empty' | 'present' {
  const nameLower = (name ?? '').toString().toLowerCase();
  if (name === undefined || name === null || nameLower === 'unavailable' || nameLower === 'unknown') {
    return 'transient';
  }
  if (nameLower === 'empty' || name === '') {
    return 'empty';
  }
  return 'present';
}

/**
 * Returns true when the printer stage/status represents an active or pausing
 * print. Empty-tray events during these states can be Bambu AMS runout / auto-
 * refill transitions; clearing the old tray assignment immediately can make the
 * subsequent usage flush unable to find the ran-out spool.
 */
export function isActivePrintState(state: string | null | undefined): boolean {
  const normalized = (state ?? '').toString().trim().toLowerCase();

  if (!normalized || ['idle', 'finished', 'completed', 'complete', 'offline', 'off', 'none', 'unknown', 'unavailable'].includes(normalized)) {
    return false;
  }

  return true;
}
