// Mirrors lambdas/report-writer/index.js's output exactly — this is the
// one contract the dashboard reads, fetched as runs/<runId>/report.json.
export interface Finding {
  metric: string;
  reasoning: string;
  severity: 'low' | 'medium' | 'high';
}

export interface Patch {
  file: string;
  reason: string;
  expected_effect: string;
  old_content?: string;
  new_content?: string;
}

export interface Metrics {
  runId: string;
  phase: 'baseline' | 'optimized';
  // measured=false means metrics-compactor guessed the CloudWatch window
  // instead of taking it from the k6 task's real start/stop times, so
  // cpu_percent and db_queries are not trustworthy for that phase.
  window: { start: string; end: string; measured?: boolean };
  requests: number;
  requests_per_second: number;
  p95_ms: number;
  error_rate: number;
  cpu_percent: number;
  db_queries: number;
  db_queries_per_request: number;
  flush_ops: number;
}

export interface EvaluationDetails {
  baseline: { p95_ms: number; error_rate: number; cpu_percent: number };
  optimized: { p95_ms: number; error_rate: number; cpu_percent: number };
  p95_improvement_ratio: number;
  error_rate_delta_pp: number;
  checks: {
    p95_improved_at_least_10pct: boolean;
    error_rate_delta_ok: boolean;
    cpu_within_ceiling: boolean;
  };
  dataQuality?: {
    baseline_present: boolean;
    optimized_present: boolean;
    baseline_p95_usable: boolean;
    cpu_measured: boolean;
    error_rate_measured: boolean;
    measurement_trustworthy: boolean;
  };
}

// Which pool entry answered each agent, written by lambdas/analyst and
// lambdas/investigator as `_llm`. Absent on runs from before the pool was
// instrumented, hence every field optional at the top level.
export interface LlmProvenance {
  provider: string;
  model: string;
  poolSize: number;
  rotations: number;
  schemaRepairUsed: boolean;
  backoffRetryUsed: boolean;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export interface TimelineStage {
  name: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface RunCost {
  totalUsd: number;
  breakdown: Record<string, number>;
  builderStandingCostPerDayUsd: number;
  basis: { region: string; ratesCapturedOn: string; totalDurationMs: number; note: string };
}

export type Verdict = 'OPTIMIZATION VALIDATED' | 'NOT VALIDATED' | 'FAILED' | null;

export interface ReportError {
  Error?: string;
  Cause?: string;
}

// Mirrors lambdas/list-runs/index.js's output — one row per
// runs/<runId>/report.json found in the bucket.
export interface RunSummary {
  runId: string;
  timestamp: string;
  verdict: Verdict;
  guardRejected: boolean;
  // Added alongside the originals so existing consumers keep working;
  // null on runs whose report.json predates these fields.
  p95Baseline?: number | null;
  p95Optimized?: number | null;
  improvementPct?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
}

export interface Report {
  runId: string;
  generatedAt: string;
  finding: Finding | null;
  patch: Patch | null;
  metrics: { baseline: Metrics | null; optimized: Metrics | null };
  verdict: Verdict;
  evaluationDetails: EvaluationDetails | null;
  ai?: { analyst: LlmProvenance | null; investigator: LlmProvenance | null } | null;
  timeline?: TimelineStage[] | null;
  totalDurationMs?: number | null;
  cost?: RunCost | null;
  error: ReportError | null;
}
