// Emits one CloudWatch Embedded Metric Format (EMF) JSON line per request
// to stdout. CloudWatch Logs parses the "_aws" block and turns it into
// metrics without needing a separate PutMetricData call.
function emitRequestMetric({ endpoint, dbQueries, flushOps }) {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'Klyro/DemoApp',
          Dimensions: [['endpoint']],
          Metrics: [
            { Name: 'requests', Unit: 'Count' },
            { Name: 'db_queries', Unit: 'Count' },
            { Name: 'flush_ops', Unit: 'Count' },
          ],
        },
      ],
    },
    endpoint,
    requests: 1,
    db_queries: dbQueries,
    flush_ops: flushOps,
  };
  process.stdout.write(JSON.stringify(emf) + '\n');
}

module.exports = { emitRequestMetric };
