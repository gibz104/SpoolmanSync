/**
 * Learning a spool's RFID serial (tray_uuid) at assignment time, and suggesting
 * spools for a tray whose serial nobody owns yet.
 *
 * SpoolmanSync used to learn a serial only at the end of a spool's first tracked
 * print. Until then a freshly loaded Bambu spool matched nothing, so the
 * previous spool stayed assigned to the tray. These helpers are pure so the
 * rules are unit-testable; the routes do the I/O.
 */
import type { Spool } from './api/spoolman';
import { normalizeTag } from './api/spoolman';
import { baseMaterialToken, normalizeHexColor } from './tray-mismatch';
import { isValidTrayUuid } from './webhook-helpers';

export interface TrayReport {
  tray_uuid?: string | null;
  material?: string | null;
  color?: string | null;
}

/**
 * Whether the filament a tray reports is the filament of `spool`. Both base
 * material and colour must be known and equal. This guards against the user
 * assigning a spool in the app before physically swapping it: the tray then
 * still reports the old spool, whose serial must not be written to the new one.
 * Strict on purpose; skipping a store only defers learning to the first print.
 */
export function trayMatchesSpool(tray: TrayReport, spool: Spool): boolean {
  const material = baseMaterialToken(tray.material);
  const color = normalizeHexColor(tray.color);
  if (!material || !color) return false;
  return (
    material === baseMaterialToken(spool.filament?.material) &&
    color === normalizeHexColor(spool.filament?.color_hex)
  );
}

/**
 * Whether a serial reported by a tray should be written to `spool` when the user
 * assigns it. Conservative on purpose: the tray must report the spool's own
 * filament, the spool must have no tag yet, and no other active spool may own
 * the serial (the webhook's first-print path remains the one that moves
 * ownership and also corrects a wrong tag).
 */
export function shouldStoreTagOnAssign(tray: TrayReport, spool: Spool, allSpools: Spool[]): boolean {
  if (!isValidTrayUuid(tray.tray_uuid)) return false;
  const target = normalizeTag(tray.tray_uuid);
  if (!target) return false;
  if (!trayMatchesSpool(tray, spool)) return false;
  if (normalizeTag(spool.extra?.['tag']) !== '') return false;
  return !allSpools.some(s => s.id !== spool.id && normalizeTag(s.extra?.['tag']) === target);
}

export interface SpoolCandidate {
  spoolId: number;
  name: string;
  /** Euclidean RGB distance to the tray colour; null when either colour is unknown. */
  colorDistance: number | null;
}

function rgbDistance(a: string, b: string): number | null {
  if (!a || !b) return null;
  const c = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return Math.hypot(c(a, 0) - c(b, 0), c(a, 2) - c(b, 2), c(a, 4) - c(b, 4));
}

/**
 * Spools that could be the one just loaded into a tray whose serial no spool
 * owns: same base material, not archived, not already in a tray, and not
 * carrying a serial of their own (that one is a different physical spool).
 * Closest colour first; spools with unknown colour sort last.
 */
export function suggestCandidateSpools(
  tray: { material?: string | null; color?: string | null },
  spools: Spool[],
  limit = 3,
): SpoolCandidate[] {
  const material = baseMaterialToken(tray.material);
  const trayColor = normalizeHexColor(tray.color);

  return spools
    .filter(s => !s.archived)
    .filter(s => !s.extra?.['active_tray'] || s.extra['active_tray'] === JSON.stringify(''))
    .filter(s => normalizeTag(s.extra?.['tag']) === '')
    .filter(s => !material || baseMaterialToken(s.filament?.material) === material)
    .map(s => ({
      spoolId: s.id,
      name: s.filament?.name ?? `Spool #${s.id}`,
      colorDistance: rgbDistance(trayColor, normalizeHexColor(s.filament?.color_hex)),
    }))
    .sort((a, b) => (a.colorDistance ?? Infinity) - (b.colorDistance ?? Infinity) || a.spoolId - b.spoolId)
    .slice(0, limit);
}
