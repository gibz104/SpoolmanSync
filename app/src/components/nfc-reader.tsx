'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Nfc, Loader2, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SpoolPickList } from '@/components/spool-pick-list';
import type { Spool } from '@/lib/api/spoolman';
import { normalizeTagUid, parseScanLink, scanTargetPath } from '@/lib/scan-codes';
import { lookUpScanCode } from '@/lib/scan-client';
import { nfcErrorMessage } from '@/lib/web-nfc';

type ReadState =
  | { step: 'idle' }
  | { step: 'reading' }
  | { step: 'looking-up' }
  | { step: 'unlinked'; uid: string }
  | { step: 'linking'; uid: string }
  | { step: 'error'; message: string };

/** The text of a tag's URL and text records, where a link would be. */
function recordTexts(event: NDEFReadingEvent): string[] {
  const texts: string[] = [];
  for (const record of event.message?.records ?? []) {
    if (!record.data || !['url', 'absolute-url', 'text'].includes(record.recordType)) continue;
    try {
      texts.push(new TextDecoder(record.encoding || 'utf-8').decode(record.data));
    } catch {
      // An encoding the browser can't decode holds no link we know.
    }
  }
  return texts;
}

/**
 * Read an NFC tag with this phone and open what it points at (#89): a spool or
 * slot link written on the tag, or else the spool Spoolman has the tag's UID
 * linked to. A tag Spoolman doesn't know can be linked to a spool here. Only
 * rendered where Web NFC works (see web-nfc.ts).
 */
export function NFCReader({ spools }: { spools: Spool[] }) {
  const router = useRouter();
  const [state, setState] = useState<ReadState>({ step: 'idle' });
  const scan = useRef<AbortController | null>(null);
  // A tag can be reported more than once before the scan stops.
  const handled = useRef(false);

  useEffect(() => () => scan.current?.abort(), []);

  const handleTag = async (event: NDEFReadingEvent) => {
    if (handled.current) return;
    handled.current = true;
    scan.current?.abort(); // one tag at a time
    const uid = normalizeTagUid(event.serialNumber ?? '');
    for (const text of recordTexts(event)) {
      const target = parseScanLink(text);
      if (!target) continue;
      // A sticker written before tags were linked in Spoolman says which spool
      // it is on, so Spoolman learns its UID now, without rewriting it. Never
      // taken from a spool Spoolman already has it linked to.
      if (target.kind === 'spool' && uid) void linkReadTag(target.id, uid);
      return router.push(scanTargetPath(target));
    }
    if (!uid) {
      setState({ step: 'error', message: 'This tag holds no spool link and reports no ID to look up.' });
      return;
    }
    setState({ step: 'looking-up' });
    try {
      const target = await lookUpScanCode(uid);
      if (target) router.push(scanTargetPath(target));
      else setState({ step: 'unlinked', uid });
    } catch {
      setState({ step: 'error', message: 'Could not look the tag up in Spoolman.' });
    }
  };

  const linkReadTag = async (spoolId: number, uid: string) => {
    try {
      const res = await fetch('/api/spools/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId, uid, move: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.linked) toast.success(`Spoolman now knows this tag as spool #${spoolId}`);
    } catch {
      // Best effort: the tag opened its spool either way.
    }
  };

  const handleRead = async () => {
    if (!window.NDEFReader) return;
    scan.current?.abort();
    const controller = new AbortController();
    scan.current = controller;
    handled.current = false;
    setState({ step: 'reading' });
    try {
      const reader = new window.NDEFReader();
      reader.onreading = event => void handleTag(event);
      reader.onreadingerror = () => {
        // A tag that left too soon: the scan is still running, so the next tap retries.
      };
      await reader.scan({ signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState({ step: 'error', message: nfcErrorMessage(err, 'Could not start reading NFC tags.') });
    }
  };

  const handleCancel = () => {
    scan.current?.abort();
    setState({ step: 'idle' });
  };

  const handleLink = async (spool: Spool, uid: string) => {
    setState({ step: 'linking', uid });
    try {
      const res = await fetch('/api/spools/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId: spool.id, uid }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.supported === false) {
        setState({ step: 'error', message: 'Linking tags to spools needs Spoolman 0.27 or later.' });
        return;
      }
      if (!res.ok) {
        setState({ step: 'error', message: data.error || 'Could not link the tag in Spoolman.' });
        return;
      }
      toast.success(`Tag linked to spool #${spool.id}`);
      router.push(`/scan/spool/${spool.id}`);
    } catch {
      setState({ step: 'error', message: 'Could not link the tag in Spoolman.' });
    }
  };

  return (
    <div className="space-y-4">
      {(state.step === 'idle' || state.step === 'error') && (
        <Button onClick={handleRead} className="w-full">
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
          <Button variant="outline" onClick={handleCancel}>Cancel</Button>
        </div>
      )}

      {state.step === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {(state.step === 'unlinked' || state.step === 'linking') && (
        <div className="space-y-3">
          <Alert>
            <Link2 className="h-4 w-4" />
            <AlertTitle>This tag isn&apos;t linked to a spool</AlertTitle>
            <AlertDescription>
              Pick the spool it belongs to, and Spoolman will know the tag from now on.
              <span className="block font-mono text-xs text-muted-foreground mt-1">{state.uid}</span>
            </AlertDescription>
          </Alert>
          <SpoolPickList spools={spools} onPick={spool => handleLink(spool, state.uid)} disabled={state.step === 'linking'} />
          <Button variant="outline" onClick={handleCancel} className="w-full" disabled={state.step === 'linking'}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
