/**
 * Test doubles for the usage tracker: a migrated SQLite database, a Home
 * Assistant whose timestamps follow HA core, and a Spoolman.
 *
 * Import this before anything that loads '@/lib/db'.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { HAPrinter } from '@/lib/api/homeassistant';
import type { Spool } from '@/lib/api/spoolman';
import type { EntityMap } from './entities';

const dbFile = join(mkdtempSync(join(tmpdir(), 'spoolmansync-usage-')), 'test.db');
{
  const db = new Database(dbFile);
  const migrations = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
  for (const name of readdirSync(migrations).filter(n => !n.endsWith('.toml')).sort()) {
    db.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
  }
  db.close();
}
process.env.DATABASE_URL = `file:${dbFile}`;
delete (globalThis as { prisma?: unknown }).prisma;

/**
 * Home Assistant's state machine, as far as the tracker can see it:
 * last_updated moves when the state or an attribute changes, last_changed only
 * when the state does, and an identical write produces no event at all.
 */
export class FakeHA {
  states: EntityMap = new Map();
  now = Date.UTC(2026, 9, 1, 12, 0, 0);
  connected = true;
  private changed: (ids: string[]) => void = () => {};

  source = (onChange: (ids: string[]) => void) => {
    this.changed = onChange;
    return {
      states: this.states,
      get connected() { return true; },
      watch: () => {},
      start: () => {},
      stop: () => {},
    };
  };

  set(id: string, state: string | number, attributes?: Record<string, unknown>): void {
    const prev = this.states.get(id);
    const value = String(state);
    const attrs = attributes ?? prev?.attributes ?? {};
    if (prev && prev.state === value && JSON.stringify(prev.attributes) === JSON.stringify(attrs)) return;
    this.states.set(id, {
      state: value,
      attributes: { ...attrs },
      lastChanged: prev && prev.state === value ? prev.lastChanged : this.now,
      lastUpdated: this.now,
    });
    this.changed([id]);
  }

  /** Merge into an entity's attributes. */
  attr(id: string, attributes: Record<string, unknown>): void {
    const prev = this.states.get(id);
    this.set(id, prev?.state ?? 'unknown', { ...prev?.attributes, ...attributes });
  }

  /** An HA restart re-creates every entity, so every timestamp moves. */
  restart(): void {
    for (const [id, e] of this.states) this.states.set(id, { ...e, lastChanged: this.now, lastUpdated: this.now });
    this.changed([...this.states.keys()]);
  }

  tick(ms: number): void {
    this.now += ms;
  }
}

export class FakeSpoolman {
  spools: Spool[] = [];
  calls: Array<{ spoolId: number; grams: number }> = [];
  /** Throw this instead of answering, while set. */
  failWith: unknown = null;
  /** Throw this from the next write only. */
  failNextWrite: unknown = null;

  add(id: number, trayKey: string | null, filament: Partial<Spool['filament']> = {}): Spool {
    const spool = {
      id, remaining_weight: 1000, used_weight: 0, initial_weight: 1000, registered: '', archived: false,
      extra: trayKey ? { active_tray: JSON.stringify(trayKey) } : {},
      filament: { id, name: `Filament ${id}`, vendor: null, material: 'PLA', color_hex: null, multi_color_hexes: null, multi_color_direction: null, density: 1.24, diameter: 1.75, ...filament },
    } as Spool;
    this.spools.push(spool);
    return spool;
  }

  assign(id: number, trayKey: string | null): void {
    const spool = this.spools.find(s => s.id === id)!;
    spool.extra = { ...spool.extra, active_tray: JSON.stringify(trayKey ?? '') };
  }

  used(id: number): number {
    return Math.round(this.spools.find(s => s.id === id)!.used_weight * 1000) / 1000;
  }

  async getSpools(): Promise<Spool[]> {
    if (this.failWith) throw this.failWith;
    return structuredClone(this.spools);
  }

  async useWeight(spoolId: number, grams: number): Promise<Spool> {
    if (this.failWith) throw this.failWith;
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
    const spool = this.spools.find(s => s.id === spoolId)!;
    spool.used_weight = Math.max(0, spool.used_weight + grams);
    spool.remaining_weight = spool.initial_weight - spool.used_weight;
    this.calls.push({ spoolId, grams });
    return structuredClone(spool);
  }

