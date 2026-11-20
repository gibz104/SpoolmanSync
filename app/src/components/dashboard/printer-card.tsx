'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TraySlot } from './tray-slot';
import type { HATray } from '@/lib/api/homeassistant';
import type { Spool } from '@/lib/api/spoolman';

interface MismatchInfo {
  type: 'material' | 'color' | 'both';
  printerReports: {
    material?: string;
    color?: string;
  };
  spoolmanHas: {
    material: string;
    color: string;
  };
  message: string;
}

interface TrayWithSpool extends HATray {
  assigned_spool?: Spool;
  mismatch?: MismatchInfo;
}

interface AMSWithSpools {
  entity_id: string;
  name: string;
  trays: TrayWithSpool[];
}

interface PrinterWithSpools {
  entity_id: string;
  name: string;
  state: string;
  ams_units: AMSWithSpools[];
  external_spools: TrayWithSpool[];
}

interface PrinterCardProps {
  printer: PrinterWithSpools;
  spools: Spool[];
  onSpoolAssign: (trayId: string, spoolId: number) => void;
  onSpoolUnassign: (spoolId: number) => void;
  showSpoolLocation?: boolean;
  /** Buttons to move the printer up or down the dashboard; a missing handler disables its button. */
  reorder?: { onMoveUp?: () => void; onMoveDown?: () => void };
}

export function PrinterCard({ printer, spools, onSpoolAssign, onSpoolUnassign, showSpoolLocation, reorder }: PrinterCardProps) {
  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 self-center">
          <span className="h-3 w-3 rounded-full bg-green-500" />
          {printer.name}
        </CardTitle>
        {reorder && (
          <CardAction className="row-span-1 -my-2 flex gap-1 self-center">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={reorder.onMoveUp}
              disabled={!reorder.onMoveUp}
              aria-label={`Move ${printer.name} up`}
              title="Move up"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={reorder.onMoveDown}
              disabled={!reorder.onMoveDown}
              aria-label={`Move ${printer.name} down`}
              title="Move down"
            >
              <ChevronDown />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {printer.ams_units.map((ams) => (
          <div key={ams.entity_id} className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">
              {ams.name}
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {ams.trays.map((tray) => (
                <TraySlot
                  key={tray.entity_id}
                  tray={tray}
                  assignedSpool={tray.assigned_spool}
                  spools={spools}
                  onAssign={(spoolId) => onSpoolAssign(tray.unique_id || tray.entity_id, spoolId)}
                  onUnassign={onSpoolUnassign}
                  mismatch={tray.mismatch}
                  showLocation={showSpoolLocation}
                />
              ))}
            </div>
          </div>
        ))}

        {/* External spool slots - only show if discovered in HA */}
        {printer.external_spools.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">
              {printer.external_spools.length > 1 ? 'External Spools' : 'External Spool'}
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {printer.external_spools.map((extSpool) => (
                <TraySlot
                  key={extSpool.entity_id}
                  tray={extSpool}
                  assignedSpool={extSpool.assigned_spool}
                  spools={spools}
                  onAssign={(spoolId) => {
                    onSpoolAssign(extSpool.unique_id || extSpool.entity_id, spoolId);
                  }}
                  onUnassign={onSpoolUnassign}
                  showLocation={showSpoolLocation}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
