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
  window: { start: string; end: string };
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
}

export interface Report {
  runId: string;
  generatedAt: string;
  finding: Finding | null;
  patch: Patch | null;
  metrics: { baseline: Metrics | null; optimized: Metrics | null };
  verdict: Verdict;
  evaluationDetails: EvaluationDetails | null;
  error: ReportError | null;
}
