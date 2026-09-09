import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FileQuestion,
  Loader2,
  ShieldAlert,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getFailureStateInfo } from '@/lib/monitors/diagnostics';
import type { DiagnosticCode } from '@/lib/monitors/diagnostics';
import type { MonitorStatus } from '@/lib/monitors/types';

const STATUS_CONFIG: Record<
  Exclude<MonitorStatus, 'error'>,
  { label: string; icon: React.ReactNode; className: string }
> = {
  idle: {
    label: 'Not checked yet',
    icon: <Circle className="h-2.5 w-2.5" />,
    className: 'text-muted-foreground',
  },
  checking: {
    label: 'Checking',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
    className: 'text-muted-foreground',
  },
  unchanged: {
    label: 'Unchanged',
    icon: <CheckCircle2 className="h-2.5 w-2.5" />,
    className: 'text-muted-foreground',
  },
  changed: {
    label: 'Changed',
    icon: <Sparkles className="h-2.5 w-2.5" />,
    className: 'text-foreground',
  },
};

export function MonitorStatusBadge({
  status,
  diagnosticCode,
  lastError,
}: {
  status: MonitorStatus;
  /** The monitor's last diagnostic code, if any. */
  diagnosticCode?: DiagnosticCode | null;
  /** The monitor's last error message, if any. */
  lastError?: string | null;
}) {
  if (status === 'error') {
    const failure = getFailureStateInfo(diagnosticCode, lastError);
    const icon =
      failure.reason === 'blocked' ? (
        <ShieldAlert className="h-2.5 w-2.5" />
      ) : failure.reason === 'page_load_failed' ? (
        <WifiOff className="h-2.5 w-2.5" />
      ) : failure.reason === 'page_changed' ? (
        <FileQuestion className="h-2.5 w-2.5" />
      ) : (
        <AlertCircle className="h-2.5 w-2.5" />
      );

    return (
      <Badge
        variant="outline"
        className={cn(
          'gap-1',
          failure.reason === 'blocked' ? 'text-muted-foreground' : 'text-foreground',
        )}
      >
        {icon}
        {failure.label}
      </Badge>
    );
  }

  const config = STATUS_CONFIG[status];
  return (
    <Badge variant="outline" className={cn('gap-1', config.className)}>
      {config.icon}
      {config.label}
    </Badge>
  );
}

