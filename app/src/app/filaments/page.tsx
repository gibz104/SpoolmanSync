'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const BAMBU_PALETTE: { group: string; colors: { name: string; hex: string }[] }[] = [
  {
    group: 'Grayscale & Essentials',
    colors: [
      { name: 'Jade White',  hex: 'FFFFFF' },
      { name: 'Black',       hex: '000000' },
      { name: 'Gray',        hex: '8E9089' },
      { name: 'Dark Gray',   hex: '545454' },
      { name: 'Silver',      hex: 'A6A9AA' },
    ],
  },
  {
    group: 'Vibrant Colors',
    colors: [
      { name: 'Red',         hex: 'C12E1F' },
      { name: 'Orange',      hex: 'FF6A13' },
      { name: 'Yellow',      hex: 'F4EE2A' },
      { name: 'Bambu Green', hex: '00AE42' },
      { name: 'Blue',        hex: '0A2989' },
      { name: 'Cyan',        hex: '0086D6' },
      { name: 'Magenta',     hex: 'EC008C' },
    ],
  },
  {
    group: 'Muted & Earth Tones',
    colors: [
      { name: 'Beige',       hex: 'F7E6DE' },
      { name: 'Brown',       hex: '9D432C' },
      { name: 'Cocoa Brown', hex: '6F5034' },
      { name: 'Terracotta',  hex: 'B15533' },
      { name: 'Desert Tan',  hex: 'E8DBB7' },
    ],
  },
  {
    group: 'Specialty Tones',
    colors: [
      { name: 'Gold',        hex: 'E4BD68' },
      { name: 'Bronze',      hex: '847D48' },
      { name: 'Purple',      hex: '5E43B7' },
      { name: 'Pink',        hex: 'F55A74' },
    ],
  },
];

interface BambuProfile {
  id: string;
  filamentId: string;
  name: string | null;
  vendor: string | null;
  material: string | null;
  syncedAt: string;
  linked: boolean;
}

interface SpoolmanFilament {
  id: number;
  name: string;
  material: string;
  color_hex: string | null;
  vendor: { name: string } | null;
  extra?: Record<string, string>;
}

interface FilamentData {
  bambuProfiles: BambuProfile[];
  spoolmanFilaments: SpoolmanFilament[];
  lastSynced: string | null;
  hasToken: boolean;
  spoolmanUrl: string | null;
}

