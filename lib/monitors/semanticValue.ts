/**
 * Semantic value detection.
 *
 * `locate.ts`'s `extractValue` only ever produces a plain string - it has
 * no idea whether "1.2K" is a follower count, "$49.99" is a price, or
 * "87%" is a completion bar. This module looks at that string after
 * extraction and, on a best-effort basis, classifies it and derives a
 * single comparable number, so the rest of the app (trend indicators,
 * future numeric comparisons/alerts) doesn't have to re-parse formatted
 * text itself every time it needs a number out of it.
 *
 * The extracted text always stays the source of truth for display -
 * `SemanticValue.raw` is just a copy of it for convenience, never a
 * replacement. Nothing here changes what a monitor stores as its
 * `value`/`lastValue`; it only adds metadata alongside it.
 *
 * Detection is pattern-based and deliberately conservative: an
 * ambiguous or unrecognized string falls back to `'text'` with a null
 * normalized value rather than guessing wrong.
 */

export type SemanticValueType =
  | 'currency'
  | 'revenue'
  | 'percentage'
  | 'followers'
  | 'views'
  | 'stars'
  | 'storage'
  | 'duration'
  | 'count'
  | 'number'
  | 'text';

export interface SemanticValue {
  type: SemanticValueType;
  /**
   * The value converted to a single comparable number, in a
   * type-specific base unit: bytes for storage, seconds for duration,
   * the plain magnitude (with K/M/B/T suffixes expanded) otherwise.
   * `null` for `'text'` or whenever parsing didn't yield a confident
   * number.
   */
  normalized: number | null;
  /** Unit/currency/scale detected, e.g. `'USD'`, `'GB'`, `'%'`, `'/5'`. `null` if not applicable. */
  unit: string | null;
  /** The exact extracted string this was derived from. */
  raw: string;
}

export const SEMANTIC_TYPE_LABELS: Record<SemanticValueType, string> = {
  currency: 'Currency',
  revenue: 'Revenue',
  percentage: 'Percentage',
  followers: 'Followers',
  views: 'Views',
  stars: 'Rating',
  storage: 'Storage',
  duration: 'Duration',
  count: 'Count',
  number: 'Number',
  text: 'Text',
};

function textValue(raw: string): SemanticValue {
  return { type: 'text', normalized: null, unit: null, raw };
}

export const CURRENCY_SYMBOLS: [symbol: string, code: string][] = [
  // Multi-character symbols first so they're matched before their
  // single-character prefix (e.g. "R$" before a lone "$" reading).
  ['R$', 'BRL'],
  ['C$', 'CAD'],
  ['A$', 'AUD'],
  ['NZ$', 'NZD'],
  ['HK$', 'HKD'],
  ['S$', 'SGD'],
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['₩', 'KRW'],
  ['₽', 'RUB'],
  ['₺', 'TRY'],
  ['₴', 'UAH'],
  ['₫', 'VND'],
  ['฿', 'THB'],
  ['₪', 'ILS'],
];
CURRENCY_SYMBOLS.sort((a, b) => b[0].length - a[0].length);

export const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'INR', 'KRW', 'RUB', 'TRY', 'UAH', 'VND', 'BRL',
  'CAD', 'AUD', 'CNY', 'CHF', 'SEK', 'NOK', 'DKK', 'MXN', 'ZAR', 'SGD', 'HKD',
  'NZD', 'THB', 'ILS', 'PLN', 'IDR', 'PHP', 'MYR',
]);

const REVENUE_KEYWORDS = /\b(revenue|sales|earnings|earned|mrr|arr|income|profit|gmv)\b/i;

const SCALE_SUFFIXES: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  mm: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
  t: 1_000_000_000_000,
  thousand: 1_000,
  thousands: 1_000,
  million: 1_000_000,
  millions: 1_000_000,
  billion: 1_000_000_000,
  billions: 1_000_000_000,
  trillion: 1_000_000_000_000,
  trillions: 1_000_000_000_000,
};

/**
 * Shared scale-suffix alternative for every magnitude regex in this
 * module: K/M/B/T letters plus English magnitude words ("22 thousand
 * subscribers", "1.2 million views" — the word form accessibility
 * labels like YouTube's `aria-label` use instead of suffixes).
 * Non-capturing, so interpolating it never shifts match-group indices.
 * Words come before their single-letter prefixes (`t` in "thousand")
 * so sites without a trailing boundary still match the full word
 * instead of stopping after its first letter; at `\b`-terminated sites
 * the order is irrelevant (only the full alternative can match).
 */
