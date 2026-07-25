import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { buildLocationSuggestions } from '@/lib/spool-location';

// Never serve a cached list: locations change in Spoolman, out of band from
// this app, and a stale suggestion list is exactly the bug this route had.
export const dynamic = 'force-dynamic';

/**
 * Return the locations SpoolmanSync should offer as suggestions, mirroring how
 * Spoolman's own Locations page builds its list:
 *
 *   1. Spoolman's user-managed `locations` setting, in the user's order.
 *   2. Any additional location strings found on NON-ARCHIVED spools.
 *
 * Why both, and why in that order (issue: stale location autofill):
 *  - Deriving from spools alone misses locations the user created in Spoolman
 *    but hasn't put a spool in yet, so new locations appeared to show up "slowly"
 *    — really, only once a spool was moved there.
 *  - Including archived spools kept deleted locations alive forever, because
 *    archiving never clears a spool's `location`. That's why only some deleted
 *    locations disappeared: the ones whose last remaining spool was archived
 *    lingered indefinitely.
 *
 * Matching Spoolman's own semantics means the two UIs now always agree.
 */
export async function GET() {
  const empty = () =>
    NextResponse.json({ locations: [] }, { headers: { 'Cache-Control': 'no-store' } });

  try {
    const conn = await prisma.spoolmanConnection.findFirst();
    if (!conn) return empty();

    const client = new SpoolmanClient(conn.url);

    // Spoolman's managed list is authoritative for ordering and for locations
    // that have no spools in them yet. It is best-effort: older Spoolman
    // versions have no such setting and simply yield [].
    const [configured, spools] = await Promise.all([
      client.getConfiguredLocations(),
      client.getSpools(), // non-archived only — archived spools keep dead locations alive
    ]);

    const locations = buildLocationSuggestions(configured, spools);

    return NextResponse.json({ locations }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Non-fatal: the UI treats an empty list as "no suggestions".
    console.error('Error fetching Spoolman locations:', error);
    return empty();
  }
}
