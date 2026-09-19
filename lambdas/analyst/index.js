'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { MistralProvider } = require('../llm-provider');

const s3 = new S3Client({});
const ssm = new SSMClient({});

const BUCKET = process.env.RESULTS_BUCKET;
const MISTRAL_API_KEY_PARAM = process.env.MISTRAL_API_KEY_PARAM;
const LLM_MODEL_ANALYST = process.env.LLM_MODEL_ANALYST;

const FINDING_SCHEMA = {
  type: 'object',
  required: ['metric', 'reasoning', 'severity'],
  properties: {
    metric: { type: 'string', minLength: 1 },
    reasoning: { type: 'string', minLength: 1 },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

const SYSTEM_PROMPT = `You are a backend performance analyst reviewing one load-test run of a
Node/Express/Postgres API. You are given a compact metrics summary for a
single run: requests, requests_per_second, p95_ms, error_rate,
cpu_percent, db_queries, db_queries_per_request, and flush_ops.

Identify the SINGLE most anomalous metric in this summary — the one
number most likely pointing at a real performance defect — and explain
why it's anomalous in specific, concrete terms (reference the actual
numbers given, and what a healthy value would look like by comparison).

Respond with ONLY a JSON object of this exact shape, no prose, no
markdown fences:
{"metric": "<one of the metric names from the summary>", "reasoning": "<why this metric is anomalous>", "severity": "low" | "medium" | "high"}`;

let cachedApiKey;
async function getMistralApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const res = await ssm.send(new GetParameterCommand({ Name: MISTRAL_API_KEY_PARAM, WithDecryption: true }));
  cachedApiKey = res.Parameter.Value;
  return cachedApiKey;
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

  const summary = await readJson(`runs/${runId}/${phase}/summary.json`);

  const apiKey = await getMistralApiKey();
  const provider = new MistralProvider({ apiKey, model: LLM_MODEL_ANALYST });

  const userPrompt = `Metrics summary for run ${runId} (${phase}):\n${JSON.stringify(summary, null, 2)}`;

  const finding = await provider.complete(SYSTEM_PROMPT, userPrompt, FINDING_SCHEMA);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/${phase}/finding.json`,
      Body: JSON.stringify(finding, null, 2),
      ContentType: 'application/json',
    })
  );

  return finding;
};
