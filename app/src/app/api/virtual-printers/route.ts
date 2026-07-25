import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import prisma from '@/lib/db';
import {
  getVirtualPrinters,
  saveVirtualPrinters,
  virtualSlotKey,
  nextSlotNumber,
  rekeyVirtualAssignments,
  migrateVirtualKeys,
  withVirtualLock,
  VirtualPrinter,
  VirtualSlot,
} from '@/lib/virtual-printers';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { createActivityLog } from '@/lib/activity-log';
import { isLocationSyncEnabled, applyLocationSync, virtualLocationLabel } from '@/lib/spool-location';

const MAX_SLOTS = 16;
const MAX_NAME_LENGTH = 100;

async function getSpoolmanClient(): Promise<SpoolmanClient | null> {
  const conn = await prisma.spoolmanConnection.findFirst();
  if (!conn) return null;
  const client = new SpoolmanClient(conn.url);
  // Wire location sync so slot/printer removal guard-clears the location field
  // (or parks the spool in the configured holding pen).
  await applyLocationSync(client);
  return client;
}

/** 503 returned for operations that must re-key/clear Spoolman but have no client. */
function spoolmanRequired(): NextResponse {
  return NextResponse.json(
    { error: 'Spoolman is not connected, so spool assignments cannot be updated. Connect Spoolman and try again.' },
    { status: 503 },
  );
}

/** Case-insensitive name-collision check among virtual printers. */
function nameTaken(printers: VirtualPrinter[], name: string, exceptId?: string): boolean {
  const n = name.trim().toLowerCase();
  return printers.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === n);
}

/**
 * Clear Spoolman assignments for the given virtual slot keys. Propagates errors
 * so callers can keep the model and Spoolman in sync (don't drop a slot/printer
 * from the model if its assignment couldn't be cleared).
 */
async function unassignKeys(client: SpoolmanClient, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const spools = await client.getSpools(true);
  const jsonKeys = new Set(keys.map((k) => JSON.stringify(k)));
  for (const spool of spools) {
    const raw = spool.extra?.['active_tray'];
    if (raw && jsonKeys.has(raw)) await client.unassignSpoolFromTray(spool.id);
  }
}

