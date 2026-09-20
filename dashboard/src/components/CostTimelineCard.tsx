import { BarList } from '@tremor/react';
import { Clock, DollarSign } from 'lucide-react';
import type { RunCost, TimelineStage } from '@/lib/types';

export interface CostTimelineCardProps {
  timeline: TimelineStage[] | null | undefined;
  totalDurationMs: number | null | undefined;
  cost: RunCost | null | undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * Where a run's wall-clock time and money actually went.
 *
 * Both come from report.json: the timeline from the Step Functions
 * execution history collapsed onto the same 10 stages the live pipeline
 * view uses, the cost from measured stage durations times a checked-in
 * ap-south-1 rate table (lambdas/shared/cost.js). The cost is an estimate
 * from published rates, not a billed amount, and says so.
 */
export function CostTimelineCard({ timeline, totalDurationMs, cost }: CostTimelineCardProps) {
  const timed = (timeline ?? []).filter((s): s is TimelineStage & { durationMs: number } => s.durationMs !== null);

  if (timed.length === 0 && !cost) return null;

  const slowest = timed.reduce((max, s) => Math.max(max, s.durationMs), 0);
  const barData = timed.map((s) => ({ name: s.name, value: s.durationMs }));

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Time &amp; cost</h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {typeof totalDurationMs === 'number' && (
            <span className="flex items-center gap-1.5">
              <Clock className="size-3.5" aria-hidden />
              <span className="font-mono text-foreground">{formatDuration(totalDurationMs)}</span>
              <span>total</span>
            </span>
          )}
          {cost && (
            <span className="flex items-center gap-1.5">
              <DollarSign className="size-3.5" aria-hidden />
              <span className="font-mono text-foreground">${cost.totalUsd.toFixed(4)}</span>
              <span>est.</span>
            </span>
          )}
        </div>
      </div>

      {barData.length > 0 && (
        <>
          <p className="mb-2 text-xs text-muted-foreground">Stage duration</p>
          <BarList
            data={barData}
            valueFormatter={(v: number) => formatDuration(v)}
            color="cyan"
            className="text-xs"
          />
          {slowest > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Slowest stage:{' '}
              <span className="font-mono text-foreground">
                {timed.find((s) => s.durationMs === slowest)?.name}
              </span>
            </p>
          )}
        </>
      )}

      {cost && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-xs text-muted-foreground">Estimated cost breakdown</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
            {Object.entries(cost.breakdown).map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <dt className="truncate text-muted-foreground">{key.replace(/_/g, ' ')}</dt>
                <dd className="shrink-0 font-mono text-foreground">${value.toFixed(5)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Estimated from published {cost.basis.region} on-demand rates ({cost.basis.ratesCapturedOn}) applied to this
            run&rsquo;s measured stage durations &mdash; not a billed amount. The builder instance is always-on and costs{' '}
            <span className="font-mono">${cost.builderStandingCostPerDayUsd.toFixed(2)}/day</span> whether or not a run
            happens; only its share of the two build stages is attributed above.
          </p>
        </div>
      )}
    </div>
  );
}
