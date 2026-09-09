import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { InlineNotice } from '@/components/layout/InlineNotice';
import { Favicon } from '@/components/layout/Favicon';
import { MonitorStatusBadge } from './MonitorStatusBadge';
import { SemanticValueBadge } from './SemanticValueBadge';
import { CURRENCY_SYMBOLS } from '@/lib/monitors/semanticValue';
import { HistoryChart } from './HistoryChart';
import { DeleteMonitorDialog } from './DeleteMonitorDialog';
import { useMonitor } from '@/hooks/useMonitor';
import { useMonitorHistory } from '@/hooks/useMonitorHistory';
import { useIsChecking } from '@/hooks/useIsChecking';
import { checkMonitorNow } from '@/lib/monitors/client';
import { deleteMonitor, updateMonitor } from '@/lib/monitors/store';
import { sendMessage } from '@/lib/messaging';
import { formatIntervalMinutes } from '@/lib/monitors/intervals';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { isTemporaryPageState, getFailureStateInfo } from '@/lib/monitors/diagnostics';
import {
  calculateValueChange,
  formatHeroMovement,
  type ValueChangeSummary,
} from '@/lib/monitors/changeSummary';
import { calculateHistoricalBenchmarks } from '@/lib/monitors/benchmarks';
import { formatAlertConditionDescription } from '@/lib/monitors/alertCondition';
import type { AlertCondition, AlertConditionType } from '@/lib/monitors/types';
import { cn } from '@/lib/utils';

interface MonitorDetailProps {
  monitorId: string;
  /** Called once the monitor has been deleted, so the caller can navigate away. */
  onDeleted: () => void;
}

/**
 * A monitor's full detail view - status, quick actions, stats, and
 * history. Rendered inline in the panel, in place of the list, so
 * clicking a monitor never leaves the page the user was on or opens a
 * new tab.
 *
 * Origin-permission checks go through the background worker
 * (`checkOriginPermissions` / `openOptionsPage`) rather than calling
 * `browser.permissions` directly, since this component has to work
 * from inside the panel's content script, which can't reach that API
 * at all - see `usePageAccess` for the same constraint.
 */
