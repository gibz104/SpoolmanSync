/**
 * Whether this page can write NFC tags with Web NFC, and if not, why (issue #84).
 *
 * Web NFC needs Chrome (or another Chromium browser) on Android, an https://
 * page, and a page that is not embedded in another one. Home Assistant shows
 * add-ons in an iframe, and its companion app's web view reports NFC as
 * blocked, so in both the write used to fail only after a spool was picked,
 * with a message about browser permissions that no setting could fix.
 */
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

/** Write a link to the next tag held to the phone. Needs a page with no blocker. */
export async function writeNfcLink(url: string): Promise<void> {
  if (!window.NDEFReader) throw Object.assign(new Error('Web NFC is not available'), { name: 'NotSupportedError' });
  const reader = new window.NDEFReader();
  const scan = new AbortController();
  try {
    // Scanning first is what asks for NFC permission.
    await reader.scan({ signal: scan.signal });
    await reader.write({ records: [{ recordType: 'url', data: url }] });
  } finally {
    scan.abort();
  }
}

/** A sentence for a failed Web NFC call. */
export function nfcErrorMessage(err: unknown): string {
  switch (err instanceof Error ? err.name : '') {
    case 'NotAllowedError': return 'NFC permission is blocked. Allow NFC for this site in Chrome\'s site settings.';
    case 'NotSupportedError': return 'NFC is not supported on this device.';
    case 'NotReadableError': return 'Could not read the NFC tag. Make sure it\'s positioned correctly.';
    case 'NetworkError': return 'NFC transfer failed. Please try again.';
    case 'AbortError': return 'NFC operation was cancelled.';
    case 'SecurityError': return 'This page is not allowed to use NFC. Open SpoolmanSync on its own page in Chrome.';
    default: return 'Failed to write to the NFC tag.';
  }
}
