/**
 * How much filament the print in progress has used from each tray, worked out
 * from the printer's Home Assistant entities. Pure: the tracker persists the
 * state and the ledger turns it into Spoolman deductions.
 *
 * Amounts are cumulative per print, so a repeated, late or missed observation
 * cannot change the total; the ledger only ever writes the difference between
 * what a tray has used and what Spoolman has already been told.
 *
 * Bambu (ha-bambulab): used = plate weight × progress. The traps are readings
 * left over from the previous print: progress keeps its last value until the
 * printer resets it, and print_weight keeps the previous plate until the new
 * 3mf is parsed (and is re-published, unchanged, whenever Home Assistant
 * restarts). So progress only counts once written after the print was seen
 * running, and the plate only once written after the print started — or, for
 * an identical reprint that writes nothing new, when it matches the plate the
 * previous print of the same job confirmed.
 *
 * Creality (ha_creality_ws): used = the job's extruded-length counter, which
 * restarts with every job and shows the previous job's figure until then.
 */
import type { EntityMap, EntityState } from './entities';
import type { PrinterWatch } from './printers';

export type Outcome = 'finished' | 'failed' | 'cancelled' | 'ended' | 'interrupted' | 'abandoned';

/** What the printer says it is printing: Bambu's subtask_name and gcode_file, Creality's file. */
export interface Job {
  name: string | null;
  file: string | null;
}

export interface Plate {
  grams: number;
  /** The slicer's grams per tray key, or null when the attributes cannot all be mapped to trays. */
  trays: Record<string, number> | null;
  /** Written during this print, as opposed to carried over from the previous print of the same job. */
  fresh: boolean;
}

export interface SessionState {
  /** HA time the print started (ms). */
  startedAt: number;
  job: Job;
  /** HA last_changed of the status as last observed. */
  statusAt: number;
  /** Bambu: HA time the print was first seen running; filament only counts from then. */
  runningSince: number | null;
  /** Bambu: highest progress (%) seen for this print. */
  progress: number;
  plate: Plate | null;
  /** Creality: the counter reading (cm) usage has been counted up to, and its HA time. */
  counter: number | null;
  counterAt: number | null;
  /** Creality: the counter has restarted for this job (until then it shows the previous job's figure). */
  restarted: boolean;
  /** Filament used per tray key, in grams (Bambu) or cm (Creality). */
  used: Record<string, number>;
  lastTray: string | null;
  /** Creality: when the printer went idle (app clock); idle only ends a print once it persists. */
  idleSince: number | null;
  /** Last time the printer reported a usable status (app clock). */
  seenAt: number;
}

/** What the printer's previous print left behind. */
export interface PreviousPrint {
  job: Job;
  plateGrams: number | null;
  counter: number | null;
}

export interface Ended {
  state: SessionState;
  outcome: Outcome;
  /** Final amount per tray key. */
  used: Record<string, number>;
  attention: string | null;
}

export interface Advance {
  /** The print in progress after this observation, or null. */
  session: SessionState | null;
  /** `session` is a print that started in this observation. */
  started: boolean;
  ended: Ended | null;
}

/** A printer that reports nothing usable for this long has its print closed. */
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
/** ha_creality_ws reports lone idle frames mid-print, so idle must persist before it ends one. */
export const CREALITY_IDLE_MS = 90 * 1000;
/**
 * Fastest a Creality printer can plausibly pull filament, cm/s (about three
 * times a 40 mm³/s hotend), over at least half a minute so a burst of frames
 * Home Assistant catches up on is not mistaken for one. Faster is a bad reading.
 */
const MAX_CM_PER_S = 5;
const MIN_WINDOW_S = 30;

const BAMBU_ACTIVE = new Set(['prepare', 'running', 'pause', 'slicing', 'init']);
const BAMBU_END: Record<string, Outcome> = { finish: 'finished', failed: 'failed', idle: 'ended' };
const CREALITY_END: Record<string, Outcome> = { completed: 'finished', stopped: 'cancelled' };
const NO_STATUS = new Set(['unavailable', 'unknown', 'offline', 'off', '']);

