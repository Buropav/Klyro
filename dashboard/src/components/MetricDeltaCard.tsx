import { motion } from 'motion/react';
import { BarChart } from '@tremor/react';
import { AnimatedNumber, type AnimatedNumberUnit } from '@/components/AnimatedNumber';
import { cn } from '@/lib/utils';

export interface MetricDeltaCardProps {
  label: string;
  before: number;
  after: number;
  unit: AnimatedNumberUnit;
  decimals?: number;
  /** Whether a LOWER after-value counts as an improvement (true for p95/cpu/db-queries/error-rate). */
  lowerIsBetter?: boolean;
  /**
   * How to express the change. 'relative' is a percentage of the before
   * value; 'absolute' is a plain difference in the metric's own unit.
   *
   * Error rate MUST use 'absolute': the evaluator's rule is a
   * percentage-POINT delta (<= 0.5pp, see CLAUDE.md), so showing 0.1% ->
   * 0.3% as "+200%" would contradict a verdict that considers that change
   * passing.
   */
  deltaMode?: 'relative' | 'absolute';
}

export function MetricDeltaCard({
  label,
  before,
  after,
  unit,
  decimals,
  lowerIsBetter = true,
  deltaMode = 'relative',
}: MetricDeltaCardProps) {
  const bothFinite = Number.isFinite(before) && Number.isFinite(after);
  const rawDelta =
    !bothFinite ? null : deltaMode === 'absolute' ? after - before : before !== 0 ? ((after - before) / before) * 100 : null;
  const improved = !bothFinite || after === before ? null : lowerIsBetter ? after < before : after > before;
  const deltaLabel =
    rawDelta === null
      ? '—'
      : deltaMode === 'absolute'
        ? `${rawDelta > 0 ? '+' : ''}${rawDelta.toFixed(decimals ?? 2)}${unit === '%' ? 'pp' : ''}`
        : `${rawDelta > 0 ? '+' : ''}${rawDelta.toFixed(0)}%`;

  const chartData = [{ metric: label, Before: before, After: after }];

  // Only claim the success treatment when the metric actually improved.
  // Previously an unknown delta (before === 0) fell through to
  // 'optimized', so a 0% -> 5% error-rate regression rendered with the
  // success glow.
  const cardState = improved === true ? 'optimized' : 'baseline';

  return (
    <div
      className="card-glow rounded-lg border border-border bg-card p-5"
      data-state={cardState}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {rawDelta !== null && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-mono font-semibold',
              improved === true && 'bg-green-400/10 text-green-400',
              improved === false && 'bg-red-400/10 text-red-400',
              improved === null && 'bg-muted text-muted-foreground'
            )}
          >
            {deltaLabel}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-3">
        <motion.span
          initial={{ opacity: 1 }}
          animate={{ opacity: 0.4 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="font-mono text-sm text-muted-foreground line-through decoration-muted-foreground/60"
        >
          <AnimatedNumber value={before} unit={unit} decimals={decimals} />
        </motion.span>
        <AnimatedNumber
          initialValue={before}
          value={after}
          unit={unit}
          decimals={decimals}
          motionPreset="smooth"
          className="text-2xl font-semibold text-foreground"
        />
      </div>

      <BarChart
        className="mt-4 h-24"
        data={chartData}
        index="metric"
        categories={['Before', 'After']}
        colors={['cyan', 'emerald']}
        showLegend={false}
        showXAxis={false}
        showYAxis={false}
        showGridLines={false}
        showAnimation
      />
    </div>
  );
}