export function MonitorDetail({ monitorId, onDeleted }: MonitorDetailProps) {
  const { monitor, isLoading } = useMonitor(monitorId);
  const { history } = useMonitorHistory(monitorId);
  const [isChecking, setIsChecking] = useState(false);
  const isCheckingInFlight = useIsChecking(monitorId);
  const isCheckingActive = isChecking || isCheckingInFlight;
  const [checkError, setCheckError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAlertOpen, setIsAlertOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMenuOpen && !isAlertOpen) return;

    const root = alertRef.current?.getRootNode() as Document | ShadowRoot | null;

    function handlePointerDown(e: Event) {
      const target = e.target as Node | null;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setIsMenuOpen(false);
      }
      if (alertRef.current && !alertRef.current.contains(target)) {
        setIsAlertOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
        setIsAlertOpen(false);
      }
    }

    if (root && root !== document) {
      root.addEventListener('pointerdown', handlePointerDown);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      if (root && root !== document) {
        root.removeEventListener('pointerdown', handlePointerDown);
      }
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen, isAlertOpen]);

  const changes = useMemo(() => {
    const result = [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (entry.changed && entry.value !== null) {
        const nextInHistory = history[i + 1];
        const prevVal =
          entry.previousValue !== undefined
            ? entry.previousValue
            : (nextInHistory?.value ?? null);
        const prevSem =
          entry.previousSemanticValue !== undefined
            ? entry.previousSemanticValue
            : (nextInHistory?.semanticValue ?? null);
        const change = calculateValueChange(prevVal, prevSem, entry.value, entry.semanticValue);
        result.push({
          id: entry.id,
          checkedAt: entry.checkedAt,
          change,
        });
      }
    }
    return result;
  }, [history]);

  const heroMovement = useMemo(() => {
    if (!monitor || !monitor.lastValue) return null;
    if (!history || history.length === 0) return null;

    let prevVal: string | null = null;
    let prevSem = null;

    if (history.length >= 2 && history[1]?.value !== null) {
      prevVal = history[1].value;
      prevSem = history[1].semanticValue ?? null;
    } else if (history[0]?.previousValue !== undefined && history[0].previousValue !== null) {
      prevVal = history[0].previousValue;
      prevSem = history[0].previousSemanticValue ?? null;
    }

    if (!prevVal) return null;

    const change = calculateValueChange(
      prevVal,
      prevSem,
      monitor.lastValue,
      monitor.lastSemanticValue,
    );

    return formatHeroMovement(change);
  }, [monitor?.lastValue, monitor?.lastSemanticValue, history]);

  const benchmarks = useMemo(() => {
    return calculateHistoricalBenchmarks(
      history,
      monitor?.lastValue,
      monitor?.lastSemanticValue,
      monitor?.stats,
    );
  }, [history, monitor?.lastValue, monitor?.lastSemanticValue, monitor?.stats]);

  useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    async function refreshAccess() {
      try {
        const granted = await sendMessage('checkOriginPermissions', [monitor!.url]);
        if (!cancelled) setHasPermission(granted[monitor!.url] ?? null);
      } catch {
        if (!cancelled) setHasPermission(null);
      }
    }
    void refreshAccess();
    // Re-check when the page regains focus: granting access happens in
    // the options tab, so returning here must immediately reflect the
    // recovery (or its absence) instead of waiting on a remount.
    function handleFocus() {
      void refreshAccess();
    }
    window.addEventListener('focus', handleFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleFocus);
    };
  }, [monitor?.url]);

  const [conditionType, setConditionType] = useState<AlertConditionType>(
    monitor?.alertCondition?.type ?? 'any',
  );
  const [targetValueStr, setTargetValueStr] = useState<string>(
    monitor?.alertCondition?.targetValue !== null && monitor?.alertCondition?.targetValue !== undefined
      ? String(monitor.alertCondition.targetValue)
      : '',
  );
  const [targetTextStr, setTargetTextStr] = useState<string>(
    monitor?.alertCondition?.targetText ?? '',
  );

  useEffect(() => {
    if (monitor) {
      const type = monitor.alertCondition?.type ?? 'any';
      const val =
        monitor.alertCondition?.targetValue !== null && monitor.alertCondition?.targetValue !== undefined
          ? String(monitor.alertCondition.targetValue)
          : '';
      const txt = monitor.alertCondition?.targetText ?? '';
      setConditionType((prev) => (prev !== type ? type : prev));
      setTargetValueStr((prev) => (prev !== val ? val : prev));
      setTargetTextStr((prev) => (prev !== txt ? txt : prev));
    }
  }, [
    monitor?.alertCondition?.type,
    monitor?.alertCondition?.targetValue,
    monitor?.alertCondition?.targetText,
  ]);

  const activeAlertCondition: AlertCondition = useMemo(() => {
    let numericTarget: number | null = null;
    if (conditionType === 'below' || conditionType === 'above') {
      const cleaned = targetValueStr.replace(/[^0-9.-]/g, '');
      if (cleaned && !Number.isNaN(parseFloat(cleaned))) {
        numericTarget = parseFloat(cleaned);
      } else if (monitor?.alertCondition?.targetValue != null) {
        numericTarget = monitor.alertCondition.targetValue;
      } else if (monitor?.lastSemanticValue?.normalized != null) {
        numericTarget = monitor.lastSemanticValue.normalized;
      }
    }
    return {
      type: conditionType,
      targetValue: numericTarget,
      targetText: conditionType === 'matches' ? targetTextStr : null,
    };
  }, [conditionType, targetValueStr, targetTextStr, monitor?.alertCondition?.targetValue, monitor?.lastSemanticValue?.normalized]);

  async function saveCondition(
    type: AlertConditionType,
    valStr: string,
    txtStr: string,
  ): Promise<boolean> {
    if (!monitor) return false;
    let numericTarget: number | null = null;
    if (type === 'below' || type === 'above') {
      const cleaned = valStr.replace(/[^0-9.-]/g, '');
      if (cleaned && !Number.isNaN(parseFloat(cleaned))) {
        numericTarget = parseFloat(cleaned);
      } else if (monitor.alertCondition?.targetValue != null) {
        numericTarget = monitor.alertCondition.targetValue;
      } else if (monitor.lastSemanticValue?.normalized != null) {
        numericTarget = monitor.lastSemanticValue.normalized;
      }
    }
    const alertCondition: AlertCondition = {
      type,
      targetValue: numericTarget,
      targetText: type === 'matches' ? txtStr : null,
    };
    const result = await updateMonitor(monitor.id, { alertCondition });
    if (!result.ok) {
      setActionError(result.error.toDisplayMessage());
      // Revert the optimistic condition UI to the last persisted values.
      const stored = monitor.alertCondition;
      setConditionType(stored?.type ?? 'any');
      setTargetValueStr(stored?.targetValue != null ? String(stored.targetValue) : '');
      setTargetTextStr(stored?.targetText ?? '');
      return false;
    }
    return true;
  }

  function handleConditionTypeChange(nextType: AlertConditionType) {
    setConditionType(nextType);
    let nextVal = targetValueStr;
    if ((nextType === 'below' || nextType === 'above') && !targetValueStr && monitor?.lastSemanticValue?.normalized != null) {
      nextVal = String(monitor.lastSemanticValue.normalized);
      setTargetValueStr(nextVal);
    }
    void saveCondition(nextType, nextVal, targetTextStr);
    setIsAlertOpen(false);
  }

  function handleTargetValueChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTargetValueStr(e.target.value);
  }

  function handleTargetTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTargetTextStr(e.target.value);
  }

  function commitTargetValue() {
    const cleaned = targetValueStr.replace(/[^0-9.-]/g, '');
    if (!cleaned || Number.isNaN(parseFloat(cleaned))) {
      const fallback =
        monitor?.alertCondition?.targetValue != null
          ? String(monitor.alertCondition.targetValue)
          : monitor?.lastSemanticValue?.normalized != null
            ? String(monitor.lastSemanticValue.normalized)
            : '';
      setTargetValueStr(fallback);
      if (fallback) {
        void saveCondition(conditionType, fallback, targetTextStr);
      }
      return;
    }
    void saveCondition(conditionType, targetValueStr, targetTextStr);
  }

  function commitTargetText() {
    void saveCondition(conditionType, targetValueStr, targetTextStr);
  }

  function handleTargetKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  }

  if (isLoading) return <DetailSkeleton />;

  if (!monitor) {
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">This monitor no longer exists.</p>
    );
  }

  async function handleCheckNow() {
    setIsChecking(true);
    setCheckError(null);
    try {
      const result = await checkMonitorNow(monitor!.id);
      if (!result.ok) {
        setCheckError(result.error.toDisplayMessage());
      }
    } finally {
      setIsChecking(false);
    }
  }

  async function handleDelete() {
    if (!monitor) return;
    setIsDeleting(true);
    setActionError(null);
    try {
      const result = await deleteMonitor(monitor.id);
      if (!result.ok) {
        setActionError(result.error.toDisplayMessage());
        return;
      }
      onDeleted();
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleToggleEnabled() {
    if (!monitor) return;
    setIsTogglingEnabled(true);
    setActionError(null);
    try {
      const result = await updateMonitor(monitor.id, { enabled: !monitor.enabled });
      if (!result.ok) {
        setActionError(result.error.toDisplayMessage());
      }
    } finally {
      setIsTogglingEnabled(false);
    }
  }

  async function handleRename(newName: string) {
    if (!monitor) return;
    setActionError(null);
    const result = await updateMonitor(monitor.id, { name: newName });
    if (!result.ok) {
      setActionError(result.error.toDisplayMessage());
    }
  }

  let hostname = monitor.url;
  try {
    hostname = new URL(monitor.url).hostname;
  } catch {
    // keep raw url
  }

  const isError = monitor.lastStatus === 'error';
  const isTemporarilyBlocked = isError && isTemporaryPageState(monitor.lastDiagnosticCode);
  const failureInfo = isError ? getFailureStateInfo(monitor.lastDiagnosticCode, monitor.lastError) : null;
  const hasValue = monitor.lastValue !== null;
  const hasSemantic = monitor.lastSemanticValue !== null;
  const isNumeric =
    hasSemantic
      ? monitor.lastSemanticValue!.type !== 'text' &&
        monitor.lastSemanticValue!.normalized !== null &&
        monitor.lastSemanticValue!.normalized !== undefined
      : false;
  const isCurrency = monitor.lastSemanticValue?.type === 'currency';
  let unitPrefix: string | null = null;
  if (isCurrency && monitor.lastSemanticValue?.unit) {
    const rawUnit = monitor.lastSemanticValue.unit;
    for (const [sym, code] of CURRENCY_SYMBOLS) {
      if (code === rawUnit || sym === rawUnit) {
        unitPrefix = sym;
        break;
      }
    }
    if (!unitPrefix) unitPrefix = rawUnit;
  }
  const prefixPaddingClass = !unitPrefix
    ? ''
    : unitPrefix.length === 1
      ? 'pl-6'
      : unitPrefix.length === 2
        ? 'pl-8'
        : 'pl-11';
  const unitSuffix = monitor.lastSemanticValue?.type === 'percentage' ? '%' : null;
  const targetPlaceholder =
    monitor.lastSemanticValue?.normalized != null
      ? String(monitor.lastSemanticValue.normalized)
      : 'Target';

  return (
    <div className="animate-enter-up flex flex-col gap-4">
      {hasPermission === false && (
        <InlineNotice
          tone="warning"
          action={
            <Button size="sm" variant="outline" onClick={() => sendMessage('openOptionsPage', undefined)}>
              Grant access
            </Button>
          }
        >
          Access to <span className="text-foreground">{hostname}</span> was revoked. Checks are paused until
          it's granted again.
        </InlineNotice>
      )}

      {/* Hero block - the current value, front and center, same role
          here as the tile value on the list view. Everything else on
          this screen is metadata about this one number. */}
      <div className="rounded-lg border border-black/[0.05] bg-muted/50 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <a
            href={monitor.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-[11.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Favicon url={monitor.url} size={12} />
            <span className="truncate">{hostname}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          {!monitor.enabled ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Pause className="h-2.5 w-2.5" />
              Paused
            </Badge>
          ) : (
            <MonitorStatusBadge
              status={isCheckingActive ? 'checking' : monitor.lastStatus}
              diagnosticCode={monitor.lastDiagnosticCode}
              lastError={monitor.lastError}
            />
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <p
            title={hasValue ? (monitor.lastValue ?? undefined) : undefined}
            className={cn(
              'truncate text-[28px] font-semibold leading-[1.1] tracking-[-0.015em] tabular-nums text-foreground',
              !hasValue && 'text-muted-foreground/50',
            )}
          >
            {hasValue ? monitor.lastValue : isError ? (failureInfo?.label ?? 'Check failed') : '—'}
          </p>

          {benchmarks?.dealStatusLabel && hasValue && (
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
                benchmarks.dealStatus === 'all-time-low'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {benchmarks.dealStatus === 'near-lowest' ? 'Near low' : benchmarks.dealStatusLabel}
            </span>
          )}
        </div>

        {heroMovement && (() => {
          const suffix = ' since last check';
          const hasSuffix = heroMovement.text.endsWith(suffix);
          const rawMovement = hasSuffix
            ? heroMovement.text.slice(0, -suffix.length)
            : heroMovement.text;
          const cleanMovement = rawMovement.replace(/([+-])0\.0%/g, '0.0%');

          return (
            <p className="mt-1 truncate text-[12px] font-medium tabular-nums">
              <span
                className={cn(
                  heroMovement.direction === 'increase'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400',
                )}
              >
                {cleanMovement}
              </span>
              {hasSuffix && (
                <span className="text-muted-foreground font-normal">
                  {suffix}
                </span>
              )}
            </p>
          );
        })()}

        <div className="mt-2 flex items-center justify-between gap-2">
          {monitor.lastSemanticValue ? (
            <SemanticValueBadge type={monitor.lastSemanticValue.type} />
          ) : (
            <span />
          )}
          <span className="text-[11px] text-muted-foreground">
            {monitor.lastCheckedAt ? `Updated ${formatRelativeTime(monitor.lastCheckedAt)}` : 'Not checked yet'}
          </span>
        </div>
      </div>

      {checkError && <InlineNotice tone="error">{checkError}</InlineNotice>}
      {actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}

      <div className="flex w-full items-center gap-2">
        {monitor.enabled ? (
          <Button size="sm" className="h-7 shrink-0 text-xs" onClick={handleCheckNow} disabled={isCheckingActive}>
            {isCheckingActive ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {isCheckingActive ? 'Checking…' : isError ? 'Retry check' : 'Check now'}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 shrink-0 text-xs"
            onClick={handleToggleEnabled}
            disabled={isTogglingEnabled}
          >
            {isTogglingEnabled ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Resume monitoring
          </Button>
        )}

        <div ref={alertRef} onPointerDown={(e) => e.stopPropagation()} className="relative flex-1 min-w-0">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(
              'h-7 w-full justify-between gap-1.5 px-2 text-xs font-normal text-foreground shadow-none',
              isAlertOpen && 'bg-muted',
            )}
            onClick={() => {
              setIsAlertOpen((prev) => !prev);
              setIsMenuOpen(false);
            }}
            aria-label="Alert condition"
            aria-haspopup="menu"
            aria-expanded={isAlertOpen}
            title={formatAlertConditionDescription(activeAlertCondition, monitor.lastSemanticValue)}
          >
            <span className="truncate tabular-nums text-left">
              {formatAlertConditionDescription(activeAlertCondition, monitor.lastSemanticValue)}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>

          {isAlertOpen && (
            <div
              role="menu"
              aria-label="Alert condition options"
              className="absolute top-full left-0 z-50 mt-1 w-full min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md animate-enter-up"
            >
              <div className="space-y-0.5">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={conditionType === 'any'}
                  onClick={() => handleConditionTypeChange('any')}
                  className={cn(
                    'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                    conditionType === 'any'
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <span>Any change</span>
                  {conditionType === 'any' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                </button>

                {(!hasSemantic || isNumeric) && (
                  <>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === 'decrease'}
                      onClick={() => handleConditionTypeChange('decrease')}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                        conditionType === 'decrease'
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span>{isCurrency ? 'Price drops' : 'Value decreases'}</span>
                      {conditionType === 'decrease' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === 'increase'}
                      onClick={() => handleConditionTypeChange('increase')}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                        conditionType === 'increase'
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span>{isCurrency ? 'Price rises' : 'Value increases'}</span>
                      {conditionType === 'increase' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === 'below'}
                      onClick={() => handleConditionTypeChange('below')}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                        conditionType === 'below'
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span>Drops below target</span>
                      {conditionType === 'below' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === 'above'}
                      onClick={() => handleConditionTypeChange('above')}
                      className={cn(
                        'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                        conditionType === 'above'
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span>Rises above target</span>
                      {conditionType === 'above' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                    </button>
                  </>
                )}

                {(!hasSemantic || !isNumeric) && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={conditionType === 'matches'}
                    onClick={() => handleConditionTypeChange('matches')}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                      conditionType === 'matches'
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <span>Text matches</span>
                    {conditionType === 'matches' && <Check className="h-3 w-3 shrink-0 text-foreground" />}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div ref={menuRef} onPointerDown={(e) => e.stopPropagation()} className="relative inline-flex shrink-0 items-center">
          <Button
            size="sm"
            variant="outline"
            className={cn('h-7 w-7 p-0', isMenuOpen && 'bg-muted')}
            onClick={() => {
              setIsMenuOpen((prev) => !prev);
              setIsAlertOpen(false);
            }}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
          >
            <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>

          {isMenuOpen && (
            <div
              role="menu"
              aria-orientation="vertical"
              aria-label="More actions"
              className="absolute top-full right-0 z-50 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md animate-enter-up"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  setIsMenuOpen(false);
                  void handleToggleEnabled();
                }}
                disabled={isTogglingEnabled}
              >
                {monitor.enabled ? (
                  <>
                    <Pause className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>Pause monitoring</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>Resume monitoring</span>
                  </>
                )}
              </button>

              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  setIsMenuOpen(false);
                  renameTriggerRef.current?.click();
                }}
              >
                <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>Rename</span>
              </button>

              <div className="my-1 border-t border-border/50" role="separator" />

              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  setIsMenuOpen(false);
                  deleteTriggerRef.current?.click();
                }}
                disabled={isDeleting}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0 text-destructive" />
                <span>Delete</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {(conditionType === 'below' || conditionType === 'above') && (
        <div className="relative w-full">
          {unitPrefix && (
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {unitPrefix}
            </span>
          )}
          <Input
            type="text"
            inputMode="decimal"
            className={cn('h-8 text-xs', prefixPaddingClass, unitSuffix && 'pr-6')}
            placeholder={targetPlaceholder}
            value={targetValueStr}
            onChange={handleTargetValueChange}
            onBlur={commitTargetValue}
            onKeyDown={handleTargetKeyDown}
            autoFocus
          />
          {unitSuffix && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {unitSuffix}
            </span>
          )}
        </div>
      )}

      {conditionType === 'matches' && (
        <div className="relative w-full">
          <Input
            type="text"
            className="h-8 text-xs"
            placeholder="e.g. In Stock"
            value={targetTextStr}
            onChange={handleTargetTextChange}
            onBlur={commitTargetText}
            onKeyDown={handleTargetKeyDown}
            autoFocus
          />
        </div>
      )}

      <RenameMonitorDialog
        currentName={monitor.name}
        defaultName={hostname}
        onSave={handleRename}
        trigger={
          <button
            ref={renameTriggerRef}
            type="button"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
        }
      />
      <DeleteMonitorDialog
        monitorName={monitor.name}
        onConfirm={handleDelete}
        trigger={
          <button
            ref={deleteTriggerRef}
            type="button"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            disabled={isDeleting}
          />
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Last checked"
          value={monitor.lastCheckedAt ? formatRelativeTime(monitor.lastCheckedAt) : 'Never'}
          title={monitor.lastCheckedAt ? formatDateTime(monitor.lastCheckedAt) : undefined}
        />
        <Stat
          label="Check every"
          value={formatIntervalMinutes(monitor.intervalMinutes)}
        >
          {!monitor.enabled && (
            <span className="text-[10px] text-muted-foreground">Paused</span>
          )}
        </Stat>
      </div>


      {isError && (
        <InlineNotice tone={isTemporarilyBlocked ? 'warning' : 'error'}>
          <div className="flex flex-col gap-1">
            <span className="font-medium">
              {failureInfo?.description ?? monitor.lastError}
            </span>
            {monitor.lastError && monitor.lastError !== failureInfo?.description && (
              <span className="text-[11.5px] text-muted-foreground">
                {monitor.lastError}
              </span>
            )}
            {isTemporarilyBlocked && (
              <span className="text-[11.5px] text-muted-foreground">
                No value has been changed or recorded from this page — Monitor will keep checking on its normal
                schedule and pick the real value back up automatically once the site stops showing it.
              </span>
            )}
            {hasValue && (
              <span className="text-[11.5px] text-muted-foreground">
                Last known value preserved: <span className="font-medium text-foreground">{monitor.lastValue}</span>
              </span>
            )}
          </div>
        </InlineNotice>
      )}

      <div>
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight">History</h2>
          <span className="text-[11px] text-muted-foreground">
            {history.length} check{history.length === 1 ? '' : 's'}
          </span>
        </div>
        <Separator className="mb-3.5" />

        {benchmarks && (
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-black/[0.05] bg-muted/50 p-2.5">
              <span className="text-[11px] text-muted-foreground">Low</span>
              <span
                title={benchmarks.lowDate ? `All-time low on ${formatDateTime(benchmarks.lowDate)}` : undefined}
                className="truncate text-[12.5px] font-medium tabular-nums text-foreground"
              >
                {benchmarks.formattedLow}
              </span>
            </div>

            <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-black/[0.05] bg-muted/50 p-2.5">
              <span className="text-[11px] text-muted-foreground">Average</span>
              <span className="truncate text-[12.5px] font-medium tabular-nums text-foreground">
                {benchmarks.formattedAverage}
              </span>
            </div>

            <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-black/[0.05] bg-muted/50 p-2.5">
              <span className="text-[11px] text-muted-foreground">High</span>
              <span className="truncate text-[12.5px] font-medium tabular-nums text-foreground">
                {benchmarks.formattedHigh}
              </span>
            </div>
          </div>
        )}

        <HistoryChart history={history} />
        {changes.length > 0 ? (
          <div className="mt-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] font-medium text-muted-foreground">Recent changes</span>
              {changes.length > 3 && (
                <Dialog>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
                    >
                      View all ({changes.length})
                    </button>
                  </DialogTrigger>
                  <DialogContent className="max-w-[340px] p-4">
                    <DialogHeader className="gap-0.5">
                      <div className="flex items-center justify-between">
                        <DialogTitle className="text-[13px] font-semibold">Change history</DialogTitle>
                        <DialogClose asChild>
                          <button
                            type="button"
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
                            aria-label="Close"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </DialogClose>
                      </div>
                      <DialogDescription className="text-[11px] text-muted-foreground">
                        {changes.length} recorded change{changes.length === 1 ? '' : 's'}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="mt-2.5 max-h-[300px] overflow-y-auto divide-y divide-border/30 pr-0.5">
                      {changes.map((item) => (
                        <ChangeRow key={item.id} {...item} />
                      ))}
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>

            <div className="divide-y divide-border/30">
              {changes.slice(0, 3).map((item) => (
                <ChangeRow key={item.id} {...item} />
              ))}
            </div>
          </div>
        ) : hasValue && history.length > 1 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/60 p-2.5 text-center text-[11px] text-muted-foreground">
            No changes recorded yet — value has remained {monitor.lastValue} across {history.length} checks.
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ChangeRowProps {
  checkedAt: number;
  change: ValueChangeSummary;
}

function ChangeRow({ checkedAt, change }: ChangeRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 py-2 px-0.5 text-[12px]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 font-medium tabular-nums text-foreground">
          {change.previousValue ? (
            <>
              <span className="truncate text-muted-foreground">{change.previousValue}</span>
              <span className="text-muted-foreground/50">→</span>
              <span className="truncate">{change.currentValue}</span>
            </>
          ) : (
            <span>{change.currentValue}</span>
          )}
        </div>
        <span className="text-[10.5px] text-muted-foreground" title={formatDateTime(checkedAt)}>
          {formatRelativeTime(checkedAt)}
        </span>
      </div>

      {change.isNumeric && change.formattedDelta && (
        <div className="flex shrink-0 items-center text-[11px] font-medium tabular-nums text-right">
          <span
            className={cn(
              change.direction === 'increase'
                ? 'text-emerald-600 dark:text-emerald-400'
                : change.direction === 'decrease'
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-muted-foreground',
            )}
          >
            {change.formattedDelta}
            {change.formattedPercentage && (
              <span className="ml-1 text-muted-foreground">
                ({change.formattedPercentage.replace(/^[+-]0\.0%$/, '0.0%')})
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

interface RenameMonitorDialogProps {
  currentName: string;
  defaultName: string;
  onSave: (newName: string) => Promise<void> | void;
  trigger: React.ReactElement;
}

function RenameMonitorDialog({
  currentName,
  defaultName,
  onSave,
  trigger,
}: RenameMonitorDialogProps) {
  const [name, setName] = useState(currentName);
  const saveBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setName(currentName);
  }, [currentName]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="max-w-[320px] p-4">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-[13px] font-semibold">Rename monitor</DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            Enter a display name. Leave empty to use {defaultName}.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-3 flex flex-col gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName}
            className="h-8 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveBtnRef.current?.click();
              }
            }}
            autoFocus
          />
          <DialogFooter className="mt-0 gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs">
                Cancel
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                ref={saveBtnRef}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  const trimmed = name.trim();
                  void onSave(trimmed || defaultName);
                }}
              >
                Save
              </Button>
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  title,
  truncate,
  children,
}: {
  label: string;
  value: string;
  title?: string;
  truncate?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-black/[0.05] bg-muted/50 p-2.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        title={title}
        className={cn(
          'text-[13px] font-medium tabular-nums',
          truncate && 'truncate',
        )}
      >
        {value}
      </span>
      {children}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-black/[0.05] bg-muted/50 p-3.5">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="mt-3 h-8 w-3/5" />
        <Skeleton className="mt-3 h-3 w-24" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
