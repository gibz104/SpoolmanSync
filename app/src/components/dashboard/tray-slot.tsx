'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { SpoolFilterBar } from '@/components/dashboard/spool-filter-bar';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import type { HATray } from '@/lib/api/homeassistant';
import type { Spool } from '@/lib/api/spoolman';
import { buildSpoolSearchValue, parseExtraValue } from '@/lib/api/spoolman';

type SortBy = 'id' | 'name' | 'material' | 'vendor';

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

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

interface TraySlotProps {
  tray: HATray;
  assignedSpool?: Spool;
  spools: Spool[];
  onAssign: (spoolId: number) => void;
  onUnassign?: (spoolId: number) => void;
  mismatch?: MismatchInfo;
}

/**
 * Get the value of a filter field from a spool
 */
function getSpoolFieldValue(spool: Spool, fieldKey: string): string | null {
  switch (fieldKey) {
    case 'material':
      return spool.filament.material || null;
    case 'vendor':
      return spool.filament.vendor?.name || null;
    case 'location':
      return spool.location || null;
    case 'lot_nr':
      return spool.lot_nr || null;
    default:
      // Extra field (key starts with extra_)
      if (fieldKey.startsWith('extra_')) {
        const extraKey = fieldKey.replace('extra_', '');
        return parseExtraValue(spool.extra?.[extraKey]) || null;
      }
      return null;
  }
}

function sortSpools(spools: Spool[], sortBy: SortBy): Spool[] {
  return [...spools].sort((a, b) => {
    switch (sortBy) {
      case 'id':
        return a.id - b.id;
      case 'name':
        return (a.filament.name || a.filament.material).localeCompare(b.filament.name || b.filament.material);
      case 'material':
        return (a.filament.material || '').localeCompare(b.filament.material || '');
      case 'vendor':
        return (a.filament.vendor?.name || '').localeCompare(b.filament.vendor?.name || '');
    }
  });
}

