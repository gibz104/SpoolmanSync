/**
 * Creality (ha_creality_ws / CFS) protocol quirks.
 *
 * Kept in one dependency-free module so the brand-specific decoding is
 * unit-testable and documented in a single place, rather than smeared across
 * entity discovery and the YAML generator.
 */

/**
 * Home Assistant integrations whose trays carry no per-spool identifier, so a
 * `tray_uuid` arriving from one must never be treated as a spool serial.
 *
 * ha_creality_ws surfaces the CFS slot's `rfid` attribute, which is Creality's
 * MATERIAL-TYPE code (PLA `00001`, PETG `00003`, ...) — shared by every spool of
 * that material and hand-settable on the printer. Storing it as a serial made
 * SpoolmanSync auto-assign whichever spool last carried that code, and steal the
 * code off its sibling spool on every print.
 *
 * Current SpoolmanSync automations send an empty tray_uuid for Creality, so this
 * is a backstop for installs still running automations generated before that
 * change — an upgrade should not need a YAML re-apply to stop mis-assigning.
 */
export const PLATFORMS_WITHOUT_SPOOL_SERIALS: ReadonlySet<string> = new Set(['ha_creality_ws']);

/**
 * Whether a tray on `platform` may have its reported tray_uuid treated as a
 * per-spool serial.
 *
 * Fails OPEN on an unknown platform (registry unreachable, entity not in the
 * registry): a brief Home Assistant hiccup must not silently disable Bambu's
 * legitimate auto-matching, whose worst case is a missed convenience rather than
 * a wrong assignment.
 */
export function trayCarriesSpoolSerial(platform: string | undefined | null): boolean {
  return !platform || !PLATFORMS_WITHOUT_SPOOL_SERIALS.has(platform);
}

/**
 * Decode a CFS slot's `color_hex` attribute into a bare 6-char RGB hex.
 *
 * Creality encodes colour as `#0rrggbb` — SEVEN hex characters, where the
 * leading nibble is a fixed alpha byte and the real RGB value is the LAST six.
 * The integration passes the printer's string through verbatim, so it arrives
 * here in that form.
 *
 * Reading the first six characters instead (which is what stripping '#' and
 * truncating does) shifts every colour by a nibble: white `#0ffffff` reads as
 * `0fffff`, orange `#0ffa800` as `0ffa80`. Only black survives by coincidence,
 * which is why every non-black Creality spool used to trip the "possible wrong
 * spool" mismatch banner.
 *
 * Confirmed against the raw MIFARE tag layout (7-nibble colour field), a
 * printer's own material_box_info.json / tn_data.json, the reverse-engineered
 * WebSocket protocol (`"color": "#0rrggbb"`), and ha_creality_ws issue #113.
 *
 * Anything that isn't a recognisable 6- or 7-char hex value is returned as
 * undefined: an unparseable colour is unknown, and callers must not compare
 * against a guess.
 */
export function normalizeCrealityColorHex(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const hex = raw.trim().replace(/^#/, '').toLowerCase();

  // `#0rrggbb` — drop Creality's fixed leading alpha nibble.
  if (/^0[0-9a-f]{6}$/.test(hex)) return hex.slice(1);

  // Already a plain RGB value (hand-configured slots, or a firmware that
  // reports the short form).
  if (/^[0-9a-f]{6}$/.test(hex)) return hex;

  return undefined;
}
