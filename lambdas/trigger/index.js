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

// Invoked two ways: directly via `aws lambda invoke` (event is the plain
// {runId?} payload), and via the HTTP API's Lambda proxy integration
// (event is an API Gateway v2 request — runId, if any, arrives as a JSON
// POST body). Both paths return the same {runId, executionArn} shape;
// under API Gateway's payload format 2.0, returning a bare JSON object
// with no statusCode is the documented "simple response" and comes back
// as 200 application/json, so the success path needs no branching. Only
// the failure path needs to know which caller it's talking to, since a
// direct `aws lambda invoke` should keep throwing (surfaces in the CLI
// response) while the HTTP path needs a real statusCode or API Gateway
// returns a bare 500 with no body.
function isHttpEvent(event) {
  return Boolean(event && event.requestContext && event.requestContext.http);
}

exports.handler = async (event) => {
  const http = isHttpEvent(event);

  if (!STATE_MACHINE_ARN) {
    const message = 'STATE_MACHINE_ARN environment variable is required and is not set.';
    if (http) return { statusCode: 500, body: JSON.stringify({ error: message }) };
    throw new Error(message);
  }

  let runId;
  try {
    const body = http && event.body ? JSON.parse(event.body) : event;
    runId = body?.runId || generateRunId();
  } catch (err) {
    if (http) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    throw err;
  }

  try {
    const res = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: runId,
        input: JSON.stringify({ runId }),
      })
    );
    return { runId, executionArn: res.executionArn };
  } catch (err) {
    if (http) return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
    throw err;
  }
};
