'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { Copy, Loader2, Nfc, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildExternalUrl } from '@/lib/ingress-path';
import { copyText } from '@/lib/clipboard';
import { slotPath } from '@/lib/scan-codes';
import { slotOptions, slotLabel, type SlotOption } from '@/lib/slot-options';
import { nfcErrorMessage, writeNfcLink } from '@/lib/web-nfc';
import { useNfcBlocker } from '@/lib/use-nfc-blocker';

/**
 * Links for every tray and storage slot, to put on a tag or QR label at the
 * slot (#97). Scanning a spool and then its slot (or the slot first) assigns
 * the spool there.
 */
export function SlotTags({ directAccessPort, qrBaseUrl }: { directAccessPort?: number; qrBaseUrl?: string }) {
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const canWrite = useNfcBlocker() === null;
  const [shownQr, setShownQr] = useState<string | null>(null);
  const [writing, setWriting] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/printers')
      .then(res => (res.ok ? res.json() : { printers: [] }))
      .then(data => setSlots(slotOptions(data.printers ?? [])))
      .catch(() => setSlots([]));
  }, []);

  const linkFor = (slot: SlotOption) => buildExternalUrl(slotPath(slot.key), directAccessPort, qrBaseUrl);

  const handleCopy = async (slot: SlotOption) => {
    if (await copyText(linkFor(slot))) toast.success('Link copied');
    else toast.error('Could not copy the link; select it and copy it instead');
  };

  const handleWrite = async (slot: SlotOption) => {
    setWriting(slot.key);
    try {
      await writeNfcLink(linkFor(slot));
      toast.success(`Tag written for ${slot.printer} ${slotLabel(slot)}`);
    } catch (err) {
      toast.error(nfcErrorMessage(err, 'Failed to write to the NFC tag.'));
    } finally {
      setWriting(null);
    }
  };

  if (slots === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (slots.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">No printers or storage slots found.</p>;
  }

  const printers = [...new Set(slots.map(s => s.printer))];
  return (
    <div className="space-y-4">
      {printers.map(printer => (
        <div key={printer} className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">{printer}</h4>
          <div className="divide-y rounded-lg border">
            {slots.filter(s => s.printer === printer).map(slot => (
              <div key={slot.key} className="p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 min-w-[8rem] text-sm font-medium">{slotLabel(slot)}</span>
                  <Button variant="outline" size="sm" onClick={() => handleCopy(slot)}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy link
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={shownQr === slot.key}
                    onClick={() => setShownQr(shownQr === slot.key ? null : slot.key)}
                  >
                    <QrCode className="h-4 w-4 mr-1" />
                    QR
                  </Button>
                  {canWrite && (
                    <Button variant="outline" size="sm" onClick={() => handleWrite(slot)} disabled={writing !== null}>
                      {writing === slot.key ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Nfc className="h-4 w-4 mr-1" />}
                      {writing === slot.key ? 'Hold tag near phone...' : 'Write tag'}
                    </Button>
                  )}
                </div>
                {shownQr === slot.key && (
                  <div className="flex flex-col items-center gap-2">
                    <div className="rounded bg-white p-3">
                      <QRCodeSVG value={linkFor(slot)} size={160} level="M" />
                    </div>
                    <p className="text-xs text-center">{slot.printer} {slotLabel(slot)}</p>
                  </div>
                )}
                <p className="text-xs font-mono text-muted-foreground/70 break-all select-all">{linkFor(slot)}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
