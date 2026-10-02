/**
 * Printers the user removed from SpoolmanSync ("hidden" printers).
 *
 * Removing a printer here only hides it from SpoolmanSync — it stays in Home
 * Assistant — so every load has to decide which discovered printers belong to a
 * removed config entry.
 *
 * Match on the HA config entry id, never on the entry title. The title is free
 * text the user can rename in HA, and matching it as a substring hid printers
 * that had nothing to do with the removed one (issue #86):
 *   - Hiding a printer titled "A1" also hid an X2D and an A2L, because their
 *     serials contain the letters "a1" (sensor.x2d_20p8bj5a1500474_...).
 *   - Hiding a Creality printer hid nothing at all, because its title
 *     ("Creality Printer (WS) (192.168.1.10)") appears in no entity_id, so the
 *     printer stayed on the dashboard after being removed.
 *
 * Entry ids are opaque, stable HA identifiers, so an exact comparison can't
 * collide. They are already what the hidden list is keyed by, so nothing needs
 * migrating; the stored title is now only a fallback for a printer that reaches
 * us with no entry id at all.
 */

/** One entry of the stored `hidden_printers` setting. */
export interface HiddenPrinterRecord {
  entryId: string;
  title: string;
}

/** The parts of a discovered printer this filter looks at. */
export interface HideablePrinter {
  name: string;
  entity_id: string;
  entry_id?: string;
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Whether a discovered printer belongs to a removed config entry.
 *
 * A printer that carries an entry id is decided by that id alone — it is never
 * also tested against titles, so one printer's title can never hide another.
 * The title fallback applies only to a printer with no entry id (an HA core old
 * enough to send none of the config-entry fields), and then only on an exact
 * name match, so the worst case is a printer that stays visible rather than the
 * wrong printer disappearing.
 */
export function isPrinterHidden(
  printer: HideablePrinter,
  hidden: HiddenPrinterRecord[],
): boolean {
  if (hidden.length === 0) return false;

  const entryId = normalize(printer.entry_id);
  if (entryId) {
    return hidden.some(h => normalize(h.entryId) === entryId);
  }

  const name = normalize(printer.name);
  if (!name) return false;
  return hidden.some(h => normalize(h.title) === name);
}

/** Drop every printer belonging to a removed config entry. */
export function filterHiddenPrinters<T extends HideablePrinter>(
  printers: T[],
  hidden: HiddenPrinterRecord[],
): T[] {
  if (hidden.length === 0) return [...printers];
  return printers.filter(p => !isPrinterHidden(p, hidden));
}
