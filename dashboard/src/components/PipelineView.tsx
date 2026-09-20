import { motion } from 'motion/react';
import { Circle, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Stage, StageStatus } from '@/lib/pipelineTypes';

export interface PipelineViewProps {
  stages: Stage[];
}

const NODE_STYLES: Record<StageStatus, string> = {
  pending: 'border-border text-muted-foreground bg-card',
  active: 'border-cyan-400 text-cyan-300 bg-cyan-400/10',
  done: 'border-green-400 text-green-400 bg-green-400/10',
  failed: 'border-red-400 text-red-400 bg-red-400/10',
};

function NodeIcon({ status }: { status: StageStatus }) {
  if (status === 'active') return <Loader2 className="size-4 animate-spin" aria-hidden />;
  if (status === 'done') return <CheckCircle2 className="size-4" aria-hidden />;
  if (status === 'failed') return <XCircle className="size-4" aria-hidden />;
  return <Circle className="size-3" aria-hidden />;
}

/** Connector between stage i and i+1 — colored/animated by what's happening at i+1 (the node it leads into). */
function connectorClassName(nextStatus: StageStatus): string {
  if (nextStatus === 'active') return 'connector-flow';
  if (nextStatus === 'done') return 'bg-green-400/60';
  if (nextStatus === 'failed') return 'bg-red-400/60';
  return 'bg-border';
}

export function PipelineView({ stages }: PipelineViewProps) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border bg-card p-6">
      <div className="flex min-w-max items-center">
        {stages.map((stage, i) => (
          <div key={stage.name} className="flex items-center">
            <div className="flex flex-col items-center gap-2">
              <motion.div
                layout
                initial={false}
                animate={
                  stage.status === 'active'
                    ? { boxShadow: ['0 0 0 0px rgba(34,211,238,0.0)', '0 0 0 8px rgba(34,211,238,0.18)', '0 0 0 0px rgba(34,211,238,0.0)'] }
                    : { boxShadow: '0 0 0 0px rgba(34,211,238,0.0)' }
                }
                transition={
                  stage.status === 'active'
                    ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
                    : { duration: 0.3 }
                }
                className={cn(
                  'flex size-10 items-center justify-center rounded-full border-2 transition-colors duration-300',
                  NODE_STYLES[stage.status]
                )}
              >
                <NodeIcon status={stage.status} />
              </motion.div>
              <span
                className={cn(
                  'whitespace-nowrap text-[11px] font-medium',
                  stage.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {stage.name}
              </span>
            </div>

            {i < stages.length - 1 && (
              <motion.div
                layout
                className={cn('mx-1 mb-5 h-0.5 w-10 sm:w-14 rounded-full', connectorClassName(stages[i + 1].status))}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
