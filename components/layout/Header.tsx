import * as React from 'react';
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/lib/constants';

interface HeaderProps {
  title?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Compact, consistent header used at the top of the options page. */
export function Header({ title = APP_NAME, action, className }: HeaderProps) {
  return (
    <header
      className={cn(
        'flex items-center justify-between border-b border-border px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <img src="/icon/32.png" alt="" className="h-6 w-6 shrink-0 rounded-md" />
        <span className="text-sm font-semibold tracking-tight">{title}</span>
      </div>
      {action}
    </header>
  );
}
