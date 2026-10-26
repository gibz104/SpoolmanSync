import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient, type Spool } from '@/lib/api/spoolman';
import { usageTracker } from '@/lib/usage/tracker';

/**
 * GET /api/usage
 * The usage tracker's connection to Home Assistant, and the most recent prints
 * with what each one deducted from which spool.
 */
export async function GET() {
  try {
    const tracker = usageTracker()?.status() ?? null;
    const rows = await prisma.printSession.findMany({
      orderBy: { startedAt: 'desc' },
      take: 25,
      include: { deductions: true },
    });

    let spools = new Map<number, Spool>();
    try {
      const connection = await prisma.spoolmanConnection.findFirst();
      if (connection) spools = new Map((await new SpoolmanClient(connection.url).getSpools(true)).map(s => [s.id, s]));
    } catch {
      // Names are a nicety; the amounts come from our own records.
    }

    const names = new Map(tracker?.printers.map(p => [p.prefix, p.name]));
    const prints = rows.map(row => {
      const grams = new Map<number, number>();
      for (const d of row.deductions) grams.set(d.spoolId, (grams.get(d.spoolId) ?? 0) + d.grams);
      return {
        id: row.id,
        printer: names.get(row.printer) ?? row.printer,
        name: row.name,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        outcome: row.outcome,
        settled: row.settled,
        attention: row.attention,
        spools: [...grams].map(([spoolId, g]) => ({
          spoolId,
          name: spools.get(spoolId)?.filament.name ?? null,
          grams: Math.round(g * 100) / 100,
        })),
      };
    });

    return NextResponse.json({ tracker, prints });
  } catch (error) {
    console.error('Error fetching usage:', error);
    return NextResponse.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
