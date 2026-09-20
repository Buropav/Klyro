import { motion } from 'motion/react';
import { Check, X, HelpCircle } from 'lucide-react';
import { StatusBadge, type Status } from '@/components/StatusBadge';
import { MetricDeltaCard } from '@/components/MetricDeltaCard';
import { FindingCard } from '@/components/FindingCard';
import { PatchView } from '@/components/PatchView';
import { CostTimelineCard } from '@/components/CostTimelineCard';
import { AiProvenanceCard } from '@/components/AiProvenanceCard';
import type { EvaluationDetails, Report } from '@/lib/types';

export interface VerdictViewProps {
  report: Report;
}

function verdictToStatus(report: Report): { status: Status; label: string } {
  if (report.verdict === 'OPTIMIZATION VALIDATED') {
    return { status: 'validated', label: 'OPTIMIZATION VALIDATED' };
  }
  if (report.verdict === 'NOT VALIDATED') {
    return { status: 'done', label: 'NOT VALIDATED' };
  }
  if (report.verdict === 'FAILED') {
    if (report.error?.Error === 'GUARD_REJECTED') {
      return { status: 'rejected', label: 'GUARD REJECTED' };
    }
    return { status: 'failed', label: report.error?.Error ?? 'FAILED' };
  }
  return { status: 'pending', label: 'NO VERDICT YET' };
}

/**
 * Step Functions sets a Lambda-invoke Catch's Cause to a JSON-stringified
 * blob carrying errorMessage, errorType and the full stack trace. Dropping
 * that raw into the page buried the one useful line in a stack dump.
 */
function readableCause(cause: string | undefined): string | null {
  if (!cause) return null;
  try {
    const parsed = JSON.parse(cause);
    if (typeof parsed?.errorMessage === 'string') return parsed.errorMessage;
  } catch {
    // Not JSON — a Fail state's plain-text Cause, already readable.
  }
  return cause;
}

const CHECK_LABELS: Record<keyof EvaluationDetails['checks'], string> = {
  p95_improved_at_least_10pct: 'p95 improved by at least 10%',
  error_rate_delta_ok: 'Error rate grew by no more than 0.5pp',
  cpu_within_ceiling: 'CPU stayed at or below 95%',
};

/**
 * The verdict is an AND of three checks, and until now the dashboard threw
 * that detail away — a NOT VALIDATED run showed a grey badge and four
 * metric cards with no indication of WHICH check failed, even though
 * evaluation.json has always carried it.
 */
function EvaluationChecks({ details }: { details: EvaluationDetails }) {
  const quality = details.dataQuality;
  const checkKeys = Object.keys(CHECK_LABELS) as (keyof EvaluationDetails['checks'])[];

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-3 text-sm font-medium">Why this verdict</h2>
      <ul className="space-y-2">
        {checkKeys.map((key) => {
          const passed = details.checks[key];
          const unmeasured = key === 'cpu_within_ceiling' && Boolean(quality) && !quality?.cpu_measured;
          return (
            <li key={key} className="flex items-start gap-2 text-xs">
              {unmeasured ? (
                <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden />
              ) : passed ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-green-400" aria-hidden />
              ) : (
                <X className="mt-0.5 size-3.5 shrink-0 text-red-400" aria-hidden />
              )}
              <span className={passed ? 'text-foreground' : 'text-muted-foreground'}>
                {CHECK_LABELS[key]}
                {unmeasured && <span className="text-amber-400"> — not measured, so treated as not passing</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {quality && !quality.measurement_trustworthy && (
        <p className="mt-3 text-[11px] leading-relaxed text-amber-400/90">
          Some inputs to this verdict were missing or unmeasured, so it rests on fewer signals than usual.
        </p>
      )}
    </div>
  );
}

const METRIC_CONFIGS = [
  { key: 'p95_ms', label: 'p95 latency', unit: 'ms' as const, decimals: undefined, deltaMode: undefined },
  { key: 'cpu_percent', label: 'CPU', unit: '%' as const, decimals: undefined, deltaMode: undefined },
  {
    key: 'db_queries_per_request',
    label: 'DB queries / request',
    unit: 'count' as const,
    decimals: 2,
    deltaMode: undefined,
  },
  // Absolute, not relative: the evaluator's rule is a percentage-POINT
  // delta, so a relative "+200%" here would contradict a passing verdict.
  {
    key: 'error_rate',
    label: 'Error rate',
    unit: '%' as const,
    decimals: 2,
    deltaMode: 'absolute' as const,
  },
];

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};
const staggerItem = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

export function VerdictView({ report }: VerdictViewProps) {
  const { status, label } = verdictToStatus(report);
  const { baseline, optimized } = report.metrics;
  const cause = readableCause(report.error?.Cause);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 py-2">
        <StatusBadge status={status} label={label} size="lg" />
        {cause && <p className="max-w-xl text-center text-xs text-muted-foreground">{cause}</p>}
      </div>

      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
        {baseline && optimized ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {METRIC_CONFIGS.map((cfg) => (
              <motion.div key={cfg.key} variants={staggerItem}>
                <MetricDeltaCard
                  label={cfg.label}
                  before={baseline[cfg.key as keyof typeof baseline] as number}
                  after={optimized[cfg.key as keyof typeof optimized] as number}
                  unit={cfg.unit}
                  decimals={cfg.decimals}
                  deltaMode={cfg.deltaMode}
                />
              </motion.div>
            ))}
          </div>
        ) : (
          // A run that failed before the optimized load test has no
          // after-numbers to compare. Previously the grid simply vanished,
          // leaving a badge and nothing else on the page.
          <motion.p
            variants={staggerItem}
            className="rounded-lg border border-border bg-card p-5 text-xs text-muted-foreground"
          >
            {baseline
              ? 'This run recorded baseline metrics but never completed an optimized run, so there is no before/after comparison.'
              : 'This run ended before any metrics were collected.'}
          </motion.p>
        )}

        {report.evaluationDetails && (
          <motion.div variants={staggerItem}>
            <EvaluationChecks details={report.evaluationDetails} />
          </motion.div>
        )}

        {report.finding && (
          <motion.div variants={staggerItem}>
            <FindingCard finding={report.finding} />
          </motion.div>
        )}

        {report.patch && (
          <motion.div variants={staggerItem}>
            <PatchView patch={report.patch} />
          </motion.div>
        )}

        <motion.div variants={staggerItem}>
          <AiProvenanceCard ai={report.ai} />
        </motion.div>

        <motion.div variants={staggerItem}>
          <CostTimelineCard timeline={report.timeline} totalDurationMs={report.totalDurationMs} cost={report.cost} />
        </motion.div>
      </motion.div>
    </div>
  );
}
