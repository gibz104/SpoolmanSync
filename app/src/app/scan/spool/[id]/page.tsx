'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '@/components/nav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import type { Spool } from '@/lib/api/spoolman';
import { isKioskMode, disableKioskMode } from '@/lib/kiosk';
import Link from 'next/link';

interface TrayOption {
  id: string;
  label: string;
  printer: string;
  amsName?: string;
}

export default function SpoolAssignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [spool, setSpool] = useState<Spool | null>(null);
  const [trays, setTrays] = useState<TrayOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [pendingTrayId, setPendingTrayId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kioskMode, setKioskMode] = useState(false);
  const [kioskSuccess, setKioskSuccess] = useState<string | null>(null);

  useEffect(() => {
    setKioskMode(isKioskMode());
  }, []);

  useEffect(() => {
    // Guard against setState-after-unmount and out-of-order responses: if the
    // effect re-runs (id change) or the component unmounts, abort the in-flight
    // fetches and ignore any late resolutions via the `active` flag.
    const controller = new AbortController();
    let active = true;

    fetchData(controller.signal, () => active);

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const fetchData = async (signal?: AbortSignal, isActive: () => boolean = () => true) => {
    setLoading(true);
    setError(null);

    try {
      // Fetch spool and trays in parallel
      const [spoolsRes, printersRes] = await Promise.all([
        fetch('/api/spools', { signal }),
        fetch('/api/printers', { signal }),
      ]);

      // Ignore stale/aborted responses (component unmounted or id changed)
      if (!isActive()) return;

      if (!spoolsRes.ok) {
        if (spoolsRes.status === 400) {
          setError('Spoolman is not configured. Please set up Spoolman in Settings first.');
        } else {
          setError('Failed to fetch spool data');
        }
        setLoading(false);
        return;
      }

      const spoolsData = await spoolsRes.json();
      if (!isActive()) return;

      const foundSpool = spoolsData.spools?.find(
        (s: Spool) => s.id.toString() === id
      );

      if (!foundSpool) {
        setError(`Spool #${id} not found in Spoolman`);
        setLoading(false);
        return;
      }

      setSpool(foundSpool);

      // Build tray options
      if (printersRes.ok) {
        const printersData = await printersRes.json();
        if (!isActive()) return;

        const trayOptions: TrayOption[] = [];

        for (const printer of printersData.printers || []) {
          for (const ams of printer.ams_units || []) {
            for (const tray of ams.trays || []) {
              trayOptions.push({
                id: tray.unique_id || tray.entity_id,
                label: `Tray ${tray.tray_number}`,
                printer: printer.name,
                amsName: ams.name,
              });
            }
          }
          const extSpools = printer.external_spools || [];
          for (let i = 0; i < extSpools.length; i++) {
            trayOptions.push({
              id: extSpools[i].unique_id || extSpools[i].entity_id,
              label:
                extSpools[i].slot_name?.trim() ||
                (extSpools.length > 1 ? `External Spool ${i + 1}` : 'External Spool'),
              printer: printer.name,
            });
          }
        }

        setTrays(trayOptions);
      }
    } catch (err) {
      // A fetch abort surfaces as an AbortError — swallow it, it's expected on
      // unmount / id change and must not flip the UI into an error state.
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (!isActive()) return;
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      if (isActive()) setLoading(false);
    }
  };

  const handleAssign = async (tray: TrayOption) => {
    if (!spool) return;

    setAssigning(true);
    setPendingTrayId(tray.id);
    try {
      const res = await fetch('/api/spools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId: spool.id, trayId: tray.id }),
      });

      if (!res.ok) throw new Error('Failed to assign spool');

      if (kioskMode) {
        const trayLabel = tray.amsName ? `${tray.amsName} — ${tray.label}` : tray.label;
        setKioskSuccess(trayLabel);
        setTimeout(() => router.push('/kiosk'), 1500);
      } else {
        toast.success('Spool assigned successfully!');
        router.push('/');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign');
      setAssigning(false);
      setPendingTrayId(null);
    }
  };

  // Kiosk mode — success screen
  if (kioskMode && kioskSuccess) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-[clamp(1rem,4vw,2rem)]">
        <CheckCircle2 className="h-[clamp(3rem,15vw,5rem)] w-[clamp(3rem,15vw,5rem)] text-green-500 mb-[clamp(0.5rem,2vw,1rem)]" />
        <h1 className="text-[clamp(1.25rem,5vw,2rem)] font-bold text-center text-green-500">
          Assigned!
        </h1>
        <p className="text-[clamp(0.75rem,3vw,1rem)] text-muted-foreground text-center mt-[clamp(0.25rem,1vw,0.5rem)]">
          {spool?.filament.name || spool?.filament.material} &rarr; {kioskSuccess}
        </p>
      </div>
    );
  }

  // Kiosk mode — touch-optimized layout
  if (kioskMode) {
    return (
      <div className="min-h-screen bg-background flex flex-col p-[clamp(0.75rem,3vw,1.5rem)]">
        {/* Loading */}
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
            <p className="text-[clamp(0.875rem,3.5vw,1.125rem)] text-destructive">{error}</p>
            <a
              href="/kiosk"
              className="text-[clamp(0.75rem,3vw,0.875rem)] text-primary hover:underline"
            >
              Back to scanner
            </a>
          </div>
        )}

        {/* Main content */}
        {!loading && !error && spool && (
          <>
            {/* Spool Info */}
            <div className="flex items-center gap-[clamp(0.5rem,2vw,0.75rem)] p-[clamp(0.5rem,2vw,0.75rem)] rounded-lg border bg-muted/50 mb-[clamp(0.75rem,3vw,1rem)]">
              <SpoolColorSwatch filament={spool.filament} size="h-12 w-12" />
              <div className="flex-1 min-w-0">
                <p className="text-[clamp(0.875rem,3.5vw,1.25rem)] font-semibold truncate">
                  {spool.filament.vendor?.name ? `${spool.filament.vendor.name} ` : ''}
                  {spool.filament.name || spool.filament.material}
                </p>
                <p className="text-[clamp(0.625rem,2.5vw,0.875rem)] text-muted-foreground">
                  {spool.filament.material} &bull; #{spool.id} &bull;{' '}
                  {Math.round(spool.remaining_weight)}g
                </p>
              </div>
            </div>

            {/* Tray Grid */}
            {trays.length > 0 ? (
              <>
                <h2 className="text-[clamp(0.75rem,3vw,1rem)] font-medium text-muted-foreground mb-[clamp(0.5rem,2vw,0.75rem)]">
                  Assign to tray:
                </h2>
                <div className="grid grid-cols-2 gap-[clamp(0.5rem,2vw,0.75rem)] flex-1 auto-rows-fr">
                  {trays.map((tray) => (
                    <button
                      key={tray.id}
                      onClick={() => handleAssign(tray)}
                      disabled={assigning}
                      className="flex flex-col items-center justify-center rounded-xl border-2 border-border p-[clamp(0.75rem,3vw,1.25rem)] transition-colors hover:border-primary hover:bg-accent active:bg-accent disabled:opacity-50"
                    >
                      {assigning && pendingTrayId === tray.id ? (
                        <Loader2 className="h-[clamp(1.25rem,5vw,1.75rem)] w-[clamp(1.25rem,5vw,1.75rem)] animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <span className="text-[clamp(1rem,4vw,1.5rem)] font-semibold">
                            {tray.label}
                          </span>
                          {tray.amsName && (
                            <span className="text-[clamp(0.625rem,2.5vw,0.875rem)] text-muted-foreground">
                              {tray.amsName}
                            </span>
                          )}
                          <span className="text-[clamp(0.5rem,2vw,0.75rem)] text-muted-foreground/70 mt-0.5">
                            {tray.printer}
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
                <p className="text-[clamp(0.75rem,3vw,0.875rem)] text-muted-foreground">
                  No printers or trays found.
                </p>
                <a
                  href="/kiosk"
                  className="text-[clamp(0.75rem,3vw,0.875rem)] text-primary hover:underline"
                >
                  Back to scanner
                </a>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-[clamp(0.5rem,2vw,0.75rem)] mt-auto">
          <a
            href="/kiosk"
            className="text-[clamp(0.625rem,2.5vw,0.75rem)] text-muted-foreground/60 hover:text-muted-foreground"
          >
            &larr; Back
          </a>
          <button
            onClick={() => {
              disableKioskMode();
              window.location.href = '/';
            }}
            className="text-[clamp(0.625rem,2.5vw,0.75rem)] text-muted-foreground/40 hover:text-muted-foreground"
          >
            Exit Kiosk Mode
          </button>
        </div>
      </div>
    );
  }

  // Normal mode
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
          <h1 className="text-xl sm:text-2xl font-bold">Assign Spool</h1>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        )}

        {/* Error State */}
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

        {/* Main Content - Spool Details & Tray Selection */}
        {!loading && !error && spool && (
          <div className="space-y-6">
            {/* Spool Details */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SpoolColorSwatch filament={spool.filament} size="h-6 w-6" />
                  Spool #{spool.id}
                </CardTitle>
                <CardDescription>
                  {spool.filament.vendor?.name} {spool.filament.name}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Material:</span>
                    <Badge variant="secondary" className="ml-2">
                      {spool.filament.material}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Remaining:</span>
                    <span className="ml-2 font-medium">{Math.round(spool.remaining_weight)}g</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Tray Selection */}
            {trays.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Select Tray</CardTitle>
                  <CardDescription>
                    Choose which AMS tray to assign this spool to
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Command className="rounded-lg border">
                    <CommandInput placeholder="Search trays..." />
                    <CommandList className="max-h-[300px]">
                      <CommandEmpty>No trays found.</CommandEmpty>
                      <CommandGroup>
                        {trays.map((tray) => (
                          <CommandItem
                            key={tray.id}
                            value={`${tray.printer} ${tray.amsName || ''} ${tray.label}`}
                            onSelect={() => handleAssign(tray)}
                            disabled={assigning}
                            className="flex items-center justify-between py-3 cursor-pointer"
                          >
                            <div>
                              <p className="font-medium">{tray.printer}</p>
                              <p className="text-sm text-muted-foreground">
                                {tray.amsName ? `${tray.amsName} - ` : ''}{tray.label}
                              </p>
                            </div>
                            {assigning ? (
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
                            ) : (
                              <Badge variant="outline">Select</Badge>
                            )}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-6">
                  <p className="text-muted-foreground text-center">
                    No printers or trays found. Please set up Home Assistant and discover printers first.
                  </p>
                  <div className="flex justify-center mt-4">
                    <Link href="/settings">
                      <Button variant="outline">Go to Settings</Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
