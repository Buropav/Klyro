'use strict';

const crypto = require('node:crypto');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

function generateRunId() {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `klyro-${ts}-${hash}`;
}

// Invocable directly via `aws lambda invoke` for now (no API Gateway yet).
// STATE_MACHINE_ARN is deliberately unset until the Step Functions state
// machine (statemachine/experiment.asl.json) exists — that's a later
// prompt's deliverable, not this one's.
exports.handler = async (event) => {
  if (!STATE_MACHINE_ARN) {
    throw new Error(
      'STATE_MACHINE_ARN environment variable is required and is not set yet — ' +
        'the Step Functions state machine this trigger starts is built in a later prompt.'
    );
  }

  const runId = event?.runId || generateRunId();

  const res = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: runId,
      input: JSON.stringify({ runId }),
    })
  );

  return { runId, executionArn: res.executionArn };
};
