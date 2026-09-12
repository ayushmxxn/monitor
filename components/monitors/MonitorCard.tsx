import { Favicon } from "@/components/layout/Favicon";
import { formatAdaptiveValue, formatRelativeTime } from "@/lib/format";
import { checkMonitorNow } from "@/lib/monitors/client";
import { SpinningCounter } from "@/components/ui/SpinningCounter";
import { ValueScanner } from "@/components/ui/ValueScanner";
import { useIsChecking } from "@/hooks/useIsChecking";
import { useCheckStage } from "@/hooks/useCheckStage";
import { getFailureStateInfo } from "@/lib/monitors/diagnostics";
import type { Monitor } from "@/lib/monitors/types";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  FileQuestion,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
  WifiOff,
} from "lucide-react";
import { memo, useCallback, useState } from "react";
import { DeleteMonitorDialog } from "./DeleteMonitorDialog";

interface MonitorCardProps {
  monitor: Monitor;
  onDelete: (id: string) => Promise<boolean>;
  onOpen: (id: string) => void;
}

const REMOVE_TRANSITION_MS = 180;

/**
 * A single bento tile on the panel's home screen: the value front
 * and center, the site's favicon + monitor name + last-updated time
 * below it, nothing else - no URL, no controls - so the grid reads as
 * data at a glance. Delete is still reachable, tucked behind a hover
 * reveal in the corner rather than competing with the value for
 * attention; everything else (interval, strategy, diagnostics) lives
 * one click away in the detail view opened by clicking the tile -
 * shown inline in the panel itself, never a new tab.
 */
