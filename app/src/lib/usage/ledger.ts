/**
 * Turning a print's per-tray usage into Spoolman deductions.
 *
 * Each write is recorded (UsageDeduction) before it is sent, so what Spoolman
 * has been told survives a crash. Only the difference between a tray's usage
 * and what it was already charged is ever sent. A write that certainly did not
 * reach Spoolman is sent again later; one that may have (a timeout, a dropped
 * connection) is kept as `uncertain` and never repeated, because repeating it
 * could charge the spool twice.
 */
import prisma from '@/lib/db';
import type { Spool, SpoolmanClient } from '@/lib/api/spoolman';
import { filamentWeight } from '@/lib/webhook-helpers';

export type Unit = 'g' | 'cm';

/** Smallest charge written mid-print; the remainder is written when the print ends. */
export const MIN_WRITE_GRAMS = 1;
/** Below this much unbilled length (about 0.3g of 1.75mm PLA) the spool list is not even fetched. */
const MIN_WRITE_CM = 100;

type WriteResult = 'done' | 'retry' | 'rejected' | 'uncertain';

/** Codes meaning the request never reached Spoolman. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);

/** What a failed write means for the spool. */
export function classifyFailure(err: unknown): Exclude<WriteResult, 'done'> {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    // Spoolman, or a proxy in front of it, answered. Only a gateway timeout leaves it unknown.
    if (status === 504) return 'uncertain';
    return status >= 500 || status === 408 || status === 429 ? 'retry' : 'rejected';
  }
  let e = err as { code?: unknown; cause?: unknown } | null;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause as typeof e) {
    if (typeof e.code === 'string' && NOT_SENT.has(e.code)) return 'retry';
  }
  return 'uncertain';
}

/** The spool assigned to a tray: by unique_id, or by entity_id for spools assigned before trays were keyed by unique_id. */
export function assignedSpool(spools: Spool[], trayKey: string, entityId?: string | null): Spool | undefined {
  return spools.find(s => s.extra?.active_tray === JSON.stringify(trayKey))
    ?? (entityId ? spools.find(s => s.extra?.active_tray === JSON.stringify(entityId)) : undefined);
}

export interface SettleInput {
  sessionId: string;
  unit: Unit;
  /** Usage so far per tray key, in `unit`. */
  used: Record<string, number>;
  /** The print has ended: write everything, including giving back any over-charge. */
  final: boolean;
  label: (trayKey: string) => string;
  entityId?: (trayKey: string) => string | null;
}

export interface Written {
  spool: Spool;
  trayKey: string;
  grams: number;
}

export interface SettleResult {
  /** `final` and nothing more can be written. */
  complete: boolean;
  /** Spoolman could not be written to; try again later. */
  retry: boolean;
  written: Written[];
  notes: string[];
}

export interface SettleDeps {
  spoolman: SpoolmanClient;
  spools: () => Promise<Spool[]>;
}

/** Writes refused for a reason that will not change, so they are not hammered on every pass. */
const refused = new Set<string>();

const fmt = (grams: number) => `${grams.toFixed(2)}g`;

export async function settle(input: SettleInput, deps: SettleDeps): Promise<SettleResult> {
  const rows = await prisma.usageDeduction.findMany({ where: { sessionId: input.sessionId }, orderBy: { createdAt: 'asc' } });
  const result: SettleResult = { complete: input.final, retry: false, written: [], notes: [] };
  const gramsPer = (spool: Spool) => (input.unit === 'g' ? 1 : filamentWeight(1, spool.filament));
  let spools: Spool[] | null = null;

  const write = async (trayKey: string, spool: Spool, amount: number): Promise<WriteResult> => {
    const grams = amount * gramsPer(spool);
    const id = `${input.sessionId}:${trayKey}:${spool.id}:${Math.sign(amount)}`;
    if (refused.has(id)) return 'rejected';
    const row = await prisma.usageDeduction.create({
      data: { sessionId: input.sessionId, trayKey, spoolId: spool.id, amount, grams, status: 'pending' },
    });
    try {
      await deps.spoolman.useWeight(spool.id, grams);
      await prisma.usageDeduction.update({ where: { id: row.id }, data: { status: 'done' } });
      result.written.push({ spool, trayKey, grams });
      return 'done';
    } catch (err) {
      const kind = classifyFailure(err);
      // Capped: a proxy in front of Spoolman can answer with a whole HTML error page.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      if (kind === 'uncertain') {
        await prisma.usageDeduction.update({ where: { id: row.id }, data: { status: 'uncertain' } });
        result.notes.push(`Spoolman did not confirm ${amount < 0 ? 'giving back' : 'deducting'} ${fmt(Math.abs(grams))} for spool #${spool.id} (${detail}); check its weight.`);
      } else {
        await prisma.usageDeduction.delete({ where: { id: row.id } });
        if (kind === 'rejected') {
          refused.add(id);
          result.notes.push(`Spoolman refused ${fmt(Math.abs(grams))} for spool #${spool.id} (${detail}).`);
        }
      }
      return kind;
    }
  };

  const keys = new Set([...Object.keys(input.used), ...rows.map(r => r.trayKey)]);
  for (const trayKey of keys) {
    const charged = rows.filter(r => r.trayKey === trayKey);
    const delta = (input.used[trayKey] ?? 0) - charged.reduce((sum, r) => sum + r.amount, 0);
    if (Math.abs(delta) < 1e-6) continue;
    if (!input.final && delta < (input.unit === 'g' ? MIN_WRITE_GRAMS : MIN_WRITE_CM)) continue;

    try {
      spools ??= await deps.spools();
    } catch {
      return { ...result, complete: false, retry: true };
    }

    if (delta > 0) {
      const spool = assignedSpool(spools, trayKey, input.entityId?.(trayKey));
      if (!spool) {
        if (input.final) result.notes.push(`${input.label(trayKey)} has no spool assigned, so its usage from this print was not deducted.`);
        continue;
      }
      const grams = delta * gramsPer(spool);
      if (grams < 0.005 || (!input.final && grams < MIN_WRITE_GRAMS)) continue;
      const outcome = await write(trayKey, spool, delta);
      if (outcome === 'retry') return { ...result, complete: false, retry: true };
      continue;
    }

    // Charged more than the print used: give it back to the spools charged, newest first.
    let owed = -delta;
    const bySpool = new Map<number, number>();
    for (const r of charged) bySpool.set(r.spoolId, (bySpool.get(r.spoolId) ?? 0) + r.amount);
    for (const [spoolId, amount] of [...bySpool].reverse()) {
      if (owed < 1e-6) break;
      const back = Math.min(owed, amount);
      const spool = spools.find(s => s.id === spoolId);
      if (back <= 0 || !spool) continue;
      const outcome = await write(trayKey, spool, -back);
      if (outcome === 'retry') return { ...result, complete: false, retry: true };
      owed -= back;
    }
  }
  return result;
}

/** A write that was in flight when the app stopped may or may not have reached Spoolman. */
export async function markInterruptedWrites(): Promise<string[]> {
  const pending = await prisma.usageDeduction.findMany({ where: { status: 'pending' } });
  if (pending.length === 0) return [];
  await prisma.usageDeduction.updateMany({ where: { status: 'pending' }, data: { status: 'uncertain' } });
  return [...new Set(pending.map(r => r.sessionId))];
}
