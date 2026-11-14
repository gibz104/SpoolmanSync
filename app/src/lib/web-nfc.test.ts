import { describe, it, expect, vi, afterEach } from 'vitest';
import { isSecureUrl, nfcErrorMessage, readNfcTag, webNfcBlocker, type NfcEnvironment } from './web-nfc';

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

describe('readNfcTag', () => {
  /** Chrome's NDEFReader, with a hand to hold tags to it. */
  class FakeReader {
    static last: FakeReader;
    static scanError: Error | null = null;
    onreading: ((event: unknown) => void) | null = null;
    onreadingerror: (() => void) | null = null;
    signal?: AbortSignal;
    constructor() { FakeReader.last = this; }
    async scan(options?: { signal?: AbortSignal }) {
      this.signal = options?.signal;
      if (FakeReader.scanError) throw FakeReader.scanError;
    }
    tap(serialNumber: string, records: { recordType: string; data?: DataView }[] = []) {
      this.onreading?.({ serialNumber, message: { records } });
    }
  }
  const record = (recordType: string, text: string) =>
    ({ recordType, data: new DataView(new TextEncoder().encode(text).buffer) });

  const withReader = () => {
    FakeReader.scanError = null;
    vi.stubGlobal('window', { NDEFReader: FakeReader });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('gives the tag\'s UID the way Spoolman stores it, and the text of its link and text records', async () => {
    withReader();
    const read = readNfcTag(new AbortController().signal);
    FakeReader.last.tap('04:a2:b3:c4:d5:e6:f7', [
      record('url', 'https://sync.example.com/scan/spool/7'),
      record('mime', 'not a link'),
      record('text', 'web+spoolman:s-7'),
    ]);
    expect(await read).toEqual({
      uid: '04A2B3C4D5E6F7',
      texts: ['https://sync.example.com/scan/spool/7', 'web+spoolman:s-7'],
    });
    // One tag, then the scan stops.
    expect(FakeReader.last.signal?.aborted).toBe(true);
  });

  it('reads a blank tag as its UID alone', async () => {
    withReader();
    const read = readNfcTag(new AbortController().signal);
    FakeReader.last.tap('aa:bb:cc:dd');
    expect(await read).toEqual({ uid: 'AABBCCDD', texts: [] });
  });

  it('keeps reading past a tag it could not read, and says so', async () => {
    withReader();
    const unreadable = vi.fn();
    const read = readNfcTag(new AbortController().signal, unreadable);
    FakeReader.last.onreadingerror?.();
    expect(unreadable).toHaveBeenCalledTimes(1);
    expect(FakeReader.last.signal?.aborted).toBe(false);
    FakeReader.last.tap('aa:bb:cc:dd');
    expect((await read).uid).toBe('AABBCCDD');
  });

  it('stops when the caller aborts, and ignores tags after that', async () => {
    withReader();
    const caller = new AbortController();
    const unreadable = vi.fn();
    const read = readNfcTag(caller.signal, unreadable);
    caller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeReader.last.signal?.aborted).toBe(true);
    FakeReader.last.onreadingerror?.();
    expect(unreadable).not.toHaveBeenCalled();
  });

  it('fails with the error the scan fails with, such as permission refused', async () => {
    withReader();
    FakeReader.scanError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await expect(readNfcTag(new AbortController().signal)).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('fails at once without Web NFC', async () => {
    vi.stubGlobal('window', {});
    await expect(readNfcTag(new AbortController().signal)).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});
