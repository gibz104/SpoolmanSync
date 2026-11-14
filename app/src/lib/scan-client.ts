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
