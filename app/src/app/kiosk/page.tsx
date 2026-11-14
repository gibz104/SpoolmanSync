'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Nfc, MonitorSmartphone } from 'lucide-react';
import { isKioskMode, enableKioskMode, disableKioskMode } from '@/lib/kiosk';
import { parseScanLink, slotPath, type ScanTarget } from '@/lib/scan-codes';

export default function KioskPage() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(true);
  const [scanInput, setScanInput] = useState('');
  const [notFound, setNotFound] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEnabled(isKioskMode());
    setChecking(false);
  }, []);

  // Keep input focused in kiosk idle mode, but never steal focus while the
  // user is actively interacting: skip if the input is already focused or if
  // it already holds text the user is mid-typing. Only refocus when focus has
  // genuinely been lost.
  useEffect(() => {
    if (!enabled) return;
    const refocus = () => {
      const input = inputRef.current;
      if (!input) return;
      if (document.activeElement === input) return; // already focused
      if (input.value) return; // user is mid-typing — don't interrupt
      input.focus();
    };
    refocus();
    const interval = setInterval(refocus, 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  const handleEnable = () => {
    enableKioskMode();
    setEnabled(true);
  };

  const handleExit = () => {
    disableKioskMode();
    router.push('/');
  };

  // A reader types what the tag holds: a spool or slot link, a spool id, or
  // the tag's UID, which Spoolman may have linked to a spool.
  const handleScanSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const code = scanInput.trim();
      setScanInput('');
      if (!code) return;
      const open = (target: ScanTarget) =>
        router.push(target.kind === 'spool' ? `/scan/spool/${target.id}` : slotPath(target.key));
      const link = parseScanLink(code);
      if (link) {
        open(link);
        return;
      }
      try {
        const res = await fetch(`/api/spools/resolve?code=${encodeURIComponent(code)}`);
        if (res.ok) {
          open((await res.json()).target);
          return;
        }
        setNotFound(res.status === 404 ? `No spool found for ${code}` : 'Could not look that up');
      } catch {
        setNotFound('Could not look that up');
      }
    },
    [scanInput, router]
  );

  if (checking) return null;

  // Setup screen — explain kiosk mode and let user opt in
  if (!enabled) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <MonitorSmartphone className="h-12 w-12 mx-auto mb-2 text-muted-foreground" />
            <CardTitle>Kiosk Mode</CardTitle>
            <CardDescription>
              Optimized for small touchscreens with NFC/RFID readers. Provides a
              simplified interface for scanning spools and assigning them to
              printer trays.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm text-muted-foreground space-y-2">
              <p>When enabled on this device:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Spool assignment pages use large, touch-friendly buttons
                </li>
                <li>Navigation is simplified for kiosk use</li>
                <li>
                  Only affects this browser — other devices are unchanged
                </li>
              </ul>
            </div>
            <Button onClick={handleEnable} className="w-full" size="lg">
              Enable Kiosk Mode
            </Button>
            <button
              onClick={() => router.push('/')}
              className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
            >
              Go back
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Idle screen — waiting for NFC scan
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-[clamp(1rem,4vw,2rem)]">
      <div className="flex-1 flex flex-col items-center justify-center w-full max-w-sm">
        <Nfc className="h-[clamp(3rem,15vw,6rem)] w-[clamp(3rem,15vw,6rem)] text-muted-foreground/50 mb-[clamp(0.5rem,3vw,1.5rem)]" />
        <h1 className="text-[clamp(1.25rem,5vw,2rem)] font-bold text-center mb-[clamp(0.25rem,1.5vw,0.5rem)]">
          Scan a Spool
        </h1>
        <p className="text-[clamp(0.75rem,3vw,1rem)] text-muted-foreground text-center mb-[clamp(1rem,4vw,2rem)]">
          Hold an NFC-tagged spool near the reader
        </p>
        <form onSubmit={handleScanSubmit} className="w-full">
          <Input
            ref={inputRef}
            value={scanInput}
            onChange={(e) => {
              setScanInput(e.target.value);
              setNotFound(null);
            }}
            placeholder="Waiting for scan..."
            className="text-center text-[clamp(0.875rem,3.5vw,1.125rem)] h-[clamp(2.5rem,8vw,3rem)]"
            autoFocus
          />
        </form>
        {notFound && (
          <p className="text-[clamp(0.75rem,3vw,1rem)] text-destructive mt-[clamp(0.5rem,2vw,1rem)] text-center">
            {notFound}
          </p>
        )}
        <p className="text-[clamp(0.625rem,2vw,0.75rem)] text-muted-foreground/50 mt-[clamp(0.5rem,2vw,1rem)] text-center">
          Or type a spool ID and press Enter
        </p>
      </div>
      <button
        onClick={handleExit}
        className="text-[clamp(0.625rem,2.5vw,0.75rem)] text-muted-foreground/40 hover:text-muted-foreground py-[clamp(0.5rem,2vw,1rem)]"
      >
        Exit Kiosk Mode
      </button>
    </div>
  );
}
