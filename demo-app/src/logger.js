const fs = require('node:fs');
const path = require('node:path');
const requestContext = require('./requestContext');

// flushIntervalMs is read but not yet used — the logger below flushes
// synchronously on every write instead of batching on this interval.
// Wiring flushIntervalMs into a real batched flush is the second seeded fix.
const configPath = path.join(__dirname, '..', 'config', 'logger.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function syncFlush(line) {
  // Stub "sync" flush target: one write() syscall per log line, immediately.
  process.stdout.write(line + '\n');
  requestContext.increment('flushOps');
}

function log(level, message, meta = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
  syncFlush(line);
}

module.exports = {
  config,
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
