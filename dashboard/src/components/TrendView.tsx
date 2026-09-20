import { BarChart } from '@tremor/react';
import { TrendingUp } from 'lucide-react';
import type { RunSummary } from '@/lib/types';

export interface TrendViewProps {
  runs: RunSummary[];
}

/** The evaluator's p95 rule, drawn as the bar a run has to clear. */
const P95_THRESHOLD_PCT = 10;

function shortRunId(runId: string): string {
  // klyro-<unix-ts>-<6-hex> — the hash suffix is the only part that
  // differs meaningfully at a glance.
  const parts = runId.split('-');
  return parts.length >= 3 ? parts[parts.length - 1] : runId;
}

/**
 * p95 improvement across runs.
 *
 * Klyro measures one run at a time, which makes it easy to miss that the
 * interesting question is whether the loop is *consistently* finding and
 * validating the same class of regression. Every value here comes from a
 * report.json that list-runs already had to open, so this costs no extra
 * reads.
 */
export function TrendView({ runs }: TrendViewProps) {
  // Oldest-first reads left-to-right as "over time"; list-runs returns
  // newest-first for the history list.
  const plottable = runs
    .filter((r) => typeof r.improvementPct === 'number')
    .slice()
    .reverse();

  if (plottable.length < 2) return null;

  const data = plottable.map((r) => ({
    run: shortRunId(r.runId),
    'p95 improvement': Number((r.improvementPct as number).toFixed(1)),
  }));

  const validated = plottable.filter((r) => r.verdict === 'OPTIMIZATION VALIDATED').length;
  const best = Math.max(...plottable.map((r) => r.improvementPct as number));

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <TrendingUp className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium">p95 improvement across runs</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {validated} of {plottable.length} runs cleared the {P95_THRESHOLD_PCT}% bar. Best so far:{' '}
        <span className="font-mono text-foreground">{best.toFixed(1)}%</span>.
      </p>

      <BarChart
        className="h-56"
        data={data}
        index="run"
        categories={['p95 improvement']}
        colors={['cyan']}
        valueFormatter={(v: number) => `${v}%`}
        showLegend={false}
        showAnimation
      />

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        A run is only validated at {P95_THRESHOLD_PCT}% or better, and only when the error rate and CPU checks also
        pass &mdash; so a tall bar alone is not a pass. Runs with no measured improvement are omitted.
      </p>
    </div>
  );
}
