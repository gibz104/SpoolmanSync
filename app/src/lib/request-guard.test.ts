import { describe, it, expect } from 'vitest';
import { isCrossSiteApiRequest } from './request-guard';

describe('isCrossSiteApiRequest', () => {
  it('refuses API requests a browser makes for another site', () => {
    expect(isCrossSiteApiRequest('/api/settings', 'POST', 'cross-site')).toBe(true);
    expect(isCrossSiteApiRequest('/api/printers/setup', 'POST', 'same-site')).toBe(true);
    // A GET with a side effect: the OAuth start fetches the URL it is given.
    expect(isCrossSiteApiRequest('/api/auth/ha', 'GET', 'cross-site')).toBe(true);
    expect(isCrossSiteApiRequest('/api', 'GET', 'cross-site')).toBe(true);
  });

  it("lets SpoolmanSync's own pages, typed addresses and clients that are not browsers through", () => {
    expect(isCrossSiteApiRequest('/api/settings', 'POST', 'same-origin')).toBe(false);
    expect(isCrossSiteApiRequest('/api/spools', 'GET', 'none')).toBe(false);
    // Home Assistant's webhook calls send no Sec-Fetch-Site.
    expect(isCrossSiteApiRequest('/api/webhook', 'POST', null)).toBe(false);
  });

  it('lets pages open from anywhere, such as a QR code or an NFC tag', () => {
    expect(isCrossSiteApiRequest('/scan/spool/12', 'GET', 'cross-site')).toBe(false);
    expect(isCrossSiteApiRequest('/', 'GET', 'same-site')).toBe(false);
    expect(isCrossSiteApiRequest('/apiary', 'GET', 'cross-site')).toBe(false);
  });

  it('leaves the OAuth callback, which Home Assistant redirects to, to its own state check', () => {
    expect(isCrossSiteApiRequest('/api/auth/ha/callback', 'GET', 'cross-site')).toBe(false);
    expect(isCrossSiteApiRequest('/api/auth/ha/callback', 'GET', 'same-site')).toBe(false);
    expect(isCrossSiteApiRequest('/api/auth/ha/callback', 'POST', 'cross-site')).toBe(true);
  });
});
