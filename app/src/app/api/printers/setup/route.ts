import { NextRequest, NextResponse } from 'next/server';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import prisma from '@/lib/db';

const SUPPORTED_DOMAINS = ['bambu_lab', 'ha_creality_ws'] as const;
type PrinterDomain = typeof SUPPORTED_DOMAINS[number];
const HIDDEN_PRINTERS_KEY = 'hidden_printers';

/**
 * Get the list of hidden printer entries (entry_id + title) that
 * the user has removed from SpoolmanSync.
 */
export async function getHiddenPrinters(): Promise<{ entryId: string; title: string }[]> {
  const setting = await prisma.settings.findUnique({ where: { key: HIDDEN_PRINTERS_KEY } });
  if (!setting) return [];
  try {
    const parsed = JSON.parse(setting.value);
    // Support both old format (string[]) and new format ({entryId, title}[])
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return parsed.map((id: string) => ({ entryId: id, title: '' }));
    }
    return parsed;
  } catch {
    return [];
  }
}

async function saveHiddenPrinters(hidden: { entryId: string; title: string }[]): Promise<void> {
  await prisma.settings.upsert({
    where: { key: HIDDEN_PRINTERS_KEY },
    create: { key: HIDDEN_PRINTERS_KEY, value: JSON.stringify(hidden) },
    update: { value: JSON.stringify(hidden) },
  });
}

/**
 * GET /api/printers/setup
 * Get config entries for all supported printer integrations (Bambu Lab, Creality),
 * filtered to exclude printers the user has removed from SpoolmanSync.
 * Also returns hidden entries so the UI can offer to re-add them.
 */
export async function GET() {
  try {
    const client = await HomeAssistantClient.fromConnection();
    if (!client) {
      console.error('[Printers] No HA client available');
      return NextResponse.json({ error: 'Home Assistant not connected' }, { status: 400 });
    }

    // Fetch config entries for all supported printer domains
    const allEntries = [];
    for (const domain of SUPPORTED_DOMAINS) {
      try {
        const entries = await client.getConfigEntries(domain);
        // Tag each entry with its domain for the frontend
        allEntries.push(...entries.map(e => ({ ...e, domain })));
      } catch (err) {
        // Domain not installed — skip silently
        console.log(`[Printers] Domain ${domain} not found or error:`, err);
      }
    }

    // Filter out printers the user has hidden from SpoolmanSync
    const hidden = await getHiddenPrinters();
    const hiddenIds = new Set(hidden.map(h => h.entryId));
    const currentEntryIds = new Set(allEntries.map(e => e.entry_id));
    const visibleEntries = allEntries.filter(e => !hiddenIds.has(e.entry_id));
    const hiddenEntries = allEntries.filter(e => hiddenIds.has(e.entry_id));

    // Clean up stale hidden entries for printers no longer in HA
    const staleHidden = hidden.filter(h => !currentEntryIds.has(h.entryId));
    if (staleHidden.length > 0) {
      const cleaned = hidden.filter(h => currentEntryIds.has(h.entryId));
      await saveHiddenPrinters(cleaned);
      console.log(`[Printers] Cleaned up ${staleHidden.length} stale hidden entry(ies)`);
    }

    console.log('[Printers] Found', allEntries.length, 'entries,', visibleEntries.length, 'visible,', hiddenEntries.length, 'hidden');
    return NextResponse.json({ entries: visibleEntries, hiddenEntries });
  } catch (error) {
    console.error('[Printers] Error getting printer entries:', error);
    return NextResponse.json({ error: 'Failed to get printer configurations' }, { status: 500 });
  }
}

