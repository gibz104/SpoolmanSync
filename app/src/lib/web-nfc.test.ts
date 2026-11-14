import { describe, it, expect } from 'vitest';
import { isSecureUrl, nfcErrorMessage, webNfcBlocker, type NfcEnvironment } from './web-nfc';

/**
 * Issue #84: in the Home Assistant sidebar and app, writing a tag failed only
 * after a spool was picked, with a message about browser permissions. Each
 * case is now named up front.
 */

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const HA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Home Assistant/2026.10.1-12345 (Android 14; Pixel 8)';
const HA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Home Assistant/2026.10.0 (io.robbie.HomeAssistant; build:2026.1001; iOS 18.0.0)';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const env = (overrides: Partial<NfcEnvironment>): NfcEnvironment =>
  ({ userAgent: CHROME_ANDROID, secure: true, hasNdefReader: true, embedded: false, ...overrides });

describe('webNfcBlocker', () => {
  it('lets Chrome on Android write on its own https:// page', () => {
    expect(webNfcBlocker(env({}))).toBeNull();
  });

  it('names the Home Assistant sidebar, where Chrome refuses Web NFC in the iframe', () => {
    expect(webNfcBlocker(env({ embedded: true }))).toBe('embedded');
  });

  it('names the Home Assistant app on either platform, embedded or not', () => {
    expect(webNfcBlocker(env({ userAgent: HA_ANDROID, embedded: true }))).toBe('companion-app');
    expect(webNfcBlocker(env({ userAgent: HA_ANDROID }))).toBe('companion-app');
    expect(webNfcBlocker(env({ userAgent: HA_IOS, hasNdefReader: false, embedded: true }))).toBe('companion-app');
  });

  it('asks for https:// before calling the browser unsupported, as http:// pages hide NDEFReader', () => {
    expect(webNfcBlocker(env({ secure: false, hasNdefReader: false }))).toBe('insecure');
    expect(webNfcBlocker(env({ secure: false, hasNdefReader: false, embedded: true }))).toBe('insecure');
  });

  it('calls a browser without Web NFC unsupported, in the sidebar or not', () => {
    expect(webNfcBlocker(env({ userAgent: SAFARI_IOS, hasNdefReader: false }))).toBe('unsupported');
    expect(webNfcBlocker(env({ userAgent: SAFARI_IOS, hasNdefReader: false, embedded: true }))).toBe('unsupported');
  });
});

describe('isSecureUrl', () => {
  it('accepts https:// and this device itself', () => {
    expect(isSecureUrl('https://spoolmansync.example.com/scan')).toBe(true);
    expect(isSecureUrl('http://localhost:3000/scan')).toBe(true);
    expect(isSecureUrl('http://127.0.0.1:3000/scan')).toBe(true);
  });

  it('rejects http:// on the network, and anything unparseable', () => {
    expect(isSecureUrl('http://192.168.1.10:3000/scan')).toBe(false);
    expect(isSecureUrl('/scan')).toBe(false);
  });
});

describe('nfcErrorMessage', () => {
  const named = (name: string) => Object.assign(new Error('x'), { name });

  it('explains the errors Web NFC raises', () => {
    expect(nfcErrorMessage(named('NotAllowedError'), 'fallback')).toMatch(/permission is blocked/);
    expect(nfcErrorMessage(named('SecurityError'), 'fallback')).toMatch(/not inside Home Assistant/);
    expect(nfcErrorMessage(named('NotReadableError'), 'fallback')).toMatch(/busy or switched off/);
  });

  it('falls back for anything else', () => {
    expect(nfcErrorMessage(named('TypeError'), 'Could not start reading NFC tags.')).toBe('Could not start reading NFC tags.');
    expect(nfcErrorMessage('not an error', 'fallback')).toBe('fallback');
  });
});
