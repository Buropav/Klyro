import type { Patch } from '@/lib/types';
import { DiffView } from '@/components/DiffView';

export interface PatchViewProps {
  patch: Patch;
}

export function PatchView({ patch }: PatchViewProps) {
  return (
    <div className="card-glow rounded-lg border border-border bg-card p-5" data-state="optimized">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Patch</span>
        <span className="font-mono text-xs text-green-400">{patch.file}</span>
      </div>
      <p className="mb-1 text-sm leading-relaxed text-foreground">{patch.reason}</p>
      <p className="mb-4 text-xs text-muted-foreground">Expected effect: {patch.expected_effect}</p>

      {typeof patch.old_content === 'string' && typeof patch.new_content === 'string' ? (
        <DiffView file={patch.file} oldContent={patch.old_content} newContent={patch.new_content} />
      ) : (
        <p className="text-xs text-muted-foreground">No diff available for this run.</p>
      )}
    </div>
  );
}
