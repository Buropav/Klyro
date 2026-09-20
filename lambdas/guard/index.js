'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
// Same manifest investigator/ used to build its prompt — computing the
// "current" hash from this shared source is what lets guard independently
// re-verify the Investigator's claimed original_sha256 rather than trusting
// it.
const allowlistManifest = require('../shared-allowlist-manifest.generated.json');
// The verification rule itself lives in shared/ so it can be unit tested
// without S3 and without this generated manifest — see tests/guard.test.js.
// This file is I/O only.
const { verifyPatch } = require('../shared/patchGuard');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

exports.handler = async (event) => {
  const { runId, phase } = event || {};
  if (!runId || !phase) {
    throw new Error('runId and phase are required in the event payload');
  }

  const patch = await readJson(`runs/${runId}/${phase}/patch.json`);
  verifyPatch(patch, allowlistManifest);

  const verified = { ...patch, verifiedAt: new Date().toISOString() };
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/${phase}/patch.verified.json`,
      Body: JSON.stringify(verified, null, 2),
      ContentType: 'application/json',
    })
  );

  return { file: patch.file, verified: true };
};