export default function FilamentsPage() {
  const [data, setData] = useState<FilamentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showPalette, setShowPalette] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('filaments_showPalette') === 'true';
  });

  // Table sort state
  type SortCol = 'name' | 'vendor' | 'material' | 'status';
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const sortedProfiles = useMemo(() => {
    return [...(data?.bambuProfiles ?? [])].sort((a, b) => {
      let va = '', vb = '';
      if (sortCol === 'name') { va = a.name ?? ''; vb = b.name ?? ''; }
      else if (sortCol === 'vendor') { va = a.vendor ?? ''; vb = b.vendor ?? ''; }
      else if (sortCol === 'material') { va = a.material ?? ''; vb = b.material ?? ''; }
      else if (sortCol === 'status') { va = a.linked ? 'linked' : 'unlinked'; vb = b.linked ? 'linked' : 'unlinked'; }
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }, [data?.bambuProfiles, sortCol, sortDir]);

  // Bambu Cloud connect form state (shown when no token stored)
  type ConnectState = 'idle' | 'loading' | 'needs_tfa' | 'needs_code';
  const [connectState, setConnectState] = useState<ConnectState>('idle');
  const [connectEmail, setConnectEmail] = useState('');
  const [connectPassword, setConnectPassword] = useState('');
  const [connectTfaKey, setConnectTfaKey] = useState('');
  const [connectTfaCode, setConnectTfaCode] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);

  // Link modal state
  const [linkingProfile, setLinkingProfile] = useState<BambuProfile | null>(null);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkSelected, setLinkSelected] = useState<Set<number>>(new Set());
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkFilterMaterial, setLinkFilterMaterial] = useState<string>('');
  const [linkFilterVendor, setLinkFilterVendor] = useState<string>('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/filaments');
      if (!res.ok) throw new Error('Failed to load');
      setData(await res.json() as FilamentData);
    } catch {
      // keep old data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch('/api/filaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resync' }),
      });
      const json = await res.json() as { status?: string; error?: string; count?: number };
      if (!res.ok) {
        setRefreshError(json.error ?? 'Refresh failed');
      } else {
        await fetchData();
      }
    } catch {
      setRefreshError('Network error');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleConnect() {
    setConnectState('loading');
    setConnectError(null);
    try {
      const res = await fetch('/api/filaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', email: connectEmail, password: connectPassword }),
      });
      const json = await res.json() as { status?: string; tfaKey?: string; error?: string };
      if (json.status === 'needs_tfa') {
        setConnectTfaKey(json.tfaKey ?? '');
        setConnectState('needs_tfa');
      } else if (json.status === 'needs_code') {
        setConnectState('needs_code');
      } else if (!res.ok) {
        setConnectError(json.error ?? 'Login failed');
        setConnectState('idle');
      } else {
        await fetchData();
        setConnectState('idle');
      }
    } catch {
      setConnectError('Network error');
      setConnectState('idle');
    }
  }

  async function handleConnectTfa() {
    setConnectState('loading');
    setConnectError(null);
    try {
      const res = await fetch('/api/filaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect_tfa', email: connectEmail, tfaKey: connectTfaKey, tfaCode: connectTfaCode }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) {
        setConnectError(json.error ?? 'TFA verification failed');
        setConnectState('needs_tfa');
      } else {
        await fetchData();
        setConnectState('idle');
      }
    } catch {
      setConnectError('Network error');
      setConnectState('needs_tfa');
    }
  }

  function openLinkModal(profile: BambuProfile) {
    // Pre-select Spoolman filaments already linked to this Bambu profile
    const preSelected = new Set<number>();
    for (const f of data?.spoolmanFilaments ?? []) {
      const raw = f.extra?.['filament_id'];
      if (raw) {
        try { if (JSON.parse(raw) === profile.filamentId) preSelected.add(f.id); }
        catch { if (raw === profile.filamentId) preSelected.add(f.id); }
      }
    }
    setLinkSelected(preSelected);
    setLinkingProfile(profile);
    setLinkSearch('');
    setLinkFilterMaterial('');
    setLinkFilterVendor('');
  }

  function toggleLinkSelection(id: number) {
    setLinkSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleLinkSelected() {
    if (!linkingProfile || linkSelected.size === 0) return;
    setLinkLoading(true);
    try {
      await Promise.all([...linkSelected].map(id =>
        fetch('/api/filaments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'link',
            spoolmanFilamentId: id,
            bambuFilamentId: linkingProfile.filamentId,
          }),
        })
      ));
      setLinkingProfile(null);
      setLinkSearch('');
      await fetchData();
    } catch {
      // silently ignore
    } finally {
      setLinkLoading(false);
    }
  }

  const allMaterials = useMemo(() =>
    [...new Set((data?.spoolmanFilaments ?? []).map(f => f.material).filter(Boolean))].sort(),
    [data?.spoolmanFilaments]);

  const allVendors = useMemo(() =>
    [...new Set((data?.spoolmanFilaments ?? []).map(f => f.vendor?.name ?? '').filter(Boolean))].sort(),
    [data?.spoolmanFilaments]);

  // Count how many Spoolman filaments are linked to each Bambu filamentId
  const linkedCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of data?.spoolmanFilaments ?? []) {
      const raw = f.extra?.['filament_id'];
      if (!raw) continue;
      let val: string;
      try { val = JSON.parse(raw); } catch { val = raw; }
      if (typeof val === 'string' && val) map.set(val, (map.get(val) ?? 0) + 1);
    }
    return map;
  }, [data?.spoolmanFilaments]);

  const filteredSpoolmanFilaments = useMemo(() =>
    (data?.spoolmanFilaments ?? []).filter(f => {
      if (linkFilterMaterial && f.material !== linkFilterMaterial) return false;
      if (linkFilterVendor && (f.vendor?.name ?? '') !== linkFilterVendor) return false;
      if (linkSearch) {
        const q = linkSearch.toLowerCase();
        return f.name.toLowerCase().includes(q) ||
          f.material.toLowerCase().includes(q) ||
          (f.vendor?.name ?? '').toLowerCase().includes(q);
      }
      return true;
    }),
    [data?.spoolmanFilaments, linkSearch, linkFilterMaterial, linkFilterVendor]);

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Bambu Filament Profiles</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Link Bambu Studio filament profiles to Spoolman filaments for automatic spool matching.
              Profiles are synced automatically when you add a printer in Settings.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data?.lastSynced && (
              <span className="text-xs text-muted-foreground">
                Synced {new Date(data.lastSynced).toLocaleDateString()}
              </span>
            )}
            {data?.spoolmanUrl && (
              <Button variant="outline" asChild>
                <a href={data.spoolmanUrl} target="_blank" rel="noopener noreferrer">
                  Spoolman <ExternalLink className="h-4 w-4 ml-1" />
                </a>
              </Button>
            )}
            {data?.hasToken && (
              <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            )}
          </div>
        </div>

        {refreshError && (
          <p className="text-sm text-destructive mb-4">{refreshError}</p>
        )}

        {/* Bambu Cloud connect card — shown when no token stored yet */}
        {!loading && !data?.hasToken && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Connect Bambu Cloud</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Enter your Bambu Cloud credentials to fetch filament profiles. These are stored
                locally and only used to sync profiles.
              </p>
            </CardHeader>
            <CardContent>
              {connectState === 'needs_code' ? (
                <p className="text-sm text-muted-foreground">
                  Bambu Cloud requires email verification for this device. Please add the printer
                  via <strong>Settings</strong> first to complete the login flow there.
                </p>
              ) : connectState === 'needs_tfa' ? (
                <div className="space-y-3 max-w-sm">
                  <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app.</p>
                  <Input
                    placeholder="000000"
                    value={connectTfaCode}
                    onChange={e => setConnectTfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    autoFocus
                  />
                  {connectError && <p className="text-sm text-destructive">{connectError}</p>}
                  <div className="flex gap-2">
                    <Button onClick={handleConnectTfa} disabled={connectState !== 'needs_tfa' || connectTfaCode.length !== 6}>
                      Verify
                    </Button>
                    <Button variant="ghost" onClick={() => { setConnectState('idle'); setConnectTfaCode(''); setConnectError(null); }}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 max-w-sm">
                  <Input
                    type="email"
                    placeholder="Bambu Cloud email"
                    value={connectEmail}
                    onChange={e => setConnectEmail(e.target.value)}
                    disabled={connectState === 'loading'}
                  />
                  <Input
                    type="password"
                    placeholder="Password"
                    value={connectPassword}
                    onChange={e => setConnectPassword(e.target.value)}
                    disabled={connectState === 'loading'}
                    onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
                  />
                  {connectError && <p className="text-sm text-destructive">{connectError}</p>}
                  <Button onClick={handleConnect} disabled={connectState === 'loading' || !connectEmail || !connectPassword}>
                    {connectState === 'loading' ? 'Connecting…' : 'Connect'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Main table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Filament Profiles
              {data && (
                <Badge variant="secondary">{data.bambuProfiles.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-4">Loading…</p>
            ) : !data || data.bambuProfiles.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground mb-1">
                  No filament profiles yet.
                </p>
                <p className="text-sm text-muted-foreground">
                  Add your printer in <strong>Settings</strong> — profiles are fetched automatically during login.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">Profile ID</th>
                      {(['name', 'vendor', 'material', 'status'] as const).map(col => (
                        <th key={col} className="text-left py-2 pr-4 font-medium">
                          <button onClick={() => toggleSort(col)} className="flex items-center gap-1 hover:text-foreground capitalize">
                            {col}
                            <span className="text-xs">{sortCol === col ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                          </button>
                        </th>
                      ))}
                      <th className="text-left py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProfiles.map(profile => (
                      <tr key={profile.filamentId} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{profile.filamentId}</td>
                        <td className="py-2 pr-4">{profile.name ?? '—'}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{profile.vendor ?? '—'}</td>
                        <td className="py-2 pr-4">
                          {profile.material ? (
                            <Badge variant="outline">{profile.material}</Badge>
                          ) : '—'}
                        </td>
                        <td className="py-2 pr-4">
                          {(() => {
                            const count = linkedCountMap.get(profile.filamentId) ?? 0;
                            return count > 0 ? (
                              <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">{count} Linked</Badge>
                            ) : (
                              <Badge variant="secondary">Unlinked</Badge>
                            );
                          })()}
                        </td>
                        <td className="py-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openLinkModal(profile)}
                          >
                            {profile.linked ? 'Manage Links' : 'Link to Spoolman'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bambu color reference palette */}
        <div className="mt-4">
          <button
            onClick={() => setShowPalette(v => { const next = !v; localStorage.setItem('filaments_showPalette', String(next)); return next; })}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            Bambu Color Reference {showPalette ? '▲' : '▼'}
          </button>
          {showPalette && (
            <Card className="mt-2">
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground mb-3">
                  These are the 20 fixed colors the Bambu machine display uses. Set your Spoolman filament colors
                  to the closest matching entry — the auto-matcher tolerates up to 40 RGB units of distance.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {BAMBU_PALETTE.map(group => (
                    <div key={group.group}>
                      <p className="text-xs font-medium text-muted-foreground mb-2">{group.group}</p>
                      <div className="space-y-1">
                        {group.colors.map(color => (
                          <div key={color.hex} className="flex items-center gap-2">
                            <span
                              className="w-5 h-5 rounded flex-shrink-0 border border-border"
                              style={{ backgroundColor: `#${color.hex}` }}
                            />
                            <span className="text-sm">{color.name}</span>
                            <span className="text-xs text-muted-foreground font-mono ml-auto">#{color.hex}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Link modal */}
        {linkingProfile && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <Card className="w-full max-w-lg mx-4">
              <CardHeader>
                <CardTitle className="text-base">
                  Link <span className="font-mono text-sm">{linkingProfile.filamentId}</span>
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {linkingProfile.vendor} {linkingProfile.name} ({linkingProfile.material}) —
                  select all matching Spoolman filaments (e.g. different colors of same material)
                </p>
              </CardHeader>
              <CardContent>
                <Input
                  placeholder="Search filaments…"
                  value={linkSearch}
                  onChange={e => setLinkSearch(e.target.value)}
                  className="mb-2"
                  autoFocus
                />
                <div className="flex gap-2 mb-3">
                  <Select value={linkFilterMaterial || '__all__'} onValueChange={v => setLinkFilterMaterial(v === '__all__' ? '' : v)}>
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue placeholder="All Material" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Material</SelectItem>
                      {allMaterials.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={linkFilterVendor || '__all__'} onValueChange={v => setLinkFilterVendor(v === '__all__' ? '' : v)}>
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue placeholder="All Vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All Vendor</SelectItem>
                      {allVendors.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="max-h-[60vh] overflow-y-auto space-y-1">
                  {filteredSpoolmanFilaments.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">No filaments found</p>
                  ) : (
                    filteredSpoolmanFilaments.map(f => {
                      const checked = linkSelected.has(f.id);
                      return (
                        <button
                          key={f.id}
                          onClick={() => toggleLinkSelection(f.id)}
                          disabled={linkLoading}
                          className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 transition-colors ${checked ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted'}`}
                        >
                          <span className={`w-4 h-4 rounded flex-shrink-0 border-2 flex items-center justify-center text-xs ${checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground'}`}>
                            {checked ? '✓' : ''}
                          </span>
                          {f.color_hex && (
                            <span
                              className="w-4 h-4 rounded-full flex-shrink-0 border"
                              style={{ backgroundColor: `#${f.color_hex.replace('#', '').slice(0, 6)}` }}
                            />
                          )}
                          <span className="font-medium">{f.name}</span>
                          <span className="text-muted-foreground">— {f.material}</span>
                          {f.vendor && <span className="text-muted-foreground text-xs">({f.vendor.name})</span>}
                          <span className="text-muted-foreground text-xs ml-auto">#{f.id}</span>
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {linkSelected.size} selected
                  </span>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => { setLinkingProfile(null); setLinkSearch(''); setLinkFilterMaterial(''); setLinkFilterVendor(''); }}>
                      Cancel
                    </Button>
                    <Button
                      onClick={handleLinkSelected}
                      disabled={linkLoading || linkSelected.size === 0}
                    >
                      {linkLoading ? 'Saving…' : `Link ${linkSelected.size} filament${linkSelected.size !== 1 ? 's' : ''}`}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
