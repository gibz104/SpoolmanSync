'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Nav } from '@/components/nav';
import { QRScanner } from '@/components/qr-scanner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import type { Spool } from '@/lib/api/spoolman';
import { QRCodeGenerator } from '@/components/qr-code-generator';
import { NFCWriter } from '@/components/nfc-writer';
import { NFCReader } from '@/components/nfc-reader';
import { SlotTags } from '@/components/slot-tags';
import { parseScanLink, slotPath, type ScanTarget } from '@/lib/scan-codes';
import { useNfcBlocker } from '@/lib/use-nfc-blocker';

function ScanPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [allSpools, setAllSpools] = useState<Spool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');
  const [spoolsLoading, setSpoolsLoading] = useState(true);
  const [directAccessPort, setDirectAccessPort] = useState<number | undefined>(undefined);
  const [qrBaseUrl, setQrBaseUrl] = useState<string | undefined>(undefined);
  const canReadNfc = useNfcBlocker() === null;

  const handleScan = useCallback(async (scannedData: string) => {
    setLoading(true);
    setError(null);

    const open = (target: ScanTarget) =>
      router.push(target.kind === 'spool' ? `/scan/spool/${target.id}` : slotPath(target.key));

    try {
      // A spool or slot link opens straight away; anything else (a spool id,
      // a barcode, a tag's UID) is looked up.
      const link = parseScanLink(scannedData);
      if (link) {
        open(link);
        return;
      }

      const res = await fetch(`/api/spools/resolve?code=${encodeURIComponent(scannedData.trim())}`);
      if (res.ok) {
        open((await res.json()).target);
      } else if (res.status === 404) {
        setError(`No spool found for: ${scannedData}`);
        toast.error('No matching spool found');
      } else {
        throw new Error('Failed to look up spool');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to look up spool');
      toast.error('Failed to look up spool');
    } finally {
      setLoading(false);
    }
  }, [router]);

  // Check for barcode in URL params
  useEffect(() => {
    const barcode = searchParams.get('barcode');
    if (barcode) {
      handleScan(barcode);
    }
  }, [searchParams, handleScan]);

  // Fetch direct access port for addon mode QR/NFC URLs
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.directAccessPort) {
          setDirectAccessPort(data.directAccessPort);
        }
        if (data.qrBaseUrl) {
          setQrBaseUrl(data.qrBaseUrl);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch all spools for QR code generator
  useEffect(() => {
    const fetchAllSpools = async () => {
      try {
        const res = await fetch('/api/spools');
        if (res.ok) {
          const data = await res.json();
          setAllSpools(data.spools || []);
        }
      } catch (err) {
        console.error('Failed to fetch spools:', err);
      } finally {
        setSpoolsLoading(false);
      }
    };
    fetchAllSpools();
  }, []);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualBarcode.trim()) {
      handleScan(manualBarcode.trim());
    }
  };

  return (
    <div className="space-y-6">
      {/* QR Scanner */}
      <Card>
        <CardHeader>
          <CardTitle>Scan QR Code</CardTitle>
          <CardDescription>
            Point your camera at a Spoolman QR code or Spoolman barcode
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QRScanner
            onScan={handleScan}
            onError={(err) => toast.error(err)}
          />
        </CardContent>
      </Card>

      {/* NFC Tag Reader: only where this page can use Web NFC */}
      {canReadNfc && (
        <Card>
          <CardHeader>
            <CardTitle>Read NFC Tag</CardTitle>
            <CardDescription>
              Tap a spool&apos;s or slot&apos;s tag: one SpoolmanSync wrote, or one linked to a spool in Spoolman
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NFCReader spools={allSpools} />
          </CardContent>
        </Card>
      )}

      {/* Manual Entry */}
      <Card>
        <CardHeader>
          <CardTitle>Manual Entry</CardTitle>
          <CardDescription>
            Enter a Spoolman barcode or spool ID manually
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleManualSubmit} className="flex gap-2">
            <Input
              placeholder="Enter spool ID, Spoolman barcode, tag UID, or web+spoolman:s-123"
              value={manualBarcode}
              onChange={(e) => setManualBarcode(e.target.value)}
            />
            <Button type="submit" disabled={loading || !manualBarcode.trim()}>
              {loading ? 'Looking up...' : 'Look up'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* QR Code Generator */}
      <Card>
        <CardHeader>
          <CardTitle>Print QR Labels</CardTitle>
          <CardDescription>
            Print QR code labels for any paper or label size. Select multiple spools and customize the layout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spoolsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : allSpools.length > 0 ? (
            <QRCodeGenerator spools={allSpools} directAccessPort={directAccessPort} qrBaseUrl={qrBaseUrl} />
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No spools found. Add spools to Spoolman to generate QR labels.
            </p>
          )}
        </CardContent>
      </Card>

      {/* NFC Tag Writer */}
      <Card>
        <CardHeader>
          <CardTitle>Write NFC Tag</CardTitle>
          <CardDescription>
            Write a spool link to an NFC sticker tag. Tap the tag with your phone to quickly assign to an AMS tray.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spoolsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : allSpools.length > 0 ? (
            <NFCWriter spools={allSpools} directAccessPort={directAccessPort} qrBaseUrl={qrBaseUrl} />
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No spools found. Add spools to Spoolman to write NFC tags.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Slot Tags */}
      <Card>
        <CardHeader>
          <CardTitle>Slot Tags</CardTitle>
          <CardDescription>
            Put a tag or QR code on each tray or storage slot. Scan a spool and then its slot, in either order, to assign it there.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SlotTags directAccessPort={directAccessPort} qrBaseUrl={qrBaseUrl} />
        </CardContent>
      </Card>

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ScanPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <h1 className="text-xl sm:text-2xl font-bold mb-6">Scan Spool</h1>
        <Suspense fallback={
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        }>
          <ScanPageContent />
        </Suspense>
      </main>
    </div>
  );
}
