/**
 * The usage tracker: watches every printer's Home Assistant entities and keeps
 * Spoolman's spool weights in step with what each print uses.
 *
 * It is the only thing that deducts usage. Each pass for a printer folds the
 * latest entity states into its print (session.ts), saves that, and writes the
 * difference to Spoolman (ledger.ts). Passes run one at a time, on every change
 * to a watched entity and on a one-minute heartbeat that also retries
 * deductions Spoolman could not take.
 */
import prisma from '@/lib/db';
import { HomeAssistantClient, type HAPrinter } from '@/lib/api/homeassistant';
import { SpoolmanClient, type Spool } from '@/lib/api/spoolman';
import { createActivityLog } from '@/lib/activity-log';
import { checkAndUpdateAlerts } from '@/lib/alerts';
import { spoolEvents, SPOOL_UPDATED, type SpoolUpdateEvent } from '@/lib/events';
import { filterHiddenPrinters } from '@/lib/hidden-printers';
import { processGlobal } from '@/lib/process-global';
import { isValidTrayUuid } from '@/lib/webhook-helpers';
import { EntitySubscription, type EntityMap } from './entities';
import { watchFor, watchedEntities, type PrinterWatch } from './printers';
import { ABANDON_AFTER_MS, advance, missedPrint, plateMark, type Ended, type Job, type Outcome, type PreviousPrint, type SessionState } from './session';
import { markInterruptedWrites, settle, type SettleResult } from './ledger';
import { removeLegacyEntities } from './legacy-cleanup';

const HEARTBEAT_MS = 60_000;
const REDISCOVER_MS = 10 * 60_000;
const SAVE_EVERY_MS = 30_000;
const SPOOL_CACHE_MS = 5_000;
/**
 * ha_creality_ws re-reads which CFS slot is feeding only every five minutes
 * unless asked, so a multi-colour print would be charged to whichever slot fed
 * at the last read. Asked this often while a print runs.
 */
const CFS_REFRESH_MS = 15_000;
/** How long an ended print keeps trying to reach Spoolman before it is given up on. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the tracker needs from the outside world; replaced in tests. */
export interface TrackerDeps {
  discover: () => Promise<HAPrinter[] | null>;
  spoolman: () => Promise<SpoolmanClient | null>;
  /** Remove what earlier versions' YAML usage tracking left in Home Assistant; returns what was removed. */
  cleanup?: () => Promise<string[]>;
  /** Ask ha_creality_ws to re-read which CFS slot is feeding on these printers' devices (all, if none are known). */
  refreshCfs?: (deviceIds: string[]) => Promise<void>;
  source: (onChange: (touched: string[]) => void, onStatus: (connected: boolean, detail?: string) => void) => {
    states: EntityMap;
    readonly connected: boolean;
    watch(entityIds: string[]): void;
    start(): void;
    stop(): void;
  };
  now: () => number;
}

interface Open {
  id: string;
  state: SessionState;
  saved: string;
  savedAt: number;
  /** `milestones` of the saved state. */
  savedMilestones: string;
}

/**
 * What a restart must not lose, saved as soon as it changes. Usage and progress
 * are re-read from Home Assistant after a restart, but not that the print
 * reached RUNNING before an outage it ended during, or where it began printing.
 */
const milestones = (s: SessionState) =>
  JSON.stringify([s.runningSince, s.plate, s.job, s.resumedFrom, s.printingFrom, s.restarted, s.lastJob, s.outage, s.dip, s.jump, s.skipped]);

export interface TrackerStatus {
  connected: boolean;
  detail: string | null;
  printers: { prefix: string; name: string; printing: boolean }[];
}

export class UsageTracker {
  private watches = new Map<string, PrinterWatch>();
  private byEntity = new Map<string, string[]>();
  private open = new Map<string, Open>();
  private previous = new Map<string, PreviousPrint | null>();
  private source: ReturnType<TrackerDeps['source']>;
  private dirty = new Set<string>();
  private scheduled: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private spoolCache: { at: number; spools: Spool[] } | null = null;
  private taggedSerials = new Set<string>();
  private alertsAt = 0;
  private spoolmanDownUntil = 0;
  private stopped = false;
  private detail: string | null = 'starting';
  /** Printers to check, once their state is known, for a print that ran while the tracker was not connected. */
  private unchecked = new Set<string>();

