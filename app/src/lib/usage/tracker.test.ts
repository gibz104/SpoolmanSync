import {
  FakeHA, FakeSpoolman, X1, K2, H2D, bambuPrinter, bambuIdle, bambuPrint, crealityPrinter, crealityIdle,
  crealityPrint, crealityFrame, h2dPrinter, h2dIdle, h2dPrint, refused, timedOut,
} from './test-fixtures';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import prisma from '@/lib/db';
import type { HAPrinter } from '@/lib/api/homeassistant';
import type { SpoolmanClient } from '@/lib/api/spoolman';
import { filamentWeight } from '@/lib/webhook-helpers';
import { spoolEvents, SPOOL_UPDATED, type SpoolUpdateEvent } from '@/lib/events';
import { UsageTracker } from './tracker';

/**
 * The usage tracker end to end: Home Assistant entity changes in, Spoolman
 * deductions out, through the real session logic, ledger and SQLite database.
 */

let ha: FakeHA;
let spoolman: FakeSpoolman;
let tracker: UsageTracker;
let printers: HAPrinter[];
let cfsRequests: string[][] = [];

async function boot(): Promise<UsageTracker> {
  tracker?.stop();
  tracker = new UsageTracker({
    discover: async () => printers,
    spoolman: async () => spoolman as unknown as SpoolmanClient,
    refreshCfs: async ids => { cfsRequests.push(ids); },
    source: (onChange, onStatus) => ha.source(onChange, onStatus),
    now: () => ha.now,
  });
  await tracker.start();
  return tracker;
}

const flush = () => tracker.flush();
const sessions = () => prisma.printSession.findMany({ orderBy: { createdAt: 'asc' }, include: { deductions: true } });
const usageLogs = async () => (await prisma.activityLog.findMany({ where: { type: 'spool_usage' } })).map(l => JSON.parse(l.details!));
const attention = async () => (await sessions()).map(s => s.attention).filter(Boolean).join(' ');
/** What the activity log says about prints starting and ending with nothing deducted, sorted. */
const printLogs = async () =>
  (await prisma.activityLog.findMany({ where: { type: { in: ['print_started', 'print_ended'] } } })).map(l => l.message).sort();
const cm = (mm: number) => mm / 10;

beforeEach(async () => {
  await prisma.usageDeduction.deleteMany();
  await prisma.printSession.deleteMany();
  await prisma.activityLog.deleteMany();
  ha = new FakeHA();
  spoolman = new FakeSpoolman();
  printers = [bambuPrinter()];
  for (const n of [1, 2, 3, 4]) spoolman.add(n, X1.key(n));
  spoolman.add(9, X1.extKey);
});

afterEach(() => tracker?.stop());

