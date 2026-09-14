import { updateMonitor, appendHistory, getMonitor } from './store';
import { STRATEGIES, baseStrategyOrder, isValidOutcome } from './strategies';
import type { StrategyOutcome } from './strategies';
import { notifyChange } from './notify';
import { hasOriginPermission } from '@/lib/permissions';
import {
  diagnostic,
  formatDiagnostic,
  FORCE_REPROBE_CODES,
  selectPrimaryDiagnostic,
  isPermanentFailure,
  shouldMarkNeedsRepick,
} from './diagnostics';
import { dedupeInFlight } from './concurrency';
import {
  RECOVERY_ACCEPT_THRESHOLD,
  REPROBE_AFTER_LOW_CONFIDENCE_STREAK,
  PERIODIC_REPROBE_INTERVAL_CHECKS,
} from './types';
import type { HistoricalStats, Monitor, MonitorCheckStrategy } from './types';
import { normalizeText } from './fingerprint';
import type { SemanticValue } from './semanticValue';
import { shouldTriggerAlert } from './alertCondition';
import { playSparkleCue, playErrorCue } from './sound';

/**
 * One in-flight run per monitor id. `checkMonitor` has three call sites
 * that can legitimately overlap in time — a scheduler tick
 * (`runDueMonitors`), "refresh all" (`checkAllMonitorsNow`), and a
 * manual "check now" — and none of them currently knows whether another
 * one is already checking the very same monitor. That matters most for
 * the scheduler: `runDueMonitors` only marks a monitor as no-longer-due
 * once its check *finishes* (`lastCheckedAt` is set at the very end, in
 * `recordSuccess`/`recordFailure`), so a monitor whose live-tab check is
 * still running when the next 1-minute alarm tick fires is still "due"
 * and gets picked up a second time. Two concurrent checks of the same
 * monitor don't just waste a background tab/window — they also race
 * each other's `updateMonitor` calls (whichever finishes last wins,
 * silently discarding the other's fingerprint update or history entry)
 * and can double-fire a change notification. Keyed by monitor id (not a
 * single global lock) so unrelated monitors are never held up by one
 * that's mid-check; the map entry is removed the instant a run finishes,
 * success or failure, so this stays memory-safe across a long-running
 * background worker rather than growing unbounded.
 */
const inFlightChecks = new Map<string, Promise<void>>();

/**
 * Runs one check for `monitor`, joining an already-running check for the
 * same monitor id instead of starting a duplicate one — see
 * `inFlightChecks` and `dedupeInFlight`.
 */
export function checkMonitor(monitor: Monitor): Promise<void> {
  return dedupeInFlight(inFlightChecks, monitor.id, () => runCheck(monitor));
}

/**
 * Checks a monitor by ID, joining any already-running check for the same monitor ID
 * rather than issuing redundant storage reads or duplicate requests.
 */
export function checkMonitorById(monitorId: string): Promise<void> {
  return dedupeInFlight(inFlightChecks, monitorId, async () => {
    const result = await getMonitor(monitorId);
    if (!result.ok) {
      throw new Error(result.error.toDisplayMessage());
    }
    return runCheck(result.value);
  });
}

/**
 * Strategy selection: try the monitor's persisted strategy first (the
 * one that worked last time, so a known-good site never pays for a
 * redundant fetch attempt before falling back to a live tab). If that
 * fails, cascade through the remaining strategies (see
 * `baseStrategyOrder`) within this same check - the user sees a fallback happen
 * automatically rather than waiting a full interval for a retry.
 * Whichever strategy produces a valid result gets persisted as the new
 * default for next time.
 *
 * Continuous re-evaluation: a persisted strategy isn't trusted forever.
 * It's dropped back to `null` (forcing a fresh cascade) whenever a
 * diagnostic implies the page's rendering characteristics may have
 * changed (see `FORCE_REPROBE_CODES`), after a run of low-confidence
 * relocations, or periodically on a schedule even when nothing looks
 * wrong — the same discipline a careful human maintainer would apply
 * rather than assuming yesterday's answer still holds.
 */
