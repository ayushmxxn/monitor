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
    <section className={className}>
      <h2 className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground/75">
        {title}
      </h2>
      <div className="divide-y divide-border/70 rounded-lg border border-border/70">{children}</div>
    </section>
  );
}
