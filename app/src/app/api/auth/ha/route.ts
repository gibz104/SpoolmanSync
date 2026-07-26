import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { isNetworkError, isTimeoutError } from '@/lib/network-error';

/**
 * Get the base URL for OAuth callbacks from the request.
 * This handles various scenarios including reverse proxies and Docker networking.
 */
function getBaseUrl(request: NextRequest): string {
  // Explicit override always wins
  if (process.env.NEXTAUTH_URL) {
    return process.env.NEXTAUTH_URL;
  }

  // Check for forwarded host (reverse proxy scenario)
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost?.split(',')[0].trim() || request.headers.get('host');

  if (!host) {
    // Fallback to nextUrl.origin (shouldn't happen in practice)
    console.warn('[OAuth] No host header found, falling back to nextUrl.origin');
    return request.nextUrl.origin;
  }

  // Determine protocol (check for reverse proxy HTTPS termination)
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0].trim() || 'http';

  return `${protocol}://${host}`;
}

/**
 * Initiate OAuth2 flow with Home Assistant
 * GET /api/auth/ha?ha_url=http://homeassistant:8123
 */
export async function GET(request: NextRequest) {
  let haUrl = request.nextUrl.searchParams.get('ha_url');

  if (!haUrl) {
    return NextResponse.json({ error: 'ha_url is required' }, { status: 400 });
  }

  // Remove trailing slashes to prevent double-slash URLs
  haUrl = haUrl.replace(/\/+$/, '');

  // Pre-flight: confirm OUR SERVER can reach HA before sending the user
  // through the login flow. The browser reaching HA proves nothing about the
  // container (issue #74: Docker networking broke, and the failure only
  // surfaced after login as a baffling "OAuth authentication failed").
  //
  // This check must only ever block on PROOF of unreachability
  // (connection refused, DNS failure, host unreachable):
  //  - Any HTTP response counts as reachable — a healthy HA returns 401 to an
  //    unauthenticated /api/ call, and an auth proxy may return 401/403/3xx.
  //    redirect 'manual' so a proxy's redirect target never has to resolve
  //    from inside the container.
  //  - A TIMEOUT is not proof: HA mid-startup or under recorder load can take
  //    longer than any sane pre-flight budget. Proceed and let the flow fail
  //    later (as it always did) if the host truly never answers.
  //  - Any OTHER failure (TLS trust, odd URLs) proceeds too, preserving the
  //    exact pre-existing behavior for those setups. Blocking here with a
  //    networking message would misdiagnose them.
  // 12s outer budget: undici's own TCP connect timeout (~10s) must fire first,
  // so a silent-drop firewall surfaces as UND_ERR_CONNECT_TIMEOUT (a blockable
  // network error) rather than being masked by our outer TimeoutError.
  try {
    await fetch(`${haUrl}/api/`, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
  } catch (err) {
    if (isNetworkError(err) && !isTimeoutError(err)) {
      console.error(`[OAuth] Pre-flight to ${haUrl} failed (network):`, err);
      return NextResponse.json({
        error: `SpoolmanSync's server cannot reach Home Assistant at ${haUrl}. ` +
          'Your browser reaching it is not enough — the SpoolmanSync server itself needs network access to this address. ' +
          'Check Docker networking, firewall rules, and that the URL is reachable from inside the container.',
      }, { status: 400 });
    }
    // Timeout, TLS, or anything else: log and continue with the normal flow.
    console.warn(`[OAuth] Pre-flight to ${haUrl} inconclusive, continuing:`, err);
  }

  // Generate a random state for CSRF protection
  const state = crypto.randomUUID();

  // Get the callback URL (where HA will redirect after auth)
  const baseUrl = getBaseUrl(request);
  const redirectUri = `${baseUrl}/api/auth/ha/callback`;

  // Store the state, HA URL, and clientId temporarily for the callback
  // Storing clientId ensures we use the exact same value for token exchange
  await prisma.settings.upsert({
    where: { key: 'oauth_state' },
    update: { value: JSON.stringify({ state, haUrl, clientId: baseUrl }) },
    create: { key: 'oauth_state', value: JSON.stringify({ state, haUrl, clientId: baseUrl }) },
  });

  // Build the authorization URL
  // Home Assistant uses a standard OAuth2 flow
  const authUrl = new URL(`${haUrl}/auth/authorize`);
  authUrl.searchParams.set('client_id', baseUrl);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  return NextResponse.json({ authUrl: authUrl.toString() });
}
