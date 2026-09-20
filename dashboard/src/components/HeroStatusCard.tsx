import { motion } from 'motion/react';
import { Play, Loader2, CheckCircle2, XCircle, ShieldCheck, ShieldX } from 'lucide-react';
import { cn } from '@/lib/utils';

export type HeroState = 'idle' | 'active' | 'done' | 'failed' | 'validated' | 'rejected';

export interface HeroStatusCardProps {
  state: HeroState;
  runId?: string;
  /** Short status line under the run id, e.g. "Building baseline image…" */
  statusLine?: string;
  onRunExperiment: () => void;
  /** True while the POST to /run is in flight, before a runId comes back. */
  starting?: boolean;
}

const TERMINAL_RING: Record<Exclude<HeroState, 'idle' | 'active'>, { className: string; Icon: typeof CheckCircle2 }> = {
  done: { className: 'text-blue-400 border-blue-400', Icon: CheckCircle2 },
  failed: { className: 'text-red-400 border-red-400', Icon: XCircle },
  validated: { className: 'text-green-400 border-green-400', Icon: ShieldCheck },
  rejected: { className: 'text-amber-400 border-amber-400', Icon: ShieldX },
};

// A "spectral" (multi-hue) glow that sweeps through the whole accent
// palette while a run is active — distinct from the solid single-color
// ring a terminal state settles into, per the design brief.
const SPECTRAL_BOX_SHADOWS = [
  '0 0 0 0px rgba(34,211,238,0.0)',
  '0 0 0 10px rgba(34,211,238,0.18)',
  '0 0 0 10px rgba(139,92,246,0.18)',
  '0 0 0 10px rgba(245,158,11,0.18)',
  '0 0 0 10px rgba(34,197,94,0.18)',
  '0 0 0 10px rgba(34,211,238,0.18)',
  '0 0 0 0px rgba(34,211,238,0.0)',
];

export function HeroStatusCard({ state, runId, statusLine, onRunExperiment, starting }: HeroStatusCardProps) {
  const isActive = state === 'active';
  const isTerminal = state === 'done' || state === 'failed' || state === 'validated' || state === 'rejected';

  return (
    <div className="rounded-xl border border-border bg-card p-10 flex flex-col items-center gap-6 text-center">
      <div className="relative flex h-28 w-28 items-center justify-center rounded-full">
        {isActive && (
          <motion.div
            className="absolute inset-0 rounded-full"
            animate={{ boxShadow: SPECTRAL_BOX_SHADOWS }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        <div
          className={cn(
            'flex h-24 w-24 items-center justify-center rounded-full border-2',
            state === 'idle' && 'border-border text-muted-foreground',
            isActive && 'border-cyan-400/60 text-cyan-300',
            isTerminal && TERMINAL_RING[state as Exclude<HeroState, 'idle' | 'active'>].className
          )}
        >
          {state === 'idle' && <Play className="size-9" aria-hidden />}
          {isActive && <Loader2 className="size-9 animate-spin" aria-hidden />}
          {isTerminal &&
            (() => {
              const { Icon } = TERMINAL_RING[state as Exclude<HeroState, 'idle' | 'active'>];
              return <Icon className="size-9" aria-hidden />;
            })()}
        </div>
      </div>

      <div className="space-y-1">
        <div className="font-mono text-sm text-muted-foreground">{runId ?? 'No run started yet'}</div>
        {statusLine && <div className="text-sm text-foreground">{statusLine}</div>}
      </div>

      {(state === 'idle' || isTerminal) && (
        <button
          onClick={onRunExperiment}
          disabled={starting}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-baseline px-5 py-2.5 text-sm font-semibold text-white shadow-glow-baseline transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
          {isTerminal ? 'Run again' : 'Run Experiment'}
        </button>
      )}
    </div>
  );
}
