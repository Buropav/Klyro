'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readJsonOptional(key) {
  try {
    return await readJson(key);
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

exports.handler = async (event) => {
  const { runId, error } = event || {};
  if (!runId) {
    throw new Error('runId is required in the event payload');
  }

  const [finding, patch, baselineSummary, optimizedSummary, evaluation] = await Promise.all([
    readJsonOptional(`runs/${runId}/baseline/finding.json`),
    readJsonOptional(`runs/${runId}/baseline/patch.verified.json`),
    readJsonOptional(`runs/${runId}/baseline/summary.json`),
    readJsonOptional(`runs/${runId}/optimized/summary.json`),
    readJsonOptional(`runs/${runId}/evaluation.json`),
  ]);

  // Called two ways: normally at the end of a successful run (no error),
  // or from the state machine's MarkFailed state after a Catch, with the
  // failed state's error attached — a minimal report still gets written
  // in that case, with whatever partial data existed at the point of
  // failure, instead of the execution just erroring out with no artifact.
  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    finding,
    patch: patch
      ? {
          file: patch.file,
          reason: patch.reason,
          expected_effect: patch.expected_effect,
          // full_new_content deliberately omitted here — it lives in
          // patch.verified.json; the report is a summary, not a blob.
        }
      : null,
    metrics: { baseline: baselineSummary, optimized: optimizedSummary },
    verdict: error ? 'FAILED' : evaluation ? evaluation.verdict : null,
    evaluationDetails: evaluation ? evaluation.metrics : null,
    error: error || null,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/report.json`,
      Body: JSON.stringify(report, null, 2),
      ContentType: 'application/json',
    })
  );

  return report;
};