const SCALE_SUFFIX_SOURCE = '(?:thousands?|millions?|billions?|trillions?|k|mm|m|bn|b|t)';

/** First numeric token in `text`, with an optional trailing K/M/B/T scale suffix expanded. */
function parseScaledNumber(text: string): number | null {
  const match = text.match(
    new RegExp(`(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?))\\s*(${SCALE_SUFFIX_SOURCE})?\\b`, 'i'),
  );
  if (!match) return null;
  const base = parseLocalizedNumberFragment(match[1]);
  if (base === null) return null;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix ? SCALE_SUFFIXES[suffix] ?? 1 : 1;
  return base * scale;
}

/**
 * Continental-European numeric syntax support (demonstrated wrong-value
 * class — committed with high confidence, sometimes with a heal):
 * - decimal comma: "9,99 €" parsed as 999, "54,55%" as 54;
 * - dot-thousands groups: "1.234,56 €" truncated to the "234,56 €"
 *   span (234.56 instead of 1234.56);
 * - space/apostrophe grouping: "1 234" truncated to the "1" span.
 *
 * US-valid numbers can never match the shapes below, so trying them
 * first cannot steal a US match: comma tails are 1–2 digits with no
 * third digit following (US thousands always take exactly 3), dot
 * groups come in pairs-or-more or with a comma tail (a bare "1.234"
 * stays a US decimal — genuinely ambiguous, deliberately preserved),
 * and space/apostrophe groups are strict 3-digit runs. Mid-number
 * starts are blocked by the leading guard, so "1,234" can never match
 * as "2,34". Typographic group separators (narrow/regular no-break
 * space, thin space, ASCII and curly apostrophes) apply anywhere;
 * bare ASCII-space grouping only in whole-token positions (free text
 * separates words and phone-like runs with plain spaces, so those stay
 * conservative).
 */
const EU_SEP_CLASS = "[\\u00A0\\u2009\\u202F'\\u2019]";
const EU_SEP_TOKEN_CLASS = "[ \\u00A0\\u2009\\u202F'\\u2019]";
const EU_GUARD_CLASS = "[\\d.,'\\u2019\\u00A0\\u2009\\u202F]";
/**
 * Free-text-safe continental fragment shared by the tokenizer scans in
 * this module and `collectNumericTokens` (`locate.ts`), so both agree
 * on what counts as one number. See the invariant comment above:
 * US-valid text can never match it.
 */
export const EU_NUM_FREE =
  "(?<!" +
  EU_GUARD_CLASS +
  ")(?:\\d{1,3}(?:\\.\\d{3}){2,}(?:,\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+,\\d{1,2}|\\d+,\\d{1,2}|\\d{1,3}(?:" +
  EU_SEP_CLASS +
  "\\d{3})+)(?!\\d)";

/**
 * Whole-token variant of the continental shapes above, additionally
 * allowing bare ASCII-space grouping. Used only where the match
 * position itself proves the span is one number: full-token `^...$`
 * validators, element-start `^` anchors, and patterns whose numeric
 * core sits directly adjacent to a currency symbol, `%`, unit word,
 * or keyword. Free-text scans must use EU_NUM_FREE instead — plain
 * spaces separate words and phone-like runs out there.
 */
const EU_NUM_TOKEN =
  "(?<![\\d.,'])(?:\\d{1,3}(?:\\.\\d{3}){2,}(?:,\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+,\\d{1,2}|\\d+,\\d{1,2}|\\d{1,3}(?:" +
  EU_SEP_TOKEN_CLASS +
  "\\d{3})+)(?!\\d)";

/**
 * Rewrites a matched numeric fragment into canonical US-ASCII form
 * (plain digits plus at most one dot) or returns null when the
 * fragment is uninterpretable. Strict shapes only — anything else
 * falls through to the historical comma-stripping behavior, and
 * fragments that survive no rule fail closed (null) instead of
 * guessing. US-valid fragments always canonicalize to a string that
 * parses identically to the old comma-stripping path.
 */
