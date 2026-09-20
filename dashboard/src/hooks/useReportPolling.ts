import { useEffect, useRef, useState } from 'react';
import { fetchReport, ReportNotFoundError } from '@/lib/api';
import type { Report } from '@/lib/types';

const POLL_INTERVAL_MS = 5000;

/**
 * Polls runs/<runId>/report.json until it exists. There's no other way
 * for an unauthenticated browser to know when a run has finished — the
 * only public surface is the report.json bucket policy (see CLAUDE.md's
 * Dashboard section) — so "report.json exists" IS the terminal-state
 * signal, for both a freshly-started run and a judge pasting in an
 * already-finished runId (which resolves on the very first poll).
 */
export function useReportPolling(runId: string | null) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    if (!runId) return;

    let cancelled = false;

    async function poll() {
      try {
        const r = await fetchReport(runId!);
        if (!cancelled) setReport(r);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ReportNotFoundError) {
          timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId]);

  return { report, error };
}
