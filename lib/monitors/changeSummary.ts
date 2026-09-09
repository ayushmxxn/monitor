import {
  type SemanticValue,
  type SemanticValueType,
  CURRENCY_SYMBOLS,
  formatCompactNumber,
  formatStorageBytes,
  formatDurationSeconds,
} from './semanticValue';
import type { AlertCondition } from './types';

export interface ValueChangeSummary {
  hasChange: boolean;
  isNumeric: boolean;
  previousValue: string | null;
  currentValue: string;
  absoluteDelta: number | null;
  formattedDelta: string | null;
  percentageDelta: number | null;
  formattedPercentage: string | null;
  direction: 'increase' | 'decrease' | 'same' | 'text';
  /** Short summary of the change, e.g. "+$25.00 (+25.0%)" or "In Stock → Out of Stock" */
  summaryText: string;
  /** Full transition text, e.g. "$100.00 → $125.00 (+$25.00, +25.0%)" or "In Stock → Out of Stock" */
  fullText: string;
}

const CODE_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  CURRENCY_SYMBOLS.map(([symbol, code]) => [code, symbol]),
);

/**
 * Formats a signed numeric delta into a human-readable string appropriate
 * for its semantic type (e.g. "+$25.00", "-USD 10.00", "+1.2K", "+5.0%").
 */
