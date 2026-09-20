'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;

// Exact PASS rule from CLAUDE.md: validated requires p95 improvement
// >=10%, error-rate delta <=0.5 percentage points, and CPU staying <=95%,
// all under the same workload/data/infra.
const P95_IMPROVEMENT_THRESHOLD = 0.1;
const ERROR_RATE_DELTA_THRESHOLD_PP = 0.5;
const CPU_CEILING_PERCENT = 95;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Pure verdict arithmetic — no I/O, no LLM, exported so it can be unit
 * tested directly (see tests/evaluator.test.js). The three thresholds are
 * a CLAUDE.md invariant and are applied exactly as written there.
 *
 * dataQuality is reported ALONGSIDE the verdict rather than folded into
 * it, so the verdict strings stay exactly two values for every consumer.
 * It exists because a check can otherwise pass for the wrong reason: if
 * CloudWatch returned no datapoints, cpu_percent is 0, and `0 <= 95` is
 * true — the ceiling check would "pass" on telemetry that was never
 * collected. Likewise a baseline p95 of 0 makes the improvement ratio
 * NaN, and `NaN >= 0.1` is false, so a broken measurement would otherwise
 * be indistinguishable from a genuine regression.
 */
function evaluate(baseline, optimized) {
  const dataQuality = {
    baseline_present: Boolean(baseline) && isNumber(baseline.p95_ms),
    optimized_present: Boolean(optimized) && isNumber(optimized.p95_ms),
    baseline_p95_usable: isPositiveNumber(baseline?.p95_ms),
    // window.measured is set by metrics-compactor: false means the
    // CloudWatch window was guessed rather than taken from the k6 task's
    // real start/stop times.
    cpu_measured: isPositiveNumber(optimized?.cpu_percent) && optimized?.window?.measured !== false,
    error_rate_measured: isNumber(baseline?.error_rate) && isNumber(optimized?.error_rate),
  };
  dataQuality.measurement_trustworthy =
    dataQuality.baseline_present &&
    dataQuality.optimized_present &&
    dataQuality.baseline_p95_usable &&
    dataQuality.cpu_measured &&
    dataQuality.error_rate_measured;

  const p95ImprovementRatio = dataQuality.baseline_p95_usable
    ? (baseline.p95_ms - optimized.p95_ms) / baseline.p95_ms
    : null;
  const errorRateDeltaPp = dataQuality.error_rate_measured ? optimized.error_rate - baseline.error_rate : null;

  const checks = {
    p95_improved_at_least_10pct: p95ImprovementRatio !== null && p95ImprovementRatio >= P95_IMPROVEMENT_THRESHOLD,
    error_rate_delta_ok: errorRateDeltaPp !== null && errorRateDeltaPp <= ERROR_RATE_DELTA_THRESHOLD_PP,
    // Unmeasured CPU is NOT a pass. This is the one check that would
    // otherwise succeed precisely when telemetry is missing.
    cpu_within_ceiling: dataQuality.cpu_measured && optimized.cpu_percent <= CPU_CEILING_PERCENT,
  };

  const verdict =
    checks.p95_improved_at_least_10pct && checks.error_rate_delta_ok && checks.cpu_within_ceiling
      ? 'OPTIMIZATION VALIDATED'
      : 'NOT VALIDATED';

  const metrics = {
    baseline: {
      p95_ms: baseline?.p95_ms ?? null,
      error_rate: baseline?.error_rate ?? null,
      cpu_percent: baseline?.cpu_percent ?? null,
    },
    optimized: {
      p95_ms: optimized?.p95_ms ?? null,
      error_rate: optimized?.error_rate ?? null,
      cpu_percent: optimized?.cpu_percent ?? null,
    },
    p95_improvement_ratio: p95ImprovementRatio,
    error_rate_delta_pp: errorRateDeltaPp,
    checks,
    dataQuality,
  };

  return { verdict, metrics };
}

exports.evaluate = evaluate;

exports.handler = async (event) => {
  const { runId } = event || {};
  if (!runId) {
    throw new Error('runId is required in the event payload');
  }

  const [baseline, optimized] = await Promise.all([
    readJson(`runs/${runId}/baseline/summary.json`),
    readJson(`runs/${runId}/optimized/summary.json`),
  ]);

  const { verdict, metrics } = evaluate(baseline, optimized);
  const result = { runId, verdict, metrics };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/evaluation.json`,
      Body: JSON.stringify(result, null, 2),
      ContentType: 'application/json',
    })
  );

  return result;
};
