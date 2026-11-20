/**
 * The order the user put their printers in (#105), kept in Settings as a JSON
 * list of printer prefixes, which survive renames. Printers it doesn't list,
 * such as one added later, follow the listed ones in the order they were found.
 */

export const PRINTER_ORDER_KEY = 'printer_order';

const MAX_ENTRIES = 100;

/** The stored order, or [] if there is none or it can't be read. */
export function parsePrinterOrder(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a request's order is a list of printer prefixes. */
export function isPrinterOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ENTRIES
    && value.every(p => typeof p === 'string' && p.length > 0 && p.length <= 200);
}

/** The printers in `order`; the ones it doesn't list follow, in their own order. */
export function sortPrinters<T extends { prefix: string }>(printers: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((prefix, i) => [prefix, i]));
  return printers
    .map((printer, i) => ({ printer, rank: rank.get(printer.prefix) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ printer }) => printer);
}

/** `prefixes` with `prefix` moved one place up (-1) or down (1). */
export function movePrinter(prefixes: readonly string[], prefix: string, offset: -1 | 1): string[] {
  const next = [...prefixes];
  const from = next.indexOf(prefix);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The order to store when the user reorders the printers they can see: theirs,
 * then the stored order's other printers, so one Home Assistant didn't report
 * this time, or that the user removed and may add back, keeps a place.
 */
export function mergePrinterOrder(shown: readonly string[], stored: readonly string[]): string[] {
  const seen = new Set(shown);
  return [...shown, ...stored.filter(p => !seen.has(p))].slice(0, MAX_ENTRIES);
}
