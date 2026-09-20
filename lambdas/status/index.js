'use strict';

const {
  SFNClient,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  ExecutionDoesNotExist,
} = require('@aws-sdk/client-sfn');

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

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

function deriveExecutionArn(runId) {
  // Execution ARNs are deterministic from the state machine name + the
  // execution name — and trigger/index.js always starts executions with
  // `name: runId` (see lambdas/trigger/index.js), so this never needs a
  // lookup. Swapping ":stateMachine:" for ":execution:" and appending the
  // execution name is the documented ARN transform between the two.
  return STATE_MACHINE_ARN.replace(':stateMachine:', ':execution:') + ':' + runId;
}

async function getEnteredStateNames(executionArn) {
  const entered = new Set();
  let nextToken;
  do {
    const res = await sfn.send(
      new GetExecutionHistoryCommand({
        executionArn,
        maxResults: 1000,
        nextToken,
      })
    );
    for (const event of res.events) {
      if (event.type.endsWith('StateEntered') && event.stateEnteredEventDetails) {
        entered.add(event.stateEnteredEventDetails.name);
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return entered;
}

exports.handler = async (event) => {
  const runId = event?.pathParameters?.runId;
  if (!runId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'runId path parameter is required' }) };
  }

  const executionArn = deriveExecutionArn(runId);

  let overallStatus;
  try {
    const desc = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    overallStatus = desc.status;
  } catch (err) {
    if (err instanceof ExecutionDoesNotExist || err.name === 'ExecutionDoesNotExist') {
      return { statusCode: 404, body: JSON.stringify({ error: `No execution found for runId "${runId}"` }) };
    }
    throw err;
  }

  const enteredStateNames = await getEnteredStateNames(executionArn);

  const stageEntered = STAGE_DEFINITIONS.map((stage) => stage.states.some((s) => enteredStateNames.has(s)));
  let lastActiveIndex = stageEntered.lastIndexOf(true);
  if (lastActiveIndex === -1) lastActiveIndex = 0; // execution just started, history not caught up yet

  const stages = STAGE_DEFINITIONS.map((stage, i) => {
    let status;
    if (i < lastActiveIndex) status = 'done';
    else if (i > lastActiveIndex) status = 'pending';
    else if (overallStatus === 'SUCCEEDED') status = 'done';
    else if (overallStatus === 'RUNNING') status = 'active';
    else status = 'failed'; // FAILED | TIMED_OUT | ABORTED
    return { name: stage.name, status };
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      overallStatus,
      currentStage: STAGE_DEFINITIONS[lastActiveIndex].name,
      stages,
    }),
  };
};
