/**
 * Whether to refuse an API request a browser made on behalf of another site.
 *
 * SpoolmanSync has no login, so without this any web page a user visits could
 * use their browser to change its settings, assign spools, or reach Home
 * Assistant through it. Browsers label every request with Sec-Fetch-Site;
 * SpoolmanSync's own pages send 'same-origin' (behind Home Assistant's ingress
 * too, as the page and its API share Home Assistant's origin), and a typed
 * address sends 'none'. Home Assistant's webhook calls and other clients that
 * are not browsers send no such header, and are let through.
 *
 * The one API address reached from another site on purpose is the OAuth
 * callback, which Home Assistant redirects the browser to after login. It
 * checks the state value it issued, so it is left alone.
 */
export function isCrossSiteApiRequest(pathname: string, method: string, fetchSite: string | null): boolean {
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
  if (fetchSite !== 'cross-site' && fetchSite !== 'same-site') return false;
  return !(pathname === '/api/auth/ha/callback' && method === 'GET');
}
