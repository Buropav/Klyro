import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { History, RefreshCw } from 'lucide-react';
import { StatusBadge, type Status } from '@/components/StatusBadge';
import { Skeleton } from '@/components/Skeleton';
import { TrendView } from '@/components/TrendView';
import { listRuns } from '@/lib/api';
import type { RunSummary } from '@/lib/types';

export interface RunHistoryViewProps {
  onSelectRun: (runId: string) => void;
  /**
   * Bump to refetch. App passes the current runId's terminal state so a
   * finished run appears in the history without a manual refresh — the
   * list previously only reloaded when the button was clicked.
   */
  refreshKey?: string | number;
}

function verdictBadge(run: RunSummary): { status: Status; label: string } {
  if (run.verdict === 'OPTIMIZATION VALIDATED') return { status: 'validated', label: 'VALIDATED' };
  if (run.verdict === 'NOT VALIDATED') return { status: 'done', label: 'NOT VALIDATED' };
  if (run.verdict === 'FAILED') {
    return run.guardRejected ? { status: 'rejected', label: 'REJECTED' } : { status: 'failed', label: 'FAILED' };
  }
  return { status: 'pending', label: 'UNKNOWN' };
}

function formatTimestamp(ts: string): string {
  // new Date(garbage).toLocaleString() returns "Invalid Date" rather than
  // throwing, so a try/catch here would never fire — check explicitly.
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Compact per-run stats, omitted entirely on runs that have none. */
function RunStats({ run }: { run: RunSummary }) {
  const bits: string[] = [];
  if (typeof run.improvementPct === 'number') bits.push(`${run.improvementPct.toFixed(1)}% p95`);
  if (typeof run.durationMs === 'number') bits.push(`${Math.round(run.durationMs / 1000 / 60)}m`);
  if (typeof run.costUsd === 'number') bits.push(`$${run.costUsd.toFixed(3)}`);
  if (bits.length === 0) return null;
  return <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{bits.join(' · ')}</span>;
}

const staggerContainer = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const staggerItem = { hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } };

export function RunHistoryView({ onSelectRun, refreshKey }: RunHistoryViewProps) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listRuns()
      .then((r) => {
        if (cancelled) return;
        setRuns(r);
        setError(null); // clear a previous transient failure on success
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [reloadKey, refreshKey]);

  return (
    <div className="space-y-6">
      {runs && runs.length > 0 && <TrendView runs={runs} />}

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <History className="size-3.5" aria-hidden />
            Run history
          </div>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Refresh run history"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        {!runs && !error && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {runs && runs.length === 0 && <p className="text-xs text-muted-foreground">No runs yet.</p>}

        {runs && runs.length > 0 && (
          <motion.ul variants={staggerContainer} initial="hidden" animate="show" className="divide-y divide-border">
            {runs.map((run) => {
              const badge = verdictBadge(run);
              return (
                <motion.li key={run.runId} variants={staggerItem}>
                  <button
                    onClick={() => onSelectRun(run.runId)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-foreground">{run.runId}</div>
                      <div className="text-[11px] text-muted-foreground">{formatTimestamp(run.timestamp)}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <RunStats run={run} />
                      <StatusBadge status={badge.status} label={badge.label} />
                    </div>
                  </button>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </div>
    </div>
  );
}
