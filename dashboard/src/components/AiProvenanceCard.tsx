import { Cpu, RefreshCw, Wrench } from 'lucide-react';
import type { LlmProvenance } from '@/lib/types';

export interface AiProvenanceCardProps {
  ai: { analyst: LlmProvenance | null; investigator: LlmProvenance | null } | null | undefined;
}

function AgentRow({ role, meta }: { role: string; meta: LlmProvenance | null }) {
  if (!meta) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-2">
        <span className="text-xs text-muted-foreground">{role}</span>
        <span className="font-mono text-xs text-muted-foreground">not recorded</span>
      </div>
    );
  }

  const tokens = meta.usage?.total_tokens;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <span className="text-xs text-muted-foreground">{role}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-mono text-foreground">{meta.model}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{meta.provider}</span>
        {meta.rotations > 0 && (
          <span
            className="flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-mono text-amber-300"
            title={`Rate-limited or unavailable on ${meta.rotations} pool ${
              meta.rotations === 1 ? 'entry' : 'entries'
            } before this one answered`}
          >
            <RefreshCw className="size-3" aria-hidden />
            {meta.rotations}/{meta.poolSize}
          </span>
        )}
        {meta.schemaRepairUsed && (
          <span
            className="flex items-center gap-1 rounded-full bg-violet-400/10 px-2 py-0.5 text-[11px] text-violet-300"
            title="The model's first response failed schema validation and was retried once on the same pool entry"
          >
            <Wrench className="size-3" aria-hidden />
            repaired
          </span>
        )}
        {typeof tokens === 'number' && <span className="font-mono text-muted-foreground">{tokens} tok</span>}
      </div>
    </div>
  );
}

/**
 * Makes the LLM key pool visible.
 *
 * Both agents draw from a rotating pool of provider+model+key entries
 * spanning two providers, so a rate-limited or hard-down account still has
 * somewhere to go. Without this card a run that survived a provider outage
 * looks exactly like one that succeeded on the first try — the rotation
 * count is the whole point.
 */
export function AiProvenanceCard({ ai }: AiProvenanceCardProps) {
  if (!ai || (!ai.analyst && !ai.investigator)) return null;

  const rotated = (ai.analyst?.rotations ?? 0) + (ai.investigator?.rotations ?? 0);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Cpu className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium">Which model answered</h2>
      </div>

      <div className="divide-y divide-border">
        <AgentRow role="Analyst — diagnosis" meta={ai.analyst ?? null} />
        <AgentRow role="Investigator — patch" meta={ai.investigator ?? null} />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {rotated > 0 ? (
          <>
            This run rotated across {rotated} pool {rotated === 1 ? 'entry' : 'entries'} that were rate-limited or
            unavailable before getting an answer. Schema repairs never rotate &mdash; a model that answers wrongly is
            retried on the same entry.
          </>
        ) : (
          <>
            Every agent was answered by its first pool entry. On a rate limit or provider outage the pool rotates to the
            next entry &mdash; a different key, often a different provider &mdash; and retries the same prompt.
          </>
        )}
      </p>
    </div>
  );
}
