import { Skeleton } from '@/components/ui/skeleton';

export function MonitorCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/50 dark:bg-card p-3">
      <Skeleton className="h-5 w-4/5 bg-foreground/10" />
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-3 w-3 rounded-sm bg-foreground/10" />
        <Skeleton className="h-2.5 w-1/2 bg-foreground/10" />
      </div>
    </div>
  );
}

export function MonitorListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <MonitorCardSkeleton key={i} />
      ))}
    </div>
  );
}
