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

exports.handler = async () => {
  const objects = [];
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

  const reportObjects = objects.filter((o) => o.Key.endsWith(REPORT_SUFFIX));

  const runs = await Promise.all(
    reportObjects.map(async (obj) => {
      const runId = obj.Key.slice('runs/'.length, -REPORT_SUFFIX.length);
      try {
        const report = await readJson(obj.Key);
        return {
          runId,
          timestamp: obj.LastModified,
          verdict: report.verdict,
          guardRejected: report.error?.Error === 'GUARD_REJECTED',
        };
      } catch {
        // report.json existed in the listing but failed to read/parse —
        // still show the run rather than dropping it silently.
        return { runId, timestamp: obj.LastModified, verdict: null, guardRejected: false };
      }
    })
  );

  runs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs }),
  };
};