/** Exported for focused permission-branch tests (same as `recordSuccess` below). */
export async function runCheck(monitor: Monitor): Promise<void> {
  if (!monitor.enabled) {
    return;
  }

  const permission = await hasOriginPermission(monitor.url);
  if (permission.ok && !permission.value) {
    await recordFailure(monitor, [diagnostic('PERMISSION_DENIED')], null);
    return;
  }
  if (!permission.ok) {
    // A failed permission *check* is not a denial: the API errored, so
    // nothing is known about access. Recording UNKNOWN keeps the
    // failure temporary and retryable (with a working Retry button)
    // instead of misdirecting the user to re-grant access.
    await recordFailure(monitor, [diagnostic('UNKNOWN', permission.error.message)], null);
    return;
  }

  const forceReprobe = shouldForceReprobe(monitor);
  const order = orderedStrategies(forceReprobe ? null : monitor.checkStrategy, monitor);
  const diagnostics: ReturnType<typeof diagnostic>[] = [];

  for (const strategyId of order) {
    const outcome = await runStrategy(strategyId, monitor);
    if (isValidOutcome(outcome)) {
      await recordSuccess(monitor, strategyId, outcome);
      return;
    }
    diagnostics.push({
      ...outcome.diagnostic,
      detail: outcome.diagnostic.detail
        ? `${strategyId}: ${outcome.diagnostic.detail}`
        : `${strategyId} strategy`,
    });
  }

  await recordFailure(monitor, diagnostics, order[0] ?? null);
}

async function runStrategy(strategyId: MonitorCheckStrategy, monitor: Monitor): Promise<StrategyOutcome> {
  try {
    return await STRATEGIES[strategyId].run(monitor);
  } catch (error) {
    return {
      value: null,
      diagnostic: diagnostic('UNKNOWN', error instanceof Error ? error.message : 'strategy threw'),
      updatedFingerprint: null,
      confidence: 0,
      method: 'none',
      semanticValue: null,
    };
  }
}

/**
 * Full cascade order for this check: the persisted strategy first (if
 * any and not being reprobed - the one known to work, so a healthy
 * monitor never pays for a redundant probe), then the rest in
 * `baseStrategyOrder`'s order - which itself prefers `live` over
 * `fetch` for a genuine feed-item permalink (see `baseStrategyOrder`).
 */
function orderedStrategies(persisted: MonitorCheckStrategy | null, monitor: Monitor): MonitorCheckStrategy[] {
  const base = baseStrategyOrder(monitor.fingerprint);
  if (!persisted) return base;
  return [persisted, ...base.filter((id) => id !== persisted)];
}

/** Decides whether the persisted strategy should be distrusted and re-cascaded this check. */
function shouldForceReprobe(monitor: Monitor): boolean {
  if (!monitor.checkStrategy) return false;
  if (monitor.lastDiagnosticCode && FORCE_REPROBE_CODES.has(monitor.lastDiagnosticCode)) return true;
  if (monitor.consecutiveRelocations >= REPROBE_AFTER_LOW_CONFIDENCE_STREAK) return true;
  if (
    monitor.totalSuccessfulChecks > 0 &&
    monitor.totalSuccessfulChecks % PERIODIC_REPROBE_INTERVAL_CHECKS === 0
  ) {
    return true;
  }
  return false;
}

export function hasValueChanged(
  prevValue: string | null,
  prevSemantic: SemanticValue | null,
  nextValue: string,
  nextSemantic: SemanticValue | null,
): boolean {
  if (prevValue === null) return false;
  if (
    prevSemantic?.normalized !== null &&
    prevSemantic?.normalized !== undefined &&
    nextSemantic?.normalized !== null &&
    nextSemantic?.normalized !== undefined &&
    prevSemantic.type === nextSemantic.type &&
    prevSemantic.unit === nextSemantic.unit
  ) {
    return prevSemantic.normalized !== nextSemantic.normalized;
  }
  return normalizeText(prevValue) !== normalizeText(nextValue);
}

