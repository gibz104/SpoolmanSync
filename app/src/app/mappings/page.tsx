'use client';

import { useState, useEffect, useCallback } from 'react';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import { toast } from 'sonner';
import type { Spool } from '@/lib/api/spoolman';
import { buildSpoolSearchValue } from '@/lib/api/spoolman';

interface MappingSpool {
  name: string;
  material: string;
  color_hex: string;
  vendor: string;
  archived: boolean;
}

interface FilamentMapping {
  id: string;
  name: string;
  material: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  spool: MappingSpool | null;
}

export default function MappingsPage() {
  const [mappings, setMappings] = useState<FilamentMapping[]>([]);
  const [spools, setSpools] = useState<Spool[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingMapping, setEditingMapping] = useState<FilamentMapping | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const fetchMappings = useCallback(async () => {
    try {
      const res = await fetch('/api/mappings');
      const data = await res.json();
      setMappings(data.mappings || []);
    } catch {
      toast.error('Failed to load mappings');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSpools = useCallback(async () => {
    try {
      const res = await fetch('/api/spools');
      const data = await res.json();
      setSpools(data.spools || []);
    } catch {
      // Spools needed for edit dialog only
    }
  }, []);

  useEffect(() => {
    fetchMappings();
    fetchSpools();
  }, [fetchMappings, fetchSpools]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch('/api/mappings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error();
      toast.success('Mapping deleted');
      fetchMappings();
    } catch {
      toast.error('Failed to delete mapping');
    }
  };

  const handleChangeSpool = async (mapping: FilamentMapping, newSpoolId: number) => {
    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: mapping.name,
          material: mapping.material,
          color: mapping.color,
          spoolId: newSpoolId,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Mapping updated');
      setEditDialogOpen(false);
      setEditingMapping(null);
      fetchMappings();
    } catch {
      toast.error('Failed to update mapping');
    }
  };

  const formatColor = (hex: string) => `#${hex}`;

  const formatSpoolLine = (s: MappingSpool) =>
    [s.name, s.material, s.vendor].filter((p) => p.trim() !== '').join(' / ');

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-7xl mx-auto px-3 sm:px-4 md:px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Filament Mappings</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Mappings link printer-reported filament name, material, and color to a specific spool for automatic assignment without RFID
            </p>
          </div>
        </div>

        {loading ? (
          <Card>
            <CardContent className="py-8">
              <p className="text-center text-muted-foreground">Loading mappings...</p>
            </CardContent>
          </Card>
        ) : mappings.length === 0 ? (
          <Card>
            <CardContent className="py-12">
              <div className="text-center space-y-3">
                <p className="text-muted-foreground">No filament mappings yet</p>
                <p className="text-sm text-muted-foreground">
                  Mappings are created automatically when you assign a spool to a tray that has no RFID tag.
                  You can enable or disable this in Settings.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {mappings.map((mapping) => (
              <Card key={mapping.id}>
                <CardContent className="py-4">
                  <div className="flex items-center gap-4">
                    {/* Color swatch */}
                    <div
                      className="h-10 w-10 rounded-full flex-shrink-0"
                      style={{
                        backgroundColor: formatColor(mapping.color),
                        border: '2px solid var(--border)',
                      }}
                    />

                    {/* Mapping info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary">{mapping.material}</Badge>
                        <span className="text-sm font-medium truncate">{mapping.name}</span>
                        <span className="text-xs text-muted-foreground">{formatColor(mapping.color)}</span>
                      </div>

                      {/* Spool info */}
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">→</span>
                        {mapping.spool ? (
                          <span className="text-sm">
                            {mapping.spool.archived && (
                              <Badge variant="outline" className="mr-1 text-orange-600 border-orange-300">Archived</Badge>
                            )}
                            <span className="font-medium">{formatSpoolLine(mapping.spool)}</span>
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            Linked spool not found in Spoolman{' '}
                            <Badge variant="outline" className="text-red-600 border-red-300">Missing</Badge>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Dialog open={editDialogOpen && editingMapping?.id === mapping.id} onOpenChange={(open) => {
                        setEditDialogOpen(open);
                        if (!open) setEditingMapping(null);
                      }}>
                        <DialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingMapping(mapping);
                              setEditDialogOpen(true);
                            }}
                          >
                            Change Spool
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-lg">
                          <DialogHeader>
                            <DialogTitle>Change Spool for Mapping</DialogTitle>
                            <DialogDescription>
                              {mapping.material} &quot;{mapping.name}&quot; ({formatColor(mapping.color)})
                            </DialogDescription>
                          </DialogHeader>
                          <Command className="border rounded-lg">
                            <CommandInput placeholder="Search spools..." />
                            <CommandList className="max-h-80">
                              <CommandEmpty>No spools found.</CommandEmpty>
                              <CommandGroup>
                                {spools.map((spool) => (
                                  <CommandItem
                                    key={spool.id}
                                    value={buildSpoolSearchValue(spool)}
                                    onSelect={() => handleChangeSpool(mapping, spool.id)}
                                  >
                                    <div className="flex items-center gap-3 w-full">
                                      <SpoolColorSwatch filament={spool.filament} size="h-6 w-6" />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <Badge variant="secondary" className="text-xs">{spool.filament.material}</Badge>
                                          <span className="text-sm font-medium truncate">{spool.filament.name}</span>
                                        </div>
                                        {spool.filament.vendor?.name && (
                                          <div className="text-xs text-muted-foreground truncate">
                                            {spool.filament.vendor.name}
                                          </div>
                                        )}
                                      </div>
                                      <div className="text-xs text-muted-foreground whitespace-nowrap">
                                        {spool.remaining_weight.toFixed(0)}g
                                      </div>
                                    </div>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </DialogContent>
                      </Dialog>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(mapping.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}

            <p className="text-xs text-muted-foreground text-center pt-2">
              {mappings.length} mapping{mappings.length !== 1 ? 's' : ''}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
