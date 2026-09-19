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

exports.handler = async (event) => {
  const { runId } = event || {};
  if (!runId) {
    throw new Error('runId is required in the event payload');
  }

  const [baseline, optimized] = await Promise.all([
    readJson(`runs/${runId}/baseline/summary.json`),
    readJson(`runs/${runId}/optimized/summary.json`),
  ]);

  const p95ImprovementRatio = (baseline.p95_ms - optimized.p95_ms) / baseline.p95_ms;
  const errorRateDeltaPp = optimized.error_rate - baseline.error_rate;

  const checks = {
    p95_improved_at_least_10pct: p95ImprovementRatio >= P95_IMPROVEMENT_THRESHOLD,
    error_rate_delta_ok: errorRateDeltaPp <= ERROR_RATE_DELTA_THRESHOLD_PP,
    cpu_within_ceiling: optimized.cpu_percent <= CPU_CEILING_PERCENT,
  };

  const verdict =
    checks.p95_improved_at_least_10pct && checks.error_rate_delta_ok && checks.cpu_within_ceiling
      ? 'OPTIMIZATION VALIDATED'
      : 'NOT VALIDATED';

  const metrics = {
    baseline: { p95_ms: baseline.p95_ms, error_rate: baseline.error_rate, cpu_percent: baseline.cpu_percent },
    optimized: { p95_ms: optimized.p95_ms, error_rate: optimized.error_rate, cpu_percent: optimized.cpu_percent },
    p95_improvement_ratio: p95ImprovementRatio,
    error_rate_delta_pp: errorRateDeltaPp,
    checks,
  };

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
