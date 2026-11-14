'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Nav } from '@/components/nav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { isKioskMode } from '@/lib/kiosk';
import { forgetScans, recentSpool, rememberSlot } from '@/lib/scan-memory';
import { slotLabel, slotOptions, type SlotOption } from '@/lib/slot-options';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function SpoolRow({ spool }: { spool: Spool }) {
  return (
    <div className="flex items-center gap-3">
      <SpoolColorSwatch filament={spool.filament} size="h-8 w-8" />
      <div className="min-w-0">
        <p className="font-medium truncate">
          {spool.filament.vendor?.name ? `${spool.filament.vendor.name} ` : ''}{spool.filament.name || spool.filament.material}
        </p>
        <p className="text-sm text-muted-foreground">{spool.filament.material} • #{spool.id}</p>
      </div>
    </div>
  );
}

/**
 * The page a slot's tag or QR code opens (#97): the AMS tray, external spool or
 * storage slot, what it holds, and a spool to put in it. Scanning a spool and
 * then its slot (or the other way round) assigns it in one tap.
 */
export default function SlotPage({ params }: { params: Promise<{ key: string }> }) {
  // Next.js hands the segment over still percent-encoded (a storage box's name can hold anything).
  const { key: segment } = use(params);
  const key = decodeSegment(segment);
  const router = useRouter();
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [spools, setSpools] = useState<Spool[]>([]);
  const [scanned, setScanned] = useState<Spool | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const [printersRes, spoolsRes] = await Promise.all([
          fetch('/api/printers', { signal: controller.signal }),
          fetch('/api/spools', { signal: controller.signal }),
        ]);
        if (!printersRes.ok || !spoolsRes.ok) {
          setError('Could not load printers and spools. Check the connections in Settings.');
          return;
        }
        const found = slotOptions((await printersRes.json()).printers ?? []).find(s => s.key === key);
        const allSpools: Spool[] = (await spoolsRes.json()).spools ?? [];
        if (!found) {
          setError('This slot no longer exists: it was removed, or its storage box renamed. Write its tag again from the Scan page.');
          return;
        }
        setSlot(found);
        setSpools(allSpools);
        rememberSlot(key);
        const recent = recentSpool();
        const candidate = recent !== null ? allSpools.find(s => s.id === recent) : undefined;
        if (candidate && candidate.id !== found.spool?.id) setScanned(candidate);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [key]);

  const assign = async (spool: Spool) => {
    if (!slot) return;
    setAssigning(true);
    try {
      const res = await fetch('/api/spools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId: spool.id, trayId: slot.key }),
      });
      if (!res.ok) throw new Error('Failed to assign spool');
      forgetScans();
      toast.success(`Spool #${spool.id} is now in ${slot.printer} ${slotLabel(slot)}`);
      router.push(isKioskMode() ? '/kiosk' : '/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign');
      setAssigning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <div className="flex items-center gap-2 mb-6">
          <Link href="/scan">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </Link>
          <h1 className="text-xl sm:text-2xl font-bold">Slot</h1>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )}

        {!loading && error && (
          <Card className="border-destructive">
            <CardContent className="pt-6">
              <p className="text-destructive mb-4">{error}</p>
              <Link href="/scan">
                <Button variant="outline">Go to Scan Page</Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {!loading && !error && slot && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{slot.printer}</CardTitle>
                <CardDescription>{slotLabel(slot)}</CardDescription>
              </CardHeader>
              <CardContent>
                {slot.spool ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Holds</p>
                    <SpoolRow spool={slot.spool} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No spool assigned</p>
                )}
              </CardContent>
            </Card>

            {scanned && !picking ? (
              <Card className="border-primary">
                <CardHeader>
                  <CardTitle>Put the spool you just scanned here?</CardTitle>
                  {slot.spool && (
                    <CardDescription>Spool #{slot.spool.id} will be unassigned from this slot.</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <SpoolRow spool={scanned} />
                  <div className="flex gap-2">
                    <Button className="flex-1" onClick={() => assign(scanned)} disabled={assigning}>
                      {assigning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Put it here
                    </Button>
                    <Button variant="outline" onClick={() => setPicking(true)} disabled={assigning}>
                      Pick another
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Pick a spool for this slot</CardTitle>
                  <CardDescription>
                    Or scan a spool&apos;s tag or QR code next, and it will offer this slot.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Command className="rounded-lg border">
                    <CommandInput placeholder="Search spools by name, vendor, material, or ID..." />
                    <CommandList className="max-h-[300px]">
                      <CommandEmpty>No spools found.</CommandEmpty>
                      <CommandGroup heading={`${spools.length} spools`}>
                        {spools.map(spool => (
                          <CommandItem
                            key={spool.id}
                            value={buildSpoolSearchValue(spool)}
                            onSelect={() => assign(spool)}
                            disabled={assigning || spool.id === slot.spool?.id}
                            className="py-2 cursor-pointer"
                          >
                            <SpoolRow spool={spool} />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
