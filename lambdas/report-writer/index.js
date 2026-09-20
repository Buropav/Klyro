'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SFNClient, DescribeExecutionCommand, GetExecutionHistoryCommand } = require('@aws-sdk/client-sfn');
const { deriveExecutionArn, collectStateEvents, buildStageTimeline } = require('../shared/executionStages');
const { estimateRunCost } = require('../shared/cost');
// Same manifest investigator/guard use — gives report-writer the
// pre-patch content of the target file without a separate S3 read, so the
// dashboard's diff view can be built from report.json alone.
const allowlistManifest = require('../shared-allowlist-manifest.generated.json');

const s3 = new S3Client({});
const sfn = new SFNClient({});
const BUCKET = process.env.RESULTS_BUCKET;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

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

/**
 * Per-stage timings for report.json, using the same STAGE_DEFINITIONS the
 * live status endpoint uses so the finished artifact and the progress view
 * agree on what a stage is.
 *
 * Best-effort by design — see the call site. When called from MarkFailed
 * the execution is still RUNNING, which is fine: the history up to the
 * failure is exactly what's wanted.
 */
async function readTimeline(runId) {
  if (!STATE_MACHINE_ARN) return { timeline: null, totalDurationMs: null };
  try {
    const executionArn = deriveExecutionArn(STATE_MACHINE_ARN, runId);
    const desc = await sfn.send(new DescribeExecutionCommand({ executionArn }));

    const events = [];
    let nextToken;
    do {
      const res = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 1000, nextToken }));
      events.push(...res.events);
      nextToken = res.nextToken;
    } while (nextToken);

    const { timings } = collectStateEvents(events);
    const startMs = desc.startDate ? new Date(desc.startDate).getTime() : null;
    const stopMs = desc.stopDate ? new Date(desc.stopDate).getTime() : Date.now();
    return {
      timeline: buildStageTimeline(timings),
      totalDurationMs: startMs === null ? null : stopMs - startMs,
    };
  } catch (err) {
    console.warn(`Could not build timeline for ${runId}: ${err.message}`);
    return { timeline: null, totalDurationMs: null };
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
  // Timing and cost come from the execution history. This whole block is
  // best-effort: report-writer is ALSO the MarkFailed handler, and the one
  // guarantee it exists to provide is that a report.json always gets
  // written. Adding a hard dependency on Step Functions here would trade
  // that guarantee away, so every failure degrades to nulls instead.
  const { timeline, totalDurationMs } = await readTimeline(runId);
  const cost = estimateRunCost(timeline, totalDurationMs);

  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    finding,
    patch: patch
      ? {
          file: patch.file,
          reason: patch.reason,
          expected_effect: patch.expected_effect,
          // DiffView (dashboard/src/components/DiffView.tsx) renders a
          // diff from report.json alone — it fetches nothing else from S3 —
          // so both sides of the patch are embedded here rather than kept
          // in patch.verified.json only.
          old_content: allowlistManifest[patch.file],
          new_content: patch.full_new_content,
        }
      : null,
    metrics: { baseline: baselineSummary, optimized: optimizedSummary },
    verdict: error ? 'FAILED' : evaluation ? evaluation.verdict : null,
    evaluationDetails: evaluation ? evaluation.metrics : null,
    // Which pool entry actually answered each agent, and how much
    // rotating/repairing it took. The multi-provider pool is otherwise
    // invisible: a run that survived a provider outage looks identical to
    // one that succeeded first try. Written by analyst/ and investigator/
    // as `_llm`; absent on older runs, hence the optional chaining.
    ai: {
      analyst: finding?._llm ?? null,
      investigator: patch?._llm ?? null,
    },
    timeline,
    totalDurationMs,
    cost,
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
