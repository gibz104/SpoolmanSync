import { FakeHA, FakeSpoolman, X1, K2, bambuPrinter, bambuIdle, crealityPrinter, crealityIdle, crealityFrame, refused, timedOut } from './test-fixtures';
import { describe, it, expect, afterEach } from 'vitest';
import prisma from '@/lib/db';
import type { HAPrinter } from '@/lib/api/homeassistant';
import type { SpoolmanClient } from '@/lib/api/spoolman';
import { filamentWeight } from '@/lib/webhook-helpers';
import { UsageTracker } from './tracker';

/**
 * Randomized print histories with the disturbances real setups see (Home
 * Assistant and SpoolmanSync restarting, Spoolman going down, the printer
 * dropping off, glitched readings, jobs resumed after power loss), checked
 * against what each print actually used. FUZZ_RUNS=500 (and FUZZ_FROM, the
 * first seed) for a long run; FUZZ_SEED reruns one history.
 */
const RUNS = Number(process.env.FUZZ_RUNS ?? 12);
const FROM = Number(process.env.FUZZ_FROM ?? 1000);
const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: RUNS }, (_, i) => FROM + i);

function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}
type Random = ReturnType<typeof random>;

let ha: FakeHA;
let spoolman: FakeSpoolman;
let tracker: UsageTracker | null = null;
let printers: HAPrinter[];

async function boot(): Promise<void> {
  tracker?.stop();
  tracker = new UsageTracker({
    discover: async () => printers,
    spoolman: async () => spoolman as unknown as SpoolmanClient,
    refreshCfs: async () => {},
    source: (onChange, onStatus) => ha.source(onChange, onStatus),
    now: () => ha.now,
  });
  await tracker.start();
}

async function reset(p: HAPrinter[]): Promise<void> {
  tracker?.stop();
  tracker = null;
  await prisma.usageDeduction.deleteMany();
  await prisma.printSession.deleteMany();
  await prisma.activityLog.deleteMany();
  ha = new FakeHA();
  spoolman = new FakeSpoolman();
  printers = p;
}

/** Let Spoolman back and the tracker settle every ended print. */
async function settleAll(): Promise<void> {
  spoolman.failWith = null;
  for (let i = 0; i < 5; i++) {
    ha.tick(60_000);
    await tracker!.heartbeat();
  }
}

// A history runs on settled promises alone (in-memory fakes, synchronous
// SQLite), so yield to the event loop between runs: Vitest's progress reports
// to its main process are otherwise not acknowledged for minutes, and a long
// run ends with a spurious "Timeout calling onTaskUpdate" error.
afterEach(async () => {
  tracker?.stop();
  await new Promise(resolve => setImmediate(resolve));
});

const close = (got: number, want: number, tol: number) => Math.abs(got - want) <= tol;