  async setSpoolTag(spoolId: number, tag: string): Promise<Spool> {
    for (const s of this.spools) if (s.extra?.tag === JSON.stringify(tag)) s.extra = { ...s.extra, tag: JSON.stringify('') };
    const spool = this.spools.find(s => s.id === spoolId)!;
    spool.extra = { ...spool.extra, tag: JSON.stringify(tag) };
    return structuredClone(spool);
  }
}

/** A connection refused: the request never reached Spoolman. */
export const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
/** A timeout: the request may have reached Spoolman. */
export const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

export const X1 = {
  status: 'sensor.x1c_print_status',
  progress: 'sensor.x1c_print_progress',
  weight: 'sensor.x1c_print_weight',
  name: 'sensor.x1c_subtask_name',
  file: 'sensor.x1c_gcode_file',
  stage: 'sensor.x1c_current_stage',
  tray: (n: number) => `sensor.x1c_ams_1_tray_${n}`,
  ext: 'sensor.x1c_external_spool',
  key: (n: number) => `X1C_SERIAL_AMS_1_tray_${n}`,
  extKey: 'X1C_SERIAL_ExternalSpool_external_spool',
};

export function bambuPrinter(): HAPrinter {
  return {
    brand: 'bambu_lab', entity_id: X1.status, name: 'X1C', state: 'idle', prefix: 'x1c_serial',
    ams_units: [{
      entity_id: 'sensor.x1c_ams_1_humidity', name: 'AMS 1', ams_number: 1,
      trays: [1, 2, 3, 4].map(n => ({ entity_id: X1.tray(n), unique_id: X1.key(n), tray_number: n })),
    }],
    external_spools: [{ entity_id: X1.ext, unique_id: X1.extKey, tray_number: 0, is_external: true }],
    current_stage_entity: X1.stage, print_weight_entity: X1.weight, print_progress_entity: X1.progress,
    job_name_entity: X1.name, gcode_file_entity: X1.file,
  };
}

/** An idle X1C whose last print left its figures behind. */
export function bambuIdle(ha: FakeHA, last: { progress?: number; plate?: number; trays?: Record<string, number>; name?: string } = {}): void {
  ha.set(X1.status, 'finish');
  ha.set(X1.progress, last.progress ?? 100);
  ha.set(X1.weight, last.plate ?? 0, last.trays ?? {});
  ha.set(X1.name, last.name ?? 'unknown');
  ha.set(X1.file, last.name ? `${last.name}.gcode.3mf` : 'unknown');
  for (const n of [1, 2, 3, 4]) ha.set(X1.tray(n), 'PLA Basic', { active: false, tray_uuid: '0000000000000000', name: 'PLA Basic', type: 'PLA' });
  ha.set(X1.ext, 'Empty', { active: false, tray_uuid: '', name: 'Empty' });
}

export interface BambuPrintOptions {
  name: string;
  plate: number;
  /** AMS tray number feeding, or a schedule of [progress, tray] switches. */
  tray: number | Array<[number, number]>;
  /** Slicer grams per tray name, as ha-bambulab publishes them. */
  trays?: Record<string, number>;
  endAt?: number;
  outcome?: 'finish' | 'failed';
  /** Cloud mode writes the plate at PREPARE; LAN parses the 3mf after RUNNING. */
  cloud?: boolean;
  /** The printer reports RUNNING before resetting progress (seen after a failed print). */
  runningBeforeReset?: boolean;
  /** Called after each progress step; return true to stop the print there. */
  during?: (pct: number) => void | boolean | Promise<void | boolean>;
  /** Skip writing the plate weight (an identical reprint writes nothing new). */
  writesPlate?: boolean;
  /** When the job's names arrive: with the status (default), with RUNNING, or after this progress. */
  namesAt?: 'running' | number;
}

