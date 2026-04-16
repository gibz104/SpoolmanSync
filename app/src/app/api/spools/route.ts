import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { normalizeMappingFields, isEmptyTrayFilamentReport } from '@/app/api/mappings/route';

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
    const { spoolId, trayId, trayName, trayMaterial, trayColor } = body;

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

    const updatedSpool = await client.assignSpoolToTray(spoolId, trayId);

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Assigned spool #${spoolId} to tray ${trayId}`,
      details: { spoolId, trayId },
    });

    // Auto-create filament mapping if enabled and spool has no RFID/serial tag
    let mappingCreated = false;
    if (
      trayName &&
      trayMaterial &&
      trayColor &&
      !isEmptyTrayFilamentReport(trayName, trayMaterial)
    ) {
      try {
        const autoMappingSetting = await prisma.settings.findUnique({ where: { key: 'auto_mapping_enabled' } });
        const autoMappingEnabled = !autoMappingSetting || autoMappingSetting.value === 'true';

        const existingTag = updatedSpool.extra?.['tag'];
        const hasValidTag = existingTag && (() => {
          try {
            const parsed = JSON.parse(existingTag);
            return parsed && parsed !== 'unknown' && parsed !== '' && parsed.replace(/0/g, '') !== '';
          } catch { return false; }
        })();

        if (autoMappingEnabled && !hasValidTag) {
          const normalized = normalizeMappingFields(trayName, trayMaterial, trayColor);
          await prisma.filamentMapping.upsert({
            where: {
              name_material_color: {
                name: normalized.name,
                material: normalized.material,
                color: normalized.color,
              },
            },
            update: { spoolId: Number(spoolId) },
            create: {
              name: normalized.name,
              material: normalized.material,
              color: normalized.color,
              spoolId: Number(spoolId),
            },
          });
          mappingCreated = true;
        }
      } catch (err) {
        console.error('Failed to auto-create filament mapping:', err);
      }
    }

    return NextResponse.json({ spool: updatedSpool, mappingCreated });
  } catch (error) {
    console.error('Error assigning spool:', error);
    return NextResponse.json({ error: 'Failed to assign spool' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId } = body;

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
