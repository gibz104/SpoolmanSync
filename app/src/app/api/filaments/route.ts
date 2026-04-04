import { NextRequest, NextResponse } from 'next/server';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { bambuLogin, bambuLoginWithTfa, fetchBambuFilaments } from '@/lib/api/bambucloud';
import prisma from '@/lib/db';


async function storeTokenAndProfiles(email: string, token: string): Promise<number> {
  await prisma.bambuCloudToken.upsert({
    where: { email },
    create: { email, accessToken: token },
    update: { accessToken: token, fetchedAt: new Date() },
  });
  const profiles = await fetchBambuFilaments(token);
  for (const profile of profiles) {
    await prisma.bambuFilamentProfile.upsert({
      where: { filamentId: profile.filamentId },
      create: {
        filamentId: profile.filamentId,
        name: profile.name,
        vendor: profile.vendor,
        material: profile.material,
      },
      update: {
        name: profile.name,
        vendor: profile.vendor,
        material: profile.material,
      },
    });
  }
  console.log(`[Bambu] Stored ${profiles.length} filament profiles for:`, email);
  return profiles.length;
}

/**
 * GET /api/filaments
 * Returns Bambu filament profiles from DB and Spoolman filaments with their
 * current filament_id extra values.
 */
export async function GET() {
  try {
    const [bambuProfiles, token] = await Promise.all([
      prisma.bambuFilamentProfile.findMany({ orderBy: [{ vendor: 'asc' }, { name: 'asc' }] }),
      prisma.bambuCloudToken.findFirst({ orderBy: { fetchedAt: 'desc' } }),
    ]);

    const conn = await prisma.spoolmanConnection.findFirst();
    const client = conn ? new SpoolmanClient(conn.url) : null;
    const spoolmanFilaments = client ? await client.getFilaments() : [];

    // Build a set of bambu filament_ids already linked to a Spoolman filament
    const linkedIds = new Set<string>();
    for (const f of spoolmanFilaments) {
      const raw = f.extra?.['filament_id'];
      if (raw) {
        try {
          const val = JSON.parse(raw);
          if (typeof val === 'string' && val) linkedIds.add(val);
        } catch {
          if (typeof raw === 'string' && raw) linkedIds.add(raw);
        }
      }
    }

    return NextResponse.json({
      bambuProfiles: bambuProfiles.map(p => ({ ...p, linked: linkedIds.has(p.filamentId) })),
      spoolmanFilaments,
      lastSynced: token?.fetchedAt ?? null,
      hasToken: !!token,
      spoolmanUrl: conn?.url ?? null,
    });
  } catch (error) {
    console.error('[Filaments] GET error:', error);
    return NextResponse.json({ error: 'Failed to load filament data' }, { status: 500 });
  }
}

/**
 * POST /api/filaments
 * Actions:
 *   resync   {}                                        — re-fetch profiles using stored token
 *   link     { spoolmanFilamentId, bambuFilamentId }   — write filament_id to Spoolman filament
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { action } = body;

    if (action === 'resync') {
      const token = await prisma.bambuCloudToken.findFirst({ orderBy: { fetchedAt: 'desc' } });
      if (!token) {
        return NextResponse.json(
          { error: 'No Bambu Cloud token stored. Connect to Bambu Cloud on this page first.' },
          { status: 400 }
        );
      }
      const count = await storeTokenAndProfiles(token.email, token.accessToken);
      return NextResponse.json({ status: 'synced', count });
    }

    if (action === 'connect') {
      const email = String(body.email ?? '');
      const password = String(body.password ?? '');
      if (!email || !password) {
        return NextResponse.json({ error: 'email and password required' }, { status: 400 });
      }
      const loginResult = await bambuLogin(email, password);
      if (loginResult.status === 'success') {
        const count = await storeTokenAndProfiles(email, loginResult.token);
        return NextResponse.json({ status: 'synced', count });
      }
      if (loginResult.status === 'needs_tfa') {
        return NextResponse.json({ status: 'needs_tfa', tfaKey: loginResult.tfaKey });
      }
      if (loginResult.status === 'needs_code') {
        return NextResponse.json({ status: 'needs_code' });
      }
      return NextResponse.json({ error: loginResult.message }, { status: 400 });
    }

    if (action === 'connect_tfa') {
      const email = String(body.email ?? '');
      const tfaKey = String(body.tfaKey ?? '');
      const tfaCode = String(body.tfaCode ?? '');
      if (!email || !tfaKey || !tfaCode) {
        return NextResponse.json({ error: 'email, tfaKey and tfaCode required' }, { status: 400 });
      }
      const loginResult = await bambuLoginWithTfa(email, tfaKey, tfaCode);
      if (loginResult.status === 'success') {
        const count = await storeTokenAndProfiles(email, loginResult.token);
        return NextResponse.json({ status: 'synced', count });
      }
      const msg = loginResult.status === 'error' ? loginResult.message : 'TFA login failed';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    if (action === 'link') {
      const spoolmanFilamentId = Number(body.spoolmanFilamentId);
      const bambuFilamentId = String(body.bambuFilamentId ?? '');

      if (!spoolmanFilamentId || !bambuFilamentId) {
        return NextResponse.json({ error: 'spoolmanFilamentId and bambuFilamentId required' }, { status: 400 });
      }

      const linkConn = await prisma.spoolmanConnection.findFirst();
      const client = linkConn ? new SpoolmanClient(linkConn.url) : null;
      if (!client) {
        return NextResponse.json({ error: 'Spoolman not connected' }, { status: 400 });
      }

      await client.updateFilamentExtra(spoolmanFilamentId, {
        filament_id: JSON.stringify(bambuFilamentId),
      });

      return NextResponse.json({ status: 'linked' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('[Filaments] POST error:', error);
    const message = error instanceof Error ? error.message : 'Request failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
