/**
 * Adaptive, semantic formatting for monitor values.
 *
 * Centralizes presentation formatting across monitors without mutating
 * underlying stored data or introducing website-specific heuristics:
 *
 * 1. Currency / Revenue:
 *    - Hides insignificant trailing decimals ($77,158 instead of $77,158.15).
 *    - Drops trailing zero decimals ($10 instead of $10.00).
 *    - Preserves meaningful cents on smaller amounts ($4.99, $0.50).
 * 2. Counts / Views:
 *    - Uses compact notation for large magnitudes (1.3M, 90k).
 *    - Preserves small integers (1, 42).
 * 3. Percentages:
 *    - Preserves exact precision (54.55%).
 * 4. Meaningful decimals:
 *    - Preserves exact precision (1.25, 0.05).
 * 5. Other / Unclassified:
 *    - Preserves raw string untouched.
 */

import type { SemanticValue } from './semanticValue';
import { detectSemanticValue, extractNumericToken } from './semanticValue';

export function formatCompactCount(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    const v = abs / 1_000_000_000;
    const str = v >= 100 ? Math.round(v).toString() : Number(v.toFixed(1)).toString();
    return `${sign}${str}B`;
  }
  if (abs >= 1_000_000) {
    const v = abs / 1_000_000;
    const str = v >= 100 ? Math.round(v).toString() : Number(v.toFixed(1)).toString();
    return `${sign}${str}M`;
  }
  if (abs >= 1_000) {
    const v = abs / 1_000;
    const str = v >= 100 ? Math.round(v).toString() : Number(v.toFixed(1)).toString();
    return `${sign}${str}k`;
  }

  return Number.isInteger(n) ? `${n}` : n.toString();
}

/**
 * Formats a monitor's display value adaptively based on its detected or cached
 * semantic classification, never altering the stored raw value.
 */
export function formatAdaptiveValue(
  raw: string | null | undefined,
  semantic?: SemanticValue | null,
): string | null {
  if (raw == null || raw === '') return raw ?? null;

  const sem = semantic ?? detectSemanticValue(raw);

  switch (sem.type) {
    case 'currency':
    case 'revenue': {
      // 1. Any trailing .00 or .0 is always insignificant ($10.00 -> $10, $500.00 -> $500)
      let formatted = raw.replace(/\.00(?!\d)/g, '').replace(/\.0(?!\d)/g, '');

      // 2. Large currency (magnitude >= 1000): hide all cents ($77,158.15 -> $77,158)
      const magnitude = Math.abs(sem.normalized ?? 0);
      if (magnitude >= 1000) {
        formatted = formatted.replace(/\.\d+(?!\d)/g, '');
      }

      return formatted;
    }

    case 'followers':
    case 'views':
    case 'count': {
      // If already has scale suffix (e.g. "1.3M" or "90k"), return as-is
      if (/^[+-]?[\d,]+(?:\.\d+)?\s*(k|mm|m|bn|b|t)$/i.test(raw.trim())) {
        return raw;
      }
      if (sem.normalized !== null && Math.abs(sem.normalized) >= 1000) {
        const compact = formatCompactCount(sem.normalized);
        const token = extractNumericToken(raw, sem);
        if (token && raw.includes(token)) {
          return raw.replace(token, compact);
        }
        return compact;
      }
      return raw;
    }

    case 'number': {
      // If it's a whole number count >= 1000, use compact notation (e.g. 90,000 -> 90k, 1,300,000 -> 1.3M)
      if (
        sem.normalized !== null &&
        Math.abs(sem.normalized) >= 1000 &&
        Number.isInteger(sem.normalized)
      ) {
        return formatCompactCount(sem.normalized);
      }
      // Otherwise, meaningful decimals (e.g. 1.25) or small numbers (e.g. 1, 42) preserve precision
      return raw;
    }

    case 'percentage':
    case 'stars':
    case 'storage':
    case 'duration':
    case 'text':
    default:
      // Preserves precision and raw representation
      return raw;
  }
}
