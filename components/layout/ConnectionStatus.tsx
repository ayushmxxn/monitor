import { cn } from '@/lib/utils';

interface ConnectionStatusProps {
  isLoading: boolean;
  isConnected: boolean;
  className?: string;
}

/** Small dot + label showing whether the background worker responded. */
export function ConnectionStatus({
  isLoading,
  isConnected,
  className,
}: ConnectionStatusProps) {
  const label = isLoading ? 'Connecting' : isConnected ? 'Connected' : 'Offline';

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          isLoading
            ? 'animate-pulse bg-muted-foreground'
            : isConnected
              ? 'bg-foreground'
              : 'bg-muted-foreground',
        )}
      />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
