import {
  type SemanticValue,
  type SemanticValueType,
  CURRENCY_SYMBOLS,
  formatCompactNumber,
  formatStorageBytes,
  formatDurationSeconds,
  detectSemanticValue,
} from './semanticValue';
import type { HistoricalStats, MonitorCheck } from './types';

export type DealStatus = 'all-time-low' | 'near-lowest' | 'all-time-high';

export interface HistoricalBenchmarks {
  low: number;
  high: number;
  average: number;
  lowDate: number;
  formattedLow: string;
  formattedHigh: string;
  formattedAverage: string;
  dealStatus: DealStatus | null;
  dealStatusLabel: string | null;
}

const CODE_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  CURRENCY_SYMBOLS.map(([symbol, code]) => [code, symbol]),
);

/**
 * Formats a benchmark number according to its semantic type and unit.
 */
export function formatBenchmarkValue(
  type: SemanticValueType,
  unit: string | null,
  value: number,
): string {
  switch (type) {
    case 'currency':
    case 'revenue': {
      const symbol = unit ? CODE_TO_SYMBOL[unit] : null;
      const prefix = symbol ?? (unit ? `${unit} ` : '');
      return `${prefix}${value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    case 'percentage':
      return `${value.toFixed(1)}%`;
    case 'storage':
      return formatStorageBytes(value);
    case 'duration':
      return formatDurationSeconds(value);
    case 'stars':
      return `${value.toFixed(1)}${unit ?? ''}`;
    case 'followers':
    case 'views':
    case 'count':
    case 'number':
      if (Math.abs(value) >= 10_000) {
        return formatCompactNumber(value);
      }
      return Number.isInteger(value)
        ? value.toLocaleString()
        : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    default:
      return value.toLocaleString();
  }
}

/**
 * Calculates all-time low, all-time high, historical average, date of all-time low,
 * and contextual deal status for a monitor based on its check history and persisted aggregate stats.
 *
 * Gracefully returns null for text monitors, empty history, or insufficient history (< 2 points).
 */
export function calculateHistoricalBenchmarks(
  history: MonitorCheck[] | null | undefined,
  currentValue?: string | null,
  currentSemantic?: SemanticValue | null,
  stats?: HistoricalStats | null,
): HistoricalBenchmarks | null {
  if (!history || history.length < 2) {
    return null;
  }

  // Extract valid numeric entries
  const parsedPoints: { check: MonitorCheck; sem: SemanticValue }[] = [];

  for (const check of history) {
    if (check.error !== null || check.value === null) continue;
    const sem = check.semanticValue ?? (check.value ? detectSemanticValue(check.value) : null);
    if (
      sem &&
      sem.type !== 'text' &&
      sem.normalized !== null &&
      Number.isFinite(sem.normalized)
    ) {
      parsedPoints.push({ check, sem });
    }
  }

  if (parsedPoints.length < 2) {
    return null;
  }

  // Determine reference semantic type
  const refType: SemanticValueType =
    currentSemantic && currentSemantic.type !== 'text'
      ? currentSemantic.type
      : parsedPoints[0].sem.type;

  if (refType === 'text') {
    return null;
  }

  const numericPoints = parsedPoints.filter((p) => p.sem.type === refType);
  if (numericPoints.length < 2) {
    return null;
  }

  const unit =
    (currentSemantic && currentSemantic.type === refType ? currentSemantic.unit : null) ??
    numericPoints[0].sem.unit ??
    null;

  const values = numericPoints.map((p) => p.sem.normalized as number);
  const localLow = Math.min(...values);
  const localHigh = Math.max(...values);
  const localSum = values.reduce((acc, v) => acc + v, 0);
  const localAverage = localSum / values.length;

  // Find the check corresponding to the local low
  const lowPoint = numericPoints.find((p) => Math.abs((p.sem.normalized as number) - localLow) < 1e-9) ?? numericPoints[0];
  const localLowDate = lowPoint.check.checkedAt;

  // Blend with persisted all-time stats if available
  let low = localLow;
  let high = localHigh;
  let average = localAverage;
  let lowDate = localLowDate;

  if (stats && stats.count > 0) {
    if (stats.low < low) {
      low = stats.low;
      lowDate = stats.lowDate;
    }
    if (stats.high > high) {
      high = stats.high;
    }
    if (stats.count >= values.length && stats.sum > 0) {
      average = stats.sum / stats.count;
    }
  }

  const formattedLow = formatBenchmarkValue(refType, unit, low);
  const formattedHigh = formatBenchmarkValue(refType, unit, high);
  const formattedAverage = formatBenchmarkValue(refType, unit, average);

  // Determine deal status relative to current value
  let dealStatus: DealStatus | null = null;
  let dealStatusLabel: string | null = null;

  if (currentValue !== undefined && currentValue !== null) {
    const currSem =
      currentSemantic ?? (currentValue ? detectSemanticValue(currentValue) : null);

    if (
      currSem &&
      currSem.type === refType &&
      currSem.normalized !== null &&
      Number.isFinite(currSem.normalized)
    ) {
      const curr = currSem.normalized;

      // Only evaluate deal status if there has been actual variation across history
      if (high > low) {
        if (Math.abs(curr - low) < 1e-9 || curr < low) {
          dealStatus = 'all-time-low';
          dealStatusLabel = 'All-time low';
        } else if (Math.abs(curr - high) < 1e-9 || curr > high) {
          dealStatus = 'all-time-high';
          dealStatusLabel = 'All-time high';
        } else {
          // Check if within 5% of the historical minimum
          let isNearLow = false;
          if (refType === 'percentage') {
            // For percentage monitors: within 5 percentage points
            isNearLow = curr > low && curr <= low + 5;
          } else if (low > 0) {
            isNearLow = curr > low && (curr - low) / low <= 0.05 + 1e-9;
          } else if (low === 0) {
            isNearLow = curr > low && (high > low ? curr / high <= 0.05 : curr <= 0.05);
          }

          if (isNearLow) {
            dealStatus = 'near-lowest';
            dealStatusLabel = 'Near lowest';
          }
        }
      }
    }
  }

  return {
    low,
    high,
    average,
    lowDate,
    formattedLow,
    formattedHigh,
    formattedAverage,
    dealStatus,
    dealStatusLabel,
  };
}
