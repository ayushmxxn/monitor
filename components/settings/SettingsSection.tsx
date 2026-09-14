import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingsSectionProps {
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * A titled group of setting rows rendered as a single hairline-bordered
 * block with dividers between rows, rather than a heavy card per group -
 * keeps a settings page scannable as one aligned column instead of a
 * stack of separately-framed boxes.
 */
export function SettingsSection({ title, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <h2 className="px-0.5 text-[11.5px] font-medium text-muted-foreground/80 select-none">
        {title}
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/70 bg-card/40 overflow-hidden">
        {children}
      </div>
    </section>
  );
}
