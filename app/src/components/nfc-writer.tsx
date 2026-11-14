'use client';

import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SpoolFilterBar } from '@/components/dashboard/spool-filter-bar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Nfc, CheckCircle2, XCircle, Loader2, AlertTriangle, Smartphone, Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import type { Spool } from '@/lib/api/spoolman';
import { buildSpoolSearchValue, parseExtraValue } from '@/lib/api/spoolman';
import { buildExternalUrl } from '@/lib/ingress-path';
import { isSecureUrl, nfcErrorMessage, writeNfcLink, type NfcBlocker } from '@/lib/web-nfc';
import { useNfcBlocker } from '@/lib/use-nfc-blocker';
import { copyText } from '@/lib/clipboard';

type SortBy = 'id' | 'name' | 'material' | 'vendor';

interface NFCWriterProps {
  spools: Spool[];
  directAccessPort?: number;
  qrBaseUrl?: string;
}

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

type WriteStatus = 'idle' | 'writing' | 'success' | 'error';

function sortSpools(spools: Spool[], sortBy: SortBy): Spool[] {
  return [...spools].sort((a, b) => {
    switch (sortBy) {
      case 'id':
        return a.id - b.id;
      case 'name':
        return (a.filament.name || a.filament.material).localeCompare(b.filament.name || b.filament.material);
      case 'material':
        return (a.filament.material || '').localeCompare(b.filament.material || '');
      case 'vendor':
        return (a.filament.vendor?.name || '').localeCompare(b.filament.vendor?.name || '');
    }
  });
}

/** Why Web NFC cannot write tags on this page, and what to do instead: one entry per NfcBlocker. */
const BLOCKED_NOTICES: Record<NfcBlocker, { title: string; body: ReactNode; openDirectly: boolean }> = {
  'companion-app': {
    title: 'Open SpoolmanSync in a browser to write NFC tags',
    body: <>The Home Assistant app can&apos;t write NFC tags for a web page. Open SpoolmanSync in Chrome on Android instead.</>,
    openDirectly: true,
  },
  insecure: {
    title: 'Writing NFC tags needs an https:// address',
    body: <>Browsers only allow Web NFC on https:// pages, and only Chrome, Edge, Opera and Samsung Internet on Android support it. Open SpoolmanSync through an https:// address, such as a reverse proxy.</>,
    openDirectly: false,
  },
  unsupported: {
    title: 'Web NFC Not Available',
    body: <>Web NFC is only supported on <strong>Android</strong> with certain browsers (Chrome, Edge, Opera, Samsung Internet). iOS, Firefox, and Brave do not support it.</>,
    openDirectly: false,
  },
  embedded: {
    title: 'Open SpoolmanSync directly to write NFC tags',
    body: <>Chrome doesn&apos;t allow Web NFC inside the Home Assistant sidebar. Open SpoolmanSync on its own page in Chrome on Android to write tags.</>,
    openDirectly: true,
  },
};

