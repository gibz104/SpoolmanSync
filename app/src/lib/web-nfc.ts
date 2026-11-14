/**
 * Whether this page can write NFC tags with Web NFC, and if not, why (issue #84).
 *
 * Web NFC needs Chrome (or another Chromium browser) on Android, an https://
 * page, and a page that is not embedded in another one. Home Assistant shows
 * add-ons in an iframe, and its companion app's web view reports NFC as
 * blocked, so in both the write used to fail only after a spool was picked,
 * with a message about browser permissions that no setting could fix.
 */
import { normalizeTagUid } from '@/lib/scan-codes';

// Web NFC (Chrome on Android), which TypeScript's DOM types leave out.
declare global {
  interface Window {
    NDEFReader?: new () => NDEFReader;
  }

  interface NDEFReader {
    write(message: NDEFMessageInit): Promise<void>;
    scan(options?: { signal?: AbortSignal }): Promise<void>;
    onreading: ((event: NDEFReadingEvent) => void) | null;
    onreadingerror: ((event: Event) => void) | null;
  }

  interface NDEFMessageInit {
    records: NDEFRecordInit[];
  }

  interface NDEFRecordInit {
    recordType: string;
    data?: string | BufferSource;
    mediaType?: string;
    id?: string;
    encoding?: string;
    lang?: string;
  }

  interface NDEFReadingEvent extends Event {
    message: NDEFMessage;
    /** The tag's hardware UID, colon-separated lower-case hex. */
    serialNumber: string;
  }

  interface NDEFMessage {
    records: NDEFRecord[];
  }

  interface NDEFRecord {
    recordType: string;
    data?: DataView;
    encoding?: string;
  }
}

export type NfcBlocker = 'companion-app' | 'insecure' | 'unsupported' | 'embedded';

export interface NfcEnvironment {
  userAgent: string;
  /** window.isSecureContext: https://, or http://localhost. */
  secure: boolean;
  hasNdefReader: boolean;
  /** Shown inside another page, as the Home Assistant sidebar shows add-ons. */
  embedded: boolean;
}

export function webNfcBlocker(env: NfcEnvironment): NfcBlocker | null {
  // The app's web view has NDEFReader but refuses it, inside an iframe or not.
  if (/Home ?Assistant\//i.test(env.userAgent)) return 'companion-app';
  // Browsers leave NDEFReader out of http:// pages, so this comes before support.
  if (!env.secure) return 'insecure';
  if (!env.hasNdefReader) return 'unsupported';
  // Chrome has NDEFReader in an iframe, but scan() and write() refuse to run there.
  if (env.embedded) return 'embedded';
  return null;
}

/** The blocker for the page this runs in (client-side only). */
export function currentNfcBlocker(): NfcBlocker | null {
  let embedded: boolean;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }
  return webNfcBlocker({
    userAgent: navigator.userAgent,
    secure: window.isSecureContext,
    hasNdefReader: 'NDEFReader' in window,
    embedded,
  });
}

/** An address a phone's browser treats as secure: https://, or this device itself. */
export function isSecureUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** What a tapped tag holds: its UID ('' if not reported) and its URL and text records' text. */
export interface TappedTag {
  uid: string;
  texts: string[];
}

/** The text of a tag's URL and text records, where a link would be. */
function recordTexts(event: NDEFReadingEvent): string[] {
  const texts: string[] = [];
  for (const record of event.message?.records ?? []) {
    if (!record.data || !['url', 'absolute-url', 'text'].includes(record.recordType)) continue;
    try {
      texts.push(new TextDecoder(record.encoding || 'utf-8').decode(record.data));
    } catch {
      // An encoding the browser can't decode holds no link we know.
    }
  }
  return texts;
}

/**
 * Wait for one tag to be tapped, and resolve with what it holds. The scan
 * stops after that tag; aborting `signal` stops it sooner and rejects with an
 * AbortError. A tag the phone can't read (moved away too soon, or not NDEF)
 * calls `onUnreadable` and the scan keeps going, so the next tap retries.
 * Needs a page with no blocker.
 */
export function readNfcTag(signal: AbortSignal, onUnreadable?: () => void): Promise<TappedTag> {
  return new Promise((resolve, reject) => {
    if (!window.NDEFReader) {
      reject(Object.assign(new Error('Web NFC is not available'), { name: 'NotSupportedError' }));
      return;
    }
    const scan = new AbortController();
    const cancel = () => {
      scan.abort();
      reject(Object.assign(new Error('NFC operation was cancelled'), { name: 'AbortError' }));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    const reader = new window.NDEFReader();
    reader.onreading = event => {
      if (scan.signal.aborted) return;
      signal.removeEventListener('abort', cancel);
      scan.abort();
      resolve({ uid: normalizeTagUid(event.serialNumber ?? ''), texts: recordTexts(event) });
    };
    reader.onreadingerror = () => {
      if (!scan.signal.aborted) onUnreadable?.();
    };
    reader.scan({ signal: scan.signal }).catch(err => {
      if (scan.signal.aborted) return;
      signal.removeEventListener('abort', cancel);
      reject(err);
    });
  });
}

/**
 * Write a link to the next tag held to the phone. With `withUid`, also return
 * the tag's UID, which the scan reports as the tag is tapped ('' if it didn't).
 * Needs a page with no blocker.
 */
export async function writeNfcLink(url: string, withUid = false): Promise<string> {
  if (!window.NDEFReader) throw Object.assign(new Error('Web NFC is not available'), { name: 'NotSupportedError' });
  const reader = new window.NDEFReader();
  const scan = new AbortController();
  let uid = '';
  reader.onreading = event => { uid = event.serialNumber ?? ''; };
  try {
    // Scanning first is what asks for NFC permission.
    await reader.scan({ signal: scan.signal });
    await reader.write({ records: [{ recordType: 'url', data: url }] });
    // The reading event can trail the write by a moment.
    for (let waited = 0; withUid && !uid && waited < 1000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    scan.abort();
  }
  return uid;
}

/** A sentence for a failed Web NFC call, or `fallback` for an error it has none for. */
export function nfcErrorMessage(err: unknown, fallback: string): string {
  switch (err instanceof Error ? err.name : '') {
    case 'NotAllowedError': return 'NFC permission is blocked. Allow NFC for this site in Chrome\'s site settings.';
    case 'NotSupportedError': return 'NFC is not supported on this device.';
    case 'NotReadableError': return 'The phone\'s NFC is busy or switched off. Check that NFC is on in Android\'s settings.';
    case 'NetworkError': return 'The tag moved away before it was done. Hold it still and try again.';
    case 'AbortError': return 'NFC operation was cancelled.';
    case 'SecurityError': return 'This page is not allowed to use NFC. Open SpoolmanSync on its own page in Chrome, not inside Home Assistant.';
    default: return fallback;
  }
}