const total = (used: Record<string, number>) => Object.values(used).reduce((a, b) => a + b, 0);

export const sameJob = (a: Job, b: Job) => (a.name !== null || a.file !== null) && a.name === b.name && a.file === b.file;

/** Two different jobs, as opposed to one whose name has not arrived yet. */
const otherJob = (a: Job, b: Job) =>
  (a.name !== null && b.name !== null && a.name !== b.name) || (a.file !== null && b.file !== null && a.file !== b.file);

function newSession(startedAt: number, job: Job, now: number): SessionState {
  return {
    startedAt, job, statusAt: startedAt, runningSince: null, progress: 0, plate: null,
    counter: null, counterAt: null, restarted: false, used: {}, lastTray: null, idleSince: null, seenAt: now,
  };
}

/** Trays feeding right now: Bambu marks them `active`, Creality `selected`. */
function feeding(watch: PrinterWatch, map: EntityMap): string[] {
  if (watch.trays.length === 1 && watch.trays[0].entityId === null) return [watch.trays[0].key];
  return watch.trays.filter(tray => {
    const attrs = tray.entityId ? map.get(tray.entityId)?.attributes : undefined;
    const flag = watch.brand === 'creality' ? attrs?.selected : attrs?.active;
    return flag === true || flag === 1 || flag === 'true' || flag === 'True' || flag === '1';
  }).map(tray => tray.key);
}

/** Give `amount` to the trays feeding now, or the last one that was. */
function allocate(s: SessionState, amount: number, watch: PrinterWatch, map: EntityMap): void {
  let trays = feeding(watch, map);
  if (trays.length === 1) s.lastTray = trays[0];
  if (trays.length === 0 && s.lastTray) trays = [s.lastTray];
  if (trays.length === 0 && watch.trays.length === 1) trays = [watch.trays[0].key];
  if (trays.length === 0) return; // owed until a tray reports feeding
  for (const key of trays) s.used[key] = (s.used[key] ?? 0) + amount / trays.length;
}

function textState(map: EntityMap, entityId: string | undefined): string | null {
  const state = entityId ? map.get(entityId)?.state?.trim() : undefined;
  return state && !NO_STATUS.has(state) ? state : null;
}

function slicerTrays(watch: PrinterWatch, attributes: Record<string, unknown>): Record<string, number> | null {
  const trays: Record<string, number> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!/^(AMS |External Spool)/.test(name)) continue;
    const key = watch.slicerNames[name];
    const grams = Number(value);
    if (!key || !Number.isFinite(grams)) return null;
    if (grams > 0) trays[key] = (trays[key] ?? 0) + grams;
  }
  return Object.keys(trays).length > 0 ? trays : null;
}

/** The plate weight for this print, if the printer has said what it is. */
function bambuPlate(watch: PrinterWatch, weight: EntityState | undefined, s: SessionState, prev: PreviousPrint | null): Plate | null {
  const grams = weight ? Number(weight.state) : NaN;
  if (!weight || !(grams > 0)) return null;
  const trays = slicerTrays(watch, weight.attributes);
  // An attribute-only write counts only when it names AMS trays: ha-bambulab also
  // rewrites the attributes, value unchanged, whenever the external spool's
  // active flag flips.
  const written = weight.lastChanged >= s.startedAt
    || (weight.lastUpdated >= s.startedAt && Object.keys(weight.attributes).some(k => k.startsWith('AMS ')));
  if (written) return { grams, trays, fresh: true };
  if (prev && sameJob(s.job, prev.job) && prev.plateGrams === grams) return { grams, trays, fresh: false };
  return null;
}

const end = (state: SessionState, outcome: Outcome, used: Record<string, number>, attention: string | null = null): Ended =>
  ({ state, outcome, used, attention });

