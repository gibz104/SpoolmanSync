import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';

/**
 * Normalize filament mapping fields for storage and lookup.
 * - name: trimmed (preserves casing from the printer / webhook)
 * - material: trimmed (preserves casing)
 * - color: trimmed, '#' stripped, lowercased (hex; alpha channel preserved)
 */
export function normalizeMappingFields(name: string, material: string, color: string) {
  return {
    name: name.trim(),
    material: material.trim(),
    color: color.trim().replace('#', '').toLowerCase(),
  };
}

/**
 * When the printer reports no spool loaded, HA often sets name or material to "Empty".
 * Filament mappings must not be created for this state.
 */
export function isEmptyTrayFilamentReport(name: string, material: string): boolean {
  return name.trim().toLowerCase() === 'empty' || material.trim().toLowerCase() === 'empty';
}

export async function GET() {
  try {
    const mappings = await prisma.filamentMapping.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
    let spoolMap = new Map<number, { name: string; material: string; color_hex: string; vendor: string; archived: boolean }>();

    if (spoolmanConnection) {
      try {
        const client = new SpoolmanClient(spoolmanConnection.url);
        const spools = await client.getSpools(true);
        for (const spool of spools) {
          spoolMap.set(spool.id, {
            name: spool.filament?.name || '',
            material: spool.filament?.material || '',
            color_hex: spool.filament?.color_hex || '',
            vendor: spool.filament?.vendor?.name || '',
            archived: spool.archived,
          });
        }
      } catch {
        // Spoolman unavailable — return mappings without spool details
      }
    }

    const enriched = mappings.map((m) => ({
      ...m,
      spool: spoolMap.get(m.spoolId) || null,
    }));

    return NextResponse.json({ mappings: enriched });
  } catch (error) {
    console.error('Error fetching mappings:', error);
    return NextResponse.json({ error: 'Failed to fetch mappings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, material, color, spoolId } = body;

    if (!name || !material || !color || !spoolId) {
      return NextResponse.json(
        { error: 'Missing required fields: name, material, color, spoolId' },
        { status: 400 },
      );
    }

    if (isEmptyTrayFilamentReport(String(name), String(material))) {
      return NextResponse.json(
        { error: 'Cannot create a mapping when name or material is Empty (no spool loaded)' },
        { status: 400 },
      );
    }

    const normalized = normalizeMappingFields(name, material, color);

    const mapping = await prisma.filamentMapping.upsert({
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

    return NextResponse.json({ mapping });
  } catch (error) {
    console.error('Error creating/updating mapping:', error);
    return NextResponse.json({ error: 'Failed to save mapping' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing required field: id' }, { status: 400 });
    }

    await prisma.filamentMapping.delete({ where: { id } });

    return NextResponse.json({ status: 'deleted' });
  } catch (error) {
    console.error('Error deleting mapping:', error);
    return NextResponse.json({ error: 'Failed to delete mapping' }, { status: 500 });
  }
}
