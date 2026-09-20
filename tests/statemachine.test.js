'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ASL_PATH = path.join(__dirname, '..', 'statemachine', 'experiment.asl.json');
const STACK_PATH = path.join(__dirname, '..', 'infra', 'lib', 'orchestration-stack.ts');

const asl = JSON.parse(fs.readFileSync(ASL_PATH, 'utf8'));

/** Every Task state in the graph, including those nested in Parallel branches. */
function taskStates(states, acc = []) {
  for (const [name, state] of Object.entries(states)) {
    if (state.Type === 'Parallel') {
      for (const branch of state.Branches || []) taskStates(branch.States, acc);
    }
    if (state.Type === 'Task') acc.push([name, state]);
  }
  return acc;
}

function allStateNames(states, acc = new Set()) {
  for (const [name, state] of Object.entries(states)) {
    acc.add(name);
    if (state.Type === 'Parallel') {
      for (const branch of state.Branches || []) allStateNames(branch.States, acc);
    }
  }
  return acc;
}

const tasks = taskStates(asl.States);

// Re-running a load test against an already-warmed service is a DIFFERENT
// workload, which would break the identical-workload invariant that makes
// the before/after comparison meaningful. These must never auto-retry.
const NO_RETRY_BY_DESIGN = new Set(['RunK6Baseline', 'RunK6Optimized']);

test('the pipeline has states to check', () => {
  assert.ok(tasks.length >= 15, `expected a substantial graph, found ${tasks.length} Task states`);
});

test('every Task state has a TimeoutSeconds', () => {
  // Raw ASL has no implicit timeout, so a wedged .sync task can hold a
  // Standard execution open for up to a year.
  const missing = tasks.filter(([, s]) => typeof s.TimeoutSeconds !== 'number').map(([n]) => n);
  assert.deepEqual(missing, [], `Task states without TimeoutSeconds: ${missing.join(', ')}`);
});

test('every Task state has a Retry, except the load tests', () => {
  // Raw ASL gets no default retries (unlike CDK's L2 constructs), so
  // without these one transient throttle loses a ~15 minute run.
  const missing = tasks.filter(([n, s]) => !NO_RETRY_BY_DESIGN.has(n) && !Array.isArray(s.Retry)).map(([n]) => n);
  assert.deepEqual(missing, [], `Task states without Retry: ${missing.join(', ')}`);

  for (const name of NO_RETRY_BY_DESIGN) {
    const found = tasks.find(([n]) => n === name);
    assert.ok(found, `${name} should exist`);
    assert.equal(found[1].Retry, undefined, `${name} must not retry — it would change the workload`);
  }
});

test('retries never swallow AI_FAILED or GUARD_REJECTED', () => {
  // Those are verdicts about the run, not transient faults: they must
  // reach MarkFailed immediately rather than being retried.
  for (const [name, state] of tasks) {
    for (const rule of state.Retry || []) {
      for (const errorName of rule.ErrorEquals) {
        assert.ok(
          !['States.ALL', 'AI_FAILED', 'GUARD_REJECTED'].includes(errorName),
          `${name} retries on ${errorName}, which would mask a real verdict`
        );
      }
    }
  }
});

test('MarkFailed is itself protected', () => {
  // It is the safety net guaranteeing a report.json always exists, and it
  // used to be the one Task with neither Catch nor Retry. The dashboard
  // treats report.json's arrival as the terminal signal, so a MarkFailed
  // that threw left the UI polling forever.
  const markFailed = asl.States.MarkFailed;
  assert.ok(markFailed, 'MarkFailed should exist');
  assert.ok(Array.isArray(markFailed.Retry), 'MarkFailed needs a Retry');
  assert.ok(Array.isArray(markFailed.Catch), 'MarkFailed needs a Catch');
  assert.equal(markFailed.Catch[0].Next, 'ExperimentFailed');
});

test('the execution as a whole is bounded', () => {
  assert.equal(typeof asl.TimeoutSeconds, 'number');
});

test('the metrics compactors receive a real measurement window', () => {
  // Without startTime/endTime, metrics-compactor falls back to guessing a
  // window at invocation time — after the k6 task already stopped — and
  // cpu_percent / db_queries come back 0.
  for (const [compactor, source] of [
    ['CompactBaselineMetrics', '$.k6Baseline'],
    ['CompactOptimizedMetrics', '$.k6Optimized'],
  ]) {
    const payload = asl.States[compactor].Parameters.Payload;
    assert.equal(payload['startTime.$'], `${source}.Tasks[0].StartedAt`);
    assert.equal(payload['endTime.$'], `${source}.Tasks[0].StoppedAt`);
  }
});

test('the k6 tasks keep their result so the window is available', () => {
  for (const [name, source] of [
    ['RunK6Baseline', '$.k6Baseline'],
    ['RunK6Optimized', '$.k6Optimized'],
  ]) {
    assert.equal(asl.States[name].ResultPath, source, `${name} must not discard its RunTask result`);
  }
});

test('every Catch routes somewhere that exists', () => {
  const names = allStateNames(asl.States);
  for (const [name, state] of tasks) {
    for (const rule of state.Catch || []) {
      assert.ok(names.has(rule.Next), `${name} catches to "${rule.Next}", which is not a state`);
    }
  }
});

test('every ${placeholder} has a substitution in orchestration-stack.ts', () => {
  // A missed substitution deploys a state machine referencing a literal
  // "${Foo}" and fails at run time, not at synth time.
  const raw = fs.readFileSync(ASL_PATH, 'utf8');
  const placeholders = new Set([...raw.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));
  assert.ok(placeholders.size > 0, 'expected the ASL to use substitutions');

  const stack = fs.readFileSync(STACK_PATH, 'utf8');
  const substitutions = stack.slice(stack.indexOf('const substitutions'));
  const missing = [...placeholders].filter((p) => !new RegExp(`\\b${p}\\s*:`).test(substitutions));
  assert.deepEqual(missing, [], `placeholders with no substitution: ${missing.join(', ')}`);
});
