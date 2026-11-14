/**
 * Whether this page can write NFC tags with Web NFC, and if not, why (issue #84).
 *
 * Web NFC needs Chrome (or another Chromium browser) on Android, an https://
 * page, and a page that is not embedded in another one. Home Assistant shows
 * add-ons in an iframe, and its companion app's web view reports NFC as
 * blocked, so in both the write used to fail only after a spool was picked,
 * with a message about browser permissions that no setting could fix.
 */
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
