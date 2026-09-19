'use strict';

const crypto = require('node:crypto');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
// Same manifest investigator/ used to build its prompt — computing the
// "current" hash from this shared source is what lets guard independently
// re-verify the Investigator's claimed original_sha256 rather than trusting
// it.
const allowlistManifest = require('../shared-allowlist-manifest.generated.json');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;
const ALLOWLIST = Object.keys(allowlistManifest);

// Named (not just .name-tagged) so a Step Functions Catch on
// ["GUARD_REJECTED"] matches this error's errorType directly.
class GUARD_REJECTED extends Error {
  constructor(message) {
    super(message);
    this.name = 'GUARD_REJECTED';
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

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

  if (!ALLOWLIST.includes(patch.file)) {
    throw new GUARD_REJECTED(`File "${patch.file}" is not in the allowlist: ${ALLOWLIST.join(', ')}`);
  }

  const currentContent = allowlistManifest[patch.file];
  const currentHash = sha256(currentContent);
  if (patch.original_sha256 !== currentHash) {
    throw new GUARD_REJECTED(
      `original_sha256 mismatch for ${patch.file}: patch says ${patch.original_sha256}, ` +
        `current file hash is ${currentHash} — the file may have drifted since the patch was proposed`
    );
  }

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