export const MonitorCard = memo(function MonitorCard({ monitor, onDelete, onOpen }: MonitorCardProps) {
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const isError = monitor.lastStatus === "error";
  const failureInfo = isError
    ? getFailureStateInfo(monitor.lastDiagnosticCode, monitor.lastError)
    : null;
  const isCheckingInFlight = useIsChecking(monitor.id);
  const isChecking = isCheckingInFlight || monitor.lastStatus === "checking";
  const isCheckingActive = isChecking || isRetrying;
  const hasValue = monitor.lastValue !== null;
  const isNewMonitorLoading = !hasValue && !isError;
  const checkStageText = useCheckStage(isCheckingActive || isNewMonitorLoading);


  const handleConfirmDelete = useCallback(() => {
    // Fade/scale out first, then remove from the underlying list once
    // the transition finishes - a plain CSS transition + timeout
    // stands in for what framer-motion's exit animation used to do,
    // at a fraction of the size. A failed delete resets the fade so
    // the still-present card comes back instead of leaving a gap.
    setIsRemoving(true);
    window.setTimeout(() => {
      void (async () => {
        const ok = await onDelete(monitor.id);
        if (!ok) setIsRemoving(false);
      })();
    }, REMOVE_TRANSITION_MS);
  }, [onDelete, monitor.id]);

  const handleCardClick = useCallback(() => {
    onOpen(monitor.id);
  }, [onOpen, monitor.id]);

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    setIsRetrying(true);
    setRetryError(null);
    try {
      const result = await checkMonitorNow(monitor.id);
      if (!result.ok) {
        setRetryError(result.error.toDisplayMessage());
      }
    } finally {
      setIsRetrying(false);
    }
  }

  const failureIcon =
    failureInfo?.reason === "blocked" ? (
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
    ) : failureInfo?.reason === "page_load_failed" ? (
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
    ) : failureInfo?.reason === "page_changed" ? (
      <FileQuestion className="h-3.5 w-3.5 shrink-0" />
    ) : (
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
    );

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg bg-muted/50 transition-all duration-150 ease-out hover:bg-accent active:scale-[0.985] origin-center",
        isRemoving &&
          "pointer-events-none scale-[0.92] opacity-0 blur-[1.5px] duration-200 ease-out motion-reduce:scale-100 motion-reduce:blur-0 motion-reduce:transition-none",
      )}
    >
      <button
        onClick={handleCardClick}
        className="flex w-full flex-col items-start gap-2 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className={cn("w-full min-w-0", !isNewMonitorLoading && "pr-4")}>
          {hasValue ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <p
                title={monitor.lastValue ?? undefined}
                className={cn(
                  "truncate text-[20px] font-semibold leading-[1.15] tracking-[-0.01em] tabular-nums",
                  isError ? "text-muted-foreground" : "text-foreground",
                  isCheckingActive && "opacity-80",
                )}
              >
                <SpinningCounter
                  key={monitor.id}
                  value={formatAdaptiveValue(
                    monitor.lastValue,
                    monitor.lastSemanticValue,
                  )}
                  lastCheckedAt={monitor.lastCheckedAt}
                />
              </p>
              {isCheckingActive && !isError && (
                <ValueScanner className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              )}
              {isError && (
                <span
                  title={failureInfo?.description ?? "Check failed"}
                  className="inline-flex shrink-0 items-center text-destructive"
                >
                  {failureIcon}
                </span>
              )}
            </div>
          ) : isError ? (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {failureIcon}
              <span
                title={failureInfo?.description}
                className="truncate text-[13px] font-medium"
              >
                {failureInfo?.label}
              </span>
            </div>
          ) : isNewMonitorLoading ? (
            <div
              className="flex h-[23px] w-full items-center justify-center"
              aria-label="Loading initial value"
            >
              <ValueScanner className="h-4 w-4 shrink-0 text-muted-foreground/70" />
            </div>
          ) : (
            <p className="truncate text-[20px] font-semibold leading-[1.15] tracking-[-0.01em] tabular-nums text-muted-foreground/50">
              —
            </p>
          )}
        </div>

        <div className="flex w-full min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Favicon url={monitor.url} size={12} />
            {/* `min-w-0` here too, not just on this row's own container:
                as a flex child, this span's default automatic min-width
                is its content's min-content size - which for nowrap+truncate
                text is the full, un-ellipsized title width. Without
                overriding it, a long monitor name pushes this row (and
                the card around it) wider than its column, the same
                overflow the grid-item comment above describes for the
                value text. */}
            <span
              title={monitor.name}
              className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-muted-foreground"
            >
              {monitor.name}
            </span>
          </div>
          <span
            className={cn(
              "text-[10px]",
              isError ? "text-destructive" : "text-muted-foreground/60",
            )}
          >
            {isCheckingActive || isNewMonitorLoading ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0 text-muted-foreground/70" />
                {checkStageText ?? "Checking…"}
              </span>
            ) : isError ? (
              `${failureInfo?.label ?? "Check failed"}${hasValue ? " (stale)" : ""}`
            ) : monitor.lastCheckedAt ? (
              `Updated ${formatRelativeTime(monitor.lastCheckedAt)}`
            ) : (
              "Not checked yet"
            )}
          </span>
          {retryError && (
            <span role="alert" className="truncate text-[10px] text-destructive">
              {retryError}
            </span>
          )}
        </div>
      </button>

      {/* "Something changed" indicator - replaced by the delete button
          on hover so the corner never shows both at once. */}
      {monitor.lastStatus === "changed" && (
        <span
          aria-hidden
          className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-foreground ring-2 ring-muted/50 transition-opacity group-hover:opacity-0"
        />
      )}

      <div
        className={cn(
          "absolute right-1 top-1 flex items-center gap-0.5 transition-opacity duration-150",
          isError
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        {isError && failureInfo?.canRetry && monitor.enabled && (
          <button
            type="button"
            aria-label={`Check ${monitor.name} now`}
            title="Check now"
            onClick={handleRetry}
            disabled={isChecking || isRetrying}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw
              className={cn(
                "h-3 w-3",
                (isChecking || isRetrying) && "animate-spin",
              )}
            />
          </button>
        )}
        <DeleteMonitorDialog
          monitorName={monitor.name}
          onConfirm={handleConfirmDelete}
          trigger={
            <button
              type="button"
              aria-label={`Delete ${monitor.name}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          }
        />
      </div>
    </div>
  );
});
