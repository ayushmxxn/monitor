import type { Monitor, MonitorCheckStrategy } from '../types';
import type { ElementFingerprint } from '../fingerprint';
import type { Diagnostic } from '../diagnostics';
import type { SemanticValue } from '../semanticValue';

export interface StrategyOutcome {
  value: string | null;
  diagnostic: Diagnostic;
  /** Present when the element was relocated with acceptable confidence — the caller persists this to self-heal. */
  updatedFingerprint: ElementFingerprint | null;
  confidence: number;
  method: string;
  /** Best-effort classification + normalized number for `value`. `null` when `value` is `null`. */
  semanticValue: SemanticValue | null;
}

export interface CheckStrategy {
  id: MonitorCheckStrategy;
  /** Attempts to produce the monitored value for `monitor`. Never throws. */
  run(monitor: Monitor): Promise<StrategyOutcome>;
}

/** True when a strategy outcome is usable as a check result. */
export function isValidOutcome(outcome: StrategyOutcome): boolean {
  return outcome.value !== null && outcome.value.length > 0;
}
