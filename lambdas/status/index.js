'use strict';

const {
  SFNClient,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  ExecutionDoesNotExist,
} = require('@aws-sdk/client-sfn');

// STAGE_DEFINITIONS and the ARN transform live in shared/ so report-writer
// can reuse the same stage mapping for report.json's timeline — one
// definition of what a "stage" is, used by both the live view and the
// finished artifact.
const { STAGE_DEFINITIONS, deriveExecutionArn, collectStateEvents } = require('../shared/executionStages');

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

const JSON_HEADERS = { 'content-type': 'application/json' };
const respond = (statusCode, body) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

// Guards against a malformed runId reaching DescribeExecution, which
// answers a bad ARN with ValidationException rather than
// ExecutionDoesNotExist — an opaque 500 for what is really bad input.
const RUN_ID_PATTERN = /^klyro-\d+-[0-9a-f]{6}$/;

async function getExecutionHistory(executionArn) {
  const events = [];
  let nextToken;
  do {
    const res = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000, nextToken }));
    events.push(...res.events);
    nextToken = res.nextToken;
  } while (nextToken);
  return events;
}

exports.handler = async (event) => {
  const runId = event?.pathParameters?.runId;
  if (!runId) {
    return respond(400, { error: 'runId path parameter is required' });
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    return respond(400, { error: `"${runId}" is not a valid runId (expected klyro-<unix-ts>-<6-hex>)` });
  }

  let executionArn;
  try {
    executionArn = deriveExecutionArn(STATE_MACHINE_ARN, runId);
  } catch (err) {
    return respond(500, { error: err.message });
  }

  let overallStatus;
  try {
    const desc = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    overallStatus = desc.status;
  } catch (err) {
    if (err instanceof ExecutionDoesNotExist || err.name === 'ExecutionDoesNotExist') {
      return respond(404, { error: `No execution found for runId "${runId}"` });
    }
    return respond(502, { error: `Could not describe execution: ${err.message}` });
  }

  let enteredStateNames;
  try {
    ({ entered: enteredStateNames } = collectStateEvents(await getExecutionHistory(executionArn)));
  } catch (err) {
    return respond(502, { error: `Could not read execution history: ${err.message}` });
  }

  const stageEntered = STAGE_DEFINITIONS.map((stage) => stage.states.some((s) => enteredStateNames.has(s)));
  let lastActiveIndex = stageEntered.lastIndexOf(true);
  if (lastActiveIndex === -1) lastActiveIndex = 0; // execution just started, history not caught up yet

  const terminalFailure = overallStatus !== 'RUNNING' && overallStatus !== 'SUCCEEDED';

  const stages = STAGE_DEFINITIONS.map((stage, i) => {
    let status;
    if (i < lastActiveIndex) status = 'done';
    else if (i > lastActiveIndex) {
      // On a run that died partway, the stages after the failure were never
      // reached and never will be. Reporting them as 'pending' left the
      // dashboard showing five stages apparently still queued on a run that
      // ended minutes ago.
      status = terminalFailure ? 'skipped' : 'pending';
    } else if (overallStatus === 'SUCCEEDED') status = 'done';
    else if (overallStatus === 'RUNNING') status = 'active';
    else status = 'failed'; // FAILED | TIMED_OUT | ABORTED
    return { name: stage.name, status };
  });

  return respond(200, {
    overallStatus,
    currentStage: STAGE_DEFINITIONS[lastActiveIndex].name,
    stages,
  });
};
