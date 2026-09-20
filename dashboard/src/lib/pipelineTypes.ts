// Mirrors lambdas/status/index.js's response shape exactly.
export type StageStatus = 'pending' | 'active' | 'done' | 'failed';
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
