import * as React from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Generic empty state, used wherever a list has no items yet (e.g. no monitors). */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'animate-enter-up flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border px-6 py-8 text-center',
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-semibold tracking-tight">{title}</p>
        {description && (
          <p className="max-w-[30ch] text-[11.5px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
