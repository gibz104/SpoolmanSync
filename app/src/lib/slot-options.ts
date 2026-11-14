import type { Spool } from '@/lib/api/spoolman';

/** The parts of /api/printers' answer a slot list needs. */
export interface SlotPrinter {
  name: string;
  is_virtual?: boolean;
  ams_units?: { name: string; trays?: SlotTray[] }[];
  external_spools?: (SlotTray & { slot_name?: string })[];
}

interface SlotTray {
  entity_id: string;
  unique_id?: string;
  tray_number: number;
  assigned_spool?: Spool;
}

/** A place a spool can be assigned: an AMS or CFS tray, an external spool, or a storage slot. */
export interface SlotOption {
  /** The assignment key spools carry in `extra.active_tray`. */
  key: string;
  printer: string;
  /** The AMS unit, CFS box or storage box the tray is in. */
  group?: string;
  label: string;
  spool?: Spool;
}

/** Every slot of these printers, labelled the way the assign page lists them. */
export function slotOptions(printers: SlotPrinter[]): SlotOption[] {
  const slots: SlotOption[] = [];
  for (const printer of printers) {
    for (const ams of printer.ams_units ?? []) {
      for (const tray of ams.trays ?? []) {
        slots.push({
          key: tray.unique_id || tray.entity_id,
          printer: printer.name,
          // A storage box's one unit is the box itself, already named as the printer.
          group: printer.is_virtual ? undefined : ams.name,
          label: `Tray ${tray.tray_number}`,
          spool: tray.assigned_spool,
        });
      }
    }
    const externals = printer.external_spools ?? [];
    externals.forEach((ext, i) => {
      slots.push({
        key: ext.unique_id || ext.entity_id,
        printer: printer.name,
        label: ext.slot_name?.trim() || (externals.length > 1 ? `External Spool ${i + 1}` : 'External Spool'),
        spool: ext.assigned_spool,
      });
    });
  }
  return slots;
}

/** "AMS 1 - Tray 2", or just the label for a slot outside any unit. */
export function slotLabel(slot: Pick<SlotOption, 'group' | 'label'>): string {
  return slot.group ? `${slot.group} - ${slot.label}` : slot.label;
}
