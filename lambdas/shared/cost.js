'use strict';

// Deterministic run-cost estimate.
//
// This is a checked-in rate table multiplied by the run's MEASURED stage
// durations — not a Pricing API call and not Cost Explorer. That is a
// deliberate choice, for the same reason the evaluator is code and not an
// LLM: the number should be reproducible from the artifact alone. The
// Pricing API is us-east-1-only and adds IAM, latency and a failure mode
// to report-writer (which is also the MarkFailed handler); Cost Explorer
// lags 24h+ and cannot attribute spend to a single runId at all, so
// neither can show anything during a demo.
//
// Rates: AWS public on-demand pricing, ap-south-1 (Mumbai), captured
// 2026-09. They are a constant here rather than config because a stale
// rate producing a slightly-off estimate is much less bad than a missing
// estimate, and because a hardcoded date is auditable.
const RATES = {
  region: 'ap-south-1',
  capturedOn: '2026-09',
  fargateVcpuHourUsd: 0.04048,
  fargateGbHourUsd: 0.004445,
  ec2T3SmallHourUsd: 0.0224,
  ebsGp3GbMonthUsd: 0.0912,
  lambdaGbSecondUsd: 0.0000166667,
  lambdaRequestUsd: 0.0000002,
  s3PutPer1000Usd: 0.005,
  s3StorageGbMonthUsd: 0.025,
};

// Fixed task sizing from infra/lib/compute-stack.ts. These are constants
// on purpose — the identical-infrastructure invariant means they are the
// same for the baseline and optimized phases of every run.
const TASK_SIZING = {
  app: { vcpu: 0.5, memoryGb: 1 },
  db: { vcpu: 0.5, memoryGb: 1 },
  k6: { vcpu: 0.25, memoryGb: 0.5 },
  dbInit: { vcpu: 0.25, memoryGb: 0.5 },
};

const HOUR_MS = 3600 * 1000;

function fargateCost({ vcpu, memoryGb }, durationMs) {
  const hours = durationMs / HOUR_MS;
  return hours * (vcpu * RATES.fargateVcpuHourUsd + memoryGb * RATES.fargateGbHourUsd);
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Estimate the AWS cost of one pipeline run.
 *
 * timeline is the buildStageTimeline() output; totalDurationMs is the
 * execution's wall-clock span. Returns null when there is no timeline to
 * compute from, so callers can degrade rather than print a fake zero.
 */
function estimateRunCost(timeline, totalDurationMs) {
  if (!Array.isArray(timeline) || timeline.length === 0 || !totalDurationMs) return null;

  const stageMs = (name) => {
    const row = timeline.find((s) => s.name === name);
    return row && row.durationMs ? row.durationMs : 0;
  };

  // The app and db services run for the whole execution — they are
  // long-lived Fargate services, not per-stage tasks, so they bill for the
  // full wall-clock span regardless of which stage is active.
  const appAndDb = fargateCost(TASK_SIZING.app, totalDurationMs) + fargateCost(TASK_SIZING.db, totalDurationMs);

  // k6 and db-init are RunTask invocations scoped to their own stages.
  const loadTestMs = stageMs('Load Test') + stageMs('Retest');
  const seedMs = stageMs('Reset');
  const k6 = fargateCost(TASK_SIZING.k6, loadTestMs);
  const dbInit = fargateCost(TASK_SIZING.dbInit, seedMs);

  // The builder instance is always-on, so strictly it is not a per-run
  // cost at all. Attributing only the build stages' share is the honest
  // reading of "what did this run cost"; the standing cost is reported
  // separately so the trade-off is visible rather than hidden.
  const builderMs = stageMs('Build') + stageMs('Rebuild');
  const builderAttributed = (builderMs / HOUR_MS) * RATES.ec2T3SmallHourUsd;

  // 11 Lambdas, none long-running; the pipeline invokes ~12 times per run
  // at 256MB. Small enough that a bounded approximation is more honest
  // than pretending to per-invocation precision.
  const lambdaInvocations = 12;
  const lambdaAvgSeconds = 3;
  const lambda =
    lambdaInvocations * RATES.lambdaRequestUsd + lambdaInvocations * lambdaAvgSeconds * 0.25 * RATES.lambdaGbSecondUsd;

  // ~15 artifacts written per run, each a few KB.
  const s3 = (15 / 1000) * RATES.s3PutPer1000Usd;

  const breakdown = {
    fargate_app_and_db: round(appAndDb),
    fargate_k6: round(k6),
    fargate_db_init: round(dbInit),
    ec2_builder_attributed: round(builderAttributed),
    lambda: round(lambda),
    s3: round(s3),
  };
  const totalUsd = round(Object.values(breakdown).reduce((a, b) => a + b, 0));

  return {
    totalUsd,
    breakdown,
    // What it costs to leave the builder up between runs. Called out
    // because it is the single largest standing cost in the account and
    // is invisible in any per-run number.
    builderStandingCostPerDayUsd: round(24 * RATES.ec2T3SmallHourUsd),
    basis: {
      region: RATES.region,
      ratesCapturedOn: RATES.capturedOn,
      totalDurationMs,
      note: 'Estimate from published on-demand rates x measured stage durations. Not a billed amount.',
    },
  };
}

module.exports = { RATES, TASK_SIZING, estimateRunCost };
