'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Nav } from '@/components/nav';
import { PeriodSelector } from '@/components/reports/period-selector';
import { SummaryCards } from '@/components/reports/summary-cards';
import { UsageBySpool } from '@/components/reports/usage-by-spool';
import { UsageOverTime } from '@/components/reports/usage-over-time';
import type { SpoolData } from '@/components/reports/usage-by-spool';
import { RecentPrints, type RecentPrint, type TrackerStatus } from '@/components/reports/recent-prints';

interface TimeBucket {
  date: string;
  totalWeight: number;
  bySpoolId: Record<number, number>;
}

interface ReportData {
  summary: {
    totalWeight: number;
    totalPrints: number;
    uniqueSpools: number;
  };
  bySpool: SpoolData[];
  overTime: TimeBucket[];
}

export default function ReportsPage() {
  const [selectedDays, setSelectedDays] = useState<number | null>(30);
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ tracker: TrackerStatus | null; prints: RecentPrint[] } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const bucket = selectedDays !== null && selectedDays > 90 ? 'week' : 'day';

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (selectedDays !== null) {
        const from = new Date();
        from.setDate(from.getDate() - selectedDays);
        params.set('from', from.toISOString());
      }
      params.set('bucket', bucket);
      params.set('tz', String(new Date().getTimezoneOffset()));

      const res = await fetch(`/api/reports/usage?${params}`);
      if (!res.ok) throw new Error('Failed to fetch report');
      const json: ReportData = await res.json();
      setData(json);
      const usageRes = await fetch('/api/usage');
      if (usageRes.ok) setUsage(await usageRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [selectedDays, bucket]);

  // Fetch on mount and when period changes
  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // Real-time: SSE with polling fallback (same pattern as logs page)
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let sseConnected = false;
    let pollInterval: NodeJS.Timeout | null = null;
    let sseCheckTimeout: NodeJS.Timeout | null = null;

    const startPolling = () => {
      if (pollInterval) return;
      pollInterval = setInterval(() => fetchReport(), 5000);
    };

    eventSource = new EventSource('/api/events');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'connected') {
          sseConnected = true;
          if (sseCheckTimeout) {
            clearTimeout(sseCheckTimeout);
            sseCheckTimeout = null;
          }
          return;
        }
        if (parsed.type === 'heartbeat') return;

        // Refresh reports when a spool_usage event arrives
        if (parsed.eventType === 'activity_log' && parsed.type === 'spool_usage') {
          fetchReport();
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      eventSourceRef.current = null;
      // Always fall back to polling — whether SSE never connected or it
      // connected then dropped. startPolling() is idempotent (it returns
      // early if already polling).
      if (sseCheckTimeout) {
        clearTimeout(sseCheckTimeout);
        sseCheckTimeout = null;
      }
      startPolling();
    };

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
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [fetchReport]);

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-7xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h1 className="text-xl sm:text-2xl font-bold">Filament Usage Reports</h1>
          <PeriodSelector selectedDays={selectedDays} onChange={setSelectedDays} />
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-destructive">{error}</p>
          </div>
        ) : data && data.summary.totalPrints === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground text-lg mb-2">No filament usage data yet</p>
            <p className="text-muted-foreground text-sm">
              Usage is recorded automatically when print jobs complete. Assign spools to trays
              and start printing to see reports here.
            </p>
          </div>
        ) : data ? (
          <div className="space-y-6">
            <SummaryCards
              totalWeight={data.summary.totalWeight}
              totalPrints={data.summary.totalPrints}
              uniqueSpools={data.summary.uniqueSpools}
            />
            <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
              <UsageBySpool data={data.bySpool} />
              <UsageOverTime data={data.overTime} spools={data.bySpool} bucket={bucket} />
            </div>
          </div>
        ) : null}
        {usage && <div className="mt-6"><RecentPrints prints={usage.prints} tracker={usage.tracker} /></div>}
      </main>
    </div>
  );
}
