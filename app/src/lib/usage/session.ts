/**
 * How much filament the print in progress has used from each tray, worked out
 * from the printer's Home Assistant entities. Pure: the tracker persists the
 * state and the ledger turns it into Spoolman deductions.
 *
 * Amounts are cumulative per print, so a repeated, late or missed observation
 * cannot change the total; the ledger only ever writes the difference between
 * what a tray has used and what Spoolman has already been told.
 *
 * Bambu (ha-bambulab): used = plate weight × progress, counted from where the
 * printer began printing: it heats, levels and calibrates first, which moves
 * the progress (the slicer counts that routine in its time estimate) but uses
 * next to no filament. The traps are readings left over from the previous
 * print: progress keeps its last value until the printer resets it, and
 * print_weight keeps the previous plate until the new 3mf is parsed (and is
 * re-published, unchanged, whenever Home Assistant restarts). So progress only
 * counts once written after the print was seen running, and the plate only once
 * written after the print started — or, for an identical reprint that writes
 * nothing new, when it matches the plate the previous print of the same job
 * confirmed. A job the printer resumes after it already ended unfinished
 * (power-loss recovery) owes only what it prints from where it picked up.
 *
 * Creality (ha_creality_ws): used = the job's extruded-length counter, which
 * restarts with every job and shows the previous job's figure until then.
 */
import type { EntityMap, EntityState } from './entities';
import type { PrinterWatch } from './printers';

export type Outcome = 'finished' | 'failed' | 'cancelled' | 'ended' | 'interrupted' | 'abandoned' | 'missed';

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
  /** The tracker saw the print start, as opposed to finding it already under way. */
  sawStart?: boolean;
  job: Job;
  /** HA last_changed of the status as last observed. */
  statusAt: number;
  /** Bambu: HA time the print was first seen running; filament only counts from then. */
  runningSince: number | null;
  /** Bambu: highest progress (%) seen for this print. */
  progress: number;
  /** Bambu: the progress (%) a resumed job picked up from, else 0; unset until progress is first read. */
  resumedFrom?: number;
  /**
   * Bambu: the progress (%) at which the printer, seen heating, levelling and
   * calibrating, began printing; for a resumed job, where the attempt it resumes
   * began. Null while a print seen starting is still preparing, when it owes
   * nothing yet. Unset when no stage was reported or the print was found under
   * way: printing then counts from 0.
   */
  printingFrom?: number | null;
  /** Bambu: objects skipped during this print. */
  skipped?: number;
  plate: Plate | null;
  /** Bambu: `plateMark` of the plate weight shown when the print began, the last print's until this one's 3mf is parsed. */
  shownAtStart?: string | null;
  /** Creality: the counter reading (cm) usage has been counted up to, and its HA time. */
  counter: number | null;
  counterAt: number | null;
  /** Creality: the counter has restarted for this job (until then it shows the previous job's figure). */
  restarted: boolean;
  /** Creality: the last job's figure, which the counter showed until it restarted for this job. */
  lastJob?: number | null;
  /** Creality: the printer went away (off or unreachable) since the counter was last read; only then can it restart. */
  outage?: boolean;
  /** Creality: a reading below the counter after an outage, its time, and when the counter was last above it; see the dip handling. */
  dip?: { from: number; at: number; since: number } | null;
  /** Creality: a reading too far above the counter to be filament, and its time; see the jump handling. */
  jump?: { to: number; at: number } | null;
  /** Creality: a reading equal to the last job's figure, counted once another reading or the job's end confirms it. */
  held?: number | null;
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
  outcome: Outcome | null;
  /** App time it ended (ms). */
  endedAt: number | null;
  /** Bambu: how far it got (%); 0 if it ended before it began printing. */
  progress: number;
  /** Bambu: the progress (%) at which its printing began, for a job resumed from it. */
  printingFrom: number;
  plateGrams: number | null;
  /** Bambu: `plateMark` of its plate. */
  plate: string | null;
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
/** How near, in %, a job must pick up to where its unfinished last print stopped to be that print resumed. */
const RESUME_SLACK_PCT = 5;
/** A print first seen this long after it started was found under way, not seen starting. */
const LATE_MS = 5 * 60_000;
/** A running print whose progress is this far (%) behind where it got has started over. */
const RESTARTED_DROP_PCT = 10;
/** Below this, picking up "where it stopped" cannot be told from starting over. */
const RESUME_MIN_PCT = 5;
/** A print first seen preparing past this progress (%) may have printed already, so it is not held. */
const PREPARE_MAX_PCT = 5;
/** A print held while preparing that goes unseen this long may have begun printing meanwhile (the tracker looks every minute). */
const HELD_GAP_MS = 3 * 60_000;
/** A dip below the counter after an outage that climbs this far (cm) is the job counting again from zero. */
const RESTART_CONFIRM_CM = 10;
/** ha_creality_ws reads a job completed a second early, then printing again at 99%, for about this long at most. */
const COMPLETED_ECHO_MS = 2 * 60_000;

