import { NextRequest, NextResponse } from 'next/server';
import { ingressPathFromHeader } from '@/lib/ingress-path';
import { scanTargetPath, spoolIdFromSegment } from '@/lib/scan-codes';

/**
 * Spoolman's link to a spool, /spool/show/<id>, opens that spool's scan page.
 * A QR label or NFC tag made for Spoolman, by Spoolman or a label tool that
 * links to Spoolman's spool page, then works with SpoolmanSync by putting
 * SpoolmanSync's address in place of Spoolman's.
 *
 * The redirect is a path with no host, so the browser stays on the address it
 * used: the direct access port, a reverse proxy, or Home Assistant's ingress,
 * whose base path it keeps.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = spoolIdFromSegment((await params).id);
  if (id === null) {
    return new NextResponse('Not a spool link', { status: 404 });
  }
  const ingressPath = ingressPathFromHeader(request.headers.get('x-ingress-path'));
  return new NextResponse(null, {
    status: 307,
    headers: { Location: ingressPath + scanTargetPath({ kind: 'spool', id }) },
  });
}
