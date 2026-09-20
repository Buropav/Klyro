import { motion } from 'motion/react';
import { StatusBadge, type Status } from '@/components/StatusBadge';
import { MetricDeltaCard } from '@/components/MetricDeltaCard';
import { FindingCard } from '@/components/FindingCard';
import { PatchView } from '@/components/PatchView';
import type { Report } from '@/lib/types';

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

const METRIC_CONFIGS = [
  { key: 'p95_ms', label: 'p95 latency', unit: 'ms' as const },
  { key: 'cpu_percent', label: 'CPU', unit: '%' as const },
  { key: 'db_queries_per_request', label: 'DB queries / request', unit: 'count' as const, decimals: 2 },
  { key: 'error_rate', label: 'Error rate', unit: '%' as const },
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 py-2">
        <StatusBadge status={status} label={label} size="lg" />
        {report.error?.Cause && (
          <p className="max-w-xl text-center text-xs text-muted-foreground">{report.error.Cause}</p>
        )}
      </div>

      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
        {baseline && optimized && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {METRIC_CONFIGS.map((cfg) => (
              <motion.div key={cfg.key} variants={staggerItem}>
                <MetricDeltaCard
                  label={cfg.label}
                  before={baseline[cfg.key as keyof typeof baseline] as number}
                  after={optimized[cfg.key as keyof typeof optimized] as number}
                  unit={cfg.unit}
                  decimals={cfg.decimals}
                />
              </motion.div>
            ))}
          </div>
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
      </motion.div>
    </div>
  );
}