/** Exported for focused commit-guard tests (same as `hasValueChanged` below). */
export async function recordSuccess(
  monitor: Monitor,
  strategyId: MonitorCheckStrategy,
  outcome: StrategyOutcome,
): Promise<void> {
  const value = outcome.value!;
  const now = Date.now();
  const wasRelocated = outcome.updatedFingerprint !== null;

  // Commit against the CURRENT stored monitor, not the snapshot from
  // when this (potentially 20-30s) check started: the user may have
  // renamed, disabled, or deleted the monitor meanwhile. A missing or
  // disabled monitor drops the result entirely - no state, no history,
  // no alert. A failed re-read is equally a no-commit: without
  // verified-current state there is nothing safe to merge into.
  const currentResult = await getMonitor(monitor.id);
  if (!currentResult.ok || !currentResult.value.enabled) {
    return;
  }
  const current = currentResult.value;

  // Zero-cliff guard: a numeric reading of exactly zero against an
  // established non-zero numeric series is overwhelmingly more likely
  // a transient/loading render (animated-counter start, skeleton slot,
  // unhydrated widget, SSR initial state) than a genuine cliff — and a
  // single such write permanently poisons all-time low (`Math.min`
  // never recovers upward), average, and the chart, even after later
  // checks restore the real value. Refuse to commit it: keep the last
  // known good value, skip history/stats/alerts/sound entirely, and
  // only advance the check timestamp so scheduling stays honest.
  // Fresh monitors (no prior value) and already-zero series still
  // store zero normally, so a website genuinely reporting 0 keeps
  // working. Deliberate trade-off: a true permanent cliff to exactly
  // zero stays preserved until re-picked — far safer than letting one
  // bad read destroy months of aggregates.
  const prevNormalized =
    current.lastValue !== null &&
    current.lastSemanticValue &&
    current.lastSemanticValue.type !== 'text'
      ? current.lastSemanticValue.normalized
      : null;
  const nextNormalized =
    outcome.semanticValue && outcome.semanticValue.type !== 'text'
      ? outcome.semanticValue.normalized
      : null;
  if (
    nextNormalized === 0 &&
    typeof prevNormalized === 'number' &&
    Number.isFinite(prevNormalized) &&
    prevNormalized !== 0
  ) {
    await updateMonitor(monitor.id, { lastCheckedAt: now });
    return;
  }

  const changed = hasValueChanged(current.lastValue, current.lastSemanticValue, value, outcome.semanticValue);

  let nextStats: HistoricalStats | null = current.stats ?? null;
  if (
    outcome.semanticValue &&
    outcome.semanticValue.type !== 'text' &&
    outcome.semanticValue.normalized !== null &&
    Number.isFinite(outcome.semanticValue.normalized)
  ) {
    const num = outcome.semanticValue.normalized;
    const prev = current.stats;
    nextStats = prev
      ? {
          low: Math.min(prev.low, num),
          lowDate: num <= prev.low ? now : prev.lowDate,
          high: Math.max(prev.high, num),
          sum: prev.sum + num,
          count: prev.count + 1,
        }
      : {
          low: num,
          lowDate: now,
          high: num,
          sum: num,
          count: 1,
        };
  }

  const previousValue = current.lastValue;
  const previousSemantic = current.lastSemanticValue;

  // History and alerts follow a successful monitor update only: if the
  // monitor vanished (or the write failed) in the gap above, neither
  // may resurrect state nor notify for a monitor that is gone.
  const updateResult = await updateMonitor(monitor.id, {
    checkStrategy: strategyId,
    consecutiveFailures: 0,
    consecutiveRelocations: wasRelocated && outcome.confidence < RECOVERY_ACCEPT_THRESHOLD + 20
      ? current.consecutiveRelocations + 1
      : 0,
    totalSuccessfulChecks: current.totalSuccessfulChecks + 1,
    lastCheckedAt: now,
    lastValue: value,
    lastSemanticValue: outcome.semanticValue,
    lastStatus: changed ? 'changed' : 'unchanged',
    lastError: null,
    lastDiagnosticCode: outcome.diagnostic.code,
    lastConfidence: outcome.confidence,
    fingerprint: outcome.updatedFingerprint ?? current.fingerprint,
    lastFingerprintUpdateAt: wasRelocated ? now : current.lastFingerprintUpdateAt,
    stats: nextStats,
  });
  if (!updateResult.ok) {
    return;
  }

  await appendHistory({
    id: `${monitor.id}_${now}`,
    monitorId: monitor.id,
    value,
    previousValue: changed ? previousValue : null,
    previousSemanticValue: changed ? previousSemantic : null,
    semanticValue: outcome.semanticValue,
    checkedAt: now,
    changed,
    error: null,
    diagnosticCode: outcome.diagnostic.code,
    confidence: outcome.confidence,
    strategy: strategyId,
  });

  if (changed) {
    playSparkleCue();
    const shouldAlert = shouldTriggerAlert(
      current.alertCondition,
      value,
      previousValue,
      outcome.semanticValue,
      previousSemantic,
    );
    if (shouldAlert) {
      await notifyChange(current, value, previousValue, previousSemantic, outcome.semanticValue);
    }
  }
}

