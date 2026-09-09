/**
 * Monitor domain types.
 *
 * A "monitor" watches one value (text or an attribute) on one element
 * on one page, on an interval. Everything here is local-only: a
 * monitor's history lives next to it in `chrome.storage.local`.
 *
 * The element is identified by an `ElementFingerprint` (see
 * `lib/monitors/fingerprint.ts`) rather than a bare CSS selector — a
 * bundle of independent signals that the adaptive recovery engine
 * scores candidate elements against whenever the exact selector no
 * longer resolves. The fingerprint is self-healing: a successful
 * recovery above the confidence threshold updates it in place so the
 * next check starts from the element's current DOM position.
 */

import type { ElementFingerprint } from './fingerprint';
import type { DiagnosticCode } from './diagnostics';
import type { SemanticValue } from './semanticValue';

/**
 * A check strategy is a pluggable way of retrieving a page's HTML/DOM so
 * the extractor can run against it. New strategies can be added by
 * implementing `CheckStrategy` in `lib/monitors/strategies` and
 * registering it in `STRATEGY_ORDER` - nothing here needs to change.
 */
export type MonitorCheckStrategy = 'fetch' | 'live';

export type ExtractMode = 'text' | 'attribute';

export type MonitorStatus =
  | 'idle'
  | 'checking'
  | 'unchanged'
  | 'changed'
  | 'error';

/** Minimum allowed check interval. Keeps `chrome.alarms` usage sane and page load polite. */
export const MIN_INTERVAL_MINUTES = 5;
export const DEFAULT_INTERVAL_MINUTES = 30;

/** Confidence score (0-100) below which a relocated element is not trusted automatically. */
export const RECOVERY_ACCEPT_THRESHOLD = 55;
/** Confidence score above which a relocation is treated as a non-event rather than flagged for review. */
export const RECOVERY_HIGH_CONFIDENCE = 80;
/** Consecutive low-confidence relocations before a strategy re-probe is forced. */
export const REPROBE_AFTER_LOW_CONFIDENCE_STREAK = 2;
/** Even a healthy monitor gets its strategy cascade re-verified periodically, in case a better one now applies. */
export const PERIODIC_REPROBE_INTERVAL_CHECKS = 40;

export interface Monitor {
  id: string;
  name: string;
  url: string;
  fingerprint: ElementFingerprint;
  extractMode: ExtractMode;
  /** Required when `extractMode` is `'attribute'`. */
  attributeName: string | null;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;

  lastCheckedAt: number | null;
  lastValue: string | null;
  /**
   * Best-effort classification of `lastValue` (currency, percentage,
   * followers, storage, duration, etc.) plus a normalized comparable
   * number, derived by `detectSemanticValue`. Always `null` when
   * `lastValue` is `null`. Purely additive metadata - `lastValue`
   * remains the original formatted text and is what the UI displays.
   */
  lastSemanticValue: SemanticValue | null;
  lastStatus: MonitorStatus;
  lastError: string | null;
  lastDiagnosticCode: DiagnosticCode | null;

  /**
   * The strategy that last successfully produced a value for this
   * monitor, so future checks start with the method known to work
   * instead of re-probing every strategy each time. `null` until the
   * first successful check, and reset to `null` whenever a diagnostic
   * suggests the current strategy may no longer be the best fit (see
   * `FORCE_REPROBE_CODES`), so the pipeline continuously re-evaluates
   * rather than trusting a stale choice forever.
   */
  checkStrategy: MonitorCheckStrategy | null;
  /** Consecutive checks where every strategy failed, for diagnostics. */
  consecutiveFailures: number;
  /** Confidence (0-100) of the most recent element location. `null` before the first check. */
  lastConfidence: number | null;
  /** Consecutive checks where the element had to be relocated (not found at its exact prior location). */
  consecutiveRelocations: number;
  /** Total successful checks ever recorded, used to schedule periodic strategy re-verification. */
  totalSuccessfulChecks: number;
  /** Timestamp of the last time the fingerprint itself was updated by a successful relocation. */
  lastFingerprintUpdateAt: number | null;
  /**
   * Optional smart alert trigger condition. When omitted or set to 'any',
   * alerts fire on any detected value change (default backward-compatible behavior).
   */
  alertCondition?: AlertCondition | null;
  /** Lightweight persisted all-time aggregate stats (low, high, average sum/count). */
  stats?: HistoricalStats | null;
}

export interface HistoricalStats {
  low: number;
  lowDate: number;
  high: number;
  sum: number;
  count: number;
}

export type AlertConditionType =
  | 'any'
  | 'decrease'
  | 'increase'
  | 'below'
  | 'above'
  | 'matches';

export interface AlertCondition {
  type: AlertConditionType;
  /** Numeric threshold for 'below' or 'above' conditions. */
  targetValue?: number | null;
  /** Target text or substring for 'matches' condition. */
  targetText?: string | null;
}

export interface MonitorCheck {
  id: string;
  monitorId: string;
  value: string | null;
  /** The value before this check if changed, or null. Compatible with legacy history entries. */
  previousValue?: string | null;
  /** Semantic classification + normalized number for previousValue, or null. */
  previousSemanticValue?: SemanticValue | null;
  /** Semantic classification + normalized number for `value`, or `null` when `value` is `null`. */
  semanticValue: SemanticValue | null;
  checkedAt: number;
  changed: boolean;
  error: string | null;
  diagnosticCode: DiagnosticCode | null;
  confidence: number | null;
  strategy: MonitorCheckStrategy | null;
}

/** Fields the UI collects when creating a monitor; the store fills in the rest. */
export interface CreateMonitorInput {
  name: string;
  url: string;
  fingerprint: ElementFingerprint;
  extractMode: ExtractMode;
  attributeName?: string | null;
  intervalMinutes?: number;
}

/** Hard safety ceiling for history retention per monitor. */
export const MAX_HISTORY_ENTRIES = 1000;
/** Primary retention period: 30 days. */
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Periodic sampling interval for identical unchanged checks. */
export const UNCHANGED_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
