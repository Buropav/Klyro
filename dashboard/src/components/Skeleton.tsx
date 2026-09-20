import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

/** Placeholder matching MetricDeltaCard's layout — shown while report.json is still fetching. */
export function MetricDeltaCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-10 rounded-full" />
      </div>
      <div className="flex items-baseline gap-3">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-7 w-16" />
      </div>
      <Skeleton className="mt-4 h-24 w-full" />
    </div>
  );
}
