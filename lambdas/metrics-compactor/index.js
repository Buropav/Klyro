'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const s3 = new S3Client({});
const cloudwatch = new CloudWatchClient({});

const BUCKET = process.env.RESULTS_BUCKET;
const CLUSTER_NAME = process.env.CLUSTER_NAME;
const APP_SERVICE_NAME = process.env.APP_SERVICE_NAME;
const EMF_NAMESPACE = process.env.EMF_NAMESPACE || 'Klyro/DemoApp';

// Must match k6/load-script.js's "measurement" scenario duration.
const MEASUREMENT_DURATION_SECONDS = 70;
// Total wall-clock span of a k6 run (20s warmup + 70s measurement), used
// only to guess a time window when the caller doesn't supply one.
const TOTAL_TEST_DURATION_SECONDS = 90;
const WINDOW_BUFFER_SECONDS = 30;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return JSON.parse(await streamToString(res.Body));
}

function extractK6Metrics(k6Summary) {
  const metrics = k6Summary.metrics || {};
  const httpReqs = metrics['http_reqs{phase:measurement}'];
  const httpReqDuration = metrics['http_req_duration{phase:measurement}'];
  const httpReqFailed = metrics['http_req_failed{phase:measurement}'];

  if (!httpReqs || !httpReqDuration || !httpReqFailed) {
    throw new Error(
      'results.json is missing {phase:measurement} submetrics — was it produced by k6/load-script.js?'
    );
  }

  const requests = httpReqs.count;
  return {
    requests,
    requests_per_second: requests / MEASUREMENT_DURATION_SECONDS,
    p95_ms: httpReqDuration['p(95)'],
    // k6 Rate metric .value is a 0..1 fraction; the evaluator's rule
    // ("error-rate delta <= 0.5 percentage points") wants a 0..100 scale.
    error_rate: (httpReqFailed.value || 0) * 100,
  };
}

// Sums an EMF custom metric across every "endpoint" dimension value in
// the window, without needing to know those values ahead of time.
async function sumEmfMetric(metricName, startTime, endTime) {
  const res = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'm1',
          Expression: `SUM(SEARCH('{${EMF_NAMESPACE},endpoint} MetricName="${metricName}"', 'Sum', 60))`,
          ReturnData: true,
        },
      ],
    })
  );
  const values = res.MetricDataResults?.[0]?.Values || [];
  return values.reduce((sum, v) => sum + v, 0);
}

async function averageCpuPercent(startTime, endTime) {
  const res = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'cpu',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/ECS',
              MetricName: 'CPUUtilization',
              Dimensions: [
                { Name: 'ClusterName', Value: CLUSTER_NAME },
                { Name: 'ServiceName', Value: APP_SERVICE_NAME },
              ],
            },
            Period: 60,
            Stat: 'Average',
          },
          ReturnData: true,
        },
      ],
    })
  );
  const values = res.MetricDataResults?.[0]?.Values || [];
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

exports.handler = async (event) => {
  const { runId, phase } = event || {};
  if (!runId || !phase) {
    throw new Error('runId and phase are required in the event payload');
  }

  const now = new Date();
  const endTime = event.endTime ? new Date(event.endTime) : now;
  // Fallback window is approximate (invocation-time based), intended for
  // manual/ad-hoc testing. The state machine built in a later prompt has
  // the real task start/stop times and should pass startTime/endTime
  // explicitly instead of relying on this guess.
  const startTime = event.startTime
    ? new Date(event.startTime)
    : new Date(endTime.getTime() - (TOTAL_TEST_DURATION_SECONDS + WINDOW_BUFFER_SECONDS) * 1000);

  const k6Summary = await readJson(`runs/${runId}/${phase}/results.json`);
  const k6Metrics = extractK6Metrics(k6Summary);

  const [dbQueries, flushOps, cpuPercent] = await Promise.all([
    sumEmfMetric('db_queries', startTime, endTime),
    sumEmfMetric('flush_ops', startTime, endTime),
    averageCpuPercent(startTime, endTime),
  ]);

  const summary = {
    runId,
    phase,
    window: { start: startTime.toISOString(), end: endTime.toISOString() },
    requests: k6Metrics.requests,
    requests_per_second: k6Metrics.requests_per_second,
    p95_ms: k6Metrics.p95_ms,
    error_rate: k6Metrics.error_rate,
    cpu_percent: cpuPercent,
    db_queries: dbQueries,
    db_queries_per_request: k6Metrics.requests > 0 ? dbQueries / k6Metrics.requests : 0,
    flush_ops: flushOps,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `runs/${runId}/${phase}/summary.json`,
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    })
  );

  return summary;
};
