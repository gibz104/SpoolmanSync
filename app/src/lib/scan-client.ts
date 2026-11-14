/**
 * The browser side of scanning: what a code opens, and assigning the spool.
 */
import { parseScanLink, type ScanTarget } from '@/lib/scan-codes';
import { forgetScans } from '@/lib/scan-memory';

/**
 * The spool or slot a scanned or typed code means: a link straight away,
 * anything else looked up by the server (see resolveScanCode). Null when
 * nothing matches; throws when the lookup itself fails.
 */
export async function lookUpScanCode(code: string): Promise<ScanTarget | null> {
  const link = parseScanLink(code);
  if (link) return link;
  const res = await fetch(`/api/spools/resolve?code=${encodeURIComponent(code.trim())}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to look up the code');
  return (await res.json()).target;
}

export interface LinkResult {
  /** Spoolman links tags (0.27 and later). */
  supported: boolean;
  linked: boolean;
  /** The spool the link was moved from, if another spool held the tag. */
  movedFrom?: number | null;
  error?: string;
}

/**
 * Link an NFC tag to a spool in Spoolman. With `move: false` (a tag only being
 * read), a tag Spoolman already knows is left where it is. Never throws.
 */
export async function linkTag(spoolId: number, uid: string, { move = true } = {}): Promise<LinkResult> {
  try {
    const res = await fetch('/api/spools/tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spoolId, uid, move }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { supported: true, linked: false, error: data.error || 'Could not link the tag in Spoolman' };
    return { supported: data.supported !== false, linked: !!data.linked, movedFrom: data.movedFrom ?? null };
  } catch {
    return { supported: true, linked: false, error: 'SpoolmanSync could not be reached' };
  }
}

/** Assign a spool to a tray or slot. Any scans that led here are used up. */
export async function assignSpool(spoolId: number, slotKey: string): Promise<void> {
  const res = await fetch('/api/spools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spoolId, trayId: slotKey }),
  });
  if (!res.ok) throw new Error('Failed to assign spool');
  forgetScans();
}
