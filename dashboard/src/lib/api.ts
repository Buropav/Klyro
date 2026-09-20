import type { Report, RunSummary } from './types';
import type { PipelineStatus } from './pipelineTypes';

// Stable, already-deployed resources — see CLAUDE.md's Storage section.
const BUCKET = 'klyro-runs-072240928277';
const REGION = 'ap-south-1';

// Set at build time from the OrchestrationStack's HttpApiUrl output (see
// dashboard/.env.example) — this one genuinely changes across
// deploys/environments, unlike the bucket/region above. Serves both
// POST /run and GET /status/{runId}.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '');

export class ReportNotFoundError extends Error {
  constructor(runId: string) {
    super(`No report found for run "${runId}" yet.`);
    this.name = 'ReportNotFoundError';
  }
}

export function reportUrl(runId: string): string {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/runs/${encodeURIComponent(runId)}/report.json`;
}

/**
 * Fetches runs/<runId>/report.json directly from S3 — public-read via a
 * bucket policy scoped to exactly that path pattern (see CLAUDE.md's
 * Dashboard section). A 403/404 means the run hasn't reached
 * report-writer yet (or the runId is wrong), not a hard error.
 */
export async function fetchReport(runId: string): Promise<Report> {
  const res = await fetch(reportUrl(runId), { cache: 'no-store' });
  if (res.status === 403 || res.status === 404) {
    throw new ReportNotFoundError(runId);
  }
  if (!res.ok) {
    throw new Error(`S3 returned HTTP ${res.status} for ${runId}`);
  }
  return (await res.json()) as Report;
}

export interface StartRunResult {
  runId: string;
  executionArn: string;
}

function requireApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error(
      'VITE_API_BASE_URL is not set — copy dashboard/.env.example to dashboard/.env and fill in ' +
        "the OrchestrationStack's HttpApiUrl CloudFormation output."
    );
  }
  return API_BASE_URL;
}

/**
 * POSTs to the trigger Lambda's HTTP API (OrchestrationStack's
 * TriggerHttpApi, route POST /run) to start a brand-new experiment run.
 */
export async function startRun(): Promise<StartRunResult> {
  const res = await fetch(`${requireApiBaseUrl()}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `Trigger API returned HTTP ${res.status}`);
  }
  return body as StartRunResult;
}

export class ExecutionNotFoundError extends Error {
  constructor(runId: string) {
    super(`No execution found for run "${runId}".`);
    this.name = 'ExecutionNotFoundError';
  }
}

/**
 * GETs the status/ Lambda's route (GET /status/{runId}) for a coarse,
 * 10-stage view of a run's Step Functions execution — see
 * lambdas/status/index.js for the state-name-to-stage mapping.
 */
export async function fetchStatus(runId: string): Promise<PipelineStatus> {
  const res = await fetch(`${requireApiBaseUrl()}/status/${encodeURIComponent(runId)}`, { cache: 'no-store' });
  if (res.status === 404) {
    throw new ExecutionNotFoundError(runId);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Status API returned HTTP ${res.status}`);
  }
  return (await res.json()) as PipelineStatus;
}

/**
 * GETs the list-runs/ Lambda's route (GET /runs) — one row per
 * runs/<runId>/report.json in the bucket, newest first.
 */
export async function listRuns(): Promise<RunSummary[]> {
  const res = await fetch(`${requireApiBaseUrl()}/runs`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `List-runs API returned HTTP ${res.status}`);
  }
  const { runs } = (await res.json()) as { runs: RunSummary[] };
  return runs;
}
