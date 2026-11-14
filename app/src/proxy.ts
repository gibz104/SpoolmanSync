import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isCrossSiteApiRequest } from '@/lib/request-guard';

/**
 * Proxy (formerly middleware). Refuses API requests that a browser makes for
 * another site (see request-guard.ts), and handles the Home Assistant ingress
 * path.
 *
 * When running as an HA add-on, requests come through the ingress proxy.
 * HA's ingress strips the base path before forwarding to the add-on, so
 * the app receives requests at "/" internally. The X-Ingress-Path header
 * tells us the external path prefix (e.g., "/api/hassio_ingress/abc123").
 *
 * We store this in a cookie so client-side code can access it if needed
 * for generating external URLs (e.g., QR codes, NFC tags).
 */
export function proxy(request: NextRequest) {
  if (isCrossSiteApiRequest(request.nextUrl.pathname, request.method, request.headers.get('sec-fetch-site'))) {
    return NextResponse.json({ error: 'SpoolmanSync does not accept API requests from other websites' }, { status: 403 });
  }

  const response = NextResponse.next();

  // Get the ingress path from the header
  const ingressPath = request.headers.get('x-ingress-path');

  if (ingressPath) {
    // Pass the ingress path to the client via a cookie
    // This allows client-side JavaScript to know the external base path
    // for generating shareable URLs (QR codes, NFC tags, etc.)
    response.cookies.set('ha-ingress-path', ingressPath, {
      path: '/',
      sameSite: 'strict',
      httpOnly: false, // Allow JS access
    });
  }

  return response;
}

// Run on all routes except static files
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
