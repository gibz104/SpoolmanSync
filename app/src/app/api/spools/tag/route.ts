import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient, TagHeldError } from '@/lib/api/spoolman';
import { createActivityLog } from '@/lib/activity-log';
import { normalizeTagUid } from '@/lib/scan-codes';

/**
 * Link an NFC tag to a spool in Spoolman (0.27+, #89), so the tag's UID
 * identifies the spool in Spoolman and in tools that read tags through it.
 * `{ supported: false }` when Spoolman is older.
 */
export async function POST(request: NextRequest) {
  try {
    const { spoolId, uid } = await request.json();
    if (typeof spoolId !== 'number' || !Number.isFinite(spoolId)) {
      return NextResponse.json({ error: 'spoolId is required and must be a number' }, { status: 400 });
    }
    const tagUid = typeof uid === 'string' ? normalizeTagUid(uid) : '';
    if (!tagUid) {
      return NextResponse.json({ error: 'uid must be a tag UID' }, { status: 400 });
    }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }
    const client = new SpoolmanClient(spoolmanConnection.url);
    if (!(await client.supportsTagUids())) return NextResponse.json({ supported: false });

    const { movedFrom } = await client.linkTagUid(spoolId, tagUid);
    await createActivityLog({
      type: 'tag_linked',
      message: movedFrom !== null
        ? `Linked NFC tag ${tagUid} to spool #${spoolId} in Spoolman (moved from spool #${movedFrom})`
        : `Linked NFC tag ${tagUid} to spool #${spoolId} in Spoolman`,
      details: { spoolId, uid: tagUid, movedFrom },
    });
    return NextResponse.json({ supported: true, linked: true, movedFrom });
  } catch (error) {
    if (error instanceof TagHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('Error linking a tag:', error);
    return NextResponse.json({ error: 'Failed to link the tag in Spoolman' }, { status: 500 });
  }
}