/** Bambu's final amounts: the slicer's per-tray figures for a finished print, else what was observed. */
function bambuEnd(s: SessionState, outcome: Outcome): Ended {
  if (s.runningSince === null) return end(s, outcome, s.used);
  if (!s.plate) {
    return end(s, outcome, s.used, total(s.used) > 0 ? null
      : 'The printer never reported this print\'s weight, so nothing was deducted.');
  }
  if (outcome !== 'finished') return end(s, outcome, s.used);

  const { grams, trays } = s.plate;
  // The slicer's split is only right if it covers the plate and every tray that
  // actually fed: an AMS that switched to a backup spool fed a tray it never planned.
  if (trays && Math.abs(total(trays) - grams) <= Math.max(0.5, grams * 0.02)
    && Object.entries(s.used).every(([key, g]) => g < 1 || key in trays)) {
    return end(s, outcome, trays);
  }
  const observed = total(s.used);
  if (observed > 0) return end(s, outcome, Object.fromEntries(Object.entries(s.used).map(([k, g]) => [k, g * grams / observed])));
  if (s.lastTray) return end(s, outcome, { [s.lastTray]: grams });
  return end(s, outcome, {}, 'No tray reported feeding during this print, so nothing was deducted.');
}

function advanceBambu(watch: PrinterWatch, map: EntityMap, cur: SessionState | null, prev: PreviousPrint | null, now: number): Advance {
  const statusEntity = map.get(watch.status);
  const status = statusEntity?.state ?? 'unavailable';
  const job: Job = { name: textState(map, watch.jobName), file: textState(map, watch.gcodeFile) };
  const progressEntity = watch.progress ? map.get(watch.progress) : undefined;

  let s = cur ? structuredClone(cur) : null;
  let ended: Ended | null = null;
  let started = false;

  // A running print, then a different job with the status changed since it was
  // last seen: a print ended and another began while the tracker was not
  // watching. Anything less is this print's own name arriving late, which
  // ha-bambulab writes after the status and can leave until after RUNNING.
  if (s && statusEntity && BAMBU_ACTIVE.has(status) && s.runningSince !== null
    && statusEntity.lastChanged !== s.statusAt && otherJob(s.job, job)) {
    ended = end(s, 'interrupted', s.used);
    s = null;
  }

  if (!s) {
    if (!statusEntity || !BAMBU_ACTIVE.has(status)) return { session: null, started: false, ended };
    s = newSession(statusEntity.lastChanged, job, now);
    started = true;
  }

  if (statusEntity) s.statusAt = statusEntity.lastChanged;
  if (!NO_STATUS.has(status)) s.seenAt = now;
  s.job = { name: job.name ?? s.job.name, file: job.file ?? s.job.file };
  if (status === 'running' && s.runningSince === null) s.runningSince = statusEntity!.lastChanged;

  // A borrowed plate is dropped once the job no longer matches the one it came
  // from. Usage so far was worked out from the old plate, so it is restated for
  // the new one (and withdrawn with a dropped one).
  const found = bambuPlate(watch, watch.weight ? map.get(watch.weight) : undefined, s, prev);
  const plate = found ?? (s.plate?.fresh ? s.plate : null);
  if (s.plate && plate?.grams !== s.plate.grams) {
    for (const key of Object.keys(s.used)) s.used[key] *= plate ? plate.grams / s.plate.grams : 0;
  }
  s.plate = plate;

  const progress = Number(progressEntity?.state);
  if (s.runningSince !== null && progressEntity && progressEntity.lastUpdated >= s.runningSince && Number.isFinite(progress)) {
    s.progress = Math.max(s.progress, Math.min(100, Math.max(0, progress)));
  }
  if (s.runningSince !== null && s.plate) {
    const due = s.plate.grams * s.progress / 100 - total(s.used);
    if (due > 0.0005) allocate(s, due, watch, map);
  }

  const outcome = BAMBU_END[status];
  if (outcome) return { session: null, started, ended: bambuEnd(s, outcome) };
  if (now - s.seenAt > ABANDON_AFTER_MS) return { session: null, started, ended: end(s, 'abandoned', s.used) };
  return { session: s, started, ended };
}