function canonicalizeNumericFragment(fragment: string): string | null {
  let s = fragment.trim();
  let negative = false;
  const sign = s.match(/^([-+])\s*/);
  if (sign) {
    negative = sign[1] === '-';
    s = s.slice(sign[0].length);
  }
  // Strict thousands grouping (typographic separators; ASCII space
  // only reaches here from whole-token positions, never free text).
  s = s.replace(/(\d)[ \u00A0\u2009\u202F'\u2019](\d{3})(?!\d)/g, '$1$2');
  // Continental dot-thousands: multi-dot groups, or dot groups with a
  // comma-decimal tail. A bare single "1.234" is ambiguous with a US
  // decimal and is deliberately left untouched.
  s = s.replace(/(\d{1,3}(?:\.\d{3})+)(,\d{1,2})?/g, (m, int: string, tail: string | undefined) => {
    if (!tail && (int.match(/\./g) ?? []).length < 2) return m;
    return int.replace(/\./g, '') + (tail ? `.${tail.slice(1)}` : '');
  });
  // US thousands commas and Indian digit grouping collapse fully
  // here (anchored whole-fragment shapes, so chained groups like
  // "2,500,000,000" cannot stall halfway the way a single left-to-right
  // pass does). An optional decimal tail is part of the shape, so
  // "68,412.10" collapses to "68412.10" instead of failing closed.
  // Anything comma-bearing left over after this is either a decimal
  // comma (next rule) or malformed (fails closed below).
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s) || /^\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');
  } else {
    // Continental decimal comma: 1-2 tail digits, never mid-number
    // (the guards plus the collapse above mean "1,234" can never
    // arrive here as "1,23" + "4"), and never just before a decimal
    // fraction (a partial span like "79,52" of "79,525.75").
    s = s.replace(/(?<![\d.,])(\d{1,3}),(\d{1,2})(?!\d)(?!\.\d)/g, '$1.$2');
  }
  s = s.trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  return (negative ? '-' : '') + s;
}

/**
 * Parses a matched numeric fragment to a number across US and strict
 * continental syntax, or null when it cannot be read confidently.
 * Replaces bare comma-stripping `parseFloat` at every value-computing
 * site so magnitudes agree with the (possibly EU-complete) display
 * span the fragment was matched from.
 */
export function parseLocalizedNumberFragment(fragment: string): number | null {
  const canonical = canonicalizeNumericFragment(fragment);
  if (canonical === null) return null;
  const parsed = parseFloat(canonical);
  return Number.isNaN(parsed) ? null : parsed;
}