/**
 * POST /api/printers/setup
 * Start or continue a printer config flow, or unhide a printer.
 *
 * Body for starting flow: { action: 'start', domain?: 'bambu_lab' | 'ha_creality_ws' }
 * Body for continuing flow: { action: 'continue', flowId: string, userInput: object }
 * Body for aborting flow: { action: 'abort', flowId: string }
 * Body for re-adding hidden printer: { action: 'unhide', entryId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const client = await HomeAssistantClient.fromConnection();
    if (!client) {
      return NextResponse.json({ error: 'Home Assistant not connected' }, { status: 400 });
    }

    const body = await request.json();
    const { action, flowId, userInput, entryId, domain } = body;

    switch (action) {
      case 'start': {
        const targetDomain: PrinterDomain = SUPPORTED_DOMAINS.includes(domain) ? domain : 'bambu_lab';
        try {
          const result = await client.startConfigFlow(targetDomain);
          return NextResponse.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          // HA returns 404 "Invalid handler" when integration is not installed
          if (msg.includes('404') || msg.includes('Invalid handler')) {
            const integrationName = targetDomain === 'ha_creality_ws' ? 'ha_creality_ws' : 'ha-bambulab';
            return NextResponse.json({
              error: `The ${integrationName} integration is not installed in Home Assistant. Please install it via HACS first, then try again.`,
            }, { status: 400 });
          }
          throw err;
        }
      }

      case 'continue': {
        if (!flowId) {
          return NextResponse.json({ error: 'flowId required' }, { status: 400 });
        }
        const result = await client.continueConfigFlow(flowId, userInput || {});
        return NextResponse.json(result);
      }

      case 'abort': {
        if (!flowId) {
          return NextResponse.json({ error: 'flowId required' }, { status: 400 });
        }
        await client.deleteConfigFlow(flowId);
        return NextResponse.json({ success: true });
      }

      case 'unhide': {
        if (!entryId) {
          return NextResponse.json({ error: 'entryId required' }, { status: 400 });
        }
        const hidden = await getHiddenPrinters();
        const updated = hidden.filter(h => h.entryId !== entryId);
        await saveHiddenPrinters(updated);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error in printer setup:', error);
    const message = error instanceof Error ? error.message : 'Failed to process request';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/printers/setup
 * Remove a printer from SpoolmanSync (hides it from the UI).
 * Does NOT remove the printer from Home Assistant or ha-bambulab.
 * Also cleans up any SpoolmanSync automation records for the printer.
 *
 * Body: { entryId: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { entryId } = body;

    if (!entryId) {
      return NextResponse.json({ error: 'entryId required' }, { status: 400 });
    }

    // Look up the config entry title before hiding (for automation cleanup
    // and for filtering discovered printers later)
    let entryTitle = '';
    try {
      const client = await HomeAssistantClient.fromConnection();
      if (client) {
        // Search across all supported domains
        let entry = null;
        for (const d of SUPPORTED_DOMAINS) {
          try {
            const entries = await client.getConfigEntries(d);
            entry = entries.find(e => e.entry_id === entryId);
            if (entry) break;
          } catch { /* domain not installed */ }
        }
        if (entry) {
          entryTitle = entry.title;

          // Clean up SpoolmanSync automation records for this printer, matching
          // the automation id built from its stable prefix. Matching the entry
          // title instead deleted other printers' records, because SQLite's
          // LIKE is case-insensitive and a title like "A1" is a substring of
          // serials such as X2D_20P8BJ5A1500474 (issue #86). A printer that
          // can't be resolved keeps its record: a leftover row for a hidden
          // printer is inert, and re-adding the printer reuses it.
          const printer = (await client.discoverPrinters()).find(p => p.entry_id === entryId);
          if (printer) {
            const deleted = await prisma.automation.deleteMany({
              where: { haAutomationId: `spoolmansync_update_spool_${printer.prefix}` },
            });
            if (deleted.count > 0) {
              console.log(`Cleaned up ${deleted.count} automation record(s) for printer: ${printer.name}`);
            }
          } else {
            console.log(`[Printers] No discovered printer for entry ${entryId}; leaving automation records alone`);
          }
        }
      }
    } catch (cleanupError) {
      console.error('Failed to clean up automation records:', cleanupError);
    }

    // Add to hidden printers list (store both entry_id and title)
    const hidden = await getHiddenPrinters();
    if (!hidden.some(h => h.entryId === entryId)) {
      hidden.push({ entryId, title: entryTitle });
      await saveHiddenPrinters(hidden);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error removing printer:', error);
    return NextResponse.json({ error: 'Failed to remove printer' }, { status: 500 });
  }
}
