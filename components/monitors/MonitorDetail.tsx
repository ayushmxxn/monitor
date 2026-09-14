import { InlineNotice } from "@/components/layout/InlineNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SpinningCounter } from "@/components/ui/SpinningCounter";
import { useCheckStage } from "@/hooks/useCheckStage";
import { useIsChecking } from "@/hooks/useIsChecking";
import { useMonitor } from "@/hooks/useMonitor";
import { useMonitorHistory } from "@/hooks/useMonitorHistory";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { sendMessage } from "@/lib/messaging";
import { formatAlertConditionDescription } from "@/lib/monitors/alertCondition";
import { calculateHistoricalBenchmarks } from "@/lib/monitors/benchmarks";
import {
  calculateValueChange,
  formatHeroMovement,
} from "@/lib/monitors/changeSummary";
import { checkMonitorNow } from "@/lib/monitors/client";
import {
  getFailureStateInfo,
  isTemporaryPageState,
} from "@/lib/monitors/diagnostics";
import { formatIntervalMinutes } from "@/lib/monitors/intervals";
import { CURRENCY_SYMBOLS } from "@/lib/monitors/semanticValue";
import { deleteMonitor, updateMonitor } from "@/lib/monitors/store";
import type { AlertCondition, AlertConditionType } from "@/lib/monitors/types";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeleteMonitorDialog } from "./DeleteMonitorDialog";
import {
  HistoryChart,
  MIN_POINTS_TO_CHART,
  RANGE_OPTIONS,
  getChartablePoints,
  pickDefaultRange,
  type RangeKey,
  type ScrubbedReading,
} from "./HistoryChart";
import { MonitorStatusBadge } from "./MonitorStatusBadge";

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
  const isCheckingInFlight = useIsChecking(monitorId, monitor?.lastCheckedAt ?? null);
  const isCheckingActive = isChecking || isCheckingInFlight;
  const isNewMonitorLoading = Boolean(
    monitor && monitor.lastValue === null && monitor.lastStatus !== "error",
  );
  const checkStageText = useCheckStage(isCheckingActive || isNewMonitorLoading);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAlertOpen, setIsAlertOpen] = useState(false);
  // The exact chart reading under the pointer while scrubbing, if any.
  // The value card shows this live and falls back to the latest
  // reading the moment the pointer leaves the chart.
  const [scrub, setScrub] = useState<ScrubbedReading | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  // Liquid highlight state for alert-condition dropdown
  const alertMenuRef = useRef<HTMLDivElement>(null);
  const [alertHighlight, setAlertHighlight] = useState<{
    top: number;
    height: number;
    opacity: number;
  } | null>(null);
  const handleAlertItemEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const container = alertMenuRef.current;
      if (!container) return;
      const cRect = container.getBoundingClientRect();
      const iRect = e.currentTarget.getBoundingClientRect();
      setAlertHighlight({
        top: iRect.top - cRect.top,
        height: iRect.height,
        opacity: 1,
      });
    },
    [],
  );

  // Liquid highlight state for more-actions menu
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const [actionsHighlight, setActionsHighlight] = useState<{
    top: number;
    height: number;
    opacity: number;
    isDestructive: boolean;
  } | null>(null);
  const handleActionsItemEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, isDestructive = false) => {
      const container = actionsMenuRef.current;
      if (!container) return;
      const cRect = container.getBoundingClientRect();
      const iRect = e.currentTarget.getBoundingClientRect();
      setActionsHighlight({
        top: iRect.top - cRect.top,
        height: iRect.height,
        opacity: 1,
        isDestructive,
      });
    },
    [],
  );

  useEffect(() => {
    if (!isMenuOpen && !isAlertOpen) return;

    const root = alertRef.current?.getRootNode() as
      | Document
      | ShadowRoot
      | null;

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
      if (e.key === "Escape") {
        setIsMenuOpen(false);
        setIsAlertOpen(false);
      }
    }

    if (root && root !== document) {
      root.addEventListener("pointerdown", handlePointerDown);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      if (root && root !== document) {
        root.removeEventListener("pointerdown", handlePointerDown);
      }
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen, isAlertOpen]);

  const heroMovement = useMemo(() => {
    if (!monitor || !monitor.lastValue) return null;
    if (!history || history.length === 0) return null;

    let prevVal: string | null = null;
    let prevSem = null;

    if (history.length >= 2 && history[1]?.value !== null) {
      prevVal = history[1].value;
      prevSem = history[1].semanticValue ?? null;
    } else if (
      history[0]?.previousValue !== undefined &&
      history[0].previousValue !== null
    ) {
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

  // Presentation-only split of a trailing decimal fraction (e.g.
  // "$58,834" + ".75") so the value card can render the fraction in
  // a muted tone like the reference. Pure string slicing of whatever
  // is currently shown (the live scrubbed reading, or the latest) -
  // the stored value, tooltip title, and all calculations are untouched.
  const shownValue =
    monitor?.lastValue != null ? scrub?.raw || monitor.lastValue : null;
  const valueParts = useMemo(() => {
    if (shownValue == null) return null;
    const match = shownValue.match(/^(.*)(\.\d+)$/);
    if (!match) return null;
    return { head: match[1], tail: match[2] };
  }, [shownValue]);

  const chartablePoints = useMemo(() => getChartablePoints(history), [history]);
  const hasChart = chartablePoints.length >= MIN_POINTS_TO_CHART;

  const [chartRange, setChartRange] = useState<RangeKey>(() =>
    chartablePoints.length >= 2 ? pickDefaultRange(chartablePoints) : "24h",
  );

  // A new monitor (or a new selection) never inherits a stale scrubbed
  // reading or range from the previously shown one.
  useEffect(() => {
    setScrub(null);
    if (chartablePoints.length >= 2) {
      setChartRange(pickDefaultRange(chartablePoints));
    }
  }, [monitorId]);

  const activeRangeOption = useMemo(
    () => RANGE_OPTIONS.find((o) => o.key === chartRange) ?? RANGE_OPTIONS[0],
    [chartRange],
  );

  const rangeMovement = useMemo(() => {
    if (!hasChart || !monitor || !monitor.lastValue) return null;
    const cutoff = Date.now() - activeRangeOption.ms;
    const filteredPoints = chartablePoints.filter(
      (entry) => entry.checkedAt >= cutoff,
    );
    if (filteredPoints.length < 2) return null;

    const baseline = filteredPoints[0];
    const targetPoint = scrub
      ? (filteredPoints.find((p) => p.checkedAt === scrub.checkedAt) ??
        filteredPoints[filteredPoints.length - 1])
      : filteredPoints[filteredPoints.length - 1];

    if (targetPoint.value == null) return null;

    const change = calculateValueChange(
      baseline.value,
      baseline.semanticValue,
      targetPoint.value,
      targetPoint.semanticValue,
    );

    if (!change.isNumeric || !change.formattedDelta) {
      return { text: change.summaryText, direction: "same" as const };
    }

    const sign =
      change.direction === "increase"
        ? "+"
        : change.direction === "decrease"
          ? "-"
          : "";
    const absDelta = change.formattedDelta.replace(/^[+-]/, "");
    const pct =
      change.percentageDelta != null
        ? `${Math.abs(change.percentageDelta).toFixed(1)}%`
        : null;
    const cleanPct = pct?.replace("0.0%", "0.0%");
    const text = cleanPct
      ? `${sign}${absDelta} · ${cleanPct}`
      : `${sign}${absDelta}`;

    return {
      text,
      direction: change.direction,
    };
  }, [hasChart, monitor?.lastValue, activeRangeOption, chartablePoints, scrub]);

  useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    async function refreshAccess() {
      try {
        const granted = await sendMessage("checkOriginPermissions", [
          monitor!.url,
        ]);
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
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
    };
  }, [monitor?.url]);

  const [conditionType, setConditionType] = useState<AlertConditionType>(
    monitor?.alertCondition?.type ?? "any",
  );
  const [targetValueStr, setTargetValueStr] = useState<string>(
    monitor?.alertCondition?.targetValue !== null &&
      monitor?.alertCondition?.targetValue !== undefined
      ? String(monitor.alertCondition.targetValue)
      : "",
  );
  const [targetTextStr, setTargetTextStr] = useState<string>(
    monitor?.alertCondition?.targetText ?? "",
  );

  useEffect(() => {
    if (monitor) {
      const type = monitor.alertCondition?.type ?? "any";
      const val =
        monitor.alertCondition?.targetValue !== null &&
        monitor.alertCondition?.targetValue !== undefined
          ? String(monitor.alertCondition.targetValue)
          : "";
      const txt = monitor.alertCondition?.targetText ?? "";
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
    if (conditionType === "below" || conditionType === "above") {
      const cleaned = targetValueStr.replace(/[^0-9.-]/g, "");
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
      targetText: conditionType === "matches" ? targetTextStr : null,
    };
  }, [
    conditionType,
    targetValueStr,
    targetTextStr,
    monitor?.alertCondition?.targetValue,
    monitor?.lastSemanticValue?.normalized,
  ]);

  async function saveCondition(
    type: AlertConditionType,
    valStr: string,
    txtStr: string,
  ): Promise<boolean> {
    if (!monitor) return false;
    let numericTarget: number | null = null;
    if (type === "below" || type === "above") {
      const cleaned = valStr.replace(/[^0-9.-]/g, "");
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
      targetText: type === "matches" ? txtStr : null,
    };
    const result = await updateMonitor(monitor.id, { alertCondition });
    if (!result.ok) {
      setActionError(result.error.toDisplayMessage());
      // Revert the optimistic condition UI to the last persisted values.
      const stored = monitor.alertCondition;
      setConditionType(stored?.type ?? "any");
      setTargetValueStr(
        stored?.targetValue != null ? String(stored.targetValue) : "",
      );
      setTargetTextStr(stored?.targetText ?? "");
      return false;
    }
    return true;
  }

  function handleConditionTypeChange(nextType: AlertConditionType) {
    setConditionType(nextType);
    let nextVal = targetValueStr;
    if (
      (nextType === "below" || nextType === "above") &&
      !targetValueStr &&
      monitor?.lastSemanticValue?.normalized != null
    ) {
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
    const cleaned = targetValueStr.replace(/[^0-9.-]/g, "");
    if (!cleaned || Number.isNaN(parseFloat(cleaned))) {
      const fallback =
        monitor?.alertCondition?.targetValue != null
          ? String(monitor.alertCondition.targetValue)
          : monitor?.lastSemanticValue?.normalized != null
            ? String(monitor.lastSemanticValue.normalized)
            : "";
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
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }

  if (isLoading) return <DetailSkeleton />;

  if (!monitor) {
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">
        This monitor no longer exists.
      </p>
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
      const result = await updateMonitor(monitor.id, {
        enabled: !monitor.enabled,
      });
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

  // Same suppression as the home card: while a check is in flight the
  // stored error is stale, so the detail reads Checking (value kept)
  // until the fresh result lands.
  const isError = monitor.lastStatus === "error" && !isCheckingInFlight;
  const isTemporarilyBlocked =
    isError && isTemporaryPageState(monitor.lastDiagnosticCode);
  const failureInfo = isError
    ? getFailureStateInfo(monitor.lastDiagnosticCode, monitor.lastError)
    : null;
  const hasValue = monitor.lastValue !== null;
  const hasSemantic = monitor.lastSemanticValue !== null;
  const isNumeric = hasSemantic
    ? monitor.lastSemanticValue!.type !== "text" &&
      monitor.lastSemanticValue!.normalized !== null &&
      monitor.lastSemanticValue!.normalized !== undefined
    : false;
  const isCurrency = monitor.lastSemanticValue?.type === "currency";
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
    ? ""
    : unitPrefix.length === 1
      ? "pl-6"
      : unitPrefix.length === 2
        ? "pl-8"
        : "pl-11";
  const unitSuffix =
    monitor.lastSemanticValue?.type === "percentage" ? "%" : null;
  const targetPlaceholder =
    monitor.lastSemanticValue?.normalized != null
      ? String(monitor.lastSemanticValue.normalized)
      : "Target";
  const baseValue = monitor?.lastValue ?? shownValue;
  // Sizes the hero for the value itself: the hero only ever shows the
  // reading (or its loading/empty placeholder), never status text, so
  // the single error status lives in the header badge alone.
  const valueLength = baseValue ? baseValue.length : 1;
  const valueFontSizeClass =
    valueLength > 13
      ? "text-[18px]"
      : valueLength > 10
        ? "text-[20px]"
        : valueLength > 7
          ? "text-[23px]"
          : valueLength > 5
            ? "text-[27px]"
            : "text-[32px]";

  return (
    <div className="animate-enter-up flex flex-col gap-3">
      {hasPermission === false && (
        <InlineNotice
          tone="warning"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendMessage("openOptionsPage", undefined)}
            >
              Grant access
            </Button>
          }
        >
          Access to <span className="text-foreground">{hostname}</span> was
          revoked. Checks are paused until it's granted again.
        </InlineNotice>
      )}

      {/* Value card - the current reading, its movement, and the trend,
          presented as one unit: large value, change underneath, the
          history line integrated below rather than as a separate
          analytics block. */}
      {/* 1. Primary: current value + status + change + chart + 24H / 7D / 30D */}
      <div className="rounded-lg bg-muted/40 dark:bg-card p-3.5">
        <div className="flex h-9 items-center justify-between gap-2.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <div
              data-testid="monitor-value"
              title={shownValue ?? undefined}
              className={cn(
                "inline-flex h-9 items-center whitespace-nowrap font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums text-foreground",
                valueFontSizeClass,
                !shownValue && "text-muted-foreground/50",
              )}
            >
              {shownValue ? (
                <SpinningCounter
                  key={monitor.id}
                  value={shownValue}
                  head={valueParts?.head}
                  tail={valueParts?.tail}
                  disabled={Boolean(scrub)}
                  lastCheckedAt={monitor.lastCheckedAt}
                />
              ) : isNewMonitorLoading ? (
                <div
                  className="flex items-center gap-2 h-8"
                  aria-label="Loading initial value"
                >
                  <div className="h-7 w-24 rounded bg-muted-foreground/20 animate-pulse" />
                  <Loader2 className="h-4 w-4 animate-spin shrink-0 text-muted-foreground/60" />
                </div>
              ) : (
                "—"
              )}
            </div>
          </div>

          <div className="shrink-0">
            {!monitor.enabled ? (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Pause className="h-2.5 w-2.5" />
                Paused
              </Badge>
            ) : (
              <MonitorStatusBadge
                status={
                  isCheckingActive || isNewMonitorLoading
                    ? "checking"
                    : monitor.lastStatus
                }
                diagnosticCode={monitor.lastDiagnosticCode}
                lastError={monitor.lastError}
                stageText={checkStageText}
              />
            )}
          </div>
        </div>

        {/* While checking, status lives in exactly two places by design:
            the header badge above ("Checking…") and the primary Check now
            button below (spinner, disabled against duplicate checks).
            No extra spinners or stage lines here — one status, one
            action, never the same state twice. */}
        {isNewMonitorLoading ? null : hasChart ? (
          <p className="mt-1 truncate text-[12px] font-medium tabular-nums">
            {rangeMovement ? (
              <span
                data-testid="monitor-movement"
                className={cn(
                  rangeMovement.direction === "increase"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : rangeMovement.direction === "decrease"
                      ? "text-red-700 dark:text-red-400"
                      : "text-muted-foreground",
                )}
              >
                {rangeMovement.text}
              </span>
            ) : (
              <span
                data-testid="monitor-movement"
                className="text-muted-foreground"
              >
                No change
              </span>
            )}
            {scrub ? (
              <span
                data-testid="monitor-reading-time"
                title={formatDateTime(scrub.checkedAt)}
                className="text-muted-foreground font-normal"
              >
                {" · "}
                {formatDateTime(scrub.checkedAt)}
              </span>
            ) : (
              <span
                data-testid="monitor-reading-time"
                className="text-muted-foreground font-normal"
              >
                {" "}
                {activeRangeOption.description}
              </span>
            )}
          </p>
        ) : (
          heroMovement &&
          (() => {
            const suffix = " since last check";
            const hasSuffix = heroMovement.text.endsWith(suffix);
            const rawMovement = hasSuffix
              ? heroMovement.text.slice(0, -suffix.length)
              : heroMovement.text;
            const cleanMovement = rawMovement.replace(/([+-])0\.0%/g, "0.0%");

            return (
              <p className="mt-1 truncate text-[12px] font-medium tabular-nums">
                <span
                  className={cn(
                    heroMovement.direction === "increase"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-700 dark:text-red-400",
                  )}
                >
                  {cleanMovement}
                </span>
                {hasSuffix && (
                  <span className="text-muted-foreground font-normal">
                    {suffix}
                  </span>
                )}
                {scrub ? (
                  <span
                    data-testid="monitor-reading-time"
                    title={formatDateTime(scrub.checkedAt)}
                    className="text-muted-foreground font-normal"
                  >
                    {" · "}
                    {formatDateTime(scrub.checkedAt)}
                  </span>
                ) : (
                  monitor.lastCheckedAt && (
                    <span
                      data-testid="monitor-reading-time"
                      className="text-muted-foreground/70 font-normal"
                    >
                      {" · "}
                      {formatRelativeTime(monitor.lastCheckedAt)}
                    </span>
                  )
                )}
              </p>
            );
          })()
        )}

        {/* No movement line (flat series, text value) yet scrubbing a
            charted series still needs its live timestamp beside the
            value - the change line above covers every other case. */}
        {!hasChart && !heroMovement && scrub && (
          <p
            data-testid="monitor-reading-time"
            title={formatDateTime(scrub.checkedAt)}
            className="mt-1 truncate text-[12px] tabular-nums text-muted-foreground"
          >
            {formatDateTime(scrub.checkedAt)}
          </p>
        )}

        <div className="mt-4">
          <HistoryChart
            history={history}
            onScrub={setScrub}
            range={chartRange}
            onRangeChange={setChartRange}
          />
        </div>
      </div>

      {checkError && <InlineNotice tone="error">{checkError}</InlineNotice>}
      {actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}

      <div className="flex w-full items-center gap-2 px-3.5">
        {monitor.enabled ? (
          <Button
            size="sm"
            className="h-8 shrink-0 px-3 text-xs font-medium shadow-xs"
            onClick={handleCheckNow}
            disabled={isCheckingActive}
          >
            {isCheckingActive ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {checkStageText ?? "Checking…"}
              </span>
            ) : isError ? (
              "Retry check"
            ) : (
              "Check now"
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 shrink-0 px-3 text-xs font-medium shadow-xs"
            onClick={handleToggleEnabled}
            disabled={isTogglingEnabled}
          >
            {isTogglingEnabled ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Resume
          </Button>
        )}

        <div
          ref={alertRef}
          onPointerDown={(e) => e.stopPropagation()}
          className="relative flex-1 min-w-0"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              "h-8 w-full justify-between gap-1.5 border-0 bg-[#F1F1F2] px-2.5 text-xs font-normal text-muted-foreground shadow-none hover:bg-[#e8e8e9] hover:text-foreground dark:bg-secondary dark:hover:bg-accent dark:hover:text-foreground",
              isAlertOpen &&
                "bg-[#e8e8e9] text-foreground dark:bg-secondary dark:text-foreground",
            )}
            onClick={() => {
              setIsAlertOpen((prev) => !prev);
              setIsMenuOpen(false);
            }}
            aria-label="Alert condition"
            aria-haspopup="menu"
            aria-expanded={isAlertOpen}
            title={formatAlertConditionDescription(
              activeAlertCondition,
              monitor.lastSemanticValue,
            )}
          >
            <span className="truncate tabular-nums text-left">
              {formatAlertConditionDescription(
                activeAlertCondition,
                monitor.lastSemanticValue,
              )}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>

          {isAlertOpen && (
            <div
              role="menu"
              aria-label="Alert condition options"
              ref={alertMenuRef}
              onMouseLeave={() =>
                setAlertHighlight((h) => (h ? { ...h, opacity: 0 } : null))
              }
              className="absolute bottom-full left-0 z-50 mb-1 w-full min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md animate-enter-down"
            >
              {alertHighlight && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 4,
                    right: 4,
                    top: alertHighlight.top,
                    height: alertHighlight.height,
                    opacity: alertHighlight.opacity,
                    borderRadius: 6,
                    background: "hsl(var(--accent))",
                    transition:
                      "top 130ms cubic-bezier(0.4,0,0.2,1), height 130ms cubic-bezier(0.4,0,0.2,1), opacity 80ms ease",
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                />
              )}
              <div className="relative z-10 space-y-0.5">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={conditionType === "any"}
                  onClick={() => handleConditionTypeChange("any")}
                  onMouseEnter={handleAlertItemEnter}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                    conditionType === "any"
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-foreground",
                  )}
                >
                  <span>Any change</span>
                  {conditionType === "any" && (
                    <Check className="h-3 w-3 shrink-0 text-foreground" />
                  )}
                </button>

                {(!hasSemantic || isNumeric) && (
                  <>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === "decrease"}
                      onClick={() => handleConditionTypeChange("decrease")}
                      onMouseEnter={handleAlertItemEnter}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                        conditionType === "decrease"
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span>
                        {isCurrency ? "Price drops" : "Value decreases"}
                      </span>
                      {conditionType === "decrease" && (
                        <Check className="h-3 w-3 shrink-0 text-foreground" />
                      )}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === "increase"}
                      onClick={() => handleConditionTypeChange("increase")}
                      onMouseEnter={handleAlertItemEnter}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                        conditionType === "increase"
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span>
                        {isCurrency ? "Price rises" : "Value increases"}
                      </span>
                      {conditionType === "increase" && (
                        <Check className="h-3 w-3 shrink-0 text-foreground" />
                      )}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === "below"}
                      onClick={() => handleConditionTypeChange("below")}
                      onMouseEnter={handleAlertItemEnter}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                        conditionType === "below"
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span>Drops below target</span>
                      {conditionType === "below" && (
                        <Check className="h-3 w-3 shrink-0 text-foreground" />
                      )}
                    </button>

                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={conditionType === "above"}
                      onClick={() => handleConditionTypeChange("above")}
                      onMouseEnter={handleAlertItemEnter}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                        conditionType === "above"
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <span>Rises above target</span>
                      {conditionType === "above" && (
                        <Check className="h-3 w-3 shrink-0 text-foreground" />
                      )}
                    </button>
                  </>
                )}

                {(!hasSemantic || !isNumeric) && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={conditionType === "matches"}
                    onClick={() => handleConditionTypeChange("matches")}
                    onMouseEnter={handleAlertItemEnter}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs",
                      conditionType === "matches"
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-foreground",
                    )}
                  >
                    <span>Text matches</span>
                    {conditionType === "matches" && (
                      <Check className="h-3 w-3 shrink-0 text-foreground" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          ref={menuRef}
          onPointerDown={(e) => e.stopPropagation()}
          className="relative inline-flex shrink-0 items-center"
        >
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "h-8 w-8 border-0 bg-[#F1F1F2] p-0 text-muted-foreground shadow-none hover:bg-[#e8e8e9] hover:text-foreground dark:bg-secondary dark:hover:bg-accent dark:hover:text-foreground",
              isMenuOpen &&
                "bg-[#e8e8e9] text-foreground dark:bg-secondary dark:text-foreground",
            )}
            onClick={() => {
              setIsMenuOpen((prev) => !prev);
              setIsAlertOpen(false);
            }}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>

          {isMenuOpen && (
            <div
              role="menu"
              aria-orientation="vertical"
              aria-label="More actions"
              ref={actionsMenuRef}
              onMouseLeave={() =>
                setActionsHighlight((h) => (h ? { ...h, opacity: 0 } : null))
              }
              className="absolute bottom-full right-0 z-50 mb-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md animate-enter-down"
            >
              {actionsHighlight && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 4,
                    right: 4,
                    top: actionsHighlight.top,
                    height: actionsHighlight.height,
                    opacity: actionsHighlight.opacity,
                    borderRadius: 6,
                    background: actionsHighlight.isDestructive
                      ? "hsl(var(--destructive) / 0.10)"
                      : "hsl(var(--accent))",
                    transition:
                      "top 130ms cubic-bezier(0.4,0,0.2,1), height 130ms cubic-bezier(0.4,0,0.2,1), opacity 80ms ease, background 100ms ease",
                    pointerEvents: "none",
                    zIndex: 0,
                  }}
                />
              )}
              <div className="relative z-10">
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => {
                    setIsMenuOpen(false);
                    void handleToggleEnabled();
                  }}
                  onMouseEnter={(e) => handleActionsItemEnter(e, false)}
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
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground"
                  onClick={() => {
                    setIsMenuOpen(false);
                    renameTriggerRef.current?.click();
                  }}
                  onMouseEnter={(e) => handleActionsItemEnter(e, false)}
                >
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>Rename</span>
                </button>

                <div
                  className="my-1 border-t border-border/50"
                  role="separator"
                />

                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-destructive disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => {
                    setIsMenuOpen(false);
                    deleteTriggerRef.current?.click();
                  }}
                  onMouseEnter={(e) => handleActionsItemEnter(e, true)}
                  disabled={isDeleting}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  <span>Delete</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {(conditionType === "below" || conditionType === "above") && (
        <div className="w-full px-6">
          <div className="relative w-full">
            {unitPrefix && (
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {unitPrefix}
              </span>
            )}
            <Input
              type="text"
              inputMode="decimal"
              className={cn(
                "h-8 text-xs",
                prefixPaddingClass,
                unitSuffix && "pr-6",
              )}
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
        </div>
      )}

      {conditionType === "matches" && (
        <div className="w-full px-3.5">
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

      {/* 3. Monitor settings: Last checked + Checks every */}
      <div className="rounded-lg bg-muted/30 dark:bg-card px-3.5 py-2.5">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Last checked
            </span>
            <span
              title={
                monitor.lastCheckedAt
                  ? formatDateTime(monitor.lastCheckedAt)
                  : undefined
              }
              className="truncate text-[12.5px] font-medium tabular-nums text-foreground"
            >
              {monitor.lastCheckedAt
                ? formatRelativeTime(monitor.lastCheckedAt)
                : "Never"}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Checks every
            </span>
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium tabular-nums text-foreground">
                {formatIntervalMinutes(monitor.intervalMinutes)}
              </span>
              {!monitor.enabled && (
                <span className="text-[10px] text-muted-foreground font-normal">
                  Paused
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Compact error explanation: one muted block, not a card. The
          error label already lives once in the header badge above, so
          this carries only the human description, the temporary-block
          note when relevant, and the preserved-value note when there is
          one — never the stored technical trace, which stays in
          storage/history for debugging. */}
      {isError && failureInfo && (
        <div role="status" className="px-3.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {failureInfo.description}
          </p>
          {isTemporarilyBlocked && (
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground/80">
              No value has been changed or recorded from this page — Monitor
              will keep checking on its normal schedule and pick the real
              value back up automatically once the site stops showing it.
            </p>
          )}
          {hasValue && (
            <p className="mt-1 text-[11.5px] text-muted-foreground/80">
              Last known value preserved:{" "}
              <span className="font-medium text-foreground">
                {monitor.lastValue}
              </span>
            </p>
          )}
        </div>
      )}

      {/* 4. Statistics: All-time low + Average + All-time high */}
      {benchmarks && (
        <div className="rounded-lg bg-muted/30 dark:bg-card px-3.5 py-2.5">
          <div className="grid grid-cols-3 gap-2">
            <div className="flex min-w-0 flex-col items-start gap-0.5 text-left">
              <span className="text-[11px] font-medium text-muted-foreground">
                All-time low
              </span>
              <span
                title={
                  benchmarks.lowDate
                    ? `All-time low on ${formatDateTime(benchmarks.lowDate)}`
                    : undefined
                }
                className="truncate text-[12.5px] font-medium tabular-nums text-foreground"
              >
                {benchmarks.formattedLow}
              </span>
            </div>

            <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
              <span className="text-[11px] font-medium text-muted-foreground">
                Average
              </span>
              <span className="truncate text-[12.5px] font-medium tabular-nums text-foreground">
                {benchmarks.formattedAverage}
              </span>
            </div>

            <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
              <span className="text-[11px] font-medium text-muted-foreground">
                All-time high
              </span>
              <span className="truncate text-[12.5px] font-medium tabular-nums text-foreground">
                {benchmarks.formattedHigh}
              </span>
            </div>
          </div>
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-[320px] p-4">
        <DialogHeader className="gap-1">
          <DialogTitle className="text-[13px] font-semibold">
            Rename monitor
          </DialogTitle>
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
              if (e.key === "Enter") {
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

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-muted/40 dark:bg-card p-3.5">
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
