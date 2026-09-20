import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { HeroStatusCard, type HeroState } from '@/components/HeroStatusCard';
import { PipelineView } from '@/components/PipelineView';
import { VerdictView } from '@/components/VerdictView';
import { RunHistoryView } from '@/components/RunHistoryView';
import { MetricDeltaCardSkeleton } from '@/components/Skeleton';
import { useReportPolling } from '@/hooks/useReportPolling';
import { usePipelineStatus } from '@/hooks/usePipelineStatus';
import { startRun } from '@/lib/api';
import { isTerminal } from '@/lib/pipelineTypes';

function deriveHeroState(
  runId: string | null,
  pipelineOverallStatus: string | undefined,
  report: ReturnType<typeof useReportPolling>['report']
): HeroState {
  if (!runId) return 'idle';
  if (report) {
    if (report.verdict === 'OPTIMIZATION VALIDATED') return 'validated';
    if (report.verdict === 'NOT VALIDATED') return 'done';
    if (report.verdict === 'FAILED') return report.error?.Error === 'GUARD_REJECTED' ? 'rejected' : 'failed';
  }
  if (pipelineOverallStatus && pipelineOverallStatus !== 'RUNNING') {
    // Terminal per Step Functions but report.json hasn't landed yet
    // (useReportPolling is still catching up) — treat as done/failed by
    // the coarser SFN-level outcome in the meantime.
    return pipelineOverallStatus === 'SUCCEEDED' ? 'done' : 'failed';
  }
  return 'active';
}

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const [starting, setStarting] = useState(false);

  const { status: pipelineStatus, error: pipelineError } = usePipelineStatus(runId);
  const runTerminal = pipelineStatus ? isTerminal(pipelineStatus.overallStatus) : false;
  // Only start polling report.json once the Step Functions execution
  // itself has reached a terminal state — this IS the "auto-navigate to
  // the before/after verdict view" transition: report.json existing (or
  // not) is what flips the rendered content below from PipelineView to
  // VerdictView.
  const { report, error: reportError } = useReportPolling(runTerminal ? runId : null);

  useEffect(() => {
    const initial = new URL(window.location.href).searchParams.get('runId');
    if (initial) {
      setRunId(initial);
      setSearchValue(initial);
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('runId', runId);
    window.history.replaceState(null, '', url.toString());
  }, [runId]);

  useEffect(() => {
    if (pipelineError) toast.error('Failed to load pipeline status', { description: pipelineError });
  }, [pipelineError]);
  useEffect(() => {
    if (reportError) toast.error('Failed to load report', { description: reportError });
  }, [reportError]);

  async function handleRunExperiment() {
    setStarting(true);
    try {
      const res = await startRun();
      setRunId(res.runId);
      setSearchValue(res.runId);
      toast.success('Experiment started', { description: res.runId });
    } catch (err) {
      toast.error('Could not start run', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = searchValue.trim();
    if (trimmed) setRunId(trimmed);
  }

  function handleSelectRun(id: string) {
    setRunId(id);
    setSearchValue(id);
  }

  const heroState = deriveHeroState(runId, pipelineStatus?.overallStatus, report);
  const statusLine = !runId
    ? undefined
    : !runTerminal
      ? (pipelineStatus?.currentStage ? `Running — ${pipelineStatus.currentStage}…` : 'Starting…')
      : !report
        ? 'Finishing up — writing report…'
        : undefined;

  return (
    <div className="min-h-screen bg-background p-6 sm:p-10">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Klyro</h1>
          <p className="text-sm text-muted-foreground">
            Automated before/after performance verdicts for a seeded Node/Express/Postgres bug.
          </p>
        </header>

        <form onSubmit={handleSearchSubmit} className="mx-auto flex max-w-md gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="klyro-1789885248-83e2a9"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 font-mono text-sm outline-none transition-colors hover:border-muted-foreground/40 focus:border-primary/60"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            Load
          </button>
        </form>

        <HeroStatusCard
          state={heroState}
          runId={runId ?? undefined}
          statusLine={statusLine}
          onRunExperiment={handleRunExperiment}
          starting={starting}
        />

        {runId && !runTerminal && pipelineStatus && <PipelineView stages={pipelineStatus.stages} />}

        {runId && runTerminal && !report && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <MetricDeltaCardSkeleton key={i} />
            ))}
          </div>
        )}

        {report && <VerdictView report={report} />}

        <RunHistoryView onSelectRun={handleSelectRun} />
      </div>
    </div>
  );
}