describe('Bambu histories', () => {
  /** Spool per feed slot: AMS trays 1-4, and 0 for the external spool. */
  const SPOOL = (slot: number) => (slot === 0 ? 9 : slot);

  interface Print {
    name: string;
    plate: number;
    /** Slot feeding from each progress on (0 = external spool). */
    feed: Array<[number, number]>;
    outcome: 'finish' | 'failed' | 'cancel';
    endAt: number;
    /** When the 3mf is parsed: at PREPARE (cloud), or once RUNNING at this progress. */
    plateAt: 'prepare' | number;
    /** When the job's names arrive: with the status, with RUNNING, or at this progress. */
    namesAt: 'status' | 'running' | number;
    /** RUNNING is reported before the last print's progress resets. */
    runningFirst: boolean;
    /** Resume the previous (failed) print of this job from where it stopped. */
    resume: boolean;
    /** Between this print and the last: Home Assistant restarts, or the printer is power-cycled. */
    before: 'nothing' | 'ha' | 'power';
    /** Progress (%) the printer heats, levels and calibrates for, reporting its stage; null when it reports none. */
    warmup: number | null;
  }

  function plan(r: Random, clears: boolean, stages: boolean): Print[] {
    const prints: Print[] = [];
    const used = new Set<number>();
    const plate = () => {
      // Only a plate cleared as the print starts shows a new job of the last one's weight.
      const last = prints.at(-1);
      if (clears && last && r.chance(0.25)) return last.plate;
      let g: number;
      do g = r.int(100, 30_000) / 100; while (used.has(g));
      used.add(g);
      return g;
    };
    const before = () => r.pick(['nothing', 'nothing', 'nothing', 'ha', 'power'] as const);
    const count = r.int(2, 4);
    for (let i = 0; i < count; i++) {
      const last = prints.at(-1);
      // Only a print that got to printing has anything to resume.
      if (last && last.outcome === 'failed' && last.endAt >= 10 && (last.warmup === null || last.endAt > last.warmup) && r.chance(0.4)) {
        const finish = r.chance(0.7);
        prints.push({
          ...last, outcome: finish ? 'finish' : 'failed', endAt: finish ? 100 : r.int(last.endAt + 1, 99),
          resume: true, runningFirst: false, namesAt: 'status', before: 'nothing',
        });
        continue;
      }
      if (last && last.outcome !== 'cancel' && !last.resume && r.chance(0.2)) {
        // The same job again, identical plate: before ha-bambulab 2.3, nothing new is written for it.
        prints.push({ ...last, outcome: 'finish', endAt: 100, resume: false, namesAt: 'status', before: before() });
        continue;
      }
      const warmup = stages ? r.int(0, 45) : null;
      const slot = () => (r.chance(0.2) ? 0 : r.int(1, 4));
      const feed: Array<[number, number]> = [[0, slot()]];
      // Filament changes come while printing, after any warming up.
      for (let n = r.int(0, 2); n > 0; n--) feed.push([r.int(Math.max(feed.at(-1)![0], warmup ?? 0) + 1, 95), slot()]);
      const outcome = r.pick(['finish', 'finish', 'finish', 'failed', 'failed', 'cancel'] as const);
      prints.push({
        name: `job-${i}`, plate: plate(), feed, outcome,
        endAt: outcome === 'finish' ? 100 : r.int(1, 99),
        plateAt: r.chance(0.4) ? 'prepare' : r.chance(0.7) ? 0 : r.int(1, 10),
        namesAt: r.chance(0.7) ? 'status' : r.chance(0.5) ? 'running' : r.int(1, 15),
        runningFirst: r.chance(0.2), resume: false, before: before(), warmup,
      });
    }
    return prints;
  }

  /** The share of the plate printed by this progress (%), which warming up moves first. */
  const printed = (p: Print, pct: number) =>
    p.warmup === null ? pct / 100 : pct >= 100 ? 1 : Math.max(0, pct - p.warmup) / (100 - p.warmup);

  /** The slicer's grams per AMS tray (ha-bambulab leaves the external spool out). */
  function amsSplit(p: Print): Record<string, number> {
    const out: Record<string, number> = {};
    p.feed.forEach(([from, slot], i) => {
      if (slot === 0) return;
      const to = p.feed[i + 1]?.[0] ?? 100;
      const key = `AMS 1 Tray ${slot}`;
      out[key] = Math.round(((out[key] ?? 0) + p.plate * (printed(p, to) - printed(p, from))) * 100) / 100;
    });
    return out;
  }
  const slotAt = (p: Print, pct: number) => p.feed.filter(([at]) => at < Math.max(pct, 1)).at(-1)![1];

  for (const seed of SEEDS) {
    // Odd seeds play ha-bambulab 2.3, which zeroes print_weight as each print
    // starts; even ones the versions before it, which keep the last plate until
    // the new print's 3mf is parsed.
    const clears = seed % 2 === 1;
    // Seeds 2-3 of every 4 report current_stage, the printer heating, levelling
    // and calibrating while the progress moves before it prints.
    const stages = Math.floor(seed / 2) % 2 === 1;
    it(`bills what each print used (seed ${seed}${clears ? ', ha-bambulab 2.3' : ''}${stages ? ', warming up' : ''})`, async () => {
      const r = random(seed);
      await reset([bambuPrinter()]);
      for (const n of [1, 2, 3, 4]) spoolman.add(SPOOL(n), X1.key(n));
      spoolman.add(SPOOL(0), X1.extKey);
      bambuIdle(ha);
      await boot();

      const prints = plan(r, clears, stages);
      const expected: Array<{ total: number; perSlot: Record<number, number> | null }> = [];
      let running = true;
      const flush = async () => { if (running) await tracker!.flush(); };
      const step = async (ms: number) => { ha.tick(ms); await flush(); };
      // ha-bambulab's print_weight: the last parsed plate, its attributes the
      // AMS split unless the external spool is active, then the whole plate under it.
      let parsed = { grams: 0, split: {} as Record<string, number> };
      let feeding: number | null = null;
      const render = () => ha.set(X1.weight, parsed.grams, feeding === 0 ? { 'External Spool': parsed.grams } : parsed.split);
      const feed = (slot: number | null) => {
        feeding = slot;
        for (const m of [1, 2, 3, 4]) ha.attr(X1.tray(m), { active: m === slot });
        ha.attr(X1.ext, { active: slot === 0 });
        render();
      };
      const log: string[] = [];
      const unweighed = new Set<string>();
      // Which slot each spool sits in, swapped-in spools included.
      const slotOf = new Map([0, 1, 2, 3, 4].map(n => [SPOOL(n), n]));
      let timeouts = 0;

      for (const p of prints) {
        log.push(JSON.stringify(p));
        // This print's 3mf parsed while it ran, or (a reprint or resume) already shown.
        let known = parsed.grams === p.plate;
        const parse = () => { parsed = { grams: p.plate, split: amsSplit(p) }; known = true; render(); };
        const names = () => { ha.set(X1.name, p.name); ha.set(X1.file, `${p.name}.gcode.3mf`); };
        let progress = p.resume ? prints[prints.indexOf(p) - 1].endAt : 0;
        const start = progress;
        // Where the tracker saw progress move, and which slot fed then.
        const seen: Array<[number, number]> = [];
        let shown = progress; // what HA shows
        let offline = false;
        let named = p.namesAt === 'status' || p.namesAt === 'running';
        let late = false; // names or plate arrived after the print was under way
        const arrive = () => {
          if (!named && progress >= (p.namesAt as number)) { names(); named = late = true; }
          if (typeof p.plateAt === 'number' && p.plateAt > 0 && progress >= p.plateAt && parsed.grams !== p.plate) { parse(); late = true; }
        };

        if (p.before === 'ha') {
          ha.restart();
          await step(60_000);
        }
        if (p.before === 'power' || p.resume) {
          // The printer drops off and comes back, a resumed job still showing where it stopped.
          ha.set(X1.status, 'offline');
          ha.set(X1.progress, 'unavailable');
          await step(5 * 60_000);
          ha.set(X1.status, 'idle');
          ha.set(X1.progress, p.resume ? progress : 100);
          await step(60_000);
        }
        ha.set(X1.status, 'prepare');
        if (clears) { parsed = { grams: 0, split: {} }; known = false; render(); }
        if (p.namesAt === 'status') names();
        if (p.plateAt === 'prepare') parse();
        await step(1_000);
        feed(slotAt(p, progress + 1));
        await step(30_000);
        if (p.outcome === 'cancel') {
          ha.set(X1.status, 'failed');
          await step(1_000);
          feed(null);
          await step(1_000);
          if (p.namesAt !== 'status') names();
          expected.push({ total: 0, perSlot: {} });
          continue;
        }
        if (p.runningFirst) {
          ha.set(X1.status, 'running');
          await step(2_000);
          ha.set(X1.progress, 0);
        } else {
          if (!p.resume) ha.set(X1.progress, 0);
          ha.set(X1.status, 'running');
        }
        if (p.namesAt === 'running') names();
        await step(5_000);
        if (p.plateAt === 0) parse();
        await step(1_000);

        if (p.warmup !== null) {
          // Heating, levelling and calibrating: the progress moves (0 -> 3 -> 30 on
          // an X1C), and a print can stop before it begins printing. A resumed job
          // only heats up again.
          ha.set(X1.stage, 'heatbed_preheating');
          await step(30_000);
          for (const pct of p.resume ? [] : [Math.min(p.warmup, r.int(1, 4)), p.warmup]) {
            if (pct <= progress || progress >= p.endAt) continue;
            progress = Math.min(pct, p.endAt);
            ha.set(X1.stage, 'auto_bed_leveling');
            ha.set(X1.progress, progress);
            shown = progress;
            arrive();
            await step(60_000);
          }
          if (progress < p.endAt) {
            ha.set(X1.stage, 'printing');
            await step(5_000);
          }
        }

        const disturbAt = r.int(progress + 1, Math.max(progress + 1, p.endAt));
        const disturbance = r.pick(['none', 'none', 'ha', 'app', 'spoolman', 'offline', 'glitch', 'timeout', 'swap', 'unassign'] as const);
        let unassigned: { spool: number; tray: string } | null = null;
        let disturbed = false;
        while (progress < p.endAt) {
          progress = Math.min(p.endAt, progress + r.int(1, 4));
          const slot = slotAt(p, progress);
          feed(slot);
          arrive();
          if (!disturbed && progress >= disturbAt) {
            disturbed = true;
            log.push(`  ${disturbance} at ${progress}`);
            if (disturbance === 'ha') {
              for (const id of [X1.status, X1.progress, X1.weight]) ha.set(id, 'unavailable', {});
              await step(30_000);
              ha.restart();
              ha.set(X1.status, 'running');
              ha.set(X1.progress, shown);
              ha.set(X1.weight, 0, {});
              await step(5_000);
              parse(); // ha-bambulab downloads the running job's 3mf again as it starts
              late = true;
            } else if (disturbance === 'app') {
              tracker!.stop();
              running = false;
            } else if (disturbance === 'spoolman') {
              spoolman.failWith = refused();
            } else if (disturbance === 'timeout') {
              // The next write times out; Spoolman may or may not have applied it.
              if (r.chance(0.5)) spoolman.failNextWrite = timedOut(); else spoolman.loseNextAnswer = timedOut();
              timeouts++;
            } else if (disturbance === 'swap' || disturbance === 'unassign') {
              // The feeding tray's spool is replaced by a fresh one, or left with none for a while.
              const tray = slot === 0 ? X1.extKey : X1.key(slot);
              const current = spoolman.spools.find(sp => sp.extra?.active_tray === JSON.stringify(tray))!;
              spoolman.assign(current.id, null);
              if (disturbance === 'swap') {
                const fresh = 100 + spoolman.spools.length;
                spoolman.add(fresh, tray);
                slotOf.set(fresh, slot);
              } else {
                unassigned = { spool: current.id, tray };
              }
            } else if (disturbance === 'offline') {
              ha.set(X1.status, 'offline');
              ha.set(X1.progress, 'unavailable');
              offline = true;
            } else if (disturbance === 'glitch') {
              ha.set(X1.progress, 0);
              await step(1_000);
            }
          }
          if (offline && progress >= disturbAt + 8) {
            ha.set(X1.status, 'running');
            offline = false;
          }
          if (!running && progress >= disturbAt + 6) {
            running = true;
            await boot();
            await tracker!.heartbeat();
          }
          if (spoolman.failWith && progress >= disturbAt + 10) spoolman.failWith = null;
          if (unassigned && progress >= disturbAt + 8) { spoolman.assign(unassigned.spool, unassigned.tray); unassigned = null; }
          if (!offline) {
            ha.set(X1.progress, progress);
            shown = progress;
            if (running) seen.push([progress, slot]);
          }
          await step(30_000);
        }
        if (offline) { ha.set(X1.status, 'running'); ha.set(X1.progress, progress); offline = false; await step(1_000); seen.push([progress, slotAt(p, progress)]); }
        if (!running) { running = true; await boot(); await tracker!.heartbeat(); seen.push([progress, slotAt(p, progress)]); }
        if (unassigned) { spoolman.assign(unassigned.spool, unassigned.tray); unassigned = null; }
        if (!named) { names(); named = late = true; }
        ha.set(X1.status, p.outcome);
        if (p.warmup !== null) ha.set(X1.stage, 'idle');
        await step(1_000);
        feed(null);
        await step(1_000);

        // A print that ended before its 3mf was parsed has no weight to bill (and is
        // flagged); a resumed job owes the rest of the plate.
        let owed = known ? p.plate * (printed(p, p.endAt) - printed(p, start)) : 0;
        if (!known) unweighed.add(p.name);
        const slots = new Set(p.feed.map(([, slot]) => slot));
        let perSlot: Record<number, number> | null = known ? null : {};
        if (known && p.outcome === 'finish' && start === 0 && !(slots.has(0) && slots.size > 1 && slotAt(p, 100) === 0)) {
          // The slicer's figures settle it, the external spool taking the rest of the plate --
          // unless that is feeding at the end, when ha-bambulab shows the plate under it alone.
          const split = Object.fromEntries(Object.entries(amsSplit(p)).map(([k, g]) => [Number(k.slice(-1)), g]));
          const rest = p.plate - Object.values(split).reduce((a, b) => a + b, 0);
          // Never seen feeding, it is only told from the slicer's rounding when the rest is more than that.
          const rounding = slots.has(0) && !seen.some(([, slot]) => slot === 0) && rest <= Math.max(0.5, p.plate * 0.02) / 4;
          if (rounding) owed -= rest;
          perSlot = slots.has(0) && !rounding ? { ...split, 0: rest } : split;
        } else if (known && disturbance === 'none' && !late && p.plateAt !== 'prepare') {
          perSlot = {};
          let last = start;
          for (const [pct, slot] of seen) {
            perSlot[slot] = (perSlot[slot] ?? 0) + p.plate * (printed(p, pct) - printed(p, last));
            last = pct;
          }
        }
        expected.push({ total: owed, perSlot });
      }
      await settleAll();

      const billed = [0, 1, 2, 3, 4].map(n => spoolman.spools.filter(sp => slotOf.get(sp.id) === n).reduce((a, sp) => a + spoolman.used(sp.id), 0));
      // A write that timed out is never sent again: if it did not reach Spoolman, its grams are missing (and flagged).
      const uncertain = (await prisma.usageDeduction.findMany({ where: { status: 'uncertain' } }));
      const lost = spoolman.dropped.reduce((a, d) => a + d.grams, 0);
      const total = expected.reduce((a, e) => a + e.total, 0);
      const recorded = (await prisma.printSession.findMany({ orderBy: { startedAt: 'asc' }, include: { deductions: true } })).map(row => {
        const state = JSON.parse(row.state);
        const perTray: Record<string, number> = {};
        for (const d of row.deductions) perTray[d.trayKey.slice(-6)] = Math.round(((perTray[d.trayKey.slice(-6)] ?? 0) + d.grams) * 1000) / 1000;
        return `${row.name} ${row.outcome} progress=${state.progress} from=${state.resumedFrom} printingFrom=${state.printingFrom} sawStart=${state.sawStart} billed=${row.deductions.reduce((a, d) => a + d.grams, 0).toFixed(3)} ${JSON.stringify(perTray)} used=${JSON.stringify(state.used)} ${row.attention ?? ''}`;
      });
      const context = `seed ${seed}\n${log.join('\n')}\nexpected ${JSON.stringify(expected)}\nbilled ${JSON.stringify(billed)}\n${recorded.join('\n')}`;
      expect(close(billed.reduce((a, b) => a + b, 0), total - lost, 0.02 * prints.length), `${context}\nlost to timeouts ${lost}`).toBe(true);
      expect(uncertain.length, context).toBeLessThanOrEqual(timeouts);
      // Per spool, wherever the print's split is certain.
      if (timeouts === 0 && expected.every(e => e.perSlot)) {
        for (const n of [0, 1, 2, 3, 4]) {
          const want = expected.reduce((a, e) => a + (e.perSlot![n] ?? 0), 0);
          expect(close(billed[n], want, 0.02 * prints.length), `${context}\nslot ${n}: want ${want}`).toBe(true);
        }
      }
      const rows = await prisma.printSession.findMany({ include: { deductions: true } });
      expect(rows.every(row => row.settled), context).toBe(true);
      expect(await prisma.usageDeduction.count({ where: { status: { notIn: ['done', 'uncertain'] } } }), context).toBe(0);
      // A print with no problem raises no flag beyond a resume's own note.
      const flagged = rows.filter(row => row.attention && !/resumed the job/.test(row.attention)
        && !(unweighed.has(row.name ?? '') && /never reported/.test(row.attention))
        && !(timeouts > 0 && /did not confirm/.test(row.attention)));
      expect(flagged.map(row => row.attention), context).toEqual([]);
    }, 60_000);
  }
});

