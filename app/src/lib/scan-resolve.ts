import type { Spool } from '@/lib/api/spoolman';
import { normalizeTagUid, parseScanLink, type ScanTarget } from '@/lib/scan-codes';

export interface ResolveDeps {
  /** Spoolman's spools, archived ones left out. */
  spools: () => Promise<Spool[]>;
  /** The spool a tag with this (normalized) UID is linked to in Spoolman, if any. */
  spoolByTagUid: (uid: string) => Promise<Spool | null>;
}

/** A spool's barcode extra field, which Spoolman stores JSON-encoded but older setups stored raw. */
function barcodeMatches(stored: string | undefined, code: string): boolean {
  return !!stored && (stored === code || stored === JSON.stringify(code) || stored === `"${code}"`);
}

/**
 * The spool or slot a scanned or typed code means (#89, #97). In order: a
 * spool or slot link, a spool's id, a spool's barcode, and the UID of an
 * NFC/RFID tag linked to a spool in Spoolman. A number goes through all of
 * them: a USB reader can type a tag's UID in digits only, and an id no spool
 * has may still be one.
 */
export async function resolveScanCode(code: string, deps: ResolveDeps): Promise<ScanTarget | null> {
  const text = code.trim();
  if (!text) return null;

  const link = parseScanLink(text);
  if (link) return link;

  const spools = await deps.spools();
  if (/^\d+$/.test(text)) {
    const byId = spools.find(s => s.id === Number(text));
    if (byId) return { kind: 'spool', id: byId.id };
  }

  const byBarcode = spools.find(s => barcodeMatches(s.extra?.barcode, text));
  if (byBarcode) return { kind: 'spool', id: byBarcode.id };

  const uid = normalizeTagUid(text);
  const tagged = uid ? await deps.spoolByTagUid(uid) : null;
  return tagged ? { kind: 'spool', id: tagged.id } : null;
}
