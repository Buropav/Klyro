'use strict';

// Shared between lambdas/status/ (live 10-stage progress for the
// dashboard) and lambdas/report-writer/ (per-stage timing baked into
// report.json). Lambda code is packaged from the lambdas/ directory as a
// whole, so a module here is requirable from every handler without a
// bundler or a dependency.

// Every real (non-bookkeeping) state name from
// statemachine/experiment.asl.json, grouped into the 10 human-facing
// stages a judge sees. MarkFailed/ExperimentSucceeded/ExperimentFailed
// are deliberately excluded — they're terminal bookkeeping, not a
// pipeline "stage" a user watches progress through. SeedDatabaseBaseline
// runs concurrently with BuildBaselineImage (same Parallel state) and has
// no stage of its own here — folded into Build, since both must finish
// before Deploy and neither is independently interesting to show.
const STAGE_DEFINITIONS = [
  {
    name: 'Build',
    states: [
      'BuildBaselineImage',
      'WaitForBaselineCommandRegistration',
      'InitBaselineBuildPollCount',
      'GetBaselineBuildStatus',
      'CheckBaselineBuildStatus',
      'WaitBaselineBuildStatus',
      'IncrementBaselineBuildPollCount',
      'BaselineBuildSucceeded',
      'BaselineBuildFailed',
      'BaselineBuildTimeout',
      'SeedDatabaseBaseline',
    ],
  },
  {
    name: 'Deploy',
    states: [
      'DeployBaselineImage',
      'InitBaselinePollCount',
      'DescribeAppServiceBaseline',
      'CheckBaselineRollout',
      'WaitBaselineRollout',
      'IncrementBaselinePollCount',
      'SetBaselineRolloutTimeoutError',
    ],
  },
  { name: 'Load Test', states: ['RunK6Baseline', 'CompactBaselineMetrics'] },
  { name: 'Diagnose', states: ['RunAnalyst'] },
  { name: 'Patch', states: ['RunInvestigator', 'RunGuard'] },
  {
    name: 'Rebuild',
    states: [
      'BuildOptimizedImage',
      'WaitForOptimizedCommandRegistration',
      'InitOptimizedBuildPollCount',
      'GetOptimizedBuildStatus',
      'CheckOptimizedBuildStatus',
      'WaitOptimizedBuildStatus',
      'IncrementOptimizedBuildPollCount',
      'SetOptimizedBuildFailedError',
      'SetOptimizedBuildTimeoutError',
    ],
  },
  {
    name: 'Redeploy',
    states: [
      'DeployOptimizedImage',
      'InitOptimizedPollCount',
      'DescribeAppServiceOptimized',
      'CheckOptimizedRollout',
      'WaitOptimizedRollout',
      'IncrementOptimizedPollCount',
      'SetOptimizedRolloutTimeoutError',
    ],
  },
  { name: 'Reset', states: ['SeedDatabaseOptimized'] },
  { name: 'Retest', states: ['RunK6Optimized', 'CompactOptimizedMetrics'] },
  { name: 'Evaluate', states: ['RunEvaluator', 'RunReportWriter'] },
];


/**
 * Execution ARNs are deterministic from the state machine name + the
 * execution name — and trigger/index.js always starts executions with
 * `name: runId` (see lambdas/trigger/index.js), so this never needs a
 * lookup. Swapping ":stateMachine:" for ":execution:" and appending the
 * execution name is the documented ARN transform between the two.
 */
function deriveExecutionArn(stateMachineArn, runId) {
  if (!stateMachineArn) {
    throw new Error('STATE_MACHINE_ARN is not set');
  }
  return stateMachineArn.replace(':stateMachine:', ':execution:') + ':' + runId;
}

/**
 * Walks the full execution history once, returning both the set of state
 * names that were entered and, for each, the first-entered / last-exited
 * timestamps. Callers that only need the names ignore the timings.
 */
function collectStateEvents(events) {
  const entered = new Set();
  const timings = new Map();
  for (const event of events) {
    const name = event.stateEnteredEventDetails?.name ?? event.stateExitedEventDetails?.name;
    if (!name) continue;
    const at = event.timestamp ? new Date(event.timestamp).getTime() : null;
    const existing = timings.get(name) || { enteredAt: null, exitedAt: null };
    if (event.type?.endsWith('StateEntered')) {
      entered.add(name);
      if (at !== null && (existing.enteredAt === null || at < existing.enteredAt)) existing.enteredAt = at;
    } else if (event.type?.endsWith('StateExited')) {
      if (at !== null && (existing.exitedAt === null || at > existing.exitedAt)) existing.exitedAt = at;
    }
    timings.set(name, existing);
  }
  return { entered, timings };
}

/**
 * Collapses per-state timings into one row per human-facing stage:
 * earliest entry and latest exit across every state in that stage.
 * Stages never reached are omitted rather than reported as zero-length.
 */
function buildStageTimeline(timings) {
  const rows = [];
  for (const stage of STAGE_DEFINITIONS) {
    let startedAt = null;
    let endedAt = null;
    for (const stateName of stage.states) {
      const t = timings.get(stateName);
      if (!t) continue;
      if (t.enteredAt !== null && (startedAt === null || t.enteredAt < startedAt)) startedAt = t.enteredAt;
      if (t.exitedAt !== null && (endedAt === null || t.exitedAt > endedAt)) endedAt = t.exitedAt;
    }
    if (startedAt === null) continue;
    rows.push({
      name: stage.name,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
      durationMs: endedAt === null ? null : endedAt - startedAt,
    });
  }
  return rows;
}

module.exports = { STAGE_DEFINITIONS, deriveExecutionArn, collectStateEvents, buildStageTimeline };