export function formatChangeDelta(
  type: SemanticValueType,
  unit: string | null,
  delta: number,
): string {
  const magnitude = Math.abs(delta);
  const sign = delta >= 0 ? '+' : '-';

  switch (type) {
    case 'currency':
    case 'revenue': {
      const symbol = unit ? CODE_TO_SYMBOL[unit] : null;
      if (symbol) {
        return `${sign}${symbol}${magnitude.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
      }
      return `${sign}${unit ? `${unit} ` : ''}${magnitude.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    case 'percentage':
      return `${sign}${magnitude.toFixed(1)}%`;
    case 'storage':
      return `${sign}${formatStorageBytes(magnitude)}`;
    case 'duration':
      return `${sign}${formatDurationSeconds(magnitude)}`;
    case 'stars':
      return `${sign}${magnitude.toFixed(1)}${unit ?? ''}`;
    case 'followers':
    case 'views':
    case 'count':
    case 'number':
      return `${sign}${formatCompactNumber(magnitude)}`;
    default:
      return `${sign}${magnitude.toLocaleString()}`;
  }
}

/**
 * Computes the absolute and percentage change between previous and current values.
 * Strictly preserves text monitors without inventing numeric calculations.
 */
export function calculateValueChange(
  previousValue: string | null,
  previousSemantic: SemanticValue | null,
  currentValue: string,
  currentSemantic: SemanticValue | null,
): ValueChangeSummary {
  if (previousValue === null) {
    return {
      hasChange: false,
      isNumeric: false,
      previousValue: null,
      currentValue,
      absoluteDelta: null,
      formattedDelta: null,
      percentageDelta: null,
      formattedPercentage: null,
      direction: 'same',
      summaryText: currentValue,
      fullText: currentValue,
    };
  }

  const isPrevNumeric =
    previousSemantic?.normalized !== null &&
    previousSemantic?.normalized !== undefined &&
    Number.isFinite(previousSemantic.normalized);
  const isCurrNumeric =
    currentSemantic?.normalized !== null &&
    currentSemantic?.normalized !== undefined &&
    Number.isFinite(currentSemantic.normalized);

  const areTypesCompatible =
    isPrevNumeric &&
    isCurrNumeric &&
    previousSemantic.type === currentSemantic.type &&
    (previousSemantic.unit === currentSemantic.unit ||
      (!previousSemantic.unit && !currentSemantic.unit));

  if (areTypesCompatible) {
    const prevNum = previousSemantic.normalized!;
    const currNum = currentSemantic.normalized!;
    const absoluteDelta = currNum - prevNum;
    const direction: ValueChangeSummary['direction'] =
      absoluteDelta > 0 ? 'increase' : absoluteDelta < 0 ? 'decrease' : 'same';
    const formattedDelta = formatChangeDelta(currentSemantic.type, currentSemantic.unit, absoluteDelta);

    let percentageDelta: number | null = null;
    let formattedPercentage: string | null = null;

    // Relative percentage change is meaningful when base is non-zero and type isn't already a percentage
    if (prevNum !== 0 && currentSemantic.type !== 'percentage') {
      percentageDelta = ((currNum - prevNum) / Math.abs(prevNum)) * 100;
      formattedPercentage = `${percentageDelta >= 0 ? '+' : ''}${percentageDelta.toFixed(1)}%`;
    }

    const summaryText =
      absoluteDelta === 0
        ? 'No change'
        : formattedPercentage
          ? `${formattedDelta} (${formattedPercentage})`
          : formattedDelta;

    const fullText =
      absoluteDelta === 0
        ? `${currentValue} (unchanged)`
        : formattedPercentage
          ? `${previousValue} → ${currentValue} (${formattedDelta}, ${formattedPercentage})`
          : `${previousValue} → ${currentValue} (${formattedDelta})`;

    return {
      hasChange: absoluteDelta !== 0,
      isNumeric: true,
      previousValue,
      currentValue,
      absoluteDelta,
      formattedDelta,
      percentageDelta,
      formattedPercentage,
      direction,
      summaryText,
      fullText,
    };
  }

  // Text monitors or mismatched non-numeric changes
  const hasTextChange = previousValue.trim() !== currentValue.trim();
  const summaryText = hasTextChange ? `${previousValue} → ${currentValue}` : `${currentValue} (unchanged)`;
  const fullText = summaryText;

  return {
    hasChange: hasTextChange,
    isNumeric: false,
    previousValue,
    currentValue,
    absoluteDelta: null,
    formattedDelta: null,
    percentageDelta: null,
    formattedPercentage: null,
    direction: hasTextChange ? 'text' : 'same',
    summaryText,
    fullText,
  };
}

/**
 * Creates the user-facing alert notification text for system notifications.
 */
export function formatChangeAlertMessage(
  change: ValueChangeSummary,
  condition?: AlertCondition | null,
): string {
  if (condition && condition.type !== 'any') {
    if (condition.type === 'below' && condition.targetValue !== null && condition.targetValue !== undefined) {
      return `${change.fullText} [Target: < ${condition.targetValue}]`;
    }
    if (condition.type === 'above' && condition.targetValue !== null && condition.targetValue !== undefined) {
      return `${change.fullText} [Target: > ${condition.targetValue}]`;
    }
    if (condition.type === 'matches' && condition.targetText) {
      return `${change.fullText} [Matches: "${condition.targetText}"]`;
    }
  }
  return change.fullText;
}

export interface HeroMovementInfo {
  text: string;
  direction: 'increase' | 'decrease';
}

/**
 * Formats a compact secondary line communicating value movement since the previous check:
 * e.g. "↑ $90.99 · +0.1% since last check" or "↓ $20.00 · -5.0% since last check".
 * Returns null for text monitors, non-changes, or missing previous comparable values.
 */
export function formatHeroMovement(
  change: ValueChangeSummary | null | undefined,
): HeroMovementInfo | null {
  if (!change || !change.hasChange || !change.isNumeric || !change.formattedDelta) {
    return null;
  }
  if (change.direction !== 'increase' && change.direction !== 'decrease') {
    return null;
  }

  const arrow = change.direction === 'increase' ? '↑' : '↓';
  const absDelta = change.formattedDelta.replace(/^[+-]/, '');

  if (change.formattedPercentage) {
    return {
      text: `${arrow} ${absDelta} · ${change.formattedPercentage} since last check`,
      direction: change.direction,
    };
  }

  return {
    text: `${arrow} ${absDelta} since last check`,
    direction: change.direction,
  };
}