const BAMBU_ACTIVE = new Set(['prepare', 'running', 'pause', 'slicing', 'init']);
/** Where a Bambu print begins; a print that was running never returns to these. */
const BAMBU_STARTING = new Set(['prepare', 'slicing']);
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
    startedAt, sawStart: now - startedAt < LATE_MS, job, statusAt: startedAt, runningSince: null, progress: 0, plate: null,
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

/** The trays feeding now, noting the one if just one is: what is owed while none is goes to it. */
function noteFeeding(s: SessionState, watch: PrinterWatch, map: EntityMap): string[] {
  const trays = feeding(watch, map);
  if (trays.length === 1) s.lastTray = trays[0];
  return trays;
}

/** Give `amount` to the trays feeding now, or the last one that was. */
function allocate(s: SessionState, amount: number, watch: PrinterWatch, map: EntityMap): void {
  let trays = noteFeeding(s, watch, map);
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

/**
 * Where this print picks up, if it resumes the same job after the printer
 * reported it ended unfinished: Bambu's power-loss recovery can resume a job
 * already reported failed or idle, and the progress before that was billed to
 * the print that stopped there. Starting the job over shows progress near 0
 * first; a resume first shows about where it stopped, or later if the printer
 * dropped off before its first update. Later only counts for a print the
 * tracker saw start, since one found under way can show any progress.
 */
function resumePoint(s: SessionState, prev: PreviousPrint | null, pct: number): number {
  if (!prev || prev.outcome === 'finished' || prev.outcome === 'missed' || !sameJob(s.job, prev.job)) return 0;
  if (pct < RESUME_MIN_PCT || prev.progress < RESUME_MIN_PCT || pct < prev.progress - RESUME_SLACK_PCT) return 0;
  if (!s.sawStart && pct > prev.progress + RESUME_SLACK_PCT) return 0;
  return Math.min(pct, prev.progress);
}

/** Decide, from the first progress (%) clear of zero, whether this print resumes the last one. */
function decideResume(s: SessionState, prev: PreviousPrint | null, pct: number): void {
  s.resumedFrom = s.progress === 0 && total(s.used) === 0 ? resumePoint(s, prev, pct) : 0;
  // Its printing began where the first attempt's did.
  if (s.resumedFrom > 0) s.printingFrom = prev?.printingFrom ?? 0;
}

/** The share of the plate printed by this progress (%): none of it before printing began. */
function printedShare(s: SessionState, pct: number): number {
  if (s.printingFrom === null) return 0;
  const from = s.printingFrom ?? 0;
  if (pct >= 100) return 1;
  return from >= 100 ? 0 : Math.max(0, pct - from) / (100 - from);
}

/** What the progress says this print owes in all: its share of the plate, less a resumed job's earlier attempts. */
const owedByProgress = (s: SessionState) =>
  s.plate ? s.plate.grams * Math.max(0, printedShare(s, s.progress) - printedShare(s, s.resumedFrom ?? 0)) : 0;

const NEVER_REPORTED = 'Home Assistant never reported this print\'s weight, so nothing was deducted. This happens when ha-bambulab cannot find the print\'s file, or when a print weighs exactly what the last one did, which Home Assistant shows as no change.';

/** A plate's weight and split, to tell one re-rendered from one newly parsed. */
export const plateMark = (grams: number, trays: Record<string, number> | null) =>
  JSON.stringify([grams, trays && Object.entries(trays).sort(([a], [b]) => a.localeCompare(b))]);

function shownPlate(watch: PrinterWatch, weight: EntityState | undefined): string | null {
  const grams = weight ? Number(weight.state) : NaN;
  return weight && grams > 0 ? plateMark(grams, slicerTrays(watch, weight.attributes)) : null;
}

/** The plate weight for this print, if the printer has said what it is. */
function bambuPlate(watch: PrinterWatch, weight: EntityState | undefined, s: SessionState, prev: PreviousPrint | null): Plate | null {
  const grams = weight ? Number(weight.state) : NaN;
  if (!weight || !(grams > 0)) return null;
  const trays = slicerTrays(watch, weight.attributes);
  // An attribute-only write counts only when it names AMS trays and is not a
  // plate already seen: ha-bambulab re-renders the attributes, value unchanged,
  // whenever the external spool's active flag flips, the last print's split
  // included until this print's 3mf is parsed.
  const mark = plateMark(grams, trays);
  const written = weight.lastChanged >= s.startedAt
    || (weight.lastUpdated >= s.startedAt && mark !== s.shownAtStart && mark !== prev?.plate
      && Object.keys(weight.attributes).some(k => k.startsWith('AMS ')));
  if (written) return { grams, trays, fresh: true };
  if (prev && sameJob(s.job, prev.job) && prev.plateGrams === grams) return { grams, trays, fresh: false };
  return null;
}

const end = (state: SessionState, outcome: Outcome, used: Record<string, number>, attention: string | null = null): Ended =>
  ({ state, outcome, used, attention });

/** Bambu's final amounts: the slicer's per-tray figures for a finished print, else what was observed. */
function bambuEnd(watch: PrinterWatch, s: SessionState, outcome: Outcome): Ended {
  if (s.runningSince === null) return end(s, outcome, s.used);
  const from = s.resumedFrom ?? 0;
  const notes = [
    from > 0 ? `This resumed the job from ${from}%, so only the rest of it was deducted.` : '',
    // The plate weight, and so the progress-based amount, includes them.
    s.skipped ? `${s.skipped} skipped object${s.skipped === 1 ? ' is' : 's are'} still in the deducted weight; check the spool's weight.` : '',
  ];
  const done = (used: Record<string, number>, note = '') =>
    end(s, outcome, used, [note, ...notes].filter(Boolean).join(' ') || null);

  if (!s.plate) return done(s.used, total(s.used) > 0 ? '' : NEVER_REPORTED);
  if (outcome !== 'finished') return done(s.used);

  const { grams, trays } = s.plate;
  // The slicer's split, for a whole job, unless a tray it never planned fed (an
  // AMS that switched to a backup spool). ha-bambulab leaves the external spool
  // out of the split, so the rest of the plate is what that fed -- and while one
  // is active it shows the whole plate under it, which is no split at all.
  const externals = watch.trays.filter(t => t.external).map(t => t.key);
  const rounding = Math.max(0.5, grams * 0.02);
  if (from === 0 && trays && total(trays) <= grams + rounding) {
    const externalOnly = Object.keys(trays).every(key => externals.includes(key));
    const outside = Object.entries(s.used).filter(([key, g]) => !(key in trays) && g > 0);
    const unplanned = outside.some(([key, g]) => g >= 1 && (externalOnly || !externals.includes(key)));
    const rest = Math.max(0, grams - total(trays));
    // An external spool that fed too briefly to be seen is the only one there is.
    const seen = outside.filter(([key]) => externals.includes(key));
    const takers = seen.length > 0 || externals.length !== 1 || rest <= rounding / 4 ? seen : [[externals[0], 1] as [string, number]];
    if (!unplanned && (takers.length > 0 || rest <= rounding)) {
      const weight = total(Object.fromEntries(takers));
      return done({ ...trays, ...Object.fromEntries(takers.map(([key, g]) => [key, rest * g / weight])) });
    }
  }
  const owed = grams * (1 - printedShare(s, from));
  const observed = total(s.used);
  if (observed > 0) return done(Object.fromEntries(Object.entries(s.used).map(([k, g]) => [k, g * owed / observed])));
  if (s.lastTray) return done({ [s.lastTray]: owed });
  return done({}, 'No tray reported feeding during this print, so nothing was deducted.');
}

function advanceBambu(watch: PrinterWatch, map: EntityMap, cur: SessionState | null, prev: PreviousPrint | null, now: number): Advance {
  const statusEntity = map.get(watch.status);
  const status = statusEntity?.state ?? 'unavailable';
  const job: Job = { name: textState(map, watch.jobName), file: textState(map, watch.gcodeFile) };
  const progressEntity = watch.progress ? map.get(watch.progress) : undefined;
  const progress = Number(progressEntity?.state);

  let s = cur ? structuredClone(cur) : null;
  let ended: Ended | null = null;
  let started = false;

  // A print ended and another began while the tracker was not watching: the
  // running print is back at its start, its progress started over, or a
  // different job's names came before the status's latest change. A print's
  // own names arriving late come after it (ha-bambulab writes them after the
  // status, and can leave them until after RUNNING), or with it when Home
  // Assistant restarts.
  const namesAt = Math.max(map.get(watch.jobName ?? '')?.lastChanged ?? 0, map.get(watch.gcodeFile ?? '')?.lastChanged ?? 0);
  if (s && statusEntity && BAMBU_ACTIVE.has(status) && s.runningSince !== null && statusEntity.lastChanged !== s.statusAt
    && (BAMBU_STARTING.has(status)
      || (progressEntity !== undefined && progressEntity.lastUpdated >= s.runningSince && progress < s.progress - RESTARTED_DROP_PCT)
      || (otherJob(s.job, job) && statusEntity.lastChanged > namesAt))) {
    // A new print still starting has not moved the progress: what it shows is
    // how far the one it replaced got.
    if (BAMBU_STARTING.has(status) && s.plate && progressEntity && progressEntity.lastUpdated >= s.runningSince && Number.isFinite(progress)) {
      s.progress = Math.max(s.progress, Math.min(100, progress));
      const due = owedByProgress(s) - total(s.used);
      if (due > 0.0005) allocate(s, due, watch, map);
    }
    ended = end(s, 'interrupted', s.used);
    s = null;
  }

  if (!s) {
    if (!statusEntity || !BAMBU_ACTIVE.has(status)) return { session: null, started: false, ended };
    s = newSession(statusEntity.lastChanged, job, now);
    s.shownAtStart = shownPlate(watch, watch.weight ? map.get(watch.weight) : undefined);
    started = true;
  }

  // A print seen starting owes nothing while the printer prepares, and the
  // plate is spread over the progress from where it says it is printing --
  // before this observation's progress counts. Unseen for a while, it may have
  // begun meanwhile, so it is taken to have begun where it was last seen.
  const stage = textState(map, watch.stage);
  if (s.printingFrom === undefined && s.sawStart && s.progress < PREPARE_MAX_PCT && stage !== null && stage !== 'idle' && stage !== 'printing') {
    s.printingFrom = null;
  }
  if (s.printingFrom === null && (stage === 'printing' || now - s.seenAt > HELD_GAP_MS)) s.printingFrom = s.progress;

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

  if (s.runningSince !== null && progressEntity && progressEntity.lastUpdated >= s.runningSince && Number.isFinite(progress)) {
    const pct = Math.min(100, Math.max(0, progress));
    // Decided by the first reading clear of zero: a lone 0 can be a glitch.
    if (s.resumedFrom === undefined && pct >= RESUME_MIN_PCT) decideResume(s, prev, pct);
    s.progress = Math.max(s.progress, pct);
  }
  if (s.runningSince !== null && s.plate) {
    const due = owedByProgress(s) - total(s.used);
    if (due > 0.0005) allocate(s, due, watch, map);
  }
  // Owing nothing yet, the tray feeding still says where the plate goes if it finishes unsplit.
  if (s.printingFrom === null) noteFeeding(s, watch, map);
  const skippedEntity = watch.skipped ? map.get(watch.skipped) : undefined;
  const skipped = Number(skippedEntity?.state);
  if (s.runningSince !== null && skippedEntity && skippedEntity.lastChanged >= s.startedAt && skipped > 0) {
    s.skipped = Math.max(s.skipped ?? 0, skipped);
  }

  const outcome = BAMBU_END[status];
  if (outcome && s.resumedFrom === undefined && s.runningSince !== null && Number.isFinite(progress)) {
    // Ended without a reading of its own: a job resumed with nothing left to print.
    decideResume(s, prev, progress);
  }
  if (outcome) return { session: null, started, ended: bambuEnd(watch, s, outcome) };
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

/**
 * Fold one reading of the job's extruded-length counter (cm) into the print.
 * Only increases count, and a misleading reading costs at most the frame it hides:
 *  - until the counter restarts for the job it shows the last job's figure,
 *    and a drop to what could have been used since the job began is the restart;
 *  - now and then a frame repeats the last job's figure, so a reading equal to
 *    it waits for one more (or the job's end) to confirm it;
 *  - zeroed and glitched readings dip below the counter, and usage resumes above it,
 *    except that after the printer went away a resumed job can count from zero
 *    again: a dip that then climbs;
 *  - a reading too far above the counter to be filament is skipped, unless the
 *    next one confirms the counter really is there (it had been left too low).
 */
function countReading(s: SessionState, reading: number, at: number, lastJob: number | null | undefined, ending: boolean, feed: (cm: number) => void): void {
  const plausible = (cm: number, since = s.counterAt ?? s.startedAt) =>
    cm <= MAX_CM_PER_S * Math.max(MIN_WINDOW_S, (at - since) / 1000);
  const moveTo = (value: number, used: number) => {
    if (used > 0) feed(used);
    Object.assign(s, { counter: value, dip: null, jump: null, held: null, outage: false });
  };
  if (s.counter === null) {
    s.counter = reading;
    s.restarted = reading < 1; // a counter at zero has already restarted for this job
  }
  const counter = s.counter;
  if (reading > counter) {
    if (s.restarted && reading === (s.lastJob ?? lastJob) && s.held !== reading && !ending) s.held = reading;
    else if (s.dip && reading - s.dip.from >= RESTART_CONFIRM_CM && plausible(reading - s.dip.from, s.dip.at)) {
      moveTo(reading, plausible(reading, s.dip.since) ? reading : 0); // the restarted count passing where it was
    } else if (plausible(reading - counter)) moveTo(reading, reading - counter);
    else if (s.jump && reading >= s.jump.to && plausible(reading - s.jump.to, s.jump.at)) moveTo(reading, reading - s.jump.to);
    else s.jump = { to: reading, at };
  } else if (reading < counter && !s.restarted) {
    if (plausible(reading)) {
      s.restarted = true;
      s.lastJob = counter;
      feed(reading);
    } else {
      s.lastJob = reading; // still the last job's figure, only lower than the one on record
    }
    s.counter = reading;
  } else if (reading < counter) {
    if (!s.dip || reading < s.dip.from) {
      if (s.outage) s.dip = { from: reading, at, since: s.dip?.since ?? s.counterAt ?? s.startedAt };
    } else if (reading - s.dip.from >= RESTART_CONFIRM_CM) {
      moveTo(reading, plausible(reading, s.dip.since) ? reading : 0);
    }
  }
  s.counterAt = at;
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
    // The printer rounds progress up to 100 a second before a job ends, then
    // reports 99 once more: still the job that just completed.
    const echo = prev?.outcome === 'finished' && prev.endedAt !== null && now - prev.endedAt < COMPLETED_ECHO_MS
      && job.file !== null && prev.job.file === job.file && Number(statusEntity.attributes.progress) >= 90;
    if (echo) return { session: null, started: false, ended };
    s = newSession(statusEntity.lastChanged, job, now);
    // Counting starts from where the last job left the counter (or, with no
    // last job on record, from the first reading), never from zero: the
    // counter shows the last job's figure until it restarts.
    s.counter = stuck ? reading : prev?.counter ?? null;
    started = true;
  }

  if (statusEntity) s.statusAt = statusEntity.lastChanged;
  if (!NO_STATUS.has(status)) s.seenAt = now;
  else if (s.counter !== null) s.outage = true;
  if (job.file !== null) s.job = job;

  if (reading !== null) {
    countReading(s, reading, statusEntity!.lastUpdated, prev?.counter, status in CREALITY_END, cm => allocate(s!, cm, watch, map));
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

/**
 * A print that ran from start to finish while the tracker was not watching
 * (SpoolmanSync, or its connection, down throughout): the printer shows a job
 * other than the last one recorded, completed. Undefined while its status is
 * not known yet. A job that ended any other way may have used nothing (one
 * cancelled while preparing), so only completed ones are reported.
 */
export function missedPrint(watch: PrinterWatch, map: EntityMap, prev: PreviousPrint | null): Job | null | undefined {
  const status = map.get(watch.status);
  if (!status || NO_STATUS.has(status.state)) return undefined;
  const fileAttr = status.attributes.file;
  const job: Job = watch.brand === 'creality'
    ? { name: null, file: typeof fileAttr === 'string' && fileAttr.trim() ? fileAttr.trim() : null }
    : { name: textState(map, watch.jobName), file: textState(map, watch.gcodeFile) };
  const completed = watch.brand === 'creality' ? status.state === 'completed' : status.state === 'finish';
  return prev && completed && otherJob(prev.job, job) ? job : null;
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
