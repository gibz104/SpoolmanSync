'use client';

import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import type { Spool } from '@/lib/api/spoolman';
import { buildSpoolSearchValue } from '@/lib/api/spoolman';

/** A searchable list to pick a spool from. */
export function SpoolPickList({ spools, onPick, disabled = false, excludeId }: {
  spools: Spool[];
  onPick: (spool: Spool) => void;
  disabled?: boolean;
  /** A spool that can't be picked: the one already in place, say. */
  excludeId?: number;
}) {
  return (
    <Command className="rounded-lg border">
      <CommandInput placeholder="Search spools by name, vendor, material, or ID..." />
      <CommandList className="max-h-[300px]">
        <CommandEmpty>No spools found.</CommandEmpty>
        <CommandGroup heading={`${spools.length} spools`}>
          {spools.map(spool => (
            <CommandItem
              key={spool.id}
              value={buildSpoolSearchValue(spool)}
              onSelect={() => onPick(spool)}
              disabled={disabled || spool.id === excludeId}
              className="flex items-center gap-3 py-2 cursor-pointer"
            >
              <SpoolColorSwatch filament={spool.filament} size="h-5 w-5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{spool.filament.name || spool.filament.material}</p>
                <p className="text-xs text-muted-foreground">
                  {spool.filament.vendor?.name ? `${spool.filament.vendor.name} • ` : ''}#{spool.id}
                </p>
              </div>
              <Badge variant="secondary" className="flex-shrink-0">{spool.filament.material}</Badge>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
