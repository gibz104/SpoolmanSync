import {
  FakeHA, FakeSpoolman, X1, K2, bambuPrinter, bambuIdle, bambuPrint, crealityPrinter, crealityIdle,
  crealityPrint, crealityFrame, refused, timedOut,
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
let cfsRefreshes = 0;

async function boot(): Promise<UsageTracker> {
  tracker?.stop();
  tracker = new UsageTracker({
    discover: async () => printers,
    spoolman: async () => spoolman as unknown as SpoolmanClient,
    refreshCfs: async () => { cfsRefreshes++; },
    source: onChange => ha.source(onChange),
    now: () => ha.now,
  });
  await tracker.start();
  return tracker;
}

const flush = () => tracker.flush();
const sessions = () => prisma.printSession.findMany({ orderBy: { createdAt: 'asc' }, include: { deductions: true } });
const usageLogs = async () => (await prisma.activityLog.findMany({ where: { type: 'spool_usage' } })).map(l => JSON.parse(l.details!));
const attention = async () => (await sessions()).map(s => s.attention).filter(Boolean).join(' ');
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

  it('keeps no record of a print cancelled before it ran', async () => {
    ha.set(X1.status, 'prepare');
    ha.tick(10_000); await flush();
    ha.set(X1.status, 'failed');
    ha.tick(1000); await flush();
    expect(await sessions()).toEqual([]);
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

  it('asks for the feeding slot to be re-read as a print starts and while it runs', async () => {
    cfsRefreshes = 0;
    await crealityPrint(ha, flush, {
      file: 'c.gcode', slot: 1, steps: 4, cmPerStep: 50,
      during: async i => { if (i === 2) await tracker.heartbeat(); },
    });
    expect(cfsRefreshes).toBe(2);
    await tracker.heartbeat(); // nothing printing
    expect(cfsRefreshes).toBe(2);
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
