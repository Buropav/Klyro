'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate } = require('../lambdas/shared/verdict');

// A pair of summaries that passes all three checks, used as the base for
// every "change exactly one thing" case below.
const baseline = (over = {}) => ({
  p95_ms: 400,
  error_rate: 0.1,
  cpu_percent: 60,
  window: { measured: true },
  ...over,
});
const optimized = (over = {}) => ({
  p95_ms: 200,
  error_rate: 0.1,
  cpu_percent: 55,
  window: { measured: true },
  ...over,
});

const VALIDATED = 'OPTIMIZATION VALIDATED';
const NOT_VALIDATED = 'NOT VALIDATED';

test('a clean 50% improvement is validated', () => {
  const { verdict, metrics } = evaluate(baseline(), optimized());
  assert.equal(verdict, VALIDATED);
  assert.equal(metrics.p95_improvement_ratio, 0.5);
  assert.deepEqual(metrics.checks, {
    p95_improved_at_least_10pct: true,
    error_rate_delta_ok: true,
    cpu_within_ceiling: true,
  });
  assert.equal(metrics.dataQuality.measurement_trustworthy, true);
});

test('the p95 threshold is inclusive at exactly 10%', () => {
  // 400 -> 360 is exactly a 10% improvement, which CLAUDE.md's ">= 10%"
  // says must pass. The boundary is the whole point of the rule.
  const { verdict } = evaluate(baseline(), optimized({ p95_ms: 360 }));
  assert.equal(verdict, VALIDATED);
});

test('just under the p95 threshold is not validated', () => {
  const { verdict, metrics } = evaluate(baseline(), optimized({ p95_ms: 361 }));
  assert.equal(verdict, NOT_VALIDATED);
  assert.equal(metrics.checks.p95_improved_at_least_10pct, false);
  // The other two checks still passed — a NOT VALIDATED verdict has to
  // stay explainable.
  assert.equal(metrics.checks.error_rate_delta_ok, true);
  assert.equal(metrics.checks.cpu_within_ceiling, true);
});

test('the error-rate rule is percentage POINTS, inclusive at 0.5', () => {
  // 0.1 -> 0.6 is +0.5pp: passes. It is also a 500% relative increase,
  // which is exactly why the rule is expressed in points.
  assert.equal(evaluate(baseline(), optimized({ error_rate: 0.6 })).verdict, VALIDATED);
  assert.equal(evaluate(baseline(), optimized({ error_rate: 0.61 })).verdict, NOT_VALIDATED);
});

test('an error rate that improves never fails its check', () => {
  const { metrics } = evaluate(baseline({ error_rate: 5 }), optimized({ error_rate: 0 }));
  assert.equal(metrics.checks.error_rate_delta_ok, true);
  assert.equal(metrics.error_rate_delta_pp, -5);
});

test('the CPU ceiling is inclusive at 95 and excludes 95.1', () => {
  assert.equal(evaluate(baseline(), optimized({ cpu_percent: 95 })).verdict, VALIDATED);
  assert.equal(evaluate(baseline(), optimized({ cpu_percent: 95.1 })).verdict, NOT_VALIDATED);
});

test('unmeasured CPU does NOT pass the ceiling check', () => {
  // This is the regression that matters most: CloudWatch returning no
  // datapoints yields cpu_percent 0, and `0 <= 95` is true, so the check
  // used to pass precisely when telemetry was missing.
  const { verdict, metrics } = evaluate(baseline(), optimized({ cpu_percent: 0 }));
  assert.equal(metrics.checks.cpu_within_ceiling, false);
  assert.equal(metrics.dataQuality.cpu_measured, false);
  assert.equal(metrics.dataQuality.measurement_trustworthy, false);
  assert.equal(verdict, NOT_VALIDATED);
});

test('a guessed measurement window disqualifies the CPU check', () => {
  // metrics-compactor sets window.measured=false when it had to infer the
  // window rather than take it from the k6 task's real start/stop times.
  const { metrics } = evaluate(baseline(), optimized({ window: { measured: false } }));
  assert.equal(metrics.dataQuality.cpu_measured, false);
  assert.equal(metrics.checks.cpu_within_ceiling, false);
});

test('a zero baseline p95 reports itself instead of producing NaN', () => {
  const { verdict, metrics } = evaluate(baseline({ p95_ms: 0 }), optimized());
  assert.equal(metrics.p95_improvement_ratio, null);
  assert.equal(metrics.dataQuality.baseline_p95_usable, false);
  assert.equal(metrics.dataQuality.measurement_trustworthy, false);
  assert.equal(verdict, NOT_VALIDATED);
});

test('a missing summary does not throw', () => {
  const { verdict, metrics } = evaluate(null, optimized());
  assert.equal(verdict, NOT_VALIDATED);
  assert.equal(metrics.dataQuality.baseline_present, false);
  assert.equal(metrics.baseline.p95_ms, null);
});

test('a regression is reported as a negative ratio, not a failure', () => {
  const { verdict, metrics } = evaluate(baseline(), optimized({ p95_ms: 500 }));
  assert.equal(verdict, NOT_VALIDATED);
  assert.equal(metrics.p95_improvement_ratio, -0.25);
  // Distinguishable from the broken-input case above, which reports null.
  assert.equal(metrics.dataQuality.measurement_trustworthy, true);
});

test('all three checks are reported individually, always', () => {
  // README promises a NOT VALIDATED result is always explainable.
  const { metrics } = evaluate(baseline({ p95_ms: 0 }), null);
  assert.deepEqual(Object.keys(metrics.checks).sort(), [
    'cpu_within_ceiling',
    'error_rate_delta_ok',
    'p95_improved_at_least_10pct',
  ]);
});