function detectCurrency(text: string): SemanticValue | null {
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prefixMatch = text.match(
        new RegExp(`(?:^|[^\\w$])([-+]?\\s*${escaped}\\s*[-+]?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
      );
      if (prefixMatch) {
        const normalized = parseScaledNumber(prefixMatch[1].replace(symbol, ' '));
        if (normalized !== null) {
          const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
          return { type, normalized, unit: code, raw: text };
        }
      }
      const suffixMatch = text.match(
        new RegExp(`(?:^|[^\\w$])([-+]?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?\\s*${escaped})(?=[^\\w$]|$)`, 'i'),
      );
      if (suffixMatch) {
        const normalized = parseScaledNumber(suffixMatch[1].replace(symbol, ' '));
        if (normalized !== null) {
          const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
          return { type, normalized, unit: code, raw: text };
        }
      }
      const withoutSymbol = text.replace(symbol, ' ');
      const normalized = parseScaledNumber(withoutSymbol);
      if (normalized === null) continue;
      const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
      return { type, normalized, unit: code, raw: text };
    }
  }

  // Bare ISO code form: "49.99 USD" or "USD 49.99".
  const codeMatch = text.match(/\b([A-Z]{3})\b/);
  if (codeMatch && CURRENCY_CODES.has(codeMatch[1])) {
    const code = codeMatch[1];
    const prefixMatch = text.match(
      new RegExp(`\\b(${code}\\s*[-+]?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
    );
    if (prefixMatch) {
      const normalized = parseScaledNumber(prefixMatch[1].replace(code, ' '));
      if (normalized !== null) {
        const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
        return { type, normalized, unit: code, raw: text };
      }
    }
    const suffixMatch = text.match(
      new RegExp(`\\b([-+]?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?\\s*${code})\\b`, 'i'),
    );
    if (suffixMatch) {
      const normalized = parseScaledNumber(suffixMatch[1].replace(code, ' '));
      if (normalized !== null) {
        const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
        return { type, normalized, unit: code, raw: text };
      }
    }
    const normalized = parseScaledNumber(text.replace(codeMatch[1], ' '));
    if (normalized !== null) {
      const type = REVENUE_KEYWORDS.test(text) ? 'revenue' : 'currency';
      return { type, normalized, unit: codeMatch[1], raw: text };
    }
  }

  return null;
}

function detectPercentage(text: string): SemanticValue | null {
  const match = text.match(new RegExp(`(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?))\\s*%`));
  if (!match) return null;
  // Routed through the localized parser so continental decimal commas
  // ("54,55%") read correctly instead of truncating at the comma.
  const normalized = parseLocalizedNumberFragment(match[1]);
  if (normalized === null) return null;
  return { type: 'percentage', normalized, unit: '%', raw: text };
}

function detectStars(text: string): SemanticValue | null {
  // "4.8/5", "4.8 out of 5", "4.8 stars", "4.8 ★" (and continental "4,8/5").
  const scaledMatch = text.match(new RegExp(`((?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?))\\s*(?:\\/\\s*(\\d+)|out of\\s*(\\d+)|★|stars?)\\b`, 'i'));
  if (scaledMatch) {
    const scale = scaledMatch[2] ?? scaledMatch[3] ?? '5';
    const normalized = parseLocalizedNumberFragment(scaledMatch[1]);
    if (normalized === null) return null;
    return {
      type: 'stars',
      normalized,
      unit: `/${scale}`,
      raw: text,
    };
  }

  // Literal glyph rating: "★★★★☆" or "★★★★★"
  if (/^[★☆\s]+$/.test(text) && /★/.test(text)) {
    const filled = (text.match(/★/g) ?? []).length;
    const total = filled + (text.match(/☆/g) ?? []).length;
    return { type: 'stars', normalized: filled, unit: `/${total}`, raw: text };
  }

  return null;
}

const STORAGE_UNITS: Record<string, { bytes: number; label: string }> = {
  b: { bytes: 1, label: 'B' },
  byte: { bytes: 1, label: 'B' },
  bytes: { bytes: 1, label: 'B' },
  kb: { bytes: 1024, label: 'KB' },
  kib: { bytes: 1024, label: 'KB' },
  mb: { bytes: 1024 ** 2, label: 'MB' },
  mib: { bytes: 1024 ** 2, label: 'MB' },
  gb: { bytes: 1024 ** 3, label: 'GB' },
  gib: { bytes: 1024 ** 3, label: 'GB' },
  tb: { bytes: 1024 ** 4, label: 'TB' },
  tib: { bytes: 1024 ** 4, label: 'TB' },
  pb: { bytes: 1024 ** 5, label: 'PB' },
  pib: { bytes: 1024 ** 5, label: 'PB' },
};

function detectStorage(text: string): SemanticValue | null {
  const match = text.match(
    new RegExp(`(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?))\\s*(pib|tib|gib|mib|kib|pb|tb|gb|mb|kb|bytes?|b)\\b`, 'i'),
  );
  if (!match) return null;
  const unit = STORAGE_UNITS[match[2].toLowerCase()];
  if (!unit) return null;
  const amount = parseLocalizedNumberFragment(match[1]);
  if (amount === null) return null;
  return { type: 'storage', normalized: amount * unit.bytes, unit: unit.label, raw: text };
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  d: 86_400,
  day: 86_400,
  days: 86_400,
  h: 3_600,
  hr: 3_600,
  hrs: 3_600,
  hour: 3_600,
  hours: 3_600,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
};

/** Unit words unambiguous enough to be trusted alone (not just a bare `h`/`m`/`s` letter). */
const WORD_DURATION_UNIT = /^(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)$/i;

function detectDuration(text: string): SemanticValue | null {
  const trimmed = text.trim();

  // "1:23:45" or "23:45"
  const colonMatch = trimmed.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) {
    const [, h, m, s] = colonMatch;
    const seconds = s !== undefined ? Number(h) * 3600 + Number(m) * 60 + Number(s) : Number(h) * 60 + Number(m);
    return { type: 'duration', normalized: seconds, unit: 's', raw: text };
  }

  const unitRegex = new RegExp(
    `((?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?))\\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\\b`,
    'gi',
  );
  const matches = [...trimmed.matchAll(unitRegex)];
  if (matches.length === 0) return null;
  if (matches.length === 0) return null;

  // A single match is only trusted as a duration when its unit is a
  // real word ("45 minutes") rather than a bare letter ("45m"), since a
  // bare letter is equally plausible as a K/M/B/T count scale suffix.
  if (matches.length === 1 && !WORD_DURATION_UNIT.test(matches[0][2])) {
    return null;
  }

  let totalSeconds = 0;
  for (const m of matches) {
    const amount = parseLocalizedNumberFragment(m[1]);
    if (amount === null) continue;
    const unitSeconds = DURATION_UNIT_SECONDS[m[2].toLowerCase()];
    if (unitSeconds === undefined) continue;
    totalSeconds += amount * unitSeconds;
  }
  return { type: 'duration', normalized: totalSeconds, unit: 's', raw: text };
}

