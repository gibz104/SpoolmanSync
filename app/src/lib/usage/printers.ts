/**
 * Which Home Assistant entities the usage tracker reads for each printer, built
 * from the same discovery the dashboard uses.
 */
import type { HAPrinter } from '@/lib/api/homeassistant';

export type Brand = 'bambu_lab' | 'creality';

export interface TrayWatch {
  /** The assignment key spools carry in `extra.active_tray` (the tray's unique_id). */
  key: string;
  /** Null for the slot discovery synthesizes for a printer with none of its own (#68). */
  entityId: string | null;
  label: string;
  /** An external spool: Bambu's slicer split never names one. */
  external: boolean;
}

export interface PrinterWatch {
  prefix: string;
  name: string;
  brand: Brand;
  /** The printer's HA device, to ask ha_creality_ws about this printer alone. */
  deviceId?: string;
  /** print_status: Bambu's gcode_state, or Creality's derived status with the job's counter as attributes. */
  status: string;
  progress?: string;
  /** Bambu: the slicer's plate weight, with per-tray grams as attributes. */
  weight?: string;
  /** Bambu: subtask_name and gcode_file, which together name the job. */
  jobName?: string;
  gcodeFile?: string;
  /** Bambu: how many objects were skipped mid-print. */
  skipped?: string;
  /** Bambu: current_stage, which tells heating, levelling and calibrating from printing. */
  stage?: string;
  /** Creality: used_material_length (cm), for integration versions whose status lacks the counter. */
  usedLength?: string;
  trays: TrayWatch[];
  /**
   * ha-bambulab's names for trays in print_weight's attributes ("AMS 1 Tray 2"),
   * to tray keys. A name two trays claim (a duplicate AMS device left in HA's
   * registry) maps to '', so the slicer's split is not trusted.
   */
  slicerNames: Record<string, string>;
}

export function watchFor(printer: HAPrinter): PrinterWatch | null {
  if (printer.brand !== 'bambu_lab' && printer.brand !== 'creality') return null;
  const trays: TrayWatch[] = [];
  const slicerNames: Record<string, string> = {};
  const name = (slicer: string, key: string) => {
    slicerNames[slicer] = slicer in slicerNames && slicerNames[slicer] !== key ? '' : key;
  };

  for (const ams of printer.ams_units) {
    for (const tray of ams.trays) {
      const key = tray.unique_id || tray.entity_id;
      trays.push({ key, entityId: tray.entity_id, label: `${ams.name} ${printer.brand === 'creality' ? 'Slot' : 'Tray'} ${tray.tray_number}`, external: false });
      name(ams.ams_number >= 128 ? `AMS HT ${ams.ams_number - 127}` : `AMS ${ams.ams_number} Tray ${tray.tray_number}`, key);
    }
  }
  for (const ext of printer.external_spools) {
    const key = ext.unique_id || ext.entity_id;
    const synthetic = !ext.entity_id.includes('.');
    trays.push({ key, entityId: synthetic ? null : ext.entity_id, label: ext.slot_name || 'External', external: true });
    // On a dual-nozzle printer ha-bambulab's ExternalSpool entity is the left
    // nozzle's spool (its index 1) and ExternalSpool2 the right's (index 0),
    // while print_weight names them by index: "External Spool" is index 0.
    const second = /_ExternalSpool2_/i.test(key);
    name(printer.external_spools.length > 1 && !second ? 'External Spool 2' : 'External Spool', key);
  }

  return {
    prefix: printer.prefix,
    name: printer.name,
    brand: printer.brand,
    deviceId: printer.device_id,
    status: printer.entity_id,
    progress: printer.print_progress_entity,
    weight: printer.print_weight_entity,
    jobName: printer.job_name_entity,
    gcodeFile: printer.gcode_file_entity,
    skipped: printer.skipped_objects_entity,
    stage: printer.current_stage_entity,
    usedLength: printer.used_material_entity,
    trays,
    slicerNames,
  };
}

/** Every entity the tracker needs to see for these printers. */
export function watchedEntities(watches: PrinterWatch[]): string[] {
  return [...new Set(watches.flatMap(w => [
    w.status, w.progress, w.weight, w.jobName, w.gcodeFile, w.skipped, w.stage, w.usedLength,
    ...w.trays.map(t => t.entityId),
  ].filter((id): id is string => !!id)))];
}