export async function GET() {
  try {
    const client = await getSpoolmanClient();
    if (client) await withVirtualLock(() => migrateVirtualKeys(client));
    const virtualPrinters = await getVirtualPrinters();
    return NextResponse.json({ virtualPrinters });
  } catch (error) {
    console.error('Error fetching virtual printers:', error);
    return NextResponse.json({ error: 'Failed to fetch virtual printers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = (body.name ?? '').toString().trim();
    if (!name) {
      return NextResponse.json({ error: 'A name is required' }, { status: 400 });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `Name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 });
    }
    const slotCount = Math.min(Math.max(parseInt(body.slotCount, 10) || 1, 1), MAX_SLOTS);

    return await withVirtualLock(async () => {
      const client = await getSpoolmanClient();
      if (client) await migrateVirtualKeys(client);

      const printers = await getVirtualPrinters();
      if (nameTaken(printers, name)) {
        return NextResponse.json({ error: `A virtual printer named "${name}" already exists` }, { status: 409 });
      }

      const slots: VirtualSlot[] = Array.from({ length: slotCount }, (_, i) => ({ id: randomUUID(), number: i + 1 }));
      const printer: VirtualPrinter = { id: randomUUID(), name, slots };
      printers.push(printer);
      await saveVirtualPrinters(printers);

      await createActivityLog({
        type: 'virtual_printer_created',
        message: `Created virtual printer "${name}" with ${slotCount} slot(s)`,
        details: { id: printer.id, slotCount },
      });

      return NextResponse.json({ success: true, virtualPrinter: printer });
    });
  } catch (error) {
    console.error('Error creating virtual printer:', error);
    return NextResponse.json({ error: 'Failed to create virtual printer' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const id = (body.id ?? '').toString();
    if (!id) {
      return NextResponse.json({ error: 'A printer id is required' }, { status: 400 });
    }

    return await withVirtualLock(async () => {
      const client = await getSpoolmanClient();
      if (client) await migrateVirtualKeys(client);

      const printers = await getVirtualPrinters();
      const printer = printers.find((p) => p.id === id);
      if (!printer) {
        return NextResponse.json({ error: 'Virtual printer not found' }, { status: 404 });
      }

      // Rename — re-key the affected Spoolman assignments so nothing orphans.
      if (typeof body.name === 'string') {
        const newName = body.name.trim();
        if (!newName) {
          return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
        }
        if (newName.length > MAX_NAME_LENGTH) {
          return NextResponse.json({ error: `Name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 });
        }
        if (newName.toLowerCase() !== printer.name.toLowerCase() && nameTaken(printers, newName, id)) {
          return NextResponse.json({ error: `A virtual printer named "${newName}" already exists` }, { status: 409 });
        }
        if (newName !== printer.name) {
          // A rename changes the key; without Spoolman we cannot re-key, so do
          // NOT diverge the model from the stored assignments.
          if (!client) return spoolmanRequired();
          const oldName = printer.name;
          // When location sync is on, a rename also moves the location string
          // (old name → new name) for spools whose location still matches.
          const syncLocation = await isLocationSyncEnabled();
          const locationRemap = syncLocation
            ? { oldLocation: virtualLocationLabel(oldName), newLocation: virtualLocationLabel(newName) }
            : {};
          const remap = printer.slots.map((s) => ({
            oldKey: virtualSlotKey(oldName, s.number),
            newKey: virtualSlotKey(newName, s.number),
            ...locationRemap,
          }));
          await rekeyVirtualAssignments(client, remap); // atomic: rolls back + throws on failure
          printer.name = newName;
        }
      }

      // Explicit slot actions (avoids fragile full-array reconciliation).
      const action = (body.action ?? '').toString();
      if (action === 'addSlot') {
        if (printer.slots.length >= MAX_SLOTS) {
          return NextResponse.json({ error: `Maximum of ${MAX_SLOTS} slots` }, { status: 400 });
        }
        printer.slots.push({ id: randomUUID(), number: nextSlotNumber(printer.slots) });
      } else if (action === 'removeSlot') {
        const slotNumber = parseInt(body.slotNumber, 10);
        if (!Number.isInteger(slotNumber)) {
          return NextResponse.json({ error: 'A valid slotNumber is required' }, { status: 400 });
        }
        if (printer.slots.some((s) => s.number === slotNumber)) {
          // Clear the assignment first; only drop the slot if that succeeded.
          if (!client) return spoolmanRequired();
          await unassignKeys(client, [virtualSlotKey(printer.name, slotNumber)]);
          printer.slots = printer.slots.filter((s) => s.number !== slotNumber);
        }
      }

      await saveVirtualPrinters(printers);
      return NextResponse.json({ success: true, virtualPrinter: printer });
    });
  } catch (error) {
    console.error('Error updating virtual printer:', error);
    return NextResponse.json({ error: 'Failed to update virtual printer' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const id = (body.id ?? '').toString();
    if (!id) {
      return NextResponse.json({ error: 'A printer id is required' }, { status: 400 });
    }

    return await withVirtualLock(async () => {
      const client = await getSpoolmanClient();
      if (client) await migrateVirtualKeys(client);

      const printers = await getVirtualPrinters();
      const removed = printers.find((p) => p.id === id);
      if (!removed) {
        return NextResponse.json({ error: 'Virtual printer not found' }, { status: 404 });
      }
      // If it has slots, we must be able to clear their assignments first.
      if (!client && removed.slots.length > 0) return spoolmanRequired();

      if (client) await unassignKeys(client, removed.slots.map((s) => virtualSlotKey(removed.name, s.number)));
      await saveVirtualPrinters(printers.filter((p) => p.id !== id));

      await createActivityLog({
        type: 'virtual_printer_deleted',
        message: `Deleted virtual printer "${removed.name}"`,
        details: { id: removed.id },
      });

      return NextResponse.json({ success: true });
    });
  } catch (error) {
    console.error('Error deleting virtual printer:', error);
    return NextResponse.json({ error: 'Failed to delete virtual printer' }, { status: 500 });
  }
}
