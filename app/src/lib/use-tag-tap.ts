'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { linkTag, lookUpScanCode } from '@/lib/scan-client';
import { parseScanLink, type ScanTarget } from '@/lib/scan-codes';
import { nfcErrorMessage, readNfcTag } from '@/lib/web-nfc';

export type TagTapState =
  | { step: 'idle' }
  /** `hint`: why the last tag held to the phone did nothing. */
  | { step: 'reading'; hint?: string }
  | { step: 'looking-up' }
  /** A tag with no link on it that Spoolman doesn't know, so it can be linked to a spool. */
  | { step: 'unlinked'; uid: string }
  | { step: 'error'; message: string };

/**
 * Read one NFC tag with this phone and find what it points at (#89): a spool or
 * slot link written on it, or else the spool Spoolman has the tag's UID linked
 * to. That goes to `onTarget`, which can return a message to show instead when
 * the tag is no use where it was read. Only for a page with no NFC blocker
 * (see useNfcBlocker). Reading stops on cancel() and when the page unmounts.
 */
export function useTagTap(onTarget: (target: ScanTarget) => string | void) {
  const [state, setState] = useState<TagTapState>({ step: 'idle' });
  const scan = useRef<AbortController | null>(null);

  useEffect(() => () => scan.current?.abort(), []);

  const found = (target: ScanTarget) => {
    const message = onTarget(target);
    setState(message ? { step: 'error', message } : { step: 'idle' });
  };

  const start = async () => {
    scan.current?.abort();
    const controller = new AbortController();
    scan.current = controller;
    setState({ step: 'reading' });
    let tag;
    try {
      tag = await readNfcTag(controller.signal, () => setState({
        step: 'reading',
        hint: 'That tag could not be read. Hold it still against the phone, or try another tag.',
      }));
    } catch (err) {
      if (!controller.signal.aborted) {
        setState({ step: 'error', message: nfcErrorMessage(err, 'Could not start reading NFC tags.') });
      }
      return;
    }

    for (const text of tag.texts) {
      const target = parseScanLink(text);
      if (!target) continue;
      // A sticker written before tags were linked in Spoolman says which spool
      // it is on, so Spoolman learns its UID now, without rewriting it. Never
      // taken from a spool Spoolman already has it linked to.
      if (target.kind === 'spool' && tag.uid) void linkReadTag(target.id, tag.uid);
      return found(target);
    }
    if (!tag.uid) {
      setState({ step: 'error', message: 'This tag holds no spool link and reports no ID to look up.' });
      return;
    }

    setState({ step: 'looking-up' });
    try {
      const target = await lookUpScanCode(tag.uid);
      if (controller.signal.aborted) return;
      if (target) found(target);
      else setState({ step: 'unlinked', uid: tag.uid });
    } catch {
      if (!controller.signal.aborted) setState({ step: 'error', message: 'Could not look the tag up in Spoolman.' });
    }
  };

  const cancel = () => {
    scan.current?.abort();
    setState({ step: 'idle' });
  };

  const fail = (message: string) => setState({ step: 'error', message });

  return { state, start, cancel, fail };
}

async function linkReadTag(spoolId: number, uid: string) {
  const result = await linkTag(spoolId, uid, { move: false });
  if (result.linked) toast.success(`Spoolman now knows this tag as spool #${spoolId}`);
}
