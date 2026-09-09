import type { AlertCondition } from './types';
import { CURRENCY_SYMBOLS, type SemanticValue } from './semanticValue';

/**
 * Extracts a comparable number from either the detected SemanticValue or a raw string value.
 * Returns null if the value is purely non-numeric text.
 */
export function extractComparableNumber(
  value: string | null | undefined,
  semantic: SemanticValue | null | undefined,
): number | null {
  if (semantic?.normalized !== null && semantic?.normalized !== undefined && !Number.isNaN(semantic.normalized)) {
    // If raw text clearly indicates negative currency/number but normalized was positive
    if (value && value.trim().startsWith('-') && semantic.normalized > 0) {
      return -semantic.normalized;
    }
    return semantic.normalized;
  }
  if (!value) return null;
  // Clean string and try to parse
  const cleaned = value.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Evaluates whether an alert notification should be triggered for a value change,
 * given the user's configured AlertCondition.
 *
 * Defaults to `true` if condition is omitted or set to 'any'.
 */
export function shouldTriggerAlert(
  condition: AlertCondition | null | undefined,
  currentValue: string,
  previousValue?: string | null,
  currentSemantic?: SemanticValue | null,
  previousSemantic?: SemanticValue | null,
): boolean {
  if (!condition || condition.type === 'any') {
    return true;
  }

  const currNum = extractComparableNumber(currentValue, currentSemantic);
  const prevNum = extractComparableNumber(previousValue, previousSemantic);

  switch (condition.type) {
    case 'decrease': {
      if (currNum === null || prevNum === null) return false;
      return currNum < prevNum;
    }

    case 'increase': {
      if (currNum === null || prevNum === null) return false;
      return currNum > prevNum;
    }

    case 'below': {
      if (
        condition.targetValue === null ||
        condition.targetValue === undefined ||
        Number.isNaN(condition.targetValue) ||
        currNum === null
      ) {
        return false;
      }
      return currNum < condition.targetValue;
    }

    case 'above': {
      if (
        condition.targetValue === null ||
        condition.targetValue === undefined ||
        Number.isNaN(condition.targetValue) ||
        currNum === null
      ) {
        return false;
      }
      return currNum > condition.targetValue;
    }

    case 'matches': {
      if (!condition.targetText || !condition.targetText.trim()) return false;
      const target = condition.targetText.trim().toLowerCase();
      return currentValue.toLowerCase().includes(target);
    }

    default:
      return true;
  }
}

/**
 * Returns a concise human-readable description of an alert condition.
 */
export function formatAlertConditionDescription(
  condition: AlertCondition | null | undefined,
  semantic?: SemanticValue | null,
): string {
  if (!condition || condition.type === 'any') {
    return 'Any change';
  }

  const isCurrency = semantic?.type === 'currency';
  let prefix = '';
  if (isCurrency && semantic?.unit) {
    for (const [sym, code] of CURRENCY_SYMBOLS) {
      if (code === semantic.unit || sym === semantic.unit) {
        prefix = sym;
        break;
      }
    }
    if (!prefix) prefix = semantic.unit;
  }
  const suffix = semantic?.type === 'percentage' ? '%' : '';

  switch (condition.type) {
    case 'decrease':
      return isCurrency ? 'Price drops' : 'Value decreases';
    case 'increase':
      return isCurrency ? 'Price rises' : 'Value increases';
    case 'below': {
      const target =
        condition.targetValue !== null && condition.targetValue !== undefined
          ? `${prefix}${condition.targetValue}${suffix}`
          : '—';
      return `Drops below ${target}`;
    }
    case 'above': {
      const target =
        condition.targetValue !== null && condition.targetValue !== undefined
          ? `${prefix}${condition.targetValue}${suffix}`
          : '—';
      return `Rises above ${target}`;
    }
    case 'matches':
      return `Matches "${condition.targetText ?? ''}"`;
    default:
      return 'Any change';
  }
}
