import { useEffect, useRef, useState } from 'react';
import { fetchStatus } from '@/lib/api';
import { isTerminal, type PipelineStatus } from '@/lib/pipelineTypes';

const POLL_INTERVAL_MS = 2000;

/**
 * Polls GET /status/{runId} every 2s while overallStatus is "RUNNING",
 * stops on any terminal status (SUCCEEDED/FAILED/TIMED_OUT/ABORTED).
 */
export function usePipelineStatus(runId: string | null) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStatus(null);
    setError(null);
    if (!runId) return;

    let cancelled = false;

    async function poll() {
      try {
        const s = await fetchStatus(runId!);
        if (cancelled) return;
        setStatus(s);
        if (!isTerminal(s.overallStatus)) {
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // Execution not registered yet right after StartExecution — keep
        // polling rather than surfacing a scary error for a race that
        // resolves itself within a second or two.
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId]);

  return { status, error };
}
