#!/bin/sh
# Entrypoint for the k6 task. Requires RUN_ID, PHASE, TARGET_URL, and
# S3_BUCKET to be set in the environment — no defaults, on purpose: the
# ECS task definition intentionally omits these so a caller who forgets to
# pass them (via RunTask containerOverrides) fails loudly here instead of
# silently reusing a stale value.
set -eu

: "${RUN_ID:?RUN_ID environment variable is required}"
: "${PHASE:?PHASE environment variable is required}"
: "${TARGET_URL:?TARGET_URL environment variable is required}"
: "${S3_BUCKET:?S3_BUCKET environment variable is required}"

RESULTS_FILE=/tmp/results.json

echo "Running k6 load test: RUN_ID=$RUN_ID PHASE=$PHASE TARGET_URL=$TARGET_URL"

# Don't let a threshold breach (e.g. p95 blown out by the seeded N+1 bug —
# an expected, meaningful result, not a script error) stop us from
# uploading results.json. Only "k6 never produced a summary at all" counts
# as a real failure below.
set +e
k6 run --summary-export="$RESULTS_FILE" /k6/load-script.js
K6_EXIT_CODE=$?
set -e

if [ ! -s "$RESULTS_FILE" ]; then
  echo "k6 did not produce $RESULTS_FILE (k6 exit code $K6_EXIT_CODE) — aborting" >&2
  exit 1
fi

DEST="s3://${S3_BUCKET}/runs/${RUN_ID}/${PHASE}/results.json"
echo "Uploading $RESULTS_FILE to $DEST"
aws s3 cp "$RESULTS_FILE" "$DEST"

echo "Done. (k6 exit code was $K6_EXIT_CODE — reflects threshold pass/fail, not upload success.)"
exit 0
