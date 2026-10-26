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
}

export interface PrinterWatch {
  prefix: string;
  name: string;
  brand: Brand;
  /** print_status: Bambu's gcode_state, or Creality's derived status with the job's counter as attributes. */
  status: string;
  progress?: string;
  /** Bambu: the slicer's plate weight, with per-tray grams as attributes. */
  weight?: string;
  /** Bambu: subtask_name and gcode_file, which together name the job. */
  jobName?: string;
  gcodeFile?: string;
  /** Creality: used_material_length (cm), for integration versions whose status lacks the counter. */
  usedLength?: string;
  trays: TrayWatch[];
  /** ha-bambulab's names for trays in print_weight's attributes ("AMS 1 Tray 2"), to tray keys. */
  slicerNames: Record<string, string>;
}

export function watchFor(printer: HAPrinter): PrinterWatch | null {
  if (printer.brand !== 'bambu_lab' && printer.brand !== 'creality') return null;
  const trays: TrayWatch[] = [];
  const slicerNames: Record<string, string> = {};

  for (const ams of printer.ams_units) {
    for (const tray of ams.trays) {
      const key = tray.unique_id || tray.entity_id;
      trays.push({ key, entityId: tray.entity_id, label: `${ams.name} ${printer.brand === 'creality' ? 'Slot' : 'Tray'} ${tray.tray_number}` });
      slicerNames[ams.ams_number >= 128 ? `AMS HT ${ams.ams_number - 127}` : `AMS ${ams.ams_number} Tray ${tray.tray_number}`] = key;
    }
  }
  for (const ext of printer.external_spools) {
    const key = ext.unique_id || ext.entity_id;
    const synthetic = !ext.entity_id.includes('.');
    trays.push({ key, entityId: synthetic ? null : ext.entity_id, label: ext.slot_name || 'External' });
    const index = Number((key.match(/_ExternalSpool(\d+)/i) ?? [])[1] ?? 1);
    slicerNames[index > 1 ? `External Spool ${index}` : 'External Spool'] = key;
  }

  return {
    prefix: printer.prefix,
    name: printer.name,
    brand: printer.brand,
    status: printer.entity_id,
    progress: printer.print_progress_entity,
    weight: printer.print_weight_entity,
    jobName: printer.job_name_entity,
    gcodeFile: printer.gcode_file_entity,
    usedLength: printer.used_material_entity,
    trays,
    slicerNames,
  };
}

/** Every entity the tracker needs to see for these printers. */
export function watchedEntities(watches: PrinterWatch[]): string[] {
  return [...new Set(watches.flatMap(w => [
    w.status, w.progress, w.weight, w.jobName, w.gcodeFile, w.usedLength,
    ...w.trays.map(t => t.entityId),
  ].filter((id): id is string => !!id)))];
}
