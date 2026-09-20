'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
// The verdict rule itself lives in shared/ so it can be unit tested
// without S3 — see tests/evaluator.test.js. This file is I/O only.
const { evaluate } = require('../shared/verdict');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;

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