describe('Creality histories', () => {
  const grams = (cm: number) => filamentWeight(cm, { density: 1.24, diameter: 1.75 });

  for (const seed of SEEDS) {
    it(`bills the length each job extruded (seed ${seed})`, async () => {
      const r = random(seed);
      await reset([crealityPrinter()]);
      for (const n of [1, 2, 3, 4]) spoolman.add(20 + n, K2.key(n));
      spoolman.add(29, K2.extKey);
      let counter = r.int(0, 30_000); // mm: the last job's figure
      crealityIdle(ha, counter, 'old.gcode');
      await boot();

      let running = true;
      const flush = async () => { if (running) await tracker!.flush(); };
      const frame = async (status: string, mm: number | null, file: string, progress: number, ms = 30_000) => {
        crealityFrame(ha, status, mm, file, { progress });
        ha.tick(ms);
        await flush();
      };
      const select = (slot: number) => {
        for (const n of [1, 2, 3, 4]) ha.attr(K2.slot(n), { selected: n === slot ? 1 : 0 });
        ha.attr(K2.ext, { selected: slot === 0 ? 1 : 0 });
      };
      const log: string[] = [];
      let expectedMm = 0;

      const jobs = r.int(2, 4);
      for (let j = 0; j < jobs; j++) {
        const file = r.chance(0.2) && j > 0 ? `job-${j - 1}.gcode` : `job-${j}.gcode`;
        const frames = r.int(4, 30);
        const slots = [r.int(0, 4)];
        const disturbance = r.pick(['none', 'stray', 'glitch', 'lone-idle', 'off', 'resume-restart', 'resume-idle', 'ha', 'app', 'spoolman'] as const);
        const end = r.pick(['completed', 'completed', 'echo', 'stopped', 'idle'] as const);
        const at = r.int(1, frames);
        const before = expectedMm;
        log.push(`${file} frames=${frames} ${disturbance}@${at} end=${end} from ${counter}`);
        select(slots[0]);
        // The first frame still carries the last job's counter, then it restarts.
        await frame('printing', counter, file, 0, 1_000);
        let mm = 0;
        let base = 0; // the counter's zero, moved by a restart
        await frame('printing', 0, file, 0);
        for (let i = 1; i <= frames; i++) {
          if (r.chance(0.15)) select(r.int(0, 4));
          const add = r.int(50, 1_400);
          mm += add;
          expectedMm += add;
          const progress = Math.min(99, Math.round(i / frames * 100));
          if (i === at) {
            if (disturbance === 'stray' && counter > mm - base) await frame('printing', counter, file, progress, 2_000);
            if (disturbance === 'glitch') await frame('printing', 0, file, progress, 2_000);
            if (disturbance === 'lone-idle') await frame('idle', mm - add - base, file, progress, 2_000);
            if (disturbance === 'off') await frame('off', mm - add - base, file, progress, 10 * 60_000);
            if (disturbance === 'resume-restart') {
              await frame('off', mm - add - base, file, progress, 10 * 60_000);
              base = mm - add; // the resumed job counts from zero again
            }
            if (disturbance === 'resume-idle') {
              await frame('off', mm - add - base, file, progress, 10 * 60_000);
              await frame('idle', mm - add - base, '', 0, 1_000);
              for (let m = 0; m < 3; m++) { ha.tick(60_000); await tracker!.heartbeat(); }
            }
            if (disturbance === 'ha') { ha.restart(); await flush(); }
            if (disturbance === 'app') { tracker!.stop(); running = false; }
            if (disturbance === 'spoolman') spoolman.failWith = refused();
          }
          if (!running && i >= at + 3) { running = true; await boot(); }
          if (spoolman.failWith && i >= at + 5) spoolman.failWith = null;
          await frame('printing', mm - base, file, progress);
        }
        if (!running) { running = true; await boot(); }
        if (end === 'stopped') {
          await frame('stopped', mm - base, file, 60, 1_000);
        } else if (end === 'idle') {
          await frame('idle', mm - base, file, 60, 1_000);
          for (let m = 0; m < 3; m++) { ha.tick(60_000); await tracker!.heartbeat(); }
        } else {
          await frame('completed', mm - base, file, 100, 1_000);
          if (end === 'echo') {
            await frame('printing', mm - base, file, 99, 1_000);
            await frame('completed', mm - base, file, 100, 1_000);
          }
        }
        await frame('idle', mm - base, '', 0, 60_000);
        log.push(`  extruded ${((expectedMm - before) / 10).toFixed(1)}cm`);
        counter = mm - base;
      }
      await settleAll();

      const billed = [21, 22, 23, 24, 29].reduce((a, id) => a + spoolman.used(id), 0);
      const want = grams(expectedMm / 10);
      const recorded = (await prisma.printSession.findMany({ orderBy: { startedAt: 'asc' }, include: { deductions: true } })).map(row => {
        const state = JSON.parse(row.state);
        return `${row.name} ${row.outcome} counter=${state.counter} restarted=${state.restarted} cm=${Object.values(state.used as Record<string, number>).reduce((a, b) => a + b, 0).toFixed(1)} billed=${row.deductions.reduce((a, d) => a + d.grams, 0).toFixed(3)}g ${row.attention ?? ''}`;
      });
      const context = `seed ${seed}\n${log.join('\n')}\nexpected ${want.toFixed(3)}g (${(expectedMm / 10).toFixed(1)}cm) billed ${billed.toFixed(3)}g\n${recorded.join('\n')}`;
      // A disturbance can cost the frame it hides (at most one 140cm frame, about 4g) but never adds any.
      expect(billed, context).toBeLessThanOrEqual(want + 0.01 * jobs);
      expect(billed, context).toBeGreaterThanOrEqual(want - grams(140) * jobs - 0.01 * jobs);
      const rows = await prisma.printSession.findMany();
      expect(rows.every(row => row.settled), context).toBe(true);
      expect(rows.filter(row => row.attention).map(row => row.attention), context).toEqual([]);
    }, 60_000);
  }
});