/** One print as ha-bambulab publishes it, one pass after each change. */
export async function bambuPrint(ha: FakeHA, flush: () => Promise<void>, o: BambuPrintOptions): Promise<void> {
  const schedule = typeof o.tray === 'number' ? [[0, o.tray] as [number, number]] : o.tray;
  const trays = o.trays ?? { [`AMS 1 Tray ${schedule[0][1]}`]: o.plate };
  const feed = (n: number) => {
    for (const m of [1, 2, 3, 4]) ha.attr(X1.tray(m), { active: m === n });
  };
  const writePlate = () => { if (o.writesPlate !== false) ha.set(X1.weight, o.plate, trays); };
  const step = async (ms: number) => { ha.tick(ms); await flush(); };

  const names = () => { ha.set(X1.name, o.name); ha.set(X1.file, `${o.name}.gcode.3mf`); };
  ha.set(X1.status, 'prepare');
  if (o.namesAt === undefined) names();
  if (o.cloud) writePlate();
  await step(1_000);
  feed(schedule[0][1]);
  await step(30_000);
  if (o.runningBeforeReset) {
    ha.set(X1.status, 'running');
    await step(2_000);
    ha.set(X1.progress, 0);
  } else {
    ha.set(X1.progress, 0);
    ha.set(X1.status, 'running');
  }
  if (o.namesAt === 'running') names();
  await step(5_000);
  if (!o.cloud) writePlate();
  await step(1_000);

  const endAt = o.endAt ?? 100;
  for (let pct = 1; pct <= endAt; pct++) {
    const next = schedule.filter(([at]) => at < pct).at(-1);
    if (next) feed(next[1]);
    ha.set(X1.progress, pct);
    if (o.namesAt === pct) names();
    await step(30_000);
    if (await o.during?.(pct)) return;
  }
  ha.set(X1.status, o.outcome ?? 'finish');
  await step(1_000);
  for (const m of [1, 2, 3, 4]) ha.attr(X1.tray(m), { active: false });
  await step(1_000);
}

export const K2 = {
  status: 'sensor.k2_print_status',
  length: 'sensor.k2_used_material_length',
  slot: (n: number) => `sensor.k2_cfs_box_1_slot_${n}_filament`,
  ext: 'sensor.k2_cfs_external_filament',
  key: (n: number) => `k2_cfs_box_1_slot_${n}_filament`,
  extKey: 'k2_cfs_external_filament',
};

export function crealityPrinter(): HAPrinter {
  return {
    brand: 'creality', entity_id: K2.status, name: 'K2 Plus', state: 'idle', prefix: 'k2',
    ams_units: [{
      entity_id: 'sensor.k2_cfs_box_1_humidity', name: 'CFS Box 1', ams_number: 1,
      trays: [1, 2, 3, 4].map(n => ({ entity_id: K2.slot(n), unique_id: K2.key(n), tray_number: n })),
    }],
    external_spools: [{ entity_id: K2.ext, unique_id: K2.extKey, tray_number: 0, is_external: true }],
    print_progress_entity: 'sensor.k2_print_progress',
    used_material_entity: K2.length,
  };
}

/** Creality's status frame: the counter (mm) and file ride along as attributes. */
export function crealityFrame(ha: FakeHA, status: string, mm: number | null, file = '', extra: Record<string, unknown> = {}): void {
  ha.set(K2.status, status, { file, used_material_mm: mm, progress: 0, ...extra });
}

export function crealityIdle(ha: FakeHA, lastMm = 0, lastFile = ''): void {
  crealityFrame(ha, 'idle', lastMm, lastFile);
  for (const n of [1, 2, 3, 4]) ha.set(K2.slot(n), 'PLA', { selected: n === 1 ? 1 : 0, type: 'PLA' });
  ha.set(K2.ext, 'PLA', { selected: 0, type: 'PLA' });
}

/** One Creality job: the counter climbs `cmPerStep` per 30s frame for `steps` frames. */
export async function crealityPrint(ha: FakeHA, flush: () => Promise<void>, o: {
  file: string; slot: number; steps: number; cmPerStep: number; startMm?: number; end?: string;
  during?: (step: number) => void | Promise<void>;
}): Promise<void> {
  const step = async (ms: number) => { ha.tick(ms); await flush(); };
  for (const n of [1, 2, 3, 4]) ha.attr(K2.slot(n), { selected: n === o.slot ? 1 : 0 });
  // The first frame still carries the previous job's counter; the next restarts it.
  crealityFrame(ha, 'printing', o.startMm ?? 0, o.file);
  await step(1_000);
  crealityFrame(ha, 'printing', 0, o.file);
  await step(30_000);
  for (let i = 1; i <= o.steps; i++) {
    crealityFrame(ha, 'printing', i * o.cmPerStep * 10, o.file, { progress: Math.round(i / o.steps * 100) });
    await step(30_000);
    await o.during?.(i);
  }
  crealityFrame(ha, o.end ?? 'completed', o.steps * o.cmPerStep * 10, o.file, { progress: 100 });
  await step(1_000);
}
