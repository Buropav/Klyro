import type { Finding } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEVERITY_STYLES: Record<Finding['severity'], string> = {
  low: 'text-slate-400 bg-slate-400/10 border-slate-400/25',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/25',
  high: 'text-red-400 bg-red-400/10 border-red-400/25',
};

export interface FindingCardProps {
  finding: Finding;
}

export function FindingCard({ finding }: FindingCardProps) {
  return (
    <div className="card-glow rounded-lg border border-border bg-card p-5" data-state="baseline">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Diagnosis</span>
        <span
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase',
            SEVERITY_STYLES[finding.severity]
          )}
        >
          {finding.severity}
        </span>
      </div>
      <div className="mb-2 font-mono text-sm text-cyan-400">{finding.metric}</div>
      <p className="text-sm leading-relaxed text-foreground">{finding.reasoning}</p>
    </div>
  );
}
