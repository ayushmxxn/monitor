import * as React from 'react';
import { AlertCircle, Info, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

type NoticeTone = 'error' | 'warning' | 'info';

interface InlineNoticeProps {
  tone?: NoticeTone;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

const TONE_ICON: Record<NoticeTone, React.ReactNode> = {
  error: <AlertCircle className="h-3.5 w-3.5" />,
  warning: <ShieldAlert className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
};

/**
 * A bordered callout for errors, warnings, and informational messages.
 * Deliberately grayscale (weight/border, not color) to stay within the
 * white/gray/black design system - severity is conveyed by icon and
 * copy, not hue.
 */
export function InlineNotice({
  tone = 'info',
  children,
  action,
  className,
}: InlineNoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-2',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{TONE_ICON[tone]}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[11.5px] leading-relaxed text-muted-foreground">{children}</div>
        {action}
      </div>
    </div>
  );
}
