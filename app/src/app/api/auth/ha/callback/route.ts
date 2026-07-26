import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createActivityLog } from '@/lib/activity-log';
import { isNetworkError } from '@/lib/network-error';

/**
 * Get the base URL for redirects from the request.
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
    console.warn('[OAuth Callback] No host header found, falling back to nextUrl.origin');
    return request.nextUrl.origin;
  }

  // Determine protocol (check for reverse proxy HTTPS termination)
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0].trim() || 'http';

  return `${protocol}://${host}`;
}

/**
 * OAuth2 callback from Home Assistant
 * GET /api/auth/ha/callback?code=...&state=...
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const baseUrl = getBaseUrl(request);

  if (!code || !state) {
    return NextResponse.redirect(new URL('/settings?error=missing_params', baseUrl));
  }

  try {
    // Retrieve the stored state and HA URL
    const storedData = await prisma.settings.findUnique({
      where: { key: 'oauth_state' },
    });

    if (!storedData) {
      return NextResponse.redirect(new URL('/settings?error=invalid_state', baseUrl));
    }

    const { state: storedState, haUrl: rawHaUrl, clientId } = JSON.parse(storedData.value);
    // Remove trailing slashes to prevent double-slash URLs
    const haUrl = rawHaUrl.replace(/\/+$/, '');

    // Verify CSRF token
    if (state !== storedState) {
      return NextResponse.redirect(new URL('/settings?error=invalid_state', baseUrl));
    }

    // Clean up the stored state
    await prisma.settings.delete({ where: { key: 'oauth_state' } });

    // Exchange the authorization code for tokens
    // Use the stored clientId to ensure it matches what was used in the auth request
    const tokenResponse = await fetch(`${haUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error('Token exchange failed:', error);
      return NextResponse.redirect(new URL('/settings?error=token_exchange_failed', baseUrl));
    }

    const tokens = await tokenResponse.json();

    // Calculate token expiry
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    // Store the connection (including clientId used for OAuth, needed for token refresh)
    await prisma.hAConnection.deleteMany();
    await prisma.hAConnection.create({
      data: {
        url: haUrl,
        clientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt,
      },
    });

    // Log activity
    await createActivityLog({
      type: 'connection',
      message: 'Home Assistant connected via OAuth',
    });

    return NextResponse.redirect(new URL('/settings?success=ha_connected', baseUrl));
  } catch (error) {
    console.error('OAuth callback error:', error);
    // A network-level failure means OUR SERVER couldn't reach HA (the browser
    // already could, or the user would never have gotten this far). Surfacing
    // that as "OAuth failed" sent users down an auth-debugging rabbit hole when
    // the actual problem was container networking (issue #74).
    if (isNetworkError(error)) {
      return NextResponse.redirect(new URL('/settings?error=ha_unreachable', baseUrl));
    }
    return NextResponse.redirect(new URL('/settings?error=oauth_failed', baseUrl));
  }
}
