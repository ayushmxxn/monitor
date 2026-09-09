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
} from './diagnostics';
import { dedupeInFlight } from './concurrency';
import {
  RECOVERY_ACCEPT_THRESHOLD,
  REPROBE_AFTER_LOW_CONFIDENCE_STREAK,
  PERIODIC_REPROBE_INTERVAL_CHECKS,
} from './types';
import type { Monitor, MonitorCheckStrategy } from './types';
import { normalizeText } from './fingerprint';
import type { SemanticValue } from './semanticValue';
import { shouldTriggerAlert } from './alertCondition';

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
async function runCheck(initialMonitor: Monitor): Promise<void> {
  const latestResult = await getMonitor(initialMonitor.id);
  const monitor = latestResult.ok ? latestResult.value : initialMonitor;
  if (!monitor.enabled) {
    return;
  }

  await updateMonitor(monitor.id, { lastStatus: 'checking' });

  const permission = await hasOriginPermission(monitor.url);
  if (!permission.ok || !permission.value) {
    await recordFailure(monitor, [diagnostic('PERMISSION_DENIED')], null);
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

async function recordSuccess(
  monitor: Monitor,
  strategyId: MonitorCheckStrategy,
  outcome: StrategyOutcome,
): Promise<void> {
  const value = outcome.value!;
  const changed = hasValueChanged(monitor.lastValue, monitor.lastSemanticValue, value, outcome.semanticValue);
  const now = Date.now();
  const wasRelocated = outcome.updatedFingerprint !== null;

  await updateMonitor(monitor.id, {
    checkStrategy: strategyId,
    consecutiveFailures: 0,
    consecutiveRelocations: wasRelocated && outcome.confidence < RECOVERY_ACCEPT_THRESHOLD + 20
      ? monitor.consecutiveRelocations + 1
      : 0,
    totalSuccessfulChecks: monitor.totalSuccessfulChecks + 1,
    lastCheckedAt: now,
    lastValue: value,
    lastSemanticValue: outcome.semanticValue,
    lastStatus: changed ? 'changed' : 'unchanged',
    lastError: null,
    lastDiagnosticCode: outcome.diagnostic.code,
    lastConfidence: outcome.confidence,
    fingerprint: outcome.updatedFingerprint ?? monitor.fingerprint,
    lastFingerprintUpdateAt: wasRelocated ? now : monitor.lastFingerprintUpdateAt,
  });

  const previousValue = monitor.lastValue;
  const previousSemantic = monitor.lastSemanticValue;

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
    const shouldAlert = shouldTriggerAlert(
      monitor.alertCondition,
      value,
      previousValue,
      outcome.semanticValue,
      previousSemantic,
    );
    if (shouldAlert) {
      await notifyChange(monitor, value, previousValue, previousSemantic, outcome.semanticValue);
    }
  }
}

async function recordFailure(
  monitor: Monitor,
  diagnostics: ReturnType<typeof diagnostic>[],
  attemptedStrategy: MonitorCheckStrategy | null,
): Promise<void> {
  const now = Date.now();
  const primary = selectPrimaryDiagnostic(diagnostics);
  const message = diagnostics.map(formatDiagnostic).join(' — ');
  // A forced reprobe that still fails shouldn't strand the monitor with
  // no persisted strategy at all — fall back to whichever it was using
  // before so at least the fast path is tried first on the next tick.
  const nextStrategy = attemptedStrategy ?? monitor.checkStrategy;
  const consecutiveFailures = monitor.consecutiveFailures + 1;
  const hasPriorValue = monitor.lastValue !== null;
  const isPermanent = isPermanentFailure(primary.code, consecutiveFailures, hasPriorValue);

  // Preserve the last known good status when a failure is temporary,
  // transitioning to 'error' only when the failure is genuinely permanent / unrecoverable.
  const nextStatus = isPermanent
    ? 'error'
    : monitor.lastStatus === 'changed'
      ? 'changed'
      : 'unchanged';

  await updateMonitor(monitor.id, {
    consecutiveFailures,
    consecutiveRelocations: 0,
    lastCheckedAt: now,
    lastStatus: nextStatus,
    lastError: message,
    lastDiagnosticCode: primary.code,
    checkStrategy: nextStrategy,
  });

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
}