const FOLLOWER_KEYWORDS = /\b(followers?|subscribers?|subs|fans|friends|connections)\b/i;
const VIEW_KEYWORDS = /\b(views?|watch(?:es|ed)?|plays?|impressions?|reads?|downloads?)\b/i;

function detectKeywordCount(
  text: string,
  keywords: RegExp,
  type: SemanticValueType,
): SemanticValue | null {
  if (!keywords.test(text)) return null;
  const beforeMatch = text.match(
    new RegExp(`(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\s*(?:${keywords.source})\\b`, 'i'),
  );
  if (beforeMatch) {
    const normalized = parseScaledNumber(beforeMatch[1]);
    if (normalized !== null) {
      return { type, normalized, unit: null, raw: text };
    }
  }
  const afterMatch = text.match(
    new RegExp(`(?:${keywords.source})[:\\s]+(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
  );
  if (afterMatch) {
    const normalized = parseScaledNumber(afterMatch[afterMatch.length - 1]);
    if (normalized !== null) {
      return { type, normalized, unit: null, raw: text };
    }
  }
  const normalized = parseScaledNumber(text);
  if (normalized === null) return null;
  return { type, normalized, unit: null, raw: text };
}

export function extractNumericToken(text: string, semantic?: SemanticValue): string {
  const sem = semantic ?? detectSemanticValue(text);
  if (sem.type === 'text' || sem.normalized === null) {
    return text;
  }

  if (sem.type === 'currency' || sem.type === 'revenue') {
    for (const [symbol] of CURRENCY_SYMBOLS) {
      if (text.includes(symbol)) {
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixMatch = text.match(
          new RegExp(`(?:^|[^\\w$])([-+]?\\s*${escaped}\\s*[-+]?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
        );
        if (prefixMatch) return prefixMatch[1].trim();
        const suffixMatch = text.match(
          new RegExp(`(?:^|[^\\w$])([-+]?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?\\s*${escaped})(?=[^\\w$]|$)`, 'i'),
        );
        if (suffixMatch) return suffixMatch[1].trim();
      }
    }
    const codeMatch = text.match(/\b([A-Z]{3})\b/);
    if (codeMatch && CURRENCY_CODES.has(codeMatch[1])) {
      const code = codeMatch[1];
      const prefixMatch = text.match(
        new RegExp(`\\b(${code}\\s*[-+]?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
      );
      if (prefixMatch) return prefixMatch[1].trim();
      const suffixMatch = text.match(
        new RegExp(`\\b([-+]?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?\\s*${code})\\b`, 'i'),
      );
      if (suffixMatch) return suffixMatch[1].trim();
    }
  }

  if (sem.type === 'followers' || sem.type === 'views') {
    const keywords = sem.type === 'followers' ? FOLLOWER_KEYWORDS : VIEW_KEYWORDS;
    const beforeMatch = text.match(
      new RegExp(`(-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\s*(?:${keywords.source})\\b`, 'i'),
    );
    if (beforeMatch) return beforeMatch[1].trim();
    const afterMatch = text.match(
      new RegExp(`(?:${keywords.source})[:\\s]+(-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*${SCALE_SUFFIX_SOURCE}?)\\b`, 'i'),
    );
    if (afterMatch) return afterMatch[afterMatch.length - 1].trim();
  }

  if (sem.type === 'percentage') {
    const match = text.match(new RegExp(`([+-]?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*%)`));
    if (match) return match[1].trim();
  }

  if (sem.type === 'storage') {
    const match = text.match(
      new RegExp(`(-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*(?:pib|tib|gib|mib|kib|pb|tb|gb|mb|kb|bytes?|b))\\b`, 'i'),
    );
    if (match) return match[1].trim();
  }

  if (sem.type === 'duration') {
    const colonMatch = text.match(/\b(\d+:\d{2}(?::\d{2})?)\b/);
    if (colonMatch) return colonMatch[1];
    const unitMatch = text.match(
      new RegExp(`((?:${EU_NUM_TOKEN}|\\d+(?:\\.\\d+)?)\\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\\s*(?:${EU_NUM_TOKEN}|\\d+(?:\\.\\d+)?)\\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s))*)\\b`, 'i'),
    );
    if (unitMatch) return unitMatch[1].trim();
  }

  if (sem.type === 'stars') {
    const scaledMatch = text.match(new RegExp(`((?:${EU_NUM_TOKEN}|\\d+(?:\\.\\d+)?)\\s*(?:\\/\\s*\\d+|out of\\s*\\d+|★|stars?))\\b`, 'i'));
    if (scaledMatch) return scaledMatch[1].trim();
    const glyphMatch = text.match(/[★☆]+/);
    if (glyphMatch) return glyphMatch[0].trim();
  }

  const leadingMatch = text.match(new RegExp(`^(-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?))\\s*(?:thousands?|millions?|billions?|trillions?|k|mm|m|bn|b|t)?`, 'i'));
  if (leadingMatch) return leadingMatch[0].trimEnd();

  const anyNumericMatch = text.match(new RegExp(`\\b(-?(?:${EU_NUM_FREE}|[\\d,]+(?:\\.\\d+)?)\\s*(?:thousands?|millions?|billions?|trillions?|k|mm|m|bn|b|t)?)\\b`, 'i'));
  if (anyNumericMatch) return anyNumericMatch[1].trim();

  return text;
}

/** Bare "1.2K", "45,231", "3.4M" — and bare English word forms ("22 thousand",
 * "1.2 million") — with no keyword context: a generic large count. Word
 * forms matter because anchor-framing can slice the keyword off a labeled
 * value ("22 thousand subscribers" → "22 thousand"); without this, that
 * slice classifies as text and numeric monitors fail it as empty instead
 * of reading the magnitude that is plainly there. */
function detectScaledCount(text: string): SemanticValue | null {
  const trimmed = text.trim();
  const unparenthesized = trimmed.replace(/^\((.*)\)$/, '$1').trim();
  if (!new RegExp(`^-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)\\s*(k|mm|m|bn|b|t|thousands?|millions?|billions?|trillions?)$`, 'i').test(unparenthesized)) return null;
  const normalized = parseScaledNumber(unparenthesized);
  if (normalized === null) return null;
  return { type: 'count', normalized, unit: null, raw: text };
}

/** A plain number, optionally comma-grouped: "12,345", "42", "3.14". */
function detectPlainNumber(text: string): SemanticValue | null {
  const trimmed = text.trim();
  const unparenthesized = trimmed.replace(/^\((.*)\)$/, '$1').trim();
  if (!new RegExp(`^-?(?:${EU_NUM_TOKEN}|[\\d,]+(?:\\.\\d+)?)$`).test(unparenthesized)) return null;
  const normalized = parseLocalizedNumberFragment(unparenthesized);
  if (normalized === null) return null;
  return { type: 'number', normalized, unit: null, raw: text };
}

const STORAGE_DISPLAY_UNITS: [string, number][] = [
  ['TB', 1024 ** 4],
  ['GB', 1024 ** 3],
  ['MB', 1024 ** 2],
  ['KB', 1024],
  ['B', 1],
];

export function formatStorageBytes(bytes: number): string {
  for (const [label, factor] of STORAGE_DISPLAY_UNITS) {
    if (bytes >= factor) return `${(bytes / factor).toFixed(bytes / factor >= 10 ? 0 : 1)} ${label}`;
  }
  return `${bytes} B`;
}

export function formatDurationSeconds(totalSeconds: number): string {
  if (totalSeconds >= 3600) return `${(totalSeconds / 3600).toFixed(1)}h`;
  if (totalSeconds >= 60) return `${(totalSeconds / 60).toFixed(1)}m`;
  return `${totalSeconds.toFixed(0)}s`;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Number.isInteger(n) ? `${n}` : n.toFixed(2);
}

/**
 * Renders a signed delta between two normalized values of the same
 * semantic type using a unit-appropriate format (bytes for storage,
 * h/m/s for duration, K/M/B compaction for large counts, ...).
 */
export function formatSemanticDelta(
  type: SemanticValueType,
  unit: string | null,
  delta: number,
): string {
  const magnitude = Math.abs(delta);
  const sign = delta >= 0 ? '+' : '-';
  switch (type) {
    case 'currency':
    case 'revenue':
      return `${sign}${unit ? `${unit} ` : ''}${magnitude.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    case 'percentage':
      return `${sign}${magnitude.toFixed(1)}%`;
    case 'storage':
      return `${sign}${formatStorageBytes(magnitude)}`;
    case 'duration':
      return `${sign}${formatDurationSeconds(magnitude)}`;
    case 'stars':
      return `${sign}${magnitude.toFixed(1)}${unit ?? ''}`;
    default:
      return `${sign}${formatCompactNumber(magnitude)}`;
  }
}