describe('Bambu', () => {
  beforeEach(async () => {
    bambuIdle(ha);
    await boot();
  });

  it('bills a finished print its plate weight', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1 });
    expect(spoolman.used(1)).toBe(100);
    expect(await usageLogs()).toMatchObject([{ spoolId: 1, usedWeight: 100 }]);
    expect((await sessions())[0]).toMatchObject({ outcome: 'finished', settled: true, name: 'benchy', attention: null });
    expect(await printLogs()).toEqual(['Print started: "benchy" on X1C']);
  });

  it('keeps Spoolman current during the print', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 50 });
    expect(spoolman.used(1)).toBeGreaterThanOrEqual(49);
    expect(spoolman.used(1)).toBeLessThanOrEqual(50);
  });

  it('tells the dashboard once per spool when a print is recorded', async () => {
    const events: SpoolUpdateEvent[] = [];
    const off = spoolEvents.on(SPOOL_UPDATED, e => { if ((e as SpoolUpdateEvent).type === 'usage') events.push(e as SpoolUpdateEvent); });
    await bambuPrint(ha, flush, {
      name: 'two-tone', plate: 100, tray: [[0, 1], [50, 2]], trays: { 'AMS 1 Tray 1': 60, 'AMS 1 Tray 2': 40 },
    });
    off();
    expect(events.map(e => [e.spoolId, e.deducted])).toEqual([[1, 60], [2, 40]]);
  });

  it('settles a finished multi-colour print to the slicer\'s split', async () => {
    await bambuPrint(ha, flush, {
      name: 'two-tone', plate: 100, tray: [[0, 1], [50, 2]],
      trays: { 'AMS 1 Tray 1': 60, 'AMS 1 Tray 2': 40 },
    });
    expect(spoolman.used(1)).toBe(60);
    expect(spoolman.used(2)).toBe(40);
  });

  it('gives the external spool the part of a finished plate the slicer\'s split leaves out', async () => {
    // It fed between two progress readings, so it was never seen active.
    await bambuPrint(ha, flush, { name: 'tiny-ext', plate: 80, tray: 1, trays: { 'AMS 1 Tray 1': 79.2 } });
    expect(spoolman.used(1)).toBe(79.2);
    expect(spoolman.used(9)).toBe(0.8);
  });

  it('charges no external spool for the slicer\'s rounding on an AMS-only print', async () => {
    await bambuPrint(ha, flush, { name: 'rounded', plate: 80, tray: 1, trays: { 'AMS 1 Tray 1': 79.95 } });
    expect(spoolman.used(1)).toBe(79.95);
    expect(spoolman.used(9)).toBe(0);
  });

  it('bills a failed print for the part it printed, to the tray that fed it', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 80, tray: 3, endAt: 50, outcome: 'failed' });
    expect(spoolman.used(3)).toBe(40);
    expect((await sessions())[0].outcome).toBe('failed');
  });

  it('bills a cloud-mode print, whose plate arrives at PREPARE', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 42, tray: 1, cloud: true });
    expect(spoolman.used(1)).toBe(42);
  });

  it('bills the external spool', async () => {
    ha.attr(X1.ext, { name: 'PLA', active: false });
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'ext');
    ha.set(X1.file, 'ext.gcode.3mf');
    ha.tick(1000); await flush();
    ha.attr(X1.ext, { active: true });
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5000); await flush();
    ha.set(X1.weight, 30, { 'External Spool': 30 });
    for (let pct = 10; pct <= 100; pct += 10) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(9)).toBe(30);
  });

  it('does not bill the previous print\'s plate after Home Assistant restarts between prints', async () => {
    await bambuPrint(ha, flush, { name: 'big', plate: 100, tray: 1 });
    ha.tick(60_000);
    ha.restart(); // ha-bambulab re-publishes the last print's 100g with new timestamps
    ha.tick(60_000); await flush();
    await bambuPrint(ha, flush, { name: 'small', plate: 15, tray: 2, endAt: 50, outcome: 'failed' });
    expect(spoolman.used(2)).toBe(7.5);
  });

  it('ignores the previous print\'s progress when RUNNING arrives before the reset', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1, endAt: 79, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(39.5);
    await bambuPrint(ha, flush, { name: 'second', plate: 100, tray: 2, runningBeforeReset: true });
    expect(spoolman.used(2)).toBe(100);
  });

  it('bills an identical reprint, which writes no new plate weight', async () => {
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1 });
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1 });
    expect(spoolman.used(1)).toBe(100);
    // ...in cloud mode, and after a Home Assistant restart in between
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1, cloud: true });
    ha.restart();
    ha.tick(10_000); await flush();
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1 });
    expect(spoolman.used(1)).toBe(200);
  });

  it('bills nothing, and says so, when a print\'s weight never arrives', async () => {
    await bambuPrint(ha, flush, { name: 'big', plate: 100, tray: 1 });
    await bambuPrint(ha, flush, { name: 'other', plate: 100, tray: 1, writesPlate: false });
    expect(spoolman.used(1)).toBe(100);
    expect(await attention()).toContain('never reported this print\'s weight');
  });

  it('does not bill a two-colour print the weight left over from the print before (#90)', async () => {
    // ha-bambulab could not find the second print's 3mf, so print_weight kept the
    // first print's 2.62g throughout. The old YAML charged a 69g print those
    // 2.62g, spread over its colour changes.
    await bambuPrint(ha, flush, { name: 'small', plate: 2.62, tray: 2 });
    await bambuPrint(ha, flush, {
      name: 'part', plate: 69.09, tray: [[0, 1], [28, 2], [34, 1], [36, 2], [40, 1]], writesPlate: false,
    });
    expect(spoolman.used(1)).toBe(0);
    expect(spoolman.used(2)).toBe(2.62);
    const part = (await sessions())[1];
    expect(part).toMatchObject({ name: 'part', outcome: 'finished', deductions: [] });
    expect(part.attention).toContain('never reported this print\'s weight');
  });

  it('bills a different job of the last one\'s weight once ha-bambulab 2.3 clears the plate at the start', async () => {
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1, clearsPlate: true });
    await bambuPrint(ha, flush, { name: 'cube-copy', plate: 50, tray: 1, clearsPlate: true });
    expect(spoolman.used(1)).toBe(100);
    expect(await attention()).toBe('');
  });

  it('bills nothing, and says so, when ha-bambulab 2.3 clears the plate and never finds the new one', async () => {
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1, clearsPlate: true });
    await bambuPrint(ha, flush, { name: 'part', plate: 69, tray: 2, clearsPlate: true, writesPlate: false });
    expect(spoolman.used(2)).toBe(0);
    expect(await attention()).toContain('never reported this print\'s weight');
  });

  it('bills nothing when the printer powers on, reconnects or Home Assistant restarts while idle (#66)', async () => {
    bambuIdle(ha, { progress: 100, plate: 120, trays: { 'AMS 1 Tray 1': 120 }, name: 'last' });
    ha.tick(1000); await flush();
    for (const status of ['offline', 'unknown', 'init', 'idle']) {
      ha.set(X1.status, status);
      ha.tick(60_000); await flush();
    }
    ha.restart();
    ha.tick(60_000); await tracker.heartbeat();
    expect(spoolman.calls).toEqual([]);
    expect(await sessions()).toEqual([]);
  });

  it('keeps counting through a dropout and bills it all when the print finishes (#75, #78)', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 40 });
    ha.set(X1.status, 'offline');
    ha.set(X1.progress, 'unavailable');
    ha.tick(10 * 60_000); await tracker.heartbeat();
    expect(spoolman.used(1)).toBe(40);
    ha.set(X1.status, 'running');
    for (let pct = 41; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(100);
  });

  it('bills what was printed when the printer loses power mid-print and comes back idle', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 40 });
    ha.set(X1.status, 'offline');
    ha.tick(3 * 60 * 60_000); await tracker.heartbeat();
    ha.set(X1.status, 'idle');
    ha.set(X1.progress, 0);
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(40);
    expect((await sessions())[0].outcome).toBe('ended');
  });

  it('survives Home Assistant restarting mid-print', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 50 });
    // Entities come back unavailable, then re-created before the 3mf is parsed again.
    for (const id of [X1.status, X1.progress, X1.weight]) ha.set(id, 'unavailable', {});
    ha.tick(30_000); await flush();
    ha.restart();
    ha.set(X1.status, 'running');
    ha.set(X1.progress, 50);
    ha.set(X1.weight, 0, {});
    ha.tick(5_000); await flush();
    ha.set(X1.weight, 100, { 'AMS 1 Tray 1': 100 });
    for (let pct = 51; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(100);
  });

  it('charges nothing extra when print_weight reads 0 for a moment mid-print (#83)', async () => {
    // A1: Home Assistant or ha-bambulab reconnected mid-print and print_weight read
    // a real 0 for a few seconds; the old usage meter counted its return as filament.
    let ahead = 0;
    await bambuPrint(ha, flush, {
      name: 'clip', plate: 12.07, tray: 1, during: async pct => {
        if (pct === 14) {
          ha.set(X1.weight, 0, {});
          ha.tick(5_000); await flush();
          ha.set(X1.weight, 12.07, { 'AMS 1 Tray 1': 12.07 });
          ha.tick(5_000); await flush();
        }
        ahead = Math.max(ahead, spoolman.used(1) - 12.07 * pct / 100);
      },
    });
    expect(ahead).toBeLessThan(0.01);
    expect(spoolman.used(1)).toBe(12.07);
    expect(await attention()).toBe('');
  });

  it('settles a print that finishes at 99% without charging the last 1% to the next one (#83)', async () => {
    await bambuPrint(ha, flush, { name: 'clip', plate: 12.07, tray: 1, endAt: 99 });
    ha.set(X1.progress, 100);
    ha.tick(30_000); await flush();
    await bambuPrint(ha, flush, { name: 'next', plate: 20, tray: 2 });
    expect(spoolman.used(1)).toBe(12.07);
    expect(spoolman.used(2)).toBe(20);
  });

  it('picks up where it left off after SpoolmanSync restarts mid-print', async () => {
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => {
        if (pct === 50) tracker.stop();
        return pct === 50;
      },
    });
    await boot();
    for (let pct = 51; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(100);
    expect(await sessions()).toHaveLength(1);
  });

  it('bills a print SpoolmanSync went down for just after it started running, and which ended meanwhile', async () => {
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'quick');
    ha.set(X1.file, 'quick.gcode.3mf');
    ha.attr(X1.tray(1), { active: true });
    ha.tick(31_000); await flush();
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5_000); await flush();
    tracker.stop(); // within the 30s the state is otherwise only saved every
    for (let pct = 1; pct <= 100; pct++) ha.set(X1.progress, pct);
    ha.set(X1.weight, 30, { 'AMS 1 Tray 1': 30 });
    ha.set(X1.status, 'finish');
    ha.tick(60_000);
    await boot();
    await tracker.heartbeat();
    expect(spoolman.used(1)).toBe(30);
  });

  it('keeps one print when Home Assistant restarts before a printer-started print\'s name arrives', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1 });
    ha.set(X1.status, 'prepare'); // names still the last print's
    ha.tick(30_000); await flush();
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.attr(X1.tray(2), { active: true });
    ha.tick(5_000); await flush();
    ha.set(X1.weight, 40, { 'AMS 1 Tray 2': 40 });
    for (let pct = 1; pct <= 30; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    // Home Assistant restarts, and comes back with the print's own name.
    for (const id of [X1.status, X1.progress, X1.weight, X1.name, X1.file]) ha.set(id, 'unavailable', {});
    ha.tick(30_000); await flush();
    ha.restart();
    ha.set(X1.status, 'running');
    ha.set(X1.progress, 30);
    ha.set(X1.name, 'second');
    ha.set(X1.file, 'second.gcode.3mf');
    ha.set(X1.weight, 40, { 'AMS 1 Tray 2': 40 });
    ha.tick(5_000); await flush();
    for (let pct = 31; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(2)).toBe(40);
    expect((await sessions()).map(s => s.outcome)).toEqual(['finished', 'finished']);
  });

  it('closes a reprint it did not see end once the next print of the same job is preparing', async () => {
    await bambuPrint(ha, flush, { name: 'cube', plate: 30, tray: 1 });
    await bambuPrint(ha, flush, {
      name: 'cube', plate: 30, tray: 1, during: pct => {
        if (pct === 50) tracker.stop();
        return pct === 50;
      },
    });
    for (let pct = 51; pct <= 100; pct++) ha.set(X1.progress, pct);
    ha.set(X1.status, 'finish');
    ha.tick(60_000);
    ha.set(X1.status, 'prepare');
    ha.tick(30_000);
    await boot();
    await tracker.heartbeat(); // the first look, as connecting gives
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    for (let pct = 1; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(90);
    expect((await sessions()).map(s => s.outcome)).toEqual(['finished', 'interrupted', 'finished']);
  });

  it('closes a reprint it did not see end when it comes back to the next one already running', async () => {
    await bambuPrint(ha, flush, {
      name: 'cube', plate: 30, tray: 1, during: pct => {
        if (pct === 50) tracker.stop();
        return pct === 50;
      },
    });
    for (let pct = 51; pct <= 100; pct++) ha.set(X1.progress, pct);
    ha.set(X1.status, 'finish');
    ha.tick(60_000);
    ha.set(X1.status, 'prepare');
    ha.tick(4 * 60_000);
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    for (let pct = 1; pct <= 10; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); }
    await boot();
    await tracker.heartbeat();
    for (let pct = 11; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect((await sessions()).map(s => s.outcome)).toEqual(['interrupted', 'finished']);
    // What it missed between 50% and the end of the first is the outage's cost.
    expect(spoolman.used(1)).toBe(15 + 30);
  });

  it('records a print that ran from start to finish while SpoolmanSync was stopped', async () => {
    await bambuPrint(ha, flush, { name: 'seen', plate: 20, tray: 1 });
    tracker.stop();
    await bambuPrint(ha, async () => {}, { name: 'unseen', plate: 30, tray: 2 });
    await boot();
    await tracker.heartbeat();
    expect(spoolman.used(2)).toBe(0);
    const missed = (await sessions()).find(s => s.outcome === 'missed');
    expect(missed).toMatchObject({ name: 'unseen', settled: true });
    expect(missed!.attention).toContain('finished while SpoolmanSync was not following the printer');
    // Checked once per connection: later passes add nothing.
    await tracker.heartbeat();
    expect((await sessions()).filter(s => s.outcome === 'missed')).toHaveLength(1);
  });

  it('records no missed print after a restart that missed nothing, or one cancelled while preparing', async () => {
    await bambuPrint(ha, flush, { name: 'seen', plate: 20, tray: 1 });
    tracker.stop();
    ha.restart();
    await boot();
    await tracker.heartbeat();
    tracker.stop();
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'cancelled');
    ha.set(X1.file, 'cancelled.gcode.3mf');
    ha.tick(60_000);
    ha.set(X1.status, 'failed');
    await boot();
    await tracker.heartbeat();
    expect((await sessions()).map(s => s.outcome)).toEqual(['finished']);
  });

  it('closes a print it did not see end, and bills the one that followed', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 100, tray: 1, during: pct => pct === 50 });
    tracker.stop();
    // While SpoolmanSync is down the print finishes and another starts.
    for (let pct = 51; pct <= 100; pct++) ha.set(X1.progress, pct);
    ha.set(X1.status, 'finish');
    ha.tick(60_000);
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'second');
    ha.set(X1.file, 'second.gcode.3mf');
    ha.tick(30_000);
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5_000);
    ha.set(X1.weight, 20, { 'AMS 1 Tray 2': 20 });
    for (const n of [1, 2]) ha.attr(X1.tray(n), { active: n === 2 });
    await boot();
    for (let pct = 1; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(50);
    expect(spoolman.used(2)).toBe(20);
    expect((await sessions()).map(s => s.outcome)).toEqual(['interrupted', 'finished']);
  });

  it('keeps billing the spool that fed a tray after the AMS switched to a backup spool', async () => {
    await bambuPrint(ha, flush, {
      name: 'long', plate: 100, tray: [[0, 1], [60, 3]], trays: { 'AMS 1 Tray 1': 100 },
    });
    expect(spoolman.used(1)).toBe(60);
    expect(spoolman.used(3)).toBe(40);
  });

  it('charges a spool swapped into the tray mid-print only from the swap on', async () => {
    spoolman.add(5, null);
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => {
        if (pct === 50) { spoolman.assign(1, null); spoolman.assign(5, X1.key(1)); }
      },
    });
    expect(spoolman.used(1) + spoolman.used(5)).toBe(100);
    expect(spoolman.used(1)).toBeGreaterThanOrEqual(49);
    expect(spoolman.used(1)).toBeLessThanOrEqual(51);
  });

  it('reports usage from a tray with no spool assigned instead of losing it silently', async () => {
    spoolman.assign(2, null);
    await bambuPrint(ha, flush, {
      name: 'two-tone', plate: 100, tray: [[0, 1], [60, 2]], trays: { 'AMS 1 Tray 1': 60, 'AMS 1 Tray 2': 40 },
    });
    expect(spoolman.used(1)).toBe(60);
    expect(await attention()).toContain('AMS 1 Tray 2 has no spool assigned');
  });

  it('bills a spool assigned to its tray just before the print ends', async () => {
    spoolman.assign(1, null);
    await bambuPrint(ha, flush, {
      name: 'late-assign', plate: 40, tray: 1, during: pct => { if (pct === 100) spoolman.assign(1, X1.key(1)); },
    });
    expect(spoolman.used(1)).toBe(40);
    expect(await attention()).toBe('');
  });

  it('holds what it owes while Spoolman is down and pays it when it is back', async () => {
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => {
        if (pct === 30) spoolman.failWith = refused();
        if (pct === 70) spoolman.failWith = null;
      },
    });
    expect(spoolman.used(1)).toBe(100);
    expect(await attention()).toBe('');
  });

  it('pays an ended print once Spoolman is back', async () => {
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => { if (pct === 90) spoolman.failWith = refused(); },
    });
    expect((await sessions())[0].settled).toBe(false);
    spoolman.failWith = null;
    ha.tick(60_000);
    await tracker.heartbeat();
    expect(spoolman.used(1)).toBe(100);
    expect((await sessions())[0].settled).toBe(true);
  });

  it('never re-sends a write that may have reached Spoolman, and flags it', async () => {
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => { if (pct === 30) spoolman.failNextWrite = timedOut(); },
    });
    const uncertain = (await prisma.usageDeduction.findMany({ where: { status: 'uncertain' } }));
    expect(uncertain).toHaveLength(1);
    expect(spoolman.used(1)).toBeCloseTo(100 - uncertain[0].grams, 6);
    expect(await attention()).toContain('did not confirm');
  });

  it('treats a write left pending by a crash as uncertain', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 20 });
    const row = await prisma.usageDeduction.findFirstOrThrow();
    await prisma.usageDeduction.update({ where: { id: row.id }, data: { status: 'pending' } });
    tracker.stop();
    await boot();
    expect((await prisma.usageDeduction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('uncertain');
    expect(await attention()).toContain('stopped while writing');
  });

  it('stores the Bambu spool serial on the spool it billed', async () => {
    ha.attr(X1.tray(1), { tray_uuid: 'A1B2C3D4E5F60718' });
    await bambuPrint(ha, flush, { name: 'benchy', plate: 10, tray: 1 });
    expect(spoolman.spools.find(s => s.id === 1)!.extra.tag).toBe(JSON.stringify('A1B2C3D4E5F60718'));
  });

  it('treats a job name that arrives after the status as the same print', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1 });
    // ha-bambulab writes the status before the names, and a printer-started
    // print can reach RUNNING before reporting its name at all.
    ha.set(X1.status, 'prepare');
    ha.tick(5_000); await flush();
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.attr(X1.tray(2), { active: true });
    ha.tick(5_000); await flush();
    ha.set(X1.weight, 20, { 'AMS 1 Tray 2': 20 });
    ha.tick(5_000); await flush();
    ha.set(X1.name, 'second');
    ha.set(X1.file, 'second.gcode.3mf');
    for (let pct = 1; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(50);
    expect(spoolman.used(2)).toBe(20);
    expect((await sessions()).map(s => s.outcome)).toEqual(['finished', 'finished']);
  });

  it('does not take the previous plate when only the external spool\'s flag rewrote it', async () => {
    await bambuPrint(ha, flush, { name: 'ams-print', plate: 100, tray: 1 });
    // An external-spool print whose 3mf is never parsed: ha-bambulab rewrites
    // print_weight's attributes, value unchanged, when the external spool goes active.
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'ext-print');
    ha.set(X1.file, 'ext-print.gcode.3mf');
    ha.tick(5_000); await flush();
    ha.attr(X1.ext, { active: true });
    ha.set(X1.weight, 100, { 'External Spool': 100 });
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5_000); await flush();
    for (let pct = 1; pct <= 50; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    expect(spoolman.used(9)).toBe(0);
    expect(await attention()).toContain('never reported this print\'s weight');
  });

  it('does not take the previous plate re-rendered when the external spool hands over to the AMS', async () => {
    await bambuPrint(ha, flush, { name: 'ams-print', plate: 100, tray: 1 });
    // Starts on the external spool and moves to an AMS tray before (and without)
    // its own 3mf being parsed: ha-bambulab re-renders the last plate both times.
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'mixed');
    ha.set(X1.file, 'mixed.gcode.3mf');
    ha.tick(5_000); await flush();
    ha.attr(X1.ext, { active: true });
    ha.set(X1.weight, 100, { 'External Spool': 100 });
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5_000); await flush();
    for (let pct = 1; pct <= 60; pct++) {
      if (pct === 20) {
        ha.attr(X1.ext, { active: false });
        ha.attr(X1.tray(2), { active: true });
        ha.set(X1.weight, 100, { 'AMS 1 Tray 1': 100 });
      }
      ha.set(X1.progress, pct); ha.tick(30_000); await flush();
    }
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    expect(spoolman.used(2)).toBe(0);
    expect(spoolman.used(9)).toBe(0);
    expect(await attention()).toContain('never reported this print\'s weight');
  });

  it('bills a failed print by its own progress when the last one\'s is still showing', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1, endAt: 79, outcome: 'failed' });
    await bambuPrint(ha, flush, { name: 'second', plate: 100, tray: 2, runningBeforeReset: true, endAt: 30, outcome: 'failed' });
    expect(spoolman.used(2)).toBe(30);
  });

  it('keeps a cloud print\'s plate when its name only arrives with RUNNING', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1 });
    await bambuPrint(ha, flush, { name: 'second', plate: 30, tray: 2, cloud: true, namesAt: 'running' });
    expect(spoolman.used(2)).toBe(30);
    expect(await attention()).toBe('');
  });

  it('bills once when a print\'s name arrives part way through it', async () => {
    await bambuPrint(ha, flush, { name: 'first', plate: 50, tray: 1 });
    await bambuPrint(ha, flush, { name: 'second', plate: 40, tray: 2, namesAt: 30 });
    expect(spoolman.used(2)).toBe(40);
  });

  it('drops a plate borrowed from the last job once this print\'s own name arrives', async () => {
    await bambuPrint(ha, flush, { name: 'big', plate: 100, tray: 1 });
    // The names still say "big" until 20%, and this print's 3mf is never parsed.
    await bambuPrint(ha, flush, { name: 'small', plate: 100, tray: 1, writesPlate: false, namesAt: 20, endAt: 50, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(100);
    expect(await attention()).toContain('never reported this print\'s weight');
  });

  it('retries a write Spoolman refused outright', async () => {
    await bambuPrint(ha, flush, {
      name: 'benchy', plate: 100, tray: 1, during: pct => { if (pct === 30) spoolman.failNextWrite = refused(); },
    });
    expect(spoolman.used(1)).toBe(100);
    expect(await prisma.usageDeduction.count({ where: { status: 'uncertain' } })).toBe(0);
    expect(await attention()).toBe('');
  });

  it('closes a print whose printer was removed from SpoolmanSync, after a day', async () => {
    await bambuPrint(ha, flush, { name: 'benchy', plate: 100, tray: 1, during: pct => pct === 30 });
    printers = [];
    await tracker.rediscover();
    ha.tick(25 * 60 * 60_000);
    await tracker.heartbeat();
    expect((await sessions())[0]).toMatchObject({ outcome: 'abandoned', settled: true });
    expect(spoolman.used(1)).toBe(30);
  });

  it('keeps no record of a print cancelled before it ran, but logs that it used nothing', async () => {
    ha.set(X1.status, 'prepare');
    ha.tick(10_000); await flush();
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    expect(await sessions()).toEqual([]);
    expect(await printLogs()).toEqual([
      'Nothing deducted for a print on X1C: it ended without using any filament.',
      'Print started on X1C',
    ]);
  });
});

