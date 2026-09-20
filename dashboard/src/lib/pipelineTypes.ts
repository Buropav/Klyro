// Mirrors lambdas/status/index.js's response shape exactly.
// 'skipped' = the run ended before reaching this stage, so it never ran
// and never will. Distinct from 'pending', which means "still queued on a
// run that is still going".
export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type OverallStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';

export interface Stage {
  name: string;
  status: StageStatus;
}

export interface PipelineStatus {
  overallStatus: OverallStatus;
  currentStage: string;
  stages: Stage[];
}

export function isTerminal(status: OverallStatus): boolean {
  return status !== 'RUNNING';
}
