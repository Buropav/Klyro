'use strict';

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const BUCKET = process.env.RESULTS_BUCKET;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Every completed run has exactly one runs/<runId>/report.json — listing
// for that suffix (rather than the runId "folder" itself, which has many
// other keys per run) is what turns the flat object listing into one row
// per run.
const REPORT_SUFFIX = '/report.json';
// Exactly one path segment between runs/ and /report.json. A plain suffix
// match would also accept runs/<id>/baseline/report.json and yield a runId
// of "<id>/baseline"; nothing writes that today, but the filter should
// describe what it means.
const REPORT_KEY_PATTERN = /^runs\/([^/]+)\/report\.json$/;

// Reading every report.json is an unbounded fan-out of GetObjects in a
// 30s Lambda. The 14-day bucket lifecycle bounds this in practice, but not
// in principle — cap it and report that the list was truncated rather than
// timing out.
const MAX_RUNS = 200;

const JSON_HEADERS = { 'content-type': 'application/json' };
const respond = (statusCode, body) => ({ statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Pulls the run-over-run comparison fields out of a full report.
 *
 * report.json already holds everything the trend view needs, so this adds
 * no extra S3 reads — the reports were being opened for `verdict` anyway.
 * Every field is null-tolerant: reports written before these fields
 * existed still list fine, they just have nothing to plot.
 */
function summarize(report) {
  const baseline = report?.metrics?.baseline;
  const optimized = report?.metrics?.optimized;
  const p95Baseline = num(baseline?.p95_ms);
  const p95Optimized = num(optimized?.p95_ms);
  const ratio = num(report?.evaluationDetails?.p95_improvement_ratio);

  const improvementPct =
    ratio !== null
      ? ratio * 100
      : p95Baseline !== null && p95Optimized !== null && p95Baseline > 0
        ? ((p95Baseline - p95Optimized) / p95Baseline) * 100
        : null;

  return {
    verdict: report?.verdict ?? null,
    guardRejected: report?.error?.Error === 'GUARD_REJECTED',
    p95Baseline,
    p95Optimized,
    improvementPct,
    durationMs: num(report?.totalDurationMs),
    costUsd: num(report?.cost?.totalUsd),
  };
}

exports.summarize = summarize;

exports.handler = async () => {
  let objects = [];
  try {
    let continuationToken;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: 'runs/',
          ContinuationToken: continuationToken,
        })
      );
      objects.push(...(res.Contents || []));
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    // Previously this threw, and API Gateway answered with a bare 500 and
    // no body — the dashboard could only report "HTTP 500".
    console.error(`ListObjectsV2 failed: ${err.message}`);
    return respond(502, { error: `Could not list runs: ${err.message}` });
  }

  const reportObjects = objects
    .filter((o) => REPORT_KEY_PATTERN.test(o.Key))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

  const truncated = reportObjects.length > MAX_RUNS;
  const selected = reportObjects.slice(0, MAX_RUNS);

  const runs = await Promise.all(
    selected.map(async (obj) => {
      const runId = obj.Key.match(REPORT_KEY_PATTERN)[1];
      const base = { runId, timestamp: obj.LastModified };
      try {
        return { ...base, ...summarize(await readJson(obj.Key)) };
      } catch {
        // report.json existed in the listing but failed to read/parse —
        // still show the run rather than dropping it silently.
        return { ...base, ...summarize(null) };
      }
    })
  );

  return respond(200, { runs, truncated });
};