describe('Bambu edge cases', () => {
  beforeEach(async () => {
    bambuIdle(ha);
    await boot();
  });

  /** The printer drops off and boots again, still showing the job it stopped. */
  async function powerCycle(progress: number) {
    ha.set(X1.status, 'offline');
    ha.set(X1.progress, 'unavailable');
    ha.tick(10 * 60_000); await flush();
    ha.set(X1.status, 'idle');
    ha.set(X1.progress, progress);
    ha.tick(60_000); await flush();
  }

  it('bills a job resumed after power loss only from where it picked up', async () => {
    await bambuPrint(ha, flush, { name: 'tall', plate: 100, tray: 1, endAt: 60, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(60);
    await powerCycle(60);
    ha.set(X1.status, 'prepare');
    ha.tick(30_000); await flush();
    ha.set(X1.status, 'running');
    ha.attr(X1.tray(1), { active: true });
    for (let pct = 61; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(100);
    expect(await attention()).toContain('resumed the job from 60%');
  });

  it('bills a resumed job that fails again straight away for what it added', async () => {
    await bambuPrint(ha, flush, { name: 'tall', plate: 100, tray: 1, endAt: 60, outcome: 'failed' });
    await powerCycle(59);
    ha.set(X1.status, 'running');
    ha.attr(X1.tray(1), { active: true });
    ha.tick(5_000); await flush();
    ha.set(X1.progress, 61);
    ha.tick(30_000); await flush();
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    // Picks up where the last print stopped: the 59% shown while idle is not this print's reading.
    expect(spoolman.used(1)).toBe(61);
  });

  it('bills nothing more for a resumed job that had nothing left to print', async () => {
    await bambuPrint(ha, flush, { name: 'tall', plate: 100, tray: 1, endAt: 100, outcome: 'failed' });
    await powerCycle(100);
    ha.set(X1.status, 'running');
    ha.tick(5_000); await flush();
    ha.set(X1.status, 'finish');
    ha.tick(1_000); await flush();
    expect(spoolman.used(1)).toBe(100);
  });

  it('bills nothing more when the printer fails to resume a failed job after a power cycle (#83)', async () => {
    // X2D: failed at 79%, power-cycled half an hour later. Booting, it tried to
    // resume and for 12s reported current_stage printing and progress 78 while idle.
    await bambuPrint(ha, flush, { name: 'part', plate: 18.58, tray: 1, endAt: 79, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(14.678);
    ha.tick(30 * 60_000);
    ha.set(X1.status, 'offline');
    ha.set(X1.progress, 'unavailable');
    ha.tick(60_000); await flush();
    ha.set(X1.status, 'failed');
    ha.set(X1.stage, 'printing');
    ha.set(X1.progress, 78);
    ha.set(X1.status, 'idle');
    ha.tick(12_000); await flush();
    ha.set(X1.stage, 'idle');
    ha.tick(60_000); await flush();
    expect(spoolman.used(1)).toBe(14.678);
    expect(await sessions()).toHaveLength(1);
  });

  it('bills the whole plate when a failed job is started again from scratch', async () => {
    await bambuPrint(ha, flush, { name: 'tall', plate: 100, tray: 1, endAt: 60, outcome: 'failed' });
    await bambuPrint(ha, flush, { name: 'tall', plate: 100, tray: 1 });
    expect(spoolman.used(1)).toBe(160);
    expect(await attention()).toBe('');
  });

  it('does not take a finished job printed again for a resume', async () => {
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1 });
    await bambuPrint(ha, flush, { name: 'cube', plate: 50, tray: 1 });
    expect(spoolman.used(1)).toBe(100);
  });

  it('says so when objects were skipped, since the plate weight still includes them', async () => {
    await bambuPrint(ha, flush, {
      name: 'four-up', plate: 80, tray: 1, during: pct => { if (pct === 40) ha.set(X1.skipped, 1, { objects: [{ id: 3 }] }); },
    });
    expect(spoolman.used(1)).toBe(80);
    expect(await attention()).toContain('1 skipped object is still in the deducted weight');
  });

  it('ignores the last print\'s skipped objects', async () => {
    ha.set(X1.skipped, 2, { objects: [{ id: 1 }, { id: 2 }] });
    ha.tick(60_000); await flush();
    await bambuPrint(ha, flush, { name: 'clean', plate: 30, tray: 1 });
    expect(await attention()).toBe('');
  });

  it('does not trust the slicer\'s split when a duplicate AMS device claims the same tray names', async () => {
    const ghost = { ...bambuPrinter().ams_units[0], entity_id: 'sensor.x1c_ams_1_humidity_2' };
    ghost.trays = ghost.trays.map(t => ({ ...t, entity_id: `${t.entity_id}_2`, unique_id: `GHOST_${t.unique_id}` }));
    printers = [{ ...bambuPrinter(), ams_units: [...bambuPrinter().ams_units, ghost] }];
    await tracker.rediscover();
    // Tray 2 feeds for the last 1%, under the 1g that marks a tray as having fed.
    await bambuPrint(ha, flush, {
      name: 'accent', plate: 50, tray: [[0, 1], [99, 2]], trays: { 'AMS 1 Tray 1': 49.5, 'AMS 1 Tray 2': 0.5 },
    });
    expect(spoolman.used(1)).toBe(49.5);
    expect(spoolman.used(2)).toBe(0.5);
  });

  it('bills a printer without an AMS whose external spool never reports active', async () => {
    printers = [{ ...bambuPrinter(), ams_units: [] }];
    await tracker.rediscover();
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'p1s');
    ha.set(X1.file, 'p1s.gcode.3mf');
    ha.tick(5_000); await flush();
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.tick(5_000); await flush();
    ha.set(X1.weight, 25, {});
    for (let pct = 1; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(9)).toBe(25);
  });

  it('bills two printers printing at the same time separately', async () => {
    const second = {
      ...bambuPrinter(), entity_id: 'sensor.p1s_print_status', name: 'P1S', prefix: 'p1s_serial', ams_units: [],
      external_spools: [{ entity_id: 'sensor.p1s_external_spool', unique_id: 'P1S_ExternalSpool_external_spool', tray_number: 0, is_external: true }],
      print_weight_entity: 'sensor.p1s_print_weight', print_progress_entity: 'sensor.p1s_print_progress',
      job_name_entity: 'sensor.p1s_subtask_name', gcode_file_entity: 'sensor.p1s_gcode_file', skipped_objects_entity: undefined,
    };
    printers = [bambuPrinter(), second];
    spoolman.add(30, 'P1S_ExternalSpool_external_spool');
    await tracker.rediscover();
    ha.set('sensor.p1s_print_status', 'idle');
    ha.set('sensor.p1s_external_spool', 'PLA', { active: true });
    await bambuPrint(ha, flush, {
      name: 'x1-job', plate: 100, tray: 1, during: pct => {
        if (pct === 10) {
          ha.set('sensor.p1s_print_status', 'prepare');
          ha.set('sensor.p1s_subtask_name', 'p1-job');
          ha.set('sensor.p1s_gcode_file', 'p1-job.gcode.3mf');
          ha.set('sensor.p1s_print_weight', 40, { 'External Spool': 40 });
        }
        if (pct === 11) { ha.set('sensor.p1s_print_progress', 0); ha.set('sensor.p1s_print_status', 'running'); }
        if (pct > 11 && pct <= 61) ha.set('sensor.p1s_print_progress', (pct - 11) * 2);
        if (pct === 62) ha.set('sensor.p1s_print_status', 'finish');
      },
    });
    expect(spoolman.used(1)).toBe(100);
    expect(spoolman.used(30)).toBe(40);
    expect((await sessions()).map(s => [s.name, s.outcome])).toEqual([['x1-job', 'finished'], ['p1-job', 'finished']]);
  });

  it('never charges an archived spool, and says the tray had none', async () => {
    spoolman.spools.find(s => s.id === 1)!.archived = true;
    await bambuPrint(ha, flush, { name: 'benchy', plate: 20, tray: 1 });
    expect(spoolman.used(1)).toBe(0);
    expect(await attention()).toContain('AMS 1 Tray 1 has no spool assigned');
  });

  it('charges one spool and says so when a tray has two assigned', async () => {
    spoolman.add(6, X1.key(1));
    await bambuPrint(ha, flush, { name: 'benchy', plate: 20, tray: 1 });
    expect(spoolman.used(1) + spoolman.used(6)).toBe(20);
    expect(await attention()).toContain('AMS 1 Tray 1 has several spools assigned (#1, #6)');
  });
});

describe('Bambu warming up', () => {
  // Heating, levelling and calibrating move the progress -- a small print's
  // routine took 40% of it on an X1C -- but use next to no filament.
  beforeEach(async () => {
    bambuIdle(ha);
    await boot();
  });

  it('bills nothing while the printer prepares, and the plate over the printing after', async () => {
    const billed: Record<number, number> = {};
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, during: pct => { billed[pct] = spoolman.used(1); } });
    expect(billed[40]).toBe(0);
    expect(billed[70]).toBe(30);
    expect(spoolman.used(1)).toBe(60);
    expect((await sessions())[0]).toMatchObject({ outcome: 'finished', attention: null });
  });

  it('bills nothing for a print cancelled while the printer prepares, and records it', async () => {
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, endAt: 30, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(0);
    expect(await sessions()).toMatchObject([{ outcome: 'failed', settled: true, attention: null, deductions: [] }]);
    expect(await printLogs()).toEqual([
      'Nothing deducted for "swatch" on X1C: it stopped before the printer began printing.',
      'Print started: "swatch" on X1C',
    ]);
  });

  it('keeps the plate of a job cancelled while preparing for a reprint that writes none, across a restart', async () => {
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, endAt: 30, outcome: 'failed' });
    await bambuPrint(ha, flush, {
      name: 'swatch', plate: 60, tray: 1, warmup: 40, writesPlate: false, during: pct => {
        if (pct === 50) tracker.stop();
        return pct === 50;
      },
    });
    await boot();
    for (let pct = 51; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(60);
    expect(await attention()).toBe('');
  });

  it('bills a print cancelled while printing for its share of the printing', async () => {
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, endAt: 70, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(30);
  });

  it('counts from where it last saw the printer preparing when it was away as printing began', async () => {
    await bambuPrint(ha, flush, {
      name: 'swatch', plate: 60, tray: 1, warmup: 40, during: pct => {
        if (pct === 20) tracker.stop();
        return pct === 20;
      },
    });
    for (let pct = 21; pct <= 60; pct++) {
      ha.set(X1.stage, pct <= 40 ? 'auto_bed_leveling' : 'printing');
      ha.set(X1.progress, pct);
      ha.tick(30_000);
    }
    ha.set(X1.stage, 'changing_filament');
    await boot();
    await flush();
    ha.set(X1.stage, 'printing');
    for (let pct = 61; pct <= 70; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    // Printing began at 40%, unseen: counted from 20%, never less than was printed.
    expect(spoolman.used(1)).toBe(37.5);
  });

  it('remembers where printing began when SpoolmanSync restarts seconds later', async () => {
    ha.set(X1.status, 'prepare');
    ha.set(X1.name, 'swatch');
    ha.set(X1.file, 'swatch.gcode.3mf');
    ha.tick(1000); await flush();
    ha.attr(X1.tray(1), { active: true });
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.set(X1.stage, 'heatbed_preheating');
    ha.tick(5000); await flush();
    ha.set(X1.weight, 60, { 'AMS 1 Tray 1': 60 });
    ha.tick(5000); await flush();
    ha.set(X1.progress, 40);
    ha.tick(5000); await flush();
    ha.set(X1.progress, 45);
    ha.tick(5000); await flush();
    ha.set(X1.stage, 'printing');
    ha.tick(5000); await flush();
    tracker.stop();
    ha.set(X1.progress, 70);
    ha.tick(60_000);
    await boot();
    await flush();
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    // Printing began at 45%, not the 40% saved a few seconds before.
    expect(spoolman.used(1)).toBeCloseTo(60 * 25 / 55, 2);
  });

  it('does not hold a print it found already under way', async () => {
    tracker.stop();
    await bambuPrint(ha, async () => {}, { name: 'swatch', plate: 60, tray: 1, warmup: 40, during: pct => pct === 60 });
    ha.set(X1.stage, 'changing_filament');
    await boot();
    await flush();
    ha.set(X1.progress, 70);
    ha.tick(30_000); await flush();
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    // When it began printing is not known, so the progress counts from 0 as it always has.
    expect(spoolman.used(1)).toBe(42);
    expect(await printLogs()).toEqual(['Print found already under way: "swatch" on X1C']);
  });

  it('bills a job resumed after power loss for the rest of its printing', async () => {
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, endAt: 70, outcome: 'failed' });
    expect(spoolman.used(1)).toBe(30);
    ha.set(X1.status, 'offline');
    ha.set(X1.progress, 'unavailable');
    ha.tick(10 * 60_000); await flush();
    ha.set(X1.status, 'idle');
    ha.set(X1.progress, 70);
    ha.tick(60_000); await flush();
    ha.set(X1.status, 'running');
    ha.set(X1.stage, 'heatbed_preheating');
    ha.attr(X1.tray(1), { active: true });
    ha.tick(60_000); await flush();
    ha.set(X1.stage, 'printing');
    for (let pct = 71; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    // 30g for 40-70%, the rest of the plate for 70-100%.
    expect(spoolman.used(1)).toBe(60);
    expect(await attention()).toContain('resumed the job from 70%');
  });

  it('does not take the next print of a job cancelled while preparing for a resume of it', async () => {
    await bambuPrint(ha, flush, { name: 'swatch', plate: 60, tray: 1, warmup: 40, endAt: 30, outcome: 'failed' });
    ha.set(X1.status, 'prepare');
    ha.tick(30_000); await flush();
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
    ha.set(X1.stage, 'heatbed_preheating');
    ha.attr(X1.tray(1), { active: true });
    ha.tick(60_000); await flush();
    // Its first reading past the start lands where the cancelled one stopped.
    ha.set(X1.progress, 30);
    ha.tick(60_000); await flush();
    ha.set(X1.stage, 'printing');
    for (let pct = 41; pct <= 100; pct++) { ha.set(X1.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(X1.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(1)).toBe(60);
    expect(await attention()).toBe('');
  });
});

describe('Dual-nozzle H2D', () => {
  beforeEach(async () => {
    printers = [h2dPrinter()];
    spoolman.add(41, H2D.key(1, 1));
    spoolman.add(42, H2D.key(1, 2));
    spoolman.add(43, H2D.key(2, 1));
    spoolman.add(44, H2D.key(2, 2));
    spoolman.add(45, H2D.htKey);
    spoolman.add(46, H2D.extKey(1));
    spoolman.add(47, H2D.extKey(2));
    h2dIdle(ha);
    await boot();
  });

  it('settles a print alternating between the two nozzles\' AMS units to the slicer\'s split', async () => {
    const feed: Array<[number, string]> = [];
    for (let at = 0; at < 100; at += 10) feed.push([at, at % 20 === 0 ? H2D.tray(1, 1) : H2D.tray(2, 1)]);
    await h2dPrint(ha, flush, { name: 'two-nozzle', plate: 120, feed, split: { 'AMS 1 Tray 1': 84, 'AMS 2 Tray 1': 36 } });
    expect(spoolman.used(41)).toBe(84);
    expect(spoolman.used(43)).toBe(36);
  });

  it('bills a failed two-nozzle print by which nozzle\'s tray fed when', async () => {
    await h2dPrint(ha, flush, {
      name: 'two-nozzle', plate: 100, feed: [[0, H2D.tray(1, 2)], [30, H2D.tray(2, 2)]],
      split: { 'AMS 1 Tray 2': 30, 'AMS 2 Tray 2': 70 }, endAt: 50, outcome: 'failed',
    });
    expect(spoolman.used(42)).toBe(30);
    expect(spoolman.used(44)).toBe(20);
  });

  it('bills a print from both external spools by which one fed when', async () => {
    await h2dPrint(ha, flush, { name: 'externals', plate: 60, feed: [[0, H2D.ext(1)], [50, H2D.ext(2)]], split: {} });
    expect(spoolman.used(46)).toBe(30);
    expect(spoolman.used(47)).toBe(30);
  });

  it('settles a print from one external spool by the slicer\'s name for it when no active flag shows', async () => {
    // An older ha-bambulab: the external spools carry no active flag, so only
    // print_weight's name for the spool says which fed -- by index, which on a
    // dual-nozzle printer is the other way round from the entities.
    for (const id of [H2D.ext(1), H2D.ext(2)]) ha.set(id, 'PLA', { name: 'PLA' });
    ha.set(H2D.status, 'prepare');
    ha.set(H2D.name, 'left-ext');
    ha.set(H2D.file, 'left-ext.gcode.3mf');
    ha.set(H2D.weight, 25, { 'External Spool 2': 25 });
    ha.tick(1000); await flush();
    ha.set(H2D.progress, 0);
    ha.set(H2D.status, 'running');
    ha.tick(5000); await flush();
    for (let pct = 1; pct <= 100; pct++) { ha.set(H2D.progress, pct); ha.tick(30_000); await flush(); }
    ha.set(H2D.status, 'finish');
    ha.tick(1000); await flush();
    expect(spoolman.used(46)).toBe(25);
    expect(spoolman.used(47)).toBe(0);
  });

  it('bills the AMS HT by its slicer name', async () => {
    await h2dPrint(ha, flush, {
      name: 'ht', plate: 40, feed: [[0, H2D.ht], [75, H2D.tray(1, 1)]], split: { 'AMS HT 1': 30, 'AMS 1 Tray 1': 10 },
    });
    expect(spoolman.used(45)).toBe(30);
    expect(spoolman.used(41)).toBe(10);
  });

  it('bills a print mixing an AMS tray and an external spool by what each fed', async () => {
    await h2dPrint(ha, flush, {
      name: 'mixed', plate: 50, feed: [[0, H2D.tray(1, 1)], [80, H2D.ext(2)]], split: { 'AMS 1 Tray 1': 40 },
    });
    expect(spoolman.used(41)).toBe(40);
    expect(spoolman.used(47)).toBe(10);
  });
});

describe('Creality', () => {
  const grams = (mmTotal: number) => filamentWeight(cm(mmTotal), { density: 1.24, diameter: 1.75 });

  beforeEach(async () => {
    printers = [crealityPrinter()];
    for (const n of [1, 2, 3, 4]) spoolman.add(20 + n, K2.key(n));
    crealityIdle(ha, 20_000, 'old.gcode');
    await boot();
  });

  it('bills the extruded length at the spool\'s density, ignoring the previous job\'s counter', async () => {
    await crealityPrint(ha, flush, { file: 'new.gcode', slot: 2, steps: 20, cmPerStep: 50, startMm: 20_000 });
    expect(spoolman.used(22)).toBeCloseTo(grams(20 * 500), 3);
    expect(spoolman.used(21)).toBe(0);
  });

  it('bills an identical reprint of the same file', async () => {
    await crealityPrint(ha, flush, { file: 'cube.gcode', slot: 1, steps: 10, cmPerStep: 50, startMm: 20_000 });
    await crealityPrint(ha, flush, { file: 'cube.gcode', slot: 1, steps: 10, cmPerStep: 50, startMm: 5_000 });
    expect(spoolman.used(21)).toBeCloseTo(grams(2 * 10 * 500), 3);
  });

  it('does not end a print on a lone idle frame', async () => {
    await crealityPrint(ha, flush, {
      file: 'a.gcode', slot: 1, steps: 10, cmPerStep: 50,
      during: async i => {
        if (i !== 5) return;
        crealityFrame(ha, 'idle', 5 * 500, 'a.gcode');
        ha.tick(2_000); await flush();
      },
    });
    expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
    expect(await sessions()).toHaveLength(1);
  });

  it('does not bill the job twice when the counter drops out mid-print', async () => {
    await crealityPrint(ha, flush, {
      file: 'a.gcode', slot: 1, steps: 10, cmPerStep: 50,
      during: async i => {
        if (i === 3) crealityFrame(ha, 'unknown', 0, 'a.gcode'); // connection lost
        if (i === 6) crealityFrame(ha, 'printing', 0, 'a.gcode'); // a glitched frame
        ha.tick(2_000); await flush();
      },
    });
    expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
  });

  it('ends a print that goes idle and stays idle', async () => {
    await crealityPrint(ha, flush, { file: 'a.gcode', slot: 1, steps: 4, cmPerStep: 50, end: 'idle' });
    ha.tick(120_000);
    await tracker.heartbeat();
    expect((await sessions())[0]).toMatchObject({ outcome: 'ended', settled: true });
    expect(spoolman.used(21)).toBeCloseTo(grams(4 * 500), 3);
  });

  it('ignores a stray frame repeating the previous job\'s counter', async () => {
    await crealityPrint(ha, flush, {
      file: 'b.gcode', slot: 1, steps: 10, cmPerStep: 50, startMm: 20_000,
      during: async i => {
        if (i !== 5) return;
        crealityFrame(ha, 'printing', 20_000, 'b.gcode');
        ha.tick(2_000); await flush();
      },
    });
    expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
  });

  it('asks this printer to re-read its feeding slot as a print starts and while it runs', async () => {
    cfsRequests = [];
    await crealityPrint(ha, flush, {
      file: 'c.gcode', slot: 1, steps: 4, cmPerStep: 50,
      during: i => { if (i === 2) tracker.pollCfs(); },
    });
    expect(cfsRequests).toEqual([['k2-device'], ['k2-device']]);
    tracker.pollCfs(); // nothing printing
    expect(cfsRequests).toHaveLength(2);
  });

  it('bills a printer whose status is stuck on error', async () => {
    crealityFrame(ha, 'error', 0, '');
    ha.tick(1000); await flush();
    for (let i = 1; i <= 10; i++) {
      crealityFrame(ha, 'error', i * 500, 'stuck.gcode');
      ha.tick(30_000); await flush();
    }
    crealityFrame(ha, 'completed', 10 * 500, 'stuck.gcode');
    ha.tick(1000); await flush();
    expect(spoolman.used(21)).toBeCloseTo(grams(9 * 500), 3);
  });
});

describe('Creality edge cases', () => {
  const grams = (mmTotal: number) => filamentWeight(cm(mmTotal), { density: 1.24, diameter: 1.75 });

  beforeEach(async () => {
    printers = [crealityPrinter()];
    for (const n of [1, 2, 3, 4]) spoolman.add(20 + n, K2.key(n));
    crealityIdle(ha, 20_000, 'old.gcode');
    await boot();
  });

  it('keeps one record when the printer reads completed a second early and printing at 99% again', async () => {
    await crealityPrint(ha, flush, {
      file: 'echo.gcode', slot: 1, steps: 10, cmPerStep: 50, startMm: 20_000, end: 'completed',
    });
    crealityFrame(ha, 'printing', 10 * 500 + 3, 'echo.gcode', { progress: 99 });
    ha.tick(1_000); await flush();
    crealityFrame(ha, 'completed', 10 * 500 + 5, 'echo.gcode', { progress: 100 });
    ha.tick(1_000); await flush();
    expect(await sessions()).toHaveLength(1);
    expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
  });

  it('starts a new record for the same file printed again soon after', async () => {
    await crealityPrint(ha, flush, { file: 'cube.gcode', slot: 1, steps: 4, cmPerStep: 50, startMm: 20_000 });
    ha.tick(30_000);
    await crealityPrint(ha, flush, { file: 'cube.gcode', slot: 2, steps: 4, cmPerStep: 50, startMm: 4 * 500 });
    expect(await sessions()).toHaveLength(2);
    expect(spoolman.used(22)).toBeCloseTo(grams(4 * 500), 3);
  });

  for (const idle of [true, false]) {
    for (const counter of ['continues', 'restarts'] as const) {
      it(`bills a print resumed after power loss once (${idle ? 'went idle first' : 'straight back to printing'}, counter ${counter})`, async () => {
        const frame = async (status: string, mm: number, file: string, progress: number, ms = 30_000) => {
          crealityFrame(ha, status, mm, file, { progress });
          ha.tick(ms); await flush();
        };
        await frame('printing', 20_000, 'tall.gcode', 0, 1_000);
        for (let i = 0; i <= 5; i++) await frame('printing', i * 500, 'tall.gcode', i * 10);
        await frame('off', 5 * 500, 'tall.gcode', 50, 10 * 60_000);
        const base = counter === 'continues' ? 5 * 500 : 0;
        if (idle) {
          await frame('idle', base, '', 0, 1_000);
          for (let m = 0; m < 3; m++) { ha.tick(60_000); await tracker.heartbeat(); }
        }
        // Resumed: the rest of the job, its counter carried on or started over.
        for (let j = 1; j <= 5; j++) await frame('printing', base + j * 500, 'tall.gcode', 50 + j * 10);
        await frame('completed', base + 5 * 500, 'tall.gcode', 100, 1_000);
        expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
        expect((await sessions()).map(s => s.outcome)).toEqual(idle ? ['ended', 'finished'] : ['finished']);
      });
    }
  }

  it('does not keep a stray frame repeating the last job\'s figure when the job ends below it', async () => {
    const frame = async (mm: number, status = 'printing', progress = 50) => {
      crealityFrame(ha, status, mm, 'next.gcode', { progress });
      ha.tick(30_000); await flush();
    };
    await frame(20_000, 'printing', 0);
    for (let mm = 0; mm <= 19_500; mm += 750) await frame(mm);
    crealityFrame(ha, 'printing', 20_000, 'next.gcode', { progress: 99 }); // the last job's figure
    ha.tick(2_000); await flush();
    await frame(19_800, 'printing', 99);
    await frame(19_800, 'completed', 100);
    expect(spoolman.used(21)).toBeCloseTo(grams(19_800), 3);
  });

  it('bills a reprint that ends at exactly the last job\'s length', async () => {
    await crealityPrint(ha, flush, { file: 'same.gcode', slot: 1, steps: 8, cmPerStep: 50, startMm: 20_000 });
    crealityFrame(ha, 'printing', 4_000, 'same.gcode', { progress: 0 });
    ha.tick(1_000); await flush();
    crealityFrame(ha, 'printing', 0, 'same.gcode', { progress: 0 });
    ha.tick(30_000); await flush();
    for (let i = 1; i <= 8; i++) {
      crealityFrame(ha, i === 8 ? 'completed' : 'printing', i * 500, 'same.gcode', { progress: i * 12.5 });
      ha.tick(30_000); await flush();
    }
    expect(spoolman.used(21)).toBeCloseTo(grams(2 * 4_000), 3);
  });

  it('recovers when glitched frames leave the counter below where the job is', async () => {
    await crealityPrint(ha, flush, {
      file: 'g.gcode', slot: 1, steps: 10, cmPerStep: 50,
      during: async i => {
        if (i !== 5) return;
        for (const mm of [0, 150]) { crealityFrame(ha, 'printing', mm, 'g.gcode'); ha.tick(2_000); await flush(); }
      },
    });
    // The 15cm the glitch read as a restart is the most it can cost.
    expect(spoolman.used(21)).toBeGreaterThanOrEqual(grams(10 * 500) - 1e-6);
    expect(spoolman.used(21)).toBeLessThanOrEqual(grams(10 * 500 + 150) + 1e-6);
  });

  it('counts a job in full when its first frame shows the last job\'s figure lower than recorded', async () => {
    await crealityPrint(ha, flush, { file: 'a.gcode', slot: 1, steps: 4, cmPerStep: 50, startMm: 20_000 });
    // The last job really ended at 1950mm, not the 2000mm on record.
    await crealityPrint(ha, flush, { file: 'b.gcode', slot: 2, steps: 6, cmPerStep: 50, startMm: 1_950 });
    expect(spoolman.used(22)).toBeCloseTo(grams(6 * 500), 3);
  });

  it('bills a resume whose restarted count starts above half of where it stopped', async () => {
    const frame = async (status: string, mm: number, progress: number, ms = 30_000) => {
      crealityFrame(ha, status, mm, 'r.gcode', { progress });
      ha.tick(ms); await flush();
    };
    await frame('printing', 20_000, 0, 1_000);
    for (const mm of [0, 600, 1_200, 1_500]) await frame('printing', mm, 20);
    await frame('off', 1_500, 20, 10 * 60_000);
    for (const mm of [1_000, 1_400, 1_800, 2_200]) await frame('printing', mm, 60);
    await frame('completed', 2_200, 100, 1_000);
    expect(spoolman.used(21)).toBeCloseTo(grams(1_500 + 2_200), 3);
  });

  it('records a job that completed while SpoolmanSync was stopped', async () => {
    await crealityPrint(ha, flush, { file: 'seen.gcode', slot: 1, steps: 4, cmPerStep: 50, startMm: 20_000 });
    tracker.stop();
    await crealityPrint(ha, async () => {}, { file: 'unseen.gcode', slot: 2, steps: 4, cmPerStep: 50, startMm: 2_000 });
    await boot();
    await tracker.heartbeat();
    expect((await sessions()).map(s => [s.name, s.outcome])).toEqual([['seen.gcode', 'finished'], ['unseen.gcode', 'missed']]);
    // The next job still counts from the right place.
    await crealityPrint(ha, flush, { file: 'next.gcode', slot: 3, steps: 4, cmPerStep: 50, startMm: 2_000 });
    expect(spoolman.used(23)).toBeCloseTo(grams(4 * 500), 3);
  });

  it('keeps counting through paused, processing and powered-off frames', async () => {
    await crealityPrint(ha, flush, {
      file: 'a.gcode', slot: 1, steps: 10, cmPerStep: 50,
      during: async i => {
        const status = { 3: 'paused', 5: 'processing', 7: 'off' }[i];
        if (!status) return;
        crealityFrame(ha, status, i * 500, 'a.gcode');
        ha.tick(5 * 60_000); await flush();
      },
    });
    expect(spoolman.used(21)).toBeCloseTo(grams(10 * 500), 3);
    expect(await sessions()).toHaveLength(1);
  });

  it('bills a printer with no CFS through the slot SpoolmanSync gives it', async () => {
    printers = [{ ...crealityPrinter(), ams_units: [], external_spools: [{ entity_id: 'k2_virtual_external_spool', unique_id: 'k2_virtual_external_spool', tray_number: 0, is_external: true }] }];
    spoolman.add(29, 'k2_virtual_external_spool');
    await tracker.rediscover();
    await crealityPrint(ha, flush, { file: 'k1c.gcode', slot: 0, steps: 6, cmPerStep: 50, startMm: 20_000 });
    expect(spoolman.used(29)).toBeCloseTo(grams(6 * 500), 3);
  });
});
