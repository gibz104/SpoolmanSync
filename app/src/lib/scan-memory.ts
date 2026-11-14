/**
 * The spool or slot scanned last on this device, so that scanning the other
 * one next assigns the spool there (#97). Kept in the browser for a few
 * minutes: a later scan is a new errand, not the second half of this one.
 */
const SPOOL_KEY = 'spoolmansync-scanned-spool';
const SLOT_KEY = 'spoolmansync-scanned-slot';
export const PAIR_WINDOW_MS = 10 * 60_000;

function remember(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // Storage blocked (private mode): pairing scans just isn't offered.
  }
}

function recall(key: string): unknown {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && typeof saved.at === 'number' && Date.now() - saved.at < PAIR_WINDOW_MS) return saved.value;
  } catch {
    // Unreadable: treat as nothing scanned.
  }
  return null;
}

export function rememberSpool(id: number): void {
  remember(SPOOL_KEY, id);
}

export function rememberSlot(key: string): void {
  remember(SLOT_KEY, key);
}

export function recentSpool(): number | null {
  const id = recall(SPOOL_KEY);
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

export function recentSlot(): string | null {
  const key = recall(SLOT_KEY);
  return typeof key === 'string' && key ? key : null;
}

/** Once a spool is assigned, both scans are used up. */
export function forgetScans(): void {
  try {
    localStorage.removeItem(SPOOL_KEY);
    localStorage.removeItem(SLOT_KEY);
  } catch {
    // Nothing to forget.
  }
}