/** The job's extruded length in cm, from the status frame itself when the integration includes it. */
function crealityCounter(watch: PrinterWatch, map: EntityMap, status: EntityState | undefined): number | null {
  if (!status || NO_STATUS.has(status.state)) return null;
  if ('used_material_mm' in status.attributes) {
    const mm = Number(status.attributes.used_material_mm ?? NaN);
    return Number.isFinite(mm) && mm >= 0 ? mm / 10 : null;
  }
  // Older ha_creality_ws: the separate sensor, which reads 0 whenever the printer is unreachable.
  const cm = Number(textState(map, watch.usedLength));
  return Number.isFinite(cm) && cm >= 0 ? cm : null;
}

function advanceCreality(watch: PrinterWatch, map: EntityMap, cur: SessionState | null, prev: PreviousPrint | null, now: number): Advance {
  const statusEntity = map.get(watch.status);
  const status = statusEntity?.state ?? 'unavailable';
  const fileAttr = statusEntity?.attributes.file;
  const job: Job = { name: null, file: typeof fileAttr === 'string' && fileAttr.trim() ? fileAttr.trim() : null };
  const reading = crealityCounter(watch, map, statusEntity);

  let s = cur ? structuredClone(cur) : null;
  let ended: Ended | null = null;
  let started = false;

  // The file arrives in the same frame as the status, so a new one while printing is a new job.
  if (s && status === 'printing' && otherJob(s.job, job)) {
    ended = end(s, 'interrupted', s.used);
    s = null;
  }

  if (!s) {
    // `error` can stick for a whole job on some firmware, so a moving counter
    // opens a print too, counting only from what it reads now.
    const stuck = status === 'error' && reading !== null && job.file !== null && reading !== (prev?.counter ?? null);
    if (!statusEntity || (status !== 'printing' && !stuck)) return { session: null, started: false, ended };
    s = newSession(statusEntity.lastChanged, job, now);
    // Counting starts from where the last job left the counter (or, with no
    // last job on record, from the first reading), never from zero: the
    // counter shows the last job's figure until it restarts.
    s.counter = stuck ? reading : prev?.counter ?? null;
    started = true;
  }

  if (statusEntity) s.statusAt = statusEntity.lastChanged;
  if (!NO_STATUS.has(status)) s.seenAt = now;
  if (job.file !== null) s.job = job;

  if (reading !== null) {
    const at = statusEntity!.lastUpdated;
    const plausible = (cmUsed: number) =>
      cmUsed <= MAX_CM_PER_S * Math.max(MIN_WINDOW_S, (at - (s!.counterAt ?? s!.startedAt)) / 1000);
    if (s.counter === null) {
      s.counter = reading;
      s.restarted = reading < 1; // a counter at zero has already restarted for this job
    }
    if (reading > s.counter) {
      // Too fast to be real (a frame repeating the last job's figure, say): skip the reading.
      if (plausible(reading - s.counter)) {
        allocate(s, reading - s.counter, watch, map);
        s.counter = reading;
      }
    } else if (reading < s.counter && !s.restarted) {
      // The job's counter restarting: what it reads now was used since.
      s.restarted = true;
      if (plausible(reading)) allocate(s, reading, watch, map);
      s.counter = reading;
    }
    // Any later dip is a zeroed or glitched reading; usage resumes above it.
    s.counterAt = at;
  }

  const outcome = CREALITY_END[status];
  if (outcome) return { session: null, started, ended: end(s, outcome, s.used) };
  if (status === 'idle') {
    s.idleSince ??= now;
    if (now - s.idleSince >= CREALITY_IDLE_MS) return { session: null, started, ended: end(s, 'ended', s.used) };
  } else {
    s.idleSince = null;
  }
  if (now - s.seenAt > ABANDON_AFTER_MS) return { session: null, started, ended: end(s, 'abandoned', s.used) };
  return { session: s, started, ended };
}

/** Fold the printer's current entity states into its print in progress. */
export function advance(
  watch: PrinterWatch,
  map: EntityMap,
  current: SessionState | null,
  previous: PreviousPrint | null,
  now: number,
): Advance {
  return watch.brand === 'creality'
    ? advanceCreality(watch, map, current, previous, now)
    : advanceBambu(watch, map, current, previous, now);
}