  constructor(private readonly deps: TrackerDeps) {
    this.source = deps.source(
      touched => this.changed(touched),
      (connected, detail) => {
        this.detail = connected ? null : detail ?? 'disconnected';
        if (!connected) return;
        this.unchecked = new Set(this.watches.keys());
        void this.rediscover();
        void this.removeLeftovers();
      },
    );
  }

  async start(): Promise<void> {
    for (const sessionId of await markInterruptedWrites()) {
      await this.addAttention(sessionId, ['SpoolmanSync stopped while writing a deduction for this print; check the spool\'s weight in Spoolman.']);
    }
    for (const row of await prisma.printSession.findMany({ where: { endedAt: null } })) {
      const state: SessionState = JSON.parse(row.state);
      this.open.set(row.printer, { id: row.id, state, saved: row.state, savedAt: this.deps.now(), savedMilestones: milestones(state) });
    }
    await this.rediscover();
    this.source.start();
    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.pollCfs(), CFS_REFRESH_MS));
    this.timers.push(setInterval(() => void this.rediscover(), REDISCOVER_MS));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.source.stop();
  }

  /** Connect to Home Assistant again, as the stored connection now says. */
  reconnect(): void {
    if (this.stopped) return;
    this.source.stop();
    this.source.start();
  }

  status(): TrackerStatus {
    return {
      connected: this.source.connected,
      detail: this.detail,
      printers: [...this.watches.values()].map(w => ({ prefix: w.prefix, name: w.name, printing: this.open.has(w.prefix) })),
    };
  }

  /** Each connect follows a Home Assistant start, which is when old YAML entities become orphans. */
  private async removeLeftovers(): Promise<void> {
    try {
      const removed = await this.deps.cleanup?.() ?? [];
      if (removed.length === 0) return;
      await createActivityLog({
        type: 'ha_cleanup',
        message: `Removed ${removed.length} entities left in Home Assistant by SpoolmanSync's old usage tracking: ${removed.join(', ')}`,
        details: { removed },
      });
    } catch (err) {
      console.warn('[usage] Could not remove leftover Home Assistant entities:', err);
    }
  }

  /** Re-read which printers exist and which entities to watch. */
  async rediscover(): Promise<void> {
    try {
      const printers = await this.deps.discover();
      if (!printers) return;
      this.watches = new Map(printers.map(watchFor).filter((w): w is PrinterWatch => w !== null).map(w => [w.prefix, w]));
      this.byEntity = new Map();
      for (const w of this.watches.values()) {
        for (const id of watchedEntities([w])) this.byEntity.set(id, [...(this.byEntity.get(id) ?? []), w.prefix]);
      }
      this.source.watch(watchedEntities([...this.watches.values()]));
    } catch (err) {
      console.warn('[usage] Could not discover printers:', err instanceof Error ? err.message : err);
    }
  }

  /** Run the passes for these entities' printers (soon, coalescing bursts). */
  changed(touched: string[]): void {
    if (this.stopped) return;
    for (const id of touched) for (const prefix of this.byEntity.get(id) ?? []) this.dirty.add(prefix);
    if (this.dirty.size === 0 || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.flush();
    }, 250);
  }

  heartbeat(): Promise<void> {
    for (const prefix of this.watches.keys()) this.dirty.add(prefix);
    return this.flush(true);
  }

  /** Re-read the feeding CFS slot of every Creality printer printing now. */
  pollCfs(): void {
    if (!this.source.connected) return;
    const printing = [...this.open.keys()].map(prefix => this.watches.get(prefix)).filter(w => w?.brand === 'creality');
    if (printing.length > 0) this.refreshCfs(printing as PrinterWatch[]);
  }

  private refreshCfs(watches: PrinterWatch[]): void {
    if (this.stopped) return;
    const ids = watches.map(w => w.deviceId).filter((id): id is string => !!id);
    this.deps.refreshCfs?.(ids.length === watches.length ? ids : [])
      .catch(err => console.warn('[usage] Could not refresh the CFS slots:', err instanceof Error ? err.message : err));
  }

  /** Every pass queued so far, one at a time. */
  flush(retryEnded = false): Promise<void> {
    if (this.stopped) return this.chain;
    this.chain = this.chain.then(async () => {
      const prefixes = [...this.dirty];
      this.dirty.clear();
      for (const prefix of prefixes) {
        try {
          await this.pass(prefix);
        } catch (err) {
          console.error(`[usage] Pass for ${prefix} failed:`, err);
        }
      }
      if (retryEnded) await this.settleEnded().catch(err => console.error('[usage] Retrying deductions failed:', err));
    });
    return this.chain;
  }

  private async pass(prefix: string): Promise<void> {
    const watch = this.watches.get(prefix);
    if (!watch || !this.source.connected) return;
    const cur = this.open.get(prefix) ?? null;
    const step = advance(watch, this.source.states, cur?.state ?? null, await this.previousFor(prefix), this.deps.now());

    if (step.ended && cur) {
      this.open.delete(prefix);
      await this.end(watch, cur.id, step.ended);
    }
    if (!step.session && !cur && this.unchecked.has(prefix)) {
      const missed = missedPrint(watch, this.source.states, await this.previousFor(prefix));
      if (missed !== undefined) this.unchecked.delete(prefix);
      if (missed) await this.recordMissed(watch, missed);
    }
    if (!step.session) return;
    if (step.started && watch.brand === 'creality') this.refreshCfs([watch]);

    let open = step.started ? null : this.open.get(prefix);
    if (!open) {
      const state = JSON.stringify(step.session);
      const row = await prisma.printSession.create({
        data: {
          printer: prefix,
          name: step.session.job.name ?? step.session.job.file,
          startedAt: new Date(step.session.startedAt),
          state,
        },
      });
      open = { id: row.id, state: step.session, saved: state, savedAt: this.deps.now(), savedMilestones: milestones(step.session) };
      this.open.set(prefix, open);
    } else {
      open.state = step.session;
      await this.save(open);
    }
    const outcome = await this.settle(watch, open.id, step.session.used, false);
    if (outcome?.notes.length) await this.addAttention(open.id, outcome.notes);
  }

  private async save(open: Open): Promise<void> {
    const state = JSON.stringify(open.state);
    const marks = milestones(open.state);
    if (state === open.saved || (marks === open.savedMilestones && this.deps.now() - open.savedAt < SAVE_EVERY_MS)) return;
    await prisma.printSession.update({
      where: { id: open.id },
      data: { state, name: open.state.job.name ?? open.state.job.file },
    });
    open.saved = state;
    open.savedAt = this.deps.now();
    open.savedMilestones = marks;
  }

  private async end(watch: PrinterWatch, id: string, ended: Ended): Promise<void> {
    const state: SessionState = { ...ended.state, used: ended.used };
    await prisma.printSession.update({
      where: { id },
      data: {
        endedAt: new Date(this.deps.now()),
        outcome: ended.outcome,
        name: state.job.name ?? state.job.file,
        state: JSON.stringify(state),
      },
    });
    if (ended.attention) await this.addAttention(id, [ended.attention]);
    this.previous.set(watch.prefix, previousPrint(state, ended.outcome, this.deps.now()));
    await this.finish(watch, id, ended.used, this.deps.now());
  }

  /** A print that ran while SpoolmanSync was not watching: what it used is unknown, so it is only recorded. */
  private async recordMissed(watch: PrinterWatch, job: Job): Promise<void> {
    const now = new Date(this.deps.now());
    const state: SessionState = {
      startedAt: now.getTime(), job, statusAt: now.getTime(), runningSince: null, progress: 100, plate: null,
      counter: null, counterAt: null, restarted: false, used: {}, lastTray: null, idleSince: null, seenAt: now.getTime(),
    };
    const row = await prisma.printSession.create({
      data: { printer: watch.prefix, name: job.name ?? job.file, startedAt: now, endedAt: now, outcome: 'missed', settled: true, state: JSON.stringify(state) },
    });
    this.previous.set(watch.prefix, previousPrint(state, 'missed', now.getTime()));
    await this.addAttention(row.id, ['This print finished while SpoolmanSync was not following the printer, so nothing was deducted for it; deduct it in Spoolman.']);
  }

  /** Write an ended print's final amounts; once complete, record it and stop retrying. */
  private async finish(watch: PrinterWatch | undefined, id: string, used: Record<string, number>, endedAt: number): Promise<void> {
    const outcome = watch ? await this.settle(watch, id, used, true) : null;
    if (outcome?.notes.length) await this.addAttention(id, outcome.notes);
    const gaveUp = this.deps.now() - endedAt > GIVE_UP_AFTER_MS;
    if (!outcome?.complete && !gaveUp) return;
    if (!outcome?.complete) await this.addAttention(id, ['Spoolman could not be reached for a day, so this print\'s remaining usage was not deducted.']);

    const session = await prisma.printSession.update({ where: { id }, data: { settled: true }, include: { deductions: true } });
    // One stopped while the printer prepared is kept: it shows the stop was seen,
    // and a reprint of the job that writes no plate weight needs this one's.
    const stoppedPreparing = (JSON.parse(session.state) as SessionState).printingFrom === null;
    if (session.deductions.length === 0 && !session.attention && !stoppedPreparing) {
      await prisma.printSession.delete({ where: { id } });
      return;
    }
    const bySpool = new Map<number, { grams: number; trayKey: string }>();
    for (const d of session.deductions) {
      bySpool.set(d.spoolId, { grams: (bySpool.get(d.spoolId)?.grams ?? 0) + d.grams, trayKey: d.trayKey });
    }
    const spools = await this.spools().catch(() => [] as Spool[]);
    for (const [spoolId, { grams, trayKey }] of bySpool) {
      if (grams < 0.005) continue;
      const spool = spools.find(s => s.id === spoolId);
      const tray = watch?.trays.find(t => t.key === trayKey);
      const label = tray?.label ?? trayKey;
      // Once per spool per print, as the dashboard's toast expects.
      const event: SpoolUpdateEvent = {
        type: 'usage', spoolId, spoolName: spool?.filament.name, deducted: Math.round(grams * 100) / 100,
        newWeight: spool?.remaining_weight, trayId: tray?.entityId ?? trayKey, timestamp: this.deps.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, event);
      await createActivityLog({
        type: 'spool_usage',
        message: `Deducted ${grams.toFixed(2)}g from spool #${spoolId}${spool ? ` (${spool.filament.name})` : ''}`
          + ` for ${session.name ? `"${session.name}"` : 'a print'} on ${watch?.name ?? session.printer} (${label})`,
        details: { spoolId, usedWeight: Math.round(grams * 100) / 100, trayId: trayKey, printer: session.printer, sessionId: id, outcome: session.outcome },
      });
    }
    this.checkAlerts(true);
  }

  /** Retry ended prints whose deductions are not all written yet. */
  private async settleEnded(): Promise<void> {
    // A print on a printer no longer watched (removed from SpoolmanSync) can never end.
    for (const [prefix, open] of this.open) {
      if (this.watches.has(prefix) || this.deps.now() - open.savedAt < ABANDON_AFTER_MS) continue;
      this.open.delete(prefix);
      await prisma.printSession.update({
        where: { id: open.id },
        data: { endedAt: new Date(this.deps.now()), outcome: 'abandoned', settled: true },
      });
    }
    for (const row of await prisma.printSession.findMany({ where: { settled: false, endedAt: { not: null } } })) {
      const state: SessionState = JSON.parse(row.state);
      await this.finish(this.watches.get(row.printer), row.id, state.used, row.endedAt!.getTime());
    }
  }

  private async settle(watch: PrinterWatch, sessionId: string, used: Record<string, number>, final: boolean): Promise<SettleResult | null> {
    if (this.deps.now() < this.spoolmanDownUntil) return null;
    const spoolman = await this.deps.spoolman();
    if (!spoolman) return null;
    const result = await settle({
      sessionId,
      unit: watch.brand === 'creality' ? 'cm' : 'g',
      used,
      final,
      label: key => watch.trays.find(t => t.key === key)?.label ?? key,
      entityId: key => watch.trays.find(t => t.key === key)?.entityId ?? null,
    }, { spoolman, spools: () => this.spools(spoolman, final) });
    // Spoolman is down: what is owed stays owed, and is written once it is back.
    if (result.retry) this.spoolmanDownUntil = this.deps.now() + 30_000;

    if (result.written.length > 0) {
      this.spoolCache = null;
      for (const w of result.written) {
        const tray = watch.trays.find(t => t.key === w.trayKey);
        if (watch.brand === 'bambu_lab' && w.grams > 0) await this.learnSerial(spoolman, w.spool, tray?.entityId ?? null);
      }
      this.checkAlerts(false);
    }
    return result;
  }

  /**
   * Store the Bambu spool serial (tray_uuid) on a spool that was just billed from
   * that tray, so it is auto-assigned when reinserted. Bambu only: Creality has
   * no per-spool serial (see src/lib/creality.ts).
   */
  private async learnSerial(spoolman: SpoolmanClient, spool: Spool, entityId: string | null): Promise<void> {
    const serial = entityId ? this.source.states.get(entityId)?.attributes.tray_uuid : undefined;
    if (typeof serial !== 'string' || !isValidTrayUuid(serial) || spool.extra?.tag === JSON.stringify(serial)) return;
    const key = `${spool.id}:${serial}`;
    if (this.taggedSerials.has(key)) return;
    this.taggedSerials.add(key);
    try {
      await spoolman.setSpoolTag(spool.id, serial);
      await createActivityLog({
        type: 'tag_stored',
        message: `Stored spool serial on spool #${spool.id} (${spool.filament.name})`,
        details: { spoolId: spool.id, trayUuid: serial },
      });
    } catch (err) {
      this.taggedSerials.delete(key);
      console.warn(`[usage] Could not store the serial on spool #${spool.id}:`, err);
    }
  }

  /** Spoolman's spools, cached briefly; `fresh` for a print's final amounts, which must see the latest assignments. */
  private async spools(client?: SpoolmanClient, fresh = false): Promise<Spool[]> {
    if (!fresh && this.spoolCache && this.deps.now() - this.spoolCache.at < SPOOL_CACHE_MS) return this.spoolCache.spools;
    const spoolman = client ?? await this.deps.spoolman();
    if (!spoolman) return [];
    const spools = await spoolman.getSpools();
    this.spoolCache = { at: this.deps.now(), spools };
    return spools;
  }

  private checkAlerts(now: boolean): void {
    if (!now && this.deps.now() - this.alertsAt < 60_000) return;
    this.alertsAt = this.deps.now();
    checkAndUpdateAlerts().catch(err => console.error('Alert check failed:', err));
  }

  private async previousFor(prefix: string): Promise<PreviousPrint | null> {
    if (!this.previous.has(prefix)) {
      const row = await prisma.printSession.findFirst({ where: { printer: prefix, endedAt: { not: null } }, orderBy: { endedAt: 'desc' } });
      this.previous.set(prefix, row ? previousPrint(JSON.parse(row.state), row.outcome as Outcome | null, row.endedAt!.getTime()) : null);
    }
    return this.previous.get(prefix) ?? null;
  }

  /** Record things the user should check about a print, and put them in the activity log once. */
  private async addAttention(sessionId: string, notes: string[]): Promise<void> {
    const row = await prisma.printSession.findUnique({ where: { id: sessionId } });
    if (!row) return;
    const fresh = notes.filter(n => !(row.attention ?? '').includes(n));
    if (fresh.length === 0) return;
    await prisma.printSession.update({ where: { id: sessionId }, data: { attention: [row.attention, ...fresh].filter(Boolean).join(' ') } });
    const printer = this.watches.get(row.printer)?.name ?? row.printer;
    for (const note of fresh) {
      await createActivityLog({
        type: 'usage_attention',
        message: `${printer}${row.name ? ` ("${row.name}")` : ''}: ${note}`,
        details: { printer: row.printer, sessionId },
      });
    }
  }
}