export function TraySlot({ tray, assignedSpool, spools, onAssign, onUnassign, mismatch }: TraySlotProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string | null>>({});
  const [enabledFields, setEnabledFields] = useState<FilterField[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>('id');

  // Fetch filter fields when dialog opens
  useEffect(() => {
    if (open) {
      fetch('/api/spools/extra-fields')
        .then((res) => res.json())
        .then((data) => {
          if (data.fields && data.filterConfig) {
            // Only show fields that are enabled in filter config
            const enabled = data.fields.filter(
              (f: FilterField) => data.filterConfig.includes(f.key)
            );
            setEnabledFields(enabled);
          }
        })
        .catch((err) => console.error('Failed to fetch filter fields:', err));
    }
  }, [open]);

  // Reset filters when dialog closes
  useEffect(() => {
    if (!open) {
      setFilters({});
    }
  }, [open]);

  // Handle filter changes
  const handleFilterChange = useCallback((key: string, value: string | null) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  // Clear all filters
  const handleClearAll = useCallback(() => {
    setFilters({});
  }, []);

  // Filter and sort spools
  const filteredSpools = useMemo(() => {
    const filtered = spools.filter((spool) => {
      for (const [key, value] of Object.entries(filters)) {
        if (value) {
          const spoolValue = getSpoolFieldValue(spool, key);
          if (spoolValue !== value) {
            return false;
          }
        }
      }
      return true;
    });
    return sortSpools(filtered, sortBy);
  }, [spools, filters, sortBy]);

  // Only show weight from Spoolman when a spool is assigned
  const displayWeight = assignedSpool?.remaining_weight;
  // Only show weight if spool is assigned and weight is a valid positive number
  const showWeight = assignedSpool && typeof displayWeight === 'number' && displayWeight >= 0;

  const handleUnassign = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening the dialog
    if (assignedSpool && onUnassign) {
      onUnassign(assignedSpool.id);
    }
  };

  const trayLabel = tray.is_external ? 'External' : `Tray ${tray.tray_number}`;

  // Check if any enabled filters have values to show
  const hasFilterOptions = enabledFields.some(f => f.values.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="relative flex w-full flex-col rounded-lg border-2 border-border p-3 transition-colors hover:border-primary hover:bg-accent text-left min-h-[120px] md:min-h-[140px]"
        >
          {/* Header row with tray label and unassign button */}
          <div className="flex items-center justify-between w-full mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              {trayLabel}
            </span>
            {assignedSpool && onUnassign && (
              <span
                onClick={handleUnassign}
                className="h-5 w-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer text-xs"
                title="Unassign spool"
              >
                ✕
              </span>
            )}
          </div>

          {/* Mismatch warning banner */}
          {mismatch && assignedSpool && (
            <div
              className="flex items-center gap-1.5 px-2 py-1 mb-2 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700"
              title={`RFID: ${mismatch.printerReports.color} (${mismatch.printerReports.material}) | Assigned: ${mismatch.spoolmanHas.color} (${mismatch.spoolmanHas.material})`}
            >
              <span className="text-amber-600 dark:text-amber-400 text-xs">⚠️</span>
              <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 truncate">
                Possible wrong spool
              </span>
            </div>
          )}

          {assignedSpool ? (
            <>
              {/* Main content: color circle + filament name */}
              <div className="flex items-center gap-2 mb-2">
                <SpoolColorSwatch filament={assignedSpool.filament} />
                <p className="text-sm font-semibold leading-tight line-clamp-2 [hyphens:none]" title={assignedSpool.filament.name || assignedSpool.filament.material}>
                  {assignedSpool.filament.name || assignedSpool.filament.material}
                </p>
              </div>

              {/* Info: material and vendor stacked */}
              <div className="space-y-1 mb-2 flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] font-medium text-muted-foreground uppercase">Material:</span>
                  <span className="text-xs font-medium">{assignedSpool.filament.material}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] font-medium text-muted-foreground uppercase">Vendor:</span>
                  <span className="text-xs font-medium truncate">{assignedSpool.filament.vendor?.name || 'Unknown'}</span>
                </div>
              </div>

              {/* Footer: spool ID and weight */}
              <div className="flex items-center justify-between mt-auto pt-1">
                <span className="text-[10px] text-muted-foreground">
                  #{assignedSpool.id}
                </span>
                {showWeight && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 whitespace-nowrap">
                    {Math.round(displayWeight)}g<span className="hidden min-[320px]:inline"> Remaining</span>
                  </Badge>
                )}
              </div>
            </>
          ) : (
            /* Empty tray state */
            <div className="flex flex-col items-center justify-center flex-1 py-2">
              <div
                className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/30 mb-2"
              />
              <p className="text-xs text-muted-foreground">
                No spool assigned
              </p>
              <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-1">
                Click to assign
              </p>
            </div>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Assign Spool to {tray.is_external ? 'External Slot' : `Tray ${tray.tray_number}`}
          </DialogTitle>
          <DialogDescription>
            Search and select a spool from your Spoolman inventory.
          </DialogDescription>
        </DialogHeader>

        {/* Mismatch warning in dialog */}
        {mismatch && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="text-amber-500 mt-0.5">⚠️</span>
              <div className="space-y-1.5">
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  Possible wrong spool assigned
                </p>
                <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                  <p>
                    <span className="opacity-70">RFID reports:</span>{' '}
                    {mismatch.printerReports.material || 'unknown material'}
                    {mismatch.printerReports.color && (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <span
                          className="inline-block w-3 h-3 rounded-full border border-amber-400"
                          style={{ backgroundColor: mismatch.printerReports.color }}
                        />
                        <span className="opacity-70">{mismatch.printerReports.color}</span>
                      </span>
                    )}
                  </p>
                  <p>
                    <span className="opacity-70">Assigned spool:</span>{' '}
                    {mismatch.spoolmanHas.material}
                    <span className="inline-flex items-center gap-1 ml-1">
                      <span
                        className="inline-block w-3 h-3 rounded-full border border-amber-400"
                        style={{ backgroundColor: mismatch.spoolmanHas.color }}
                      />
                      <span className="opacity-70">{mismatch.spoolmanHas.color}</span>
                    </span>
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select the correct spool below.
                </p>
              </div>
            </div>
          </div>
        )}

        <Command className="rounded-lg border shadow-md">
          {/* Filter bar with sort */}
          {hasFilterOptions ? (
            <SpoolFilterBar
              filters={filters}
              onFilterChange={handleFilterChange}
              onClearAll={handleClearAll}
              fields={enabledFields}
              extra={
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="id">Sort: ID</SelectItem>
                    <SelectItem value="name">Sort: Name</SelectItem>
                    <SelectItem value="material">Sort: Material</SelectItem>
                    <SelectItem value="vendor">Sort: Vendor</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          ) : (
            <div className="flex items-center justify-end border-b p-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="id">Sort: ID</SelectItem>
                  <SelectItem value="name">Sort: Name</SelectItem>
                  <SelectItem value="material">Sort: Material</SelectItem>
                  <SelectItem value="vendor">Sort: Vendor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <CommandInput placeholder="Search spools by name, vendor, material, ID, or any field..." />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>No spools found matching your filters.</CommandEmpty>
            <CommandGroup heading={`Available Spools (${filteredSpools.length})`}>
              {filteredSpools.map((spool) => (
                <CommandItem
                  key={spool.id}
                  value={buildSpoolSearchValue(spool)}
                  onSelect={() => {
                    onAssign(spool.id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 py-2"
                >
                  <SpoolColorSwatch filament={spool.filament} size="h-6 w-6" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {spool.filament.name || spool.filament.material}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {spool.filament.vendor?.name ? `${spool.filament.vendor.name} • ` : ''}{spool.filament.material} • {Math.round(spool.remaining_weight)}g
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    #{spool.id}
                  </span>
                  {assignedSpool?.id === spool.id && (
                    <Badge variant="outline" className="ml-1">Current</Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