function NfcBlockedNotice({ blocker, directUrl, linkTemplate }: { blocker: NfcBlocker; directUrl: string; linkTemplate: string }) {
  const notice = BLOCKED_NOTICES[blocker];
  return (
    <Alert>
      <Smartphone className="h-4 w-4" />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{notice.body}</p>
        {notice.openDirectly && (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={directUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Open SpoolmanSync directly
              </a>
            </Button>
            {!isSecureUrl(directUrl) && (
              <p className="text-xs text-muted-foreground">
                That address is http://, and Web NFC needs https://. Put an https:// reverse proxy in front of
                it, and enter that address under Settings, QR Code / NFC URL.
              </p>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Or write a spool&apos;s link with an NFC app such as NFC Tools: pick a spool below to copy its link.
          The links have this form:
        </p>
        <p className="text-xs font-mono bg-muted p-2 rounded break-all select-all">
          {linkTemplate}<span className="text-primary">[SPOOL_ID]</span>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function getSpoolFieldValue(spool: Spool, fieldKey: string): string | null {
  switch (fieldKey) {
    case 'material':
      return spool.filament.material || null;
    case 'vendor':
      return spool.filament.vendor?.name || null;
    case 'location':
      return spool.location || null;
    case 'lot_nr':
      return spool.lot_nr || null;
    default:
      if (fieldKey.startsWith('extra_')) {
        const extraKey = fieldKey.replace('extra_', '');
        return parseExtraValue(spool.extra?.[extraKey]) || null;
      }
      return null;
  }
}

export function NFCWriter({ spools, directAccessPort, qrBaseUrl }: NFCWriterProps) {
  const [selectedSpool, setSelectedSpool] = useState<Spool | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const [filters, setFilters] = useState<Record<string, string | null>>({});
  const [enabledFields, setEnabledFields] = useState<FilterField[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>('id');
  // undefined while checking; null when this page can write tags.
  const blocker = useNfcBlocker();
  const [writeStatus, setWriteStatus] = useState<WriteStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [linkNote, setLinkNote] = useState('');
  // The spool selected now, so a link answer for an earlier one is not shown against it.
  const selectedId = useRef<number | null>(null);
  useEffect(() => {
    selectedId.current = selectedSpool?.id ?? null;
  }, [selectedSpool]);

  // Fetch filter fields on mount
  useEffect(() => {
    fetch('/api/spools/extra-fields')
      .then((res) => res.json())
      .then((data) => {
        if (data.fields && data.filterConfig) {
          const enabled = data.fields.filter(
            (f: FilterField) => data.filterConfig.includes(f.key)
          );
          setEnabledFields(enabled);
        }
      })
      .catch((err) => console.error('Failed to fetch filter fields:', err));
  }, []);

  // Filter and sort spools
  const filteredSpools = useMemo(() => {
    const filtered = spools.filter((spool) => {
      for (const [key, value] of Object.entries(filters)) {
        if (value) {
          const spoolValue = getSpoolFieldValue(spool, key);
          if (spoolValue !== value) return false;
        }
      }
      return true;
    });
    return sortSpools(filtered, sortBy);
  }, [spools, filters, sortBy]);

  const nfcUrl = selectedSpool
    ? buildExternalUrl(`/scan/spool/${selectedSpool.id}`, directAccessPort, qrBaseUrl)
    : null;

  const handleSpoolSelect = (spool: Spool) => {
    setSelectedSpool(spool);
    setSearchValue('');
    setWriteStatus('idle');
    setErrorMessage('');
    setLinkNote('');
  };

  const handleFilterChange = (key: string, value: string | null) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleClearFilters = () => {
    setFilters({});
  };

  const handleCopyLink = async () => {
    if (!nfcUrl) return;
    if (await copyText(nfcUrl)) toast.success('Link copied');
    else toast.error('Could not copy the link; select it and copy it instead');
  };

  // So the tag identifies the spool in Spoolman too (0.27+, #89). Best effort:
  // the tag is written either way.
  const linkWrittenTag = async (spoolId: number, uid: string) => {
    try {
      const res = await fetch('/api/spools/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoolId, uid }),
      });
      const data = await res.json().catch(() => ({}));
      if (selectedId.current !== spoolId) return;
      if (res.ok && data.linked) {
        setLinkNote(data.movedFrom !== null && data.movedFrom !== undefined
          ? `Spoolman now knows this tag as spool #${spoolId} (it was linked to spool #${data.movedFrom}).`
          : `Spoolman now knows this tag as spool #${spoolId}.`);
      } else if (!res.ok) {
        setLinkNote(`The tag works, but Spoolman could not link it to the spool: ${data.error || 'unknown error'}.`);
      }
    } catch {
      if (selectedId.current === spoolId) setLinkNote('The tag works, but Spoolman could not be reached to link it to the spool.');
    }
  };

  const handleWriteNFC = async () => {
    const spoolId = selectedSpool?.id;
    if (!nfcUrl || spoolId === undefined || blocker || !window.NDEFReader) return;

    setWriteStatus('writing');
    setErrorMessage('');
    setLinkNote('');

    try {
      // The tap also reports the tag's UID, for linking it in Spoolman.
      const tagUid = await writeNfcLink(nfcUrl, true);
      setWriteStatus('success');
      if (tagUid) void linkWrittenTag(spoolId, tagUid);
    } catch (err) {
      setWriteStatus('error');
      setErrorMessage(nfcErrorMessage(err, 'Failed to write to the NFC tag.'));
    }
  };

  // Show loading state while checking NFC support
  if (blocker === undefined) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {blocker && (
        <NfcBlockedNotice
          blocker={blocker}
          directUrl={buildExternalUrl('/scan', directAccessPort, qrBaseUrl)}
          linkTemplate={buildExternalUrl('/scan/spool/', directAccessPort, qrBaseUrl)}
        />
      )}

      {/* Filters & Sort */}
      {enabledFields.length > 0 ? (
        <SpoolFilterBar
          filters={filters}
          onFilterChange={handleFilterChange}
          onClearAll={handleClearFilters}
          fields={enabledFields}
          extra={
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="id">Sort: ID</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
                <SelectItem value="material">Sort: Material</SelectItem>
                <SelectItem value="vendor">Sort: Vendor</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      ) : (
        <div className="flex items-center justify-end">
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="id">Sort: ID</SelectItem>
              <SelectItem value="name">Sort: Name</SelectItem>
              <SelectItem value="material">Sort: Material</SelectItem>
              <SelectItem value="vendor">Sort: Vendor</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Spool Selector */}
      <Command className="rounded-lg border">
        <CommandInput
          placeholder="Search spools by name, vendor, material, or ID..."
          value={searchValue}
          onValueChange={setSearchValue}
        />
        <CommandList className="max-h-[200px]">
          <CommandEmpty>No spools found.</CommandEmpty>
          <CommandGroup heading={`${filteredSpools.length} spools`}>
            {filteredSpools.map((spool) => (
              <CommandItem
                key={spool.id}
                value={buildSpoolSearchValue(spool)}
                onSelect={() => handleSpoolSelect(spool)}
                className="flex items-center gap-3 py-2 cursor-pointer"
              >
                <SpoolColorSwatch filament={spool.filament} size="h-5 w-5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {spool.filament.name || spool.filament.material}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {spool.filament.vendor?.name ? `${spool.filament.vendor.name} • ` : ''}#{spool.id}
                  </p>
                </div>
                <Badge variant="secondary" className="flex-shrink-0">
                  {spool.filament.material}
                </Badge>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>

      {/* Selected Spool & Write Button */}
      {selectedSpool && nfcUrl && (
        <div className="space-y-4">
          {/* Selected Spool Info */}
          <div className="flex items-center gap-3 p-4 border rounded-lg bg-muted/50">
            <SpoolColorSwatch filament={selectedSpool.filament} size="h-10 w-10" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">
                {selectedSpool.filament.vendor?.name} {selectedSpool.filament.name}
              </p>
              <p className="text-sm text-muted-foreground">
                {selectedSpool.filament.material} • Spool #{selectedSpool.id}
              </p>
            </div>
          </div>

          {/* Write Status Feedback */}
          {writeStatus === 'success' && (
            <Alert className="border-green-500 bg-green-500/10">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <AlertTitle className="text-green-500">Success!</AlertTitle>
              <AlertDescription>
                NFC tag written successfully. You can now stick it on your spool.
                {linkNote && <span className="block mt-1 text-xs text-muted-foreground">{linkNote}</span>}
              </AlertDescription>
            </Alert>
          )}

          {writeStatus === 'error' && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Write Failed</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {/* Buttons Row */}
          <div className="flex gap-2">
            {blocker ? (
              <Button onClick={handleCopyLink} className="flex-1">
                <Copy className="h-4 w-4 mr-2" />
                Copy Link
              </Button>
            ) : (
            <Button
              onClick={handleWriteNFC}
              disabled={writeStatus === 'writing'}
              className="flex-1"
            >
              {writeStatus === 'writing' ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Hold tag near phone...
                </>
              ) : (
                <>
                  <Nfc className="h-4 w-4 mr-2" />
                  Write to NFC Tag
                </>
              )}
            </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setSelectedSpool(null);
                setWriteStatus('idle');
                setErrorMessage('');
              }}
            >
              Clear
            </Button>
          </div>

          {!blocker && writeStatus === 'idle' && (
            <p className="text-xs text-muted-foreground text-center">
              Click the button, then hold your NFC tag near your phone's NFC reader.
            </p>
          )}

          {/* URL Preview */}
          <p className="text-xs text-muted-foreground/70 text-center font-mono break-all select-all">
            {nfcUrl}
          </p>
        </div>
      )}

      {/* Empty state */}
      {!selectedSpool && (
        <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
          <Nfc className="h-12 w-12 mb-3 opacity-50" />
          <p className="text-sm">{blocker ? 'Select a spool above to copy its link' : 'Select a spool above to write to an NFC tag'}</p>
        </div>
      )}

      {/* Instructions */}
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Before You Start</AlertTitle>
        <AlertDescription className="text-xs space-y-1">
          <p>• Use NTAG213, NTAG215, or NTAG216 NFC sticker tags</p>
          <p>• These should not interfere with Bambu Lab AMS RFID tags (different protocol), but test first</p>
          <p>• Place the NFC sticker on the outside of the spool where it won't rub against the AMS</p>
          <p>• Scanning the tag will open SpoolmanSync's tray assignment page</p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
