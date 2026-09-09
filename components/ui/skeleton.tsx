import { cn } from '@/lib/utils';

/** Shimmering placeholder block used while data loads. Pure CSS - see `.skeleton-shimmer` in globals.css. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('skeleton-shimmer rounded-md bg-muted', className)}
      {...props}
    />
  );
}
