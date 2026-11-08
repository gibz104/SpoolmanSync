'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A setting's label with its explanation in a tooltip, shown when the label or
 * the info icon is hovered or the icon is focused. A tap on the icon opens it
 * too, since touch screens have no hover; a tap on the label still toggles the
 * control it labels.
 */
export function LabelWithHint({ htmlFor, hint, children }: {
  htmlFor: string;
  hint: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={300}>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5">
          <Label htmlFor={htmlFor} className="cursor-pointer">
            {children}
          </Label>
          <button
            type="button"
            aria-label="More about this setting"
            className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            // Radix treats a click on the trigger as a dismissal; here it opens.
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
