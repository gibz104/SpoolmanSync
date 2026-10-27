'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface RecentPrint {
  id: string;
  printer: string;
  name: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  settled: boolean;
  attention: string | null;
  spools: { spoolId: number; name: string | null; grams: number }[];
}

export interface TrackerStatus {
  connected: boolean;
  detail: string | null;
}

const OUTCOME: Record<string, string> = {
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  ended: 'Ended',
  interrupted: 'Not seen to end',
  abandoned: 'Printer stopped reporting',
  missed: 'Not seen',
};

/** What the usage tracker recorded for each recent print. */
export function RecentPrints({ prints, tracker }: { prints: RecentPrint[]; tracker: TrackerStatus | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Prints</CardTitle>
        <CardDescription>
          {tracker === null
            ? 'Usage tracking has not started.'
            : tracker.connected
              ? 'SpoolmanSync is following your printers in Home Assistant and deducting what each print uses.'
              : `Not connected to Home Assistant (${tracker.detail ?? 'disconnected'}); usage is caught up once it reconnects.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {prints.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prints recorded yet.</p>
        ) : (
          <ul className="divide-y">
            {prints.map(print => (
              <li key={print.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{print.name ?? 'Untitled print'}</span>
                  <span className="text-muted-foreground">on {print.printer}</span>
                  <Badge variant={print.endedAt ? 'secondary' : 'default'}>
                    {print.endedAt ? OUTCOME[print.outcome ?? ''] ?? print.outcome : 'Printing'}
                  </Badge>
                  {print.endedAt && !print.settled && <Badge variant="outline">Waiting for Spoolman</Badge>}
                  <time className="ml-auto text-xs text-muted-foreground">{new Date(print.startedAt).toLocaleString()}</time>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {print.spools.length === 0
                    ? 'Nothing deducted'
                    : print.spools.map(s => `${s.grams.toFixed(2)}g from #${s.spoolId}${s.name ? ` ${s.name}` : ''}`).join(', ')}
                </div>
                {print.attention && <p className="mt-1 text-amber-600 dark:text-amber-400">{print.attention}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