/**
 * Renders a normalized value (not a delta) using the same
 * unit-appropriate, compact formatting as `formatSemanticDelta` -
 * currency/revenue get their unit prefixed, storage/duration get
 * human units, large counts compact to K/M/B/T. Used anywhere a raw
 * normalized number needs to read the way the rest of the UI already
 * formats that semantic type (e.g. chart tooltips).
 */
export function formatSemanticValue(
  type: SemanticValueType,
  unit: string | null,
  value: number,
): string {
  switch (type) {
    case 'currency':
    case 'revenue':
      return `${unit ? `${unit} ` : ''}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    case 'percentage':
      return `${value.toFixed(1)}%`;
    case 'storage':
      return formatStorageBytes(value);
    case 'duration':
      return formatDurationSeconds(value);
    case 'stars':
      return `${value.toFixed(1)}${unit ?? ''}`;
    default:
      return formatCompactNumber(value);
  }
}

/**
 * Classifies an extracted string and derives a normalized comparable
 * number where possible. Checked roughly most-specific-first so a
 * string that could match more than one pattern (e.g. "$45M" matching
 * both a currency symbol and a bare scale suffix) resolves to the more
 * informative type.
 */
export function detectSemanticValue(raw: string): SemanticValue {
  const text = raw.trim();
  if (text.length === 0) return textValue(raw);

  return (
    detectCurrency(text) ??
    detectPercentage(text) ??
    detectStars(text) ??
    detectKeywordCount(text, FOLLOWER_KEYWORDS, 'followers') ??
    detectKeywordCount(text, VIEW_KEYWORDS, 'views') ??
    detectStorage(text) ??
    detectDuration(text) ??
    detectScaledCount(text) ??
    detectPlainNumber(text) ??
    textValue(raw)
  );
}

/** Human-readable label for a semantic type, for badges and tooltips. */
export function describeSemanticType(type: SemanticValueType): string {
  return SEMANTIC_TYPE_LABELS[type];
}

/**
 * Semantic kinds that all describe "a scaled count of things": a bare
 * magnitude (`count`: "21k", "1.2M") and the same magnitude with a
 * thing-label (`followers`: "12.4K followers", "22 thousand
 * subscribers"; `views`: "222K views"). The label — not the kind —
 * tells subscribers apart from views, and labels already score
 * separately during recovery.
 *
 * A bare token and its labeled rendering are interchangeable across
 * renders of the *same* metric: pickers canonicalize ("22 thousand
 * subscribers" is picked as "21k"-shaped "22k"), while checks read
 * whatever the page currently renders (an `aria-label` word form, a
 * suffix form). Requiring exact equality here turns that ordinary
 * re-render into a permanent wrong-kind rejection of the correct
 * element. Every other kind still requires an exact match — in
 * particular `percentage` (change-indicator deltas), `currency`,
 * `duration`, `storage`, and `stars` are unaffected, as is the
 * sign-shape check built on top of a kind match.
 */
const COUNT_FAMILY: ReadonlySet<SemanticValueType> = new Set(['count', 'followers', 'views']);

export function isCompatibleSemanticKind(a: SemanticValueType, b: SemanticValueType): boolean {
  if (a === b) return true;
  return COUNT_FAMILY.has(a) && COUNT_FAMILY.has(b);
}

/**
 * Compares two semantic values of the same kind and returns the signed
 * delta, or `null` if they aren't comparable (different/unparsed
 * types). Used to show trend direction without re-parsing text.
 */
export function compareSemanticValues(
  previous: SemanticValue | null,
  current: SemanticValue | null,
): number | null {
  if (!previous || !current) return null;
  if (previous.type !== current.type) return null;
  if (previous.normalized === null || current.normalized === null) return null;
  return current.normalized - previous.normalized;
}
