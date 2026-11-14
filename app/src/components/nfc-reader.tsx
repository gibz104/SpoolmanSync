'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Nfc, Loader2, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SpoolPickList } from '@/components/spool-pick-list';
import type { Spool } from '@/lib/api/spoolman';
import { scanTargetPath } from '@/lib/scan-codes';
import { linkTag } from '@/lib/scan-client';
import { useTagTap } from '@/lib/use-tag-tap';

/**
 * Read an NFC tag with this phone and open what it points at (#89): a spool or
 * slot link written on the tag, or else the spool Spoolman has the tag's UID
 * linked to. A tag Spoolman doesn't know can be linked to a spool here. Only
 * rendered where Web NFC works (see web-nfc.ts).
 */
export function NFCReader({ spools }: { spools: Spool[] }) {
  const router = useRouter();
  const tap = useTagTap(target => router.push(scanTargetPath(target)));
  const { state } = tap;
  const [linking, setLinking] = useState(false);

  const handleLink = async (spool: Spool, uid: string) => {
    setLinking(true);
    const result = await linkTag(spool.id, uid);
    if (result.linked) {
      toast.success(`Tag linked to spool #${spool.id}`);
      router.push(`/scan/spool/${spool.id}`);
      return;
    }
    setLinking(false);
    tap.fail(result.supported
      ? result.error || 'Could not link the tag in Spoolman.'
      : 'Linking tags to spools needs Spoolman 0.27 or later.');
  };

  return (
    <div className="space-y-4">
      {(state.step === 'idle' || state.step === 'error') && (
        <Button onClick={tap.start} className="w-full">
          <Nfc className="h-4 w-4 mr-2" />
          Read NFC Tag
        </Button>
      )}

      {(state.step === 'reading' || state.step === 'looking-up') && (
        <div className="flex gap-2">
          <Button disabled className="flex-1">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {state.step === 'reading' ? 'Hold a tag near your phone...' : 'Looking the tag up...'}
          </Button>
          <Button variant="outline" onClick={tap.cancel}>Cancel</Button>
        </div>
      )}

      {state.step === 'reading' && state.hint && (
        <p className="text-sm text-muted-foreground">{state.hint}</p>
      )}

      {state.step === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.step === 'unlinked' && (
        <div className="space-y-3">
          <Alert>
            <Link2 className="h-4 w-4" />
            <AlertTitle>This tag isn&apos;t linked to a spool</AlertTitle>
            <AlertDescription>
              Pick the spool it belongs to, and Spoolman will know the tag from now on.
              <span className="block font-mono text-xs text-muted-foreground mt-1">{state.uid}</span>
            </AlertDescription>
          </Alert>
          <SpoolPickList spools={spools} onPick={spool => handleLink(spool, state.uid)} disabled={linking} />
          <Button variant="outline" onClick={tap.cancel} className="w-full" disabled={linking}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
