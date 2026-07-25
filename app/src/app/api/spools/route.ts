import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { applyLocationSync } from '@/lib/spool-location';

export async function GET() {
  try {
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);
    const spools = await client.getSpools();

    // Filter out archived spools
    const activeSpools = spools.filter(s => !s.archived);

    return NextResponse.json({ spools: activeSpools });
  } catch (error) {
    console.error('Error fetching spools:', error);
    return NextResponse.json({ error: 'Failed to fetch spools' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId, trayId } = body;

    // Validate inputs before touching Spoolman to avoid malformed requests / 500s
    if (typeof spoolId !== 'number' || !Number.isFinite(spoolId)) {
      return NextResponse.json({ error: 'spoolId is required and must be a number' }, { status: 400 });
    }
    if (typeof trayId !== 'string' || trayId.trim() === '') {
      return NextResponse.json({ error: 'trayId is required and must be a non-empty string' }, { status: 400 });
    }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let entityIdMap: Map<string, string> | null = null;
    client.setEntityIdResolver(async (entityId: string) => {
      if (!entityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) entityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!entityIdMap) entityIdMap = new Map();
      }
      return entityIdMap.get(entityId) || entityId;
    });

    // Location sync (no-op unless enabled) — keep Spoolman's location field in
    // step with the tray this spool is being assigned to.
    await applyLocationSync(client);

    const updatedSpool = await client.assignSpoolToTray(spoolId, trayId);

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Assigned spool #${spoolId} to tray ${trayId}`,
      details: { spoolId, trayId },
    });

    return NextResponse.json({ spool: updatedSpool });
  } catch (error) {
    console.error('Error assigning spool:', error);
    return NextResponse.json({ error: 'Failed to assign spool' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId } = body;

    // Validate inputs before touching Spoolman to avoid malformed requests / 500s
    if (typeof spoolId !== 'number' || !Number.isFinite(spoolId)) {
      return NextResponse.json({ error: 'spoolId is required and must be a number' }, { status: 400 });
    }

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let deleteEntityIdMap: Map<string, string> | null = null;
    client.setEntityIdResolver(async (entityId: string) => {
      if (!deleteEntityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) deleteEntityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!deleteEntityIdMap) deleteEntityIdMap = new Map();
      }
      return deleteEntityIdMap.get(entityId) || entityId;
    });

    // Location sync (no-op unless enabled) — the guarded clear/holding-pen write
    // in unassignSpoolFromTray only applies if we set the location.
    await applyLocationSync(client);

    const updatedSpool = await client.unassignSpoolFromTray(spoolId);

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Unassigned spool #${spoolId} from tray`,
      details: { spoolId },
    });

    return NextResponse.json({ spool: updatedSpool });
  } catch (error) {
    console.error('Error unassigning spool:', error);
    return NextResponse.json({ error: 'Failed to unassign spool' }, { status: 500 });
  }
}
