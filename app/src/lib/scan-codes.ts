/**
 * What a scanned code points at: a QR label, the link on an NFC tag, a line a
 * USB reader types in kiosk mode, or an id typed by hand.
 *
 * Spool links come from SpoolmanSync (/scan/spool/12) and Spoolman
 * (web+spoolman:s-12, /spool/show/12). Slot links come from SpoolmanSync
 * (/scan/tray/<key>): the AMS tray, external spool or storage slot a spool
 * goes in, so that scanning a spool and then a slot assigns it (#97).
 */
export type ScanTarget = { kind: 'spool'; id: number } | { kind: 'slot'; key: string };

/** A spool or slot link, or null for anything else (a bare number is resolved by the server). */
export function parseScanLink(input: string): ScanTarget | null {
  const text = input.trim();
  const slot = text.match(/\/scan\/tray\/([^/?#\s]+)/i);
  if (slot) {
    const key = slotKeyFromSegment(slot[1]);
    return key ? { kind: 'slot', key } : null;
  }
  const id = text.match(/\/scan\/spool\/(\d+)/i)?.[1]
    ?? text.match(/web\+spoolman:s-(\d+)/i)?.[1]
    ?? text.match(/\/spool\/show\/(\d+)/i)?.[1];
  return id ? { kind: 'spool', id: Number(id) } : null;
}

/** The path of a slot's page, which its tag or QR code links to. */
export function slotPath(key: string): string {
  return `/scan/tray/${encodeURIComponent(key)}`;
}

/** A slot's key from the last segment of its path (see slotPath), or null if it can't be decoded. */
export function slotKeyFromSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment) || null;
  } catch {
    return null;
  }
}

/**
 * A spool's id from the last segment of a link's path, such as the 12 of
 * Spoolman's /spool/show/12, or null if the segment is not a whole number.
 */
export function spoolIdFromSegment(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) ? id : null;
}

/** The page a scanned spool or slot opens. */
export function scanTargetPath(target: ScanTarget): string {
  return target.kind === 'spool' ? `/scan/spool/${target.id}` : slotPath(target.key);
}

/**
 * A tag's hardware UID the way Spoolman stores it (#89): upper-case hex, no
 * separators, a whole number of bytes. Readers each spell it their own way
 * (Web NFC "04:a2:b3:c4", others "04-A2-B3-C4" or "04a2b3c4"). '' if the text
 * is not a UID.
 */
export function normalizeTagUid(uid: string): string {
  const hex = uid.replace(/[\s:_.-]+/g, '').toUpperCase().replace(/^0X/, '');
  return /^[0-9A-F]+$/.test(hex) && hex.length % 2 === 0 && hex.length <= 64 ? hex : '';
}
