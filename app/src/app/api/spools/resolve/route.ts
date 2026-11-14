import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { resolveScanCode } from '@/lib/scan-resolve';

/**
 * The spool or slot a scanned or typed code means: a link, a spool id or
 * barcode, or the UID of a tag linked to a spool in Spoolman (see
 * resolveScanCode).
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code') ?? '';
  try {
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }
    const client = new SpoolmanClient(spoolmanConnection.url);
    const target = await resolveScanCode(code, {
      spools: async () => (await client.getSpools()).filter(s => !s.archived),
      spoolByTagUid: uid => client.findSpoolByTagUid(uid),
    });
    if (!target) return NextResponse.json({ error: `No spool found for: ${code.trim()}` }, { status: 404 });
    return NextResponse.json({ target });
  } catch (error) {
    console.error('Error resolving a scanned code:', error);
    return NextResponse.json({ error: 'Failed to look up the code' }, { status: 500 });
  }
}