function previousPrint(state: SessionState, outcome: Outcome | null, endedAt: number): PreviousPrint {
  return {
    // One that ended while still preparing printed nothing to resume.
    job: state.job, outcome, endedAt, progress: state.printingFrom === null ? 0 : state.progress, counter: state.counter,
    printingFrom: state.printingFrom ?? 0,
    plateGrams: state.plate?.grams ?? null, plate: state.plate ? plateMark(state.plate.grams, state.plate.trays) : null,
  };
}

async function spoolmanClient(): Promise<SpoolmanClient | null> {
  const connection = await prisma.spoolmanConnection.findFirst();
  return connection ? new SpoolmanClient(connection.url) : null;
}

async function discoverPrinters(): Promise<HAPrinter[] | null> {
  const ha = await HomeAssistantClient.fromConnection();
  if (!ha) return null;
  const { getHiddenPrinters } = await import('@/app/api/printers/setup/route');
  return filterHiddenPrinters(await ha.discoverPrinters(), await getHiddenPrinters()).filter(p => !p.is_virtual);
}

const tracker = () => processGlobal('usage-tracker', () => ({ instance: null as UsageTracker | null }));

/** Start the tracker once per process. */
export async function startUsageTracker(): Promise<void> {
  const slot = tracker();
  if (slot.instance) return;
  // A refresh token Home Assistant refused is not presented again until it is
  // replaced (by reconnecting in Settings): HA counts each refusal towards its
  // IP ban, and the reconnect loop would otherwise retry it every minute.
  let refused: string | null = null;
  slot.instance = new UsageTracker({
    discover: discoverPrinters,
    spoolman: spoolmanClient,
    cleanup: async () => {
      const ha = await HomeAssistantClient.fromConnection();
      return ha ? removeLegacyEntities(ha) : [];
    },
    refreshCfs: async deviceIds => {
      await (await HomeAssistantClient.fromConnection())?.callService('ha_creality_ws', 'request_cfs_info', deviceIds.length > 0 ? { device_id: deviceIds } : {});
    },
    source: (onChange, onStatus) => new EntitySubscription({
      connect: async () => {
        const ha = await HomeAssistantClient.fromConnection();
        if (!ha) return null;
        const stored = (await prisma.hAConnection.findFirst())?.refreshToken ?? null;
        if (refused !== null && stored === refused) throw new Error('Home Assistant refused the stored login; reconnect Home Assistant in Settings');
        try {
          const token = await ha.currentAccessToken();
          return token ? { url: ha.url, token } : null;
        } catch (err) {
          if (/refresh HA access token: 40[013]/.test(String(err))) refused = stored;
          throw err;
        }
      },
      onChange,
      onStatus,
    }),
    now: () => Date.now(),
  });
  await slot.instance.start();
  console.log('[usage] Tracking filament usage in SpoolmanSync');
}

export function usageTracker(): UsageTracker | null {
  return tracker().instance;
}

/** The Home Assistant connection was replaced or removed: drop the old one. */
export function reconnectUsageTracker(): void {
  tracker().instance?.reconnect();
}

/**
 * Pick up printers that were just added, removed or shown again, now and once
 * more shortly after, for a new printer whose entities HA is still registering.
 */
export function refreshUsagePrinters(): void {
  const instance = tracker().instance;
  if (!instance) return;
  void instance.rediscover();
  setTimeout(() => void instance.rediscover(), 30_000).unref?.();
}
