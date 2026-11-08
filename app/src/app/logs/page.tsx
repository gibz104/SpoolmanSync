'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';

interface ActivityLog {
  id: string;
  type: string;
  message: string;
  details: string | null;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type FilterType = 'all' | 'actions' | 'tray_changes' | 'errors';

const FILTER_OPTIONS: { value: FilterType; label: string; description: string }[] = [
  { value: 'all', label: 'All Events', description: 'Show all activity' },
  { value: 'actions', label: 'Actions', description: 'Spool assignments and usage' },
  { value: 'tray_changes', label: 'Tray Changes', description: 'All detected tray changes' },
  { value: 'errors', label: 'Errors', description: 'Errors only' },
];

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export default function LogsPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenLogIdsRef = useRef<Set<string>>(new Set());

  // Edit/delete state for usage events (issue #54)
  const [editTarget, setEditTarget] = useState<ActivityLog | null>(null);
  const [editWeight, setEditWeight] = useState('');
  const [editAdjustSpoolman, setEditAdjustSpoolman] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ActivityLog | null>(null);
  const [deleteAdjustSpoolman, setDeleteAdjustSpoolman] = useState(false);
  const [mutating, setMutating] = useState(false);

  /** Load a page of logs; false, keeping what is shown, if they could not be loaded. */
  const fetchLogs = useCallback(async (pageNum: number = page, filterType: FilterType = filter, limit: number = pageSize): Promise<boolean> => {
    try {
      setLoading(true);
      const res = await fetch(`/api/logs?page=${pageNum}&limit=${limit}&filter=${filterType}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const fetchedLogs = data.logs || [];
      setLogs(fetchedLogs);
      setPagination(data.pagination || null);

      // Update seen IDs ref for duplicate detection in SSE
      seenLogIdsRef.current = new Set(fetchedLogs.map((log: ActivityLog) => log.id));
      return true;
    } catch (err) {
      console.error('Failed to fetch logs:', err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [page, filter, pageSize]);

  // The reload is often too quick to see, so the button spins and then says how it went.
  const refresh = async () => {
    setRefreshing(true);
    const ok = await fetchLogs(page, filter, pageSize);
    setRefreshing(false);
    if (ok) toast.success('Logs refreshed');
    else toast.error('Could not load the logs. Try again in a moment.');
  };

  useEffect(() => {
    fetchLogs(page, filter, pageSize);
  }, [page, filter, pageSize, fetchLogs]);

  useEffect(() => {
    // Try SSE for real-time updates, fall back to polling if SSE doesn't work
    // (HA's ingress proxy doesn't support SSE streaming)
    let eventSource: EventSource | null = null;
    let sseConnected = false;
    let pollInterval: NodeJS.Timeout | null = null;
    let sseCheckTimeout: NodeJS.Timeout | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const startPolling = () => {
      if (pollInterval) return;
      console.log('SSE unavailable on logs page, falling back to polling every 2s');
      pollInterval = setInterval(() => {
        fetchLogs(page, filter, pageSize);
      }, 2000);
    };

    const handleSSEMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          sseConnected = true;
          setConnected(true);
          if (sseCheckTimeout) {
            clearTimeout(sseCheckTimeout);
            sseCheckTimeout = null;
          }
          // If we fell back to polling after a drop and SSE has now
          // re-established, stop the redundant polling.
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          return;
        }

        if (data.type === 'heartbeat') return;

        if (data.eventType === 'activity_log') {
          const matchesFilter = shouldShowLog(data.type, filter);

          if (matchesFilter && page === 1) {
            if (seenLogIdsRef.current.has(data.id)) {
              return;
            }

            seenLogIdsRef.current.add(data.id);

            setLogs((prevLogs) => {
              return [{
                id: data.id,
                type: data.type,
                message: data.message,
                details: data.details,
                createdAt: data.createdAt,
              }, ...prevLogs].slice(0, pageSize);
            });

            setPagination((prev) => {
              if (!prev) return prev;
              const newTotal = prev.total + 1;
              return {
                ...prev,
                total: newTotal,
                totalPages: Math.ceil(newTotal / prev.limit),
              };
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    const connect = () => {
      eventSource = new EventSource('/api/events');
      eventSourceRef.current = eventSource;
      eventSource.onmessage = handleSSEMessage;

      eventSource.onerror = () => {
        setConnected(false);
        eventSource?.close();
        eventSource = null;
        eventSourceRef.current = null;
        if (!sseConnected) {
          // SSE never connected — go straight to polling
          if (sseCheckTimeout) {
            clearTimeout(sseCheckTimeout);
            sseCheckTimeout = null;
          }
          startPolling();
        } else {
          // Was connected then dropped — fall back to polling so updates keep
          // flowing, and also try to re-establish SSE after a short delay
          startPolling();
          reconnectTimeout = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    // If SSE doesn't deliver a "connected" message within 4 seconds, fall back to polling
    sseCheckTimeout = setTimeout(() => {
      if (!sseConnected) {
        eventSource?.close();
        eventSource = null;
        eventSourceRef.current = null;
        startPolling();
      }
    }, 4000);

    return () => {
      eventSource?.close();
      if (sseCheckTimeout) clearTimeout(sseCheckTimeout);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [filter, page, pageSize, fetchLogs]);

  const shouldShowLog = (type: string, filterType: FilterType): boolean => {
    if (filterType === 'all') return true;
    if (filterType === 'actions') {
      return ['spool_usage', 'spool_change', 'spool_unassign', 'spool_assign', 'tag_stored'].includes(type);
    }
    if (filterType === 'tray_changes') {
      return ['spool_change', 'spool_unassign', 'tray_change_detected', 'tray_empty_detected'].includes(type);
    }
    if (filterType === 'errors') {
      return type === 'error';
    }
    return true;
  };

  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter);
    setPage(1); // Reset to first page when filter changes
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1); // Reset to first page when page size changes
  };

  const getTypeBadgeVariant = (type: string) => {
    switch (type) {
      case 'error':
        return 'destructive';
      case 'spool_change':
      case 'spool_assign':
        return 'default';
      case 'spool_usage':
        return 'secondary';
      case 'spool_unassign':
        return 'outline';
      case 'tray_change_detected':
      case 'tray_empty_detected':
        return 'secondary';
      case 'tag_stored':
        return 'outline';
      case 'connection':
        return 'secondary';
      case 'webhook':
      case 'print_started':
      case 'print_ended':
        return 'outline';
      default:
        return 'secondary';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'spool_usage':
        return 'Usage';
      case 'spool_change':
        return 'Assigned';
      case 'spool_assign':
        return 'Assigned';
      case 'spool_unassign':
        return 'Unassigned';
      case 'tray_change_detected':
        return 'Tray Change';
      case 'tray_empty_detected':
        return 'Empty Tray';
      case 'tag_stored':
        return 'Tag Stored';
      case 'usage_attention':
        return 'Check Usage';
      case 'print_started':
        return 'Print Started';
      case 'print_ended':
        return 'Print Ended';
      case 'error':
        return 'Error';
      case 'connection':
        return 'Connection';
      default:
        return type;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // Pretty-print details JSON, falling back to the raw string if it isn't
  // valid JSON so a malformed payload never crashes the row.
  const formatDetails = (details: string) => {
    try {
      return JSON.stringify(JSON.parse(details), null, 2);
    } catch {
      return details;
    }
  };

  // Pull the recorded usedWeight (grams) out of a usage event's details JSON.
  // Guarded the same way as formatDetails so a malformed payload never crashes.
  const getUsedWeight = (details: string | null): number | null => {
    if (!details) return null;
    try {
      const parsed = JSON.parse(details);
      return typeof parsed.usedWeight === 'number' ? parsed.usedWeight : null;
    } catch {
      return null;
    }
  };

  const openEdit = (log: ActivityLog) => {
    const current = getUsedWeight(log.details);
    setEditTarget(log);
    setEditWeight(current != null ? String(current) : '');
    setEditAdjustSpoolman(false);
  };

  const openDelete = (log: ActivityLog) => {
    setDeleteTarget(log);
    setDeleteAdjustSpoolman(false);
  };

  const handleEditSave = async () => {
    if (!editTarget) return;
    const weight = Number(editWeight);
    if (!isFinite(weight) || weight < 0) {
      toast.error('Enter a valid non-negative weight in grams');
      return;
    }
    try {
      setMutating(true);
      const res = await fetch('/api/logs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editTarget.id, usedWeight: weight, adjustSpoolman: editAdjustSpoolman }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Failed to edit usage event');
      }
      toast.success('Usage event updated');
      if (data.warning) {
        toast.error(data.warning);
      }
      setEditTarget(null);
      await fetchLogs(page, filter, pageSize);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to edit usage event');
    } finally {
      setMutating(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      setMutating(true);
      const res = await fetch('/api/logs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id, adjustSpoolman: deleteAdjustSpoolman }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Failed to delete usage event');
      }
      toast.success('Usage event deleted');
      if (data.warning) {
        toast.error(data.warning);
      }
      setDeleteTarget(null);
      await fetchLogs(page, filter, pageSize);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete usage event');
    } finally {
      setMutating(false);
    }
  };

  if (loading && logs.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold">Activity Logs</h1>
            {connected && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <Button variant="outline" onClick={refresh} disabled={refreshing} className="w-auto self-start sm:self-auto">
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          By default, editing or deleting a usage event only corrects SpoolmanSync statistics — it does not change the
          spool&apos;s remaining weight in Spoolman unless you opt in.
        </p>

        {/* Filter tabs */}
        <div className="mb-4 grid grid-cols-4 sm:flex sm:flex-wrap gap-2">
          {FILTER_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={filter === option.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleFilterChange(option.value)}
              title={option.description}
              className="text-xs sm:text-sm h-auto min-h-[32px] py-1 text-center whitespace-normal"
            >
              {option.label}
            </Button>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>
                {FILTER_OPTIONS.find(o => o.value === filter)?.label || 'Activity'}
              </CardTitle>
              {pagination && (
                <span className="text-sm text-muted-foreground">
                  {pagination.total} total events
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                No activity logs yet
              </p>
            ) : (
              <div className="space-y-3">
                {logs.map((log) => (
                  <div
                    key={log.id}
                    className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 border-b pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center justify-between sm:contents">
                      <Badge variant={getTypeBadgeVariant(log.type)} className="shrink-0">
                        {getTypeLabel(log.type)}
                      </Badge>
                      <time className="text-xs text-muted-foreground whitespace-nowrap sm:order-last">
                        {formatDate(log.createdAt)}
                      </time>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm break-words">{log.message}</p>
                      {log.details && (
                        <details className="mt-1">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            Details
                          </summary>
                          <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto">
                            {formatDetails(log.details)}
                          </pre>
                        </details>
                      )}
                      {log.type === 'spool_usage' && (
                        <div className="mt-2 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => openEdit(log)}
                            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => openDelete(log)}
                            className="text-xs text-muted-foreground hover:text-destructive underline-offset-2 hover:underline"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Pagination controls */}
            {pagination && (
              <div className="mt-6 flex items-center justify-between border-t pt-4">
                <div className="flex items-center gap-2">
                  {pagination.totalPages > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1 || loading}
                    >
                      Previous
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {pagination.totalPages > 1 && (
                    <span className="text-sm text-muted-foreground">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <label htmlFor="pageSize" className="text-sm text-muted-foreground">
                      Show:
                    </label>
                    <select
                      id="pageSize"
                      value={pageSize}
                      onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {pagination.totalPages > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                      disabled={page >= pagination.totalPages || loading}
                    >
                      Next
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Edit usage event dialog (issue #54) */}
        <Dialog open={editTarget !== null} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit usage event</DialogTitle>
              <DialogDescription>
                Correct the grams recorded for this usage event. This only updates SpoolmanSync statistics unless you
                opt in to adjust Spoolman below.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="editWeight">Used weight (g)</Label>
                <Input
                  id="editWeight"
                  type="number"
                  min={0}
                  step="0.01"
                  value={editWeight}
                  onChange={(e) => setEditWeight(e.target.value)}
                  disabled={mutating}
                />
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="editAdjustSpoolman"
                  checked={editAdjustSpoolman}
                  onCheckedChange={(checked) => setEditAdjustSpoolman(checked === true)}
                  disabled={mutating}
                />
                <Label htmlFor="editAdjustSpoolman" className="text-sm font-normal leading-snug">
                  Also adjust Spoolman remaining weight
                </Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditTarget(null)} disabled={mutating}>
                Cancel
              </Button>
              <Button onClick={handleEditSave} disabled={mutating}>
                {mutating ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete usage event confirmation dialog (issue #54) */}
        <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete usage event</DialogTitle>
              <DialogDescription>
                This removes the usage event from SpoolmanSync statistics. It does not change the spool&apos;s remaining
                weight in Spoolman unless you opt in below.
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="deleteAdjustSpoolman"
                  checked={deleteAdjustSpoolman}
                  onCheckedChange={(checked) => setDeleteAdjustSpoolman(checked === true)}
                  disabled={mutating}
                />
                <Label htmlFor="deleteAdjustSpoolman" className="text-sm font-normal leading-snug">
                  Also adjust Spoolman remaining weight (return the deducted grams to the spool)
                </Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={mutating}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDeleteConfirm} disabled={mutating}>
                {mutating ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
