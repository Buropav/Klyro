import { Clock, Loader2, CheckCircle2, XCircle, ShieldCheck, ShieldX, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Status = 'pending' | 'active' | 'done' | 'failed' | 'validated' | 'rejected';

interface StatusConfig {
  label: string;
  icon: LucideIcon;
  className: string;
  spin?: boolean;
}

// Six distinct states across the run lifecycle: queued (pending), a step
// running (active), a step finished with no verdict attached (done),
// a hard failure (failed), the Evaluator's "OPTIMIZATION VALIDATED"
// verdict (validated), and Guard's GUARD_REJECTED verdict (rejected) —
// kept visually distinct from "failed" since it's a deliberate policy
// rejection, not a crash.
const STATUS_CONFIG: Record<Status, StatusConfig> = {
  pending: {
    label: 'Pending',
    icon: Clock,
    className: 'text-slate-400 bg-slate-400/10 border-slate-400/25',
  },
  active: {
    label: 'Active',
    icon: Loader2,
    className: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25',
    spin: true,
  },
  done: {
    label: 'Done',
    icon: CheckCircle2,
    className: 'text-blue-400 bg-blue-400/10 border-blue-400/25',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'text-red-400 bg-red-400/10 border-red-400/25',
  },
  validated: {
    label: 'Validated',
    icon: ShieldCheck,
    className: 'text-green-400 bg-green-400/10 border-green-400/25',
  },
  rejected: {
    label: 'Rejected',
    icon: ShieldX,
    className: 'text-amber-400 bg-amber-400/10 border-amber-400/25',
  },
};

export interface StatusBadgeProps {
  status: Status;
  /** Override the default label (e.g. "OPTIMIZATION VALIDATED" instead of "Validated"). */
  label?: string;
  className?: string;
  /** 'sm' (default) for inline use, 'lg' for a top-of-page verdict badge. */
  size?: 'sm' | 'lg';
}

const SIZE_CLASSES = {
  sm: { pill: 'gap-1.5 px-2.5 py-1 text-xs', icon: 'size-3.5' },
  lg: { pill: 'gap-2.5 px-4 py-2 text-base font-semibold', icon: 'size-5' },
};

export function StatusBadge({ status, label, className, size = 'sm' }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const sizeClasses = SIZE_CLASSES[size];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        sizeClasses.pill,
        config.className,
        className
      )}
    >
      <Icon className={cn(sizeClasses.icon, config.spin && 'animate-spin')} aria-hidden />
      {label ?? config.label}
    </span>
  );
}
