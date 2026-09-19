'use strict';

const crypto = require('node:crypto');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { GroqProvider } = require('../llm-provider');
// Generated at CDK synth time (orchestration-stack.ts) from the actual
// current content of the three allowlisted demo-app files. Shared with
// guard/, which independently re-verifies against the same manifest.
const allowlistManifest = require('../shared-allowlist-manifest.generated.json');

const s3 = new S3Client({});
const ssm = new SSMClient({});

const BUCKET = process.env.RESULTS_BUCKET;
const GROQ_API_KEY_PARAM = process.env.GROQ_API_KEY_PARAM;
const GROQ_MODEL_INVESTIGATOR = process.env.GROQ_MODEL_INVESTIGATOR;

const ALLOWLIST = Object.keys(allowlistManifest);

const PATCH_SCHEMA = {
  type: 'object',
  required: ['file', 'original_sha256', 'full_new_content', 'reason', 'expected_effect'],
  properties: {
    file: { type: 'string', enum: ALLOWLIST },
    original_sha256: { type: 'string', minLength: 64 },
    full_new_content: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
    expected_effect: { type: 'string', minLength: 1 },
  },
};

const SYSTEM_PROMPT = `You are a backend performance engineer fixing ONE specific, already-diagnosed
performance defect in a small Node/Express/Postgres demo app.

You may modify exactly ONE of these files, and nothing else:
${ALLOWLIST.map((f) => `  - ${f}`).join('\n')}

You will be given the analyst's finding (which metric is anomalous and
why), the current full content and sha256 of each of the files above, and
a description of the workload that produced the anomaly.

Pick the single file whose change most directly addresses the finding,
and rewrite its FULL content (not a diff) with a minimal, targeted fix.
Do not change behavior unrelated to the finding.

For original_sha256, copy the "sha256" value given to you for the file
you chose — do not compute it yourself.

Respond with ONLY a JSON object of this exact shape, no prose, no
markdown fences:
{"file": "<one of the allowed paths, exactly as given>",
 "original_sha256": "<the given sha256 for that file, copied exactly>",
 "full_new_content": "<the complete new file content>",
 "reason": "<why this change fixes the finding>",
 "expected_effect": "<what should measurably improve, named using the summary.json metric names>"}`;

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

let cachedApiKey;
async function getGroqApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await ssm.send(new GetParameterCommand({ Name: GROQ_API_KEY_PARAM, WithDecryption: true }));
  cachedApiKey = res.Parameter.Value;
  return cachedApiKey;
}

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Purely descriptive context for the prompt — not a validated pipeline
// contract. This project has exactly two known seeded bugs, so "expected"
// values here are the known-good shape of a fix, not a generic heuristic.
function buildWorkloadContract(finding, summary) {
  const dbHeavy = ['db_queries', 'db_queries_per_request', 'p95_ms'].includes(finding.metric);
  return {
    endpoint: dbHeavy ? '/orders' : 'all endpoints (every request logs at least once)',
    load:
      '15 constant VUs for 70s of measurement (after a 20s excluded warmup), hitting ' +
      '/login, /products, /orders every iteration; /orders uses pageSize=50, which is ' +
      '1 + 50 = 51 db_queries per request if the product lookup is not batched',
    observed: {
      db_queries_per_request: summary.db_queries_per_request,
      p95_ms: summary.p95_ms,
      flush_ops: summary.flush_ops,
      requests: summary.requests,
    },
    expected: {
      db_queries_per_request: '~2 (1 orders query + 1 batched WHERE id IN (...) query)',
      flush_ops: 'well under 1 flush per log call once writes are batched on flushIntervalMs',
    },
  };
}

exports.handler = async (event) => {
  const { runId, phase } = event || {};
  if (!runId || !phase) {
    throw new Error('runId and phase are required in the event payload');
  }

  const [finding, summary] = await Promise.all([
    readJson(`runs/${runId}/${phase}/finding.json`),
    readJson(`runs/${runId}/${phase}/summary.json`),
  ]);

  const files = ALLOWLIST.map((filePath) => ({
    path: filePath,
    sha256: sha256(allowlistManifest[filePath]),
    content: allowlistManifest[filePath],
  }));

  const userPrompt = JSON.stringify(
    {
      finding,
      workloadContract: buildWorkloadContract(finding, summary),
      files,
    },
    null,
    2
  );

  const apiKey = await getGroqApiKey();
  const provider = new GroqProvider({ apiKey, model: GROQ_MODEL_INVESTIGATOR });

  const patch = await provider.complete(SYSTEM_PROMPT, userPrompt, PATCH_SCHEMA);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/${phase}/patch.json`,
      Body: JSON.stringify(patch, null, 2),
      ContentType: 'application/json',
    })
  );

  return patch;
};