/** Exported for focused commit-guard tests (same as `recordSuccess` above). */
export async function recordFailure(
  monitor: Monitor,
  diagnostics: ReturnType<typeof diagnostic>[],
  attemptedStrategy: MonitorCheckStrategy | null,
): Promise<void> {
  const now = Date.now();
  const selected = selectPrimaryDiagnostic(diagnostics);
  const message = diagnostics.map(formatDiagnostic).join(' — ');
  // Same commit gate as recordSuccess above: re-fetch first, drop the
  // result for a missing/disabled monitor, and only append history
  // after a successful monitor update.
  const currentResult = await getMonitor(monitor.id);
  if (!currentResult.ok || !currentResult.value.enabled) {
    return;
  }
  const current = currentResult.value;
  // A forced reprobe that still fails shouldn't strand the monitor with
  // no persisted strategy at all — fall back to whichever it was using
  // before so at least the fast path is tried first on the next tick.
  const nextStrategy = attemptedStrategy ?? current.checkStrategy;
  const consecutiveFailures = current.consecutiveFailures + 1;
  const hasPriorValue = current.lastValue !== null;
  // Terminal identity state: the stored fingerprint (including a
  // value-anchored re-anchor retry on every attempt) has now failed
  // repeatedly past the permanent threshold on an existing monitor.
  // Name it honestly so the UI offers a re-pick instead of an endless
  // retry loop. The original trace stays in `message`/`lastError`, and
  // lastValue/history stay preserved; scheduled checks keep running in
  // case the page changes back.
  const primary = shouldMarkNeedsRepick(selected.code, consecutiveFailures, hasPriorValue)
    ? diagnostic('NEEDS_REPICK', selected.detail)
    : selected;
  const isPermanent =
    primary.code === 'NEEDS_REPICK' || isPermanentFailure(primary.code, consecutiveFailures, hasPriorValue);

  // Preserve the last known good status when a failure is temporary,
  // transitioning to 'error' only when the failure is genuinely permanent / unrecoverable.
  const nextStatus = isPermanent
    ? 'error'
    : current.lastStatus === 'changed'
      ? 'changed'
      : 'unchanged';

  const updateResult = await updateMonitor(monitor.id, {
    consecutiveFailures,
    consecutiveRelocations: 0,
    lastCheckedAt: now,
    lastStatus: nextStatus,
    lastError: message,
    lastDiagnosticCode: primary.code,
    checkStrategy: nextStrategy,
  });
  if (!updateResult.ok) {
    return;
  }

  await appendHistory({
    id: `${monitor.id}_${now}`,
    monitorId: monitor.id,
    value: null,
    semanticValue: null,
    checkedAt: now,
    changed: false,
    error: message,
    diagnosticCode: primary.code,
    confidence: null,
    strategy: null,
  });

  const isNewFailure =
    current.consecutiveFailures === 0 &&
    (current.lastValue !== null || current.totalSuccessfulChecks > 0);
  if (isNewFailure) {
    playErrorCue();
  }
}
