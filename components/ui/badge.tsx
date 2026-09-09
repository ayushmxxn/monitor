import * as React from 'react';
import { cn } from '@/lib/utils';

const VARIANT_CLASS: Record<string, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: keyof typeof VARIANT_CLASS;
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
        VARIANT_CLASS[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
