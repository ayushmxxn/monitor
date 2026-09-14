import { locateElementWithRanking, rankRecoveryCandidates, buildFingerprint, buildReanchorFingerprint, normalizeText, isEffectivelyEmpty, isVisuallyHidden, extractVisibleText, type ElementFingerprint, type TextAnchor } from './fingerprint';
import { detectAntiAutomation, detectAuthWall } from './antiAutomation';
import { diagnostic, STALE_IDENTITY_CODES, type Diagnostic, type DiagnosticCode } from './diagnostics';
import { withExponentialBackoff, sleep, type ReadinessResult } from './readiness';
import { detectSemanticValue, extractNumericToken, isCompatibleSemanticKind, CURRENCY_SYMBOLS, CURRENCY_CODES, type SemanticValue, type SemanticValueType } from './semanticValue';

export interface LocateAndExtractResult {
  value: string | null;
  diagnostic: Diagnostic;
  /** Present when the element moved and was recovered — the caller should persist this to self-heal the monitor. */
  updatedFingerprint: ElementFingerprint | null;
  confidence: number;
  method: string;
  /**
   * Best-effort classification of `value` (currency, percentage,
   * followers, storage, duration, etc.) plus a normalized comparable
   * number, derived by `detectSemanticValue`. `null` whenever `value`
   * is `null`. Display should always use `value` — this is metadata,
   * not a replacement for the original formatted text.
   */
  semanticValue: SemanticValue | null;
}

const HIGH_CONFIDENCE = 80;
const ACCEPT_THRESHOLD = 55;

/**
 * The single source of truth for "given a fingerprint and a document,
 * what's the current value?" Used by both the live-tab content script
 * (which has a real `Window` for fingerprint capture on relocation) and
 * the offscreen document parsing fetched HTML (which only has a
 * `Document`, so relocation fingerprints there omit viewport-relative
 * signals — `buildFingerprint` degrades gracefully without a `Window`).
 */
export function locateAndExtract(
  doc: Document,
  fp: ElementFingerprint,
  extractMode: 'text' | 'attribute',
  attributeName: string | null,
  win?: Window,
): LocateAndExtractResult {
  // Single scan: one gather+score pass yields both the locate verdict
  // and the ranked fallback list, so a recovery read never pays for
  // the same scan twice (Check Now stays fast; no timeout is raised).
  // The monitored attribute (attribute mode only) is threaded into the
  // scan so the empty-candidate guard judges emptiness on the value
  // source actually being read, not just rendered text.
  const scanAttributeName = extractMode === 'attribute' ? attributeName : null;
  const { locate: result, ranked } = locateElementWithRanking(fp, doc, {
    acceptThreshold: ACCEPT_THRESHOLD,
    attributeName: scanAttributeName,
  });

  if (!result.element) {
    const antiAutomation = detectAntiAutomation(doc);
    if (antiAutomation.detected) {
      return {
        value: null,
        diagnostic: diagnostic('ANTI_AUTOMATION_DETECTED', antiAutomation.reason ?? undefined),
        updatedFingerprint: null,
        confidence: 0,
        method: result.method,
        semanticValue: null,
      };
    }

    if (detectAuthWall(doc, false)) {
      return {
        value: null,
        diagnostic: diagnostic('AUTH_REQUIRED'),
        updatedFingerprint: null,
        confidence: 0,
        method: result.method,
        semanticValue: null,
      };
    }

    if (result.score > 0 && result.score < ACCEPT_THRESHOLD) {
      return {
        value: null,
        diagnostic: diagnostic(
          'SELECTOR_RECOVERY_LOW_CONFIDENCE',
          `best candidate scored ${result.score}/100 across ${result.candidatesConsidered} elements considered; needs ${ACCEPT_THRESHOLD}`,
        ),
        updatedFingerprint: null,
        confidence: result.score,
        method: result.method,
        semanticValue: null,
      };
    }

    return {
      value: null,
      diagnostic: diagnostic(
        'ELEMENT_NOT_FOUND',
        `scanned ${result.candidatesConsidered} candidate element(s), none matched`,
      ),
      updatedFingerprint: null,
      confidence: 0,
      method: result.method,
      semanticValue: null,
    };
  }

  const wasExactMatch = result.method.startsWith('fast-path');
  // Recovery-scan fallback: the single best structural match may hold
  // no value yet (a loading skeleton) while a slightly lower-ranked
  // candidate already holds the real one. Try ranked candidates in
  // order — all scored by the same combined bundle (semantic type,
  // nearby labels/context, stable attributes, anchor text, structure)
  // — and take the first that yields a non-empty, kind-consistent
  // value. (An exact match that itself comes back empty takes the same
  // fallback via `attemptFastPathFallback` below rather than locking
  // onto its one slot.)
  if (!wasExactMatch) {
    const list = ranked.length > 0
      ? ranked
      : [{ element: result.element, score: result.score, signals: result.signals }];
    let sawEmpty = false;
    let mismatchDetail: string | null = null;
    for (const cand of list) {
      const attempt = attemptExtraction(cand.element, cand.score, result.method, fp, extractMode, attributeName, win, false);
      if (attempt.value !== null) return attempt;
      if (attempt.diagnostic.code === 'EXTRACTION_EMPTY') sawEmpty = true;
      if (attempt.diagnostic.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE' && attempt.diagnostic.detail) {
        mismatchDetail = attempt.diagnostic.detail;
      }
    }
    if (sawEmpty) {
      return {
        value: null,
        diagnostic: diagnostic('EXTRACTION_EMPTY'),
        updatedFingerprint: null,
        confidence: result.score,
        method: result.method,
        semanticValue: null,
      };
    }
    return {
      value: null,
      diagnostic: diagnostic(
        'SELECTOR_RECOVERY_LOW_CONFIDENCE',
        mismatchDetail ?? `best candidate scored ${result.score}/100 across ${result.candidatesConsidered} elements considered; needs ${ACCEPT_THRESHOLD}`,
      ),
      updatedFingerprint: null,
      confidence: result.score,
      method: result.method,
      semanticValue: null,
    };
  }

  const exact = attemptExtraction(result.element, result.score, result.method, fp, extractMode, attributeName, win, true);
  if (exact.value !== null) return exact;
  // The exact slot resolved but holds no usable value. Historically
  // this locked the check onto that one slot (`EXTRACTION_EMPTY` from
  // the pin-pointed element, retry only via the outer settle loop) —
  // which strands virtualized/recycled pages where the selector still
  // resolves yet the value has moved on. Fall back to the same bounded
  // ranked recovery instead; on total failure the honest exact
  // diagnostic is preserved (never healed, last value kept).
  const recovered = attemptFastPathFallback(doc, fp, result.element, extractMode, attributeName, win);
  return recovered ?? exact;
}

/**
 * True when the stored fingerprint's value memory already agrees with
 * `lastValue` — snapshot and anchor value both match — so a re-anchor
 * attempt would score identically to the primary one just run. Skips
 * the redundant second scan; the primary verdict stands.
 */
function isValueConsistent(fp: ElementFingerprint, lastValue: string): boolean {
  if (fp.textSnapshot !== lastValue) return false;
  const anchorValue = fp.textAnchor?.value ?? null;
  if (anchorValue !== null && anchorValue !== lastValue) return false;
  return true;
}

/**
 * Value-anchored re-location for existing monitors whose stored
 * fingerprint has gone stale or was corrupted (e.g. healed onto a
 * neighboring element before the kind gates existed): runs the
 * standard `locateAndExtract` pipeline first, untouched, and only when
 * that fails on identity grounds (not found / low confidence / empty —
 * never auth, anti-automation, or other page-state failures) retries
 * once with a re-anchor fingerprint rebuilt from the monitor's last
 * known good value (see `buildReanchorFingerprint`).
 *
 * Correctness properties, all enforced by construction rather than
 * convention:
 * - Healthy and new monitors are unaffected: a primary success
 *   returns immediately (the derived code never runs), and a `null`
 *   `lastValue` (never successfully checked) skips the attempt.
 * - The retry uses the identical pipeline — same acceptance
 *   threshold, same kind/sign/frame-echo gates, same ambiguity rule —
 *   so it can only succeed where the standard strictness is met.
 * - A retry success heals forward (the fresh fingerprint, falling
 *   back to the corrected value memory itself when the read landed on
 *   an unchanged exact slot that yields no structural heal), so the
 *   monitor converges instead of re-anchoring forever.
 * - Any retry failure returns the *primary* failure untouched, with no
 *   heal and no semantic value — the caller preserves the last known
 *   value exactly as before.
 * - Bounded: at most two locate passes per read, both over the
 *   already-loaded document. No waiting, no timeout changes.
 */
export function locateAndExtractWithReanchor(
  doc: Document,
  fp: ElementFingerprint,
  extractMode: 'text' | 'attribute',
  attributeName: string | null,
  win: Window | undefined,
  reanchorLastValue: string | null | undefined,
): LocateAndExtractResult {
  const primary = locateAndExtract(doc, fp, extractMode, attributeName, win);
  if (primary.value !== null) return primary;
  if (!STALE_IDENTITY_CODES.has(primary.diagnostic.code as DiagnosticCode)) return primary;
  if (!reanchorLastValue || isEffectivelyEmpty(reanchorLastValue) || isPlaceholderValue(reanchorLastValue)) {
    return primary;
  }
  if (isValueConsistent(fp, reanchorLastValue)) return primary;
  const derived = buildReanchorFingerprint(fp, reanchorLastValue);
  if (!derived) return primary;
  const attempt = locateAndExtract(doc, derived, extractMode, attributeName, win);
  if (attempt.value === null) return primary;
  const baseDetail =
    attempt.diagnostic.detail ?? `relocated with ${attempt.confidence}/100 confidence via ${attempt.method}`;
  return {
    value: attempt.value,
    diagnostic: diagnostic(
      'OK_RECOVERED',
      `${baseDetail}; re-anchored from the last known value after the stored fingerprint stopped matching`,
    ),
    // A re-anchor that lands on an unchanged exact slot yields no
    // structural heal of its own; persisting the corrected value
    // memory itself still strictly dominates the corrupt stored
    // fingerprint (same structure, honest value memory), so the next
    // check starts from truth instead of re-anchoring forever.
    updatedFingerprint: attempt.updatedFingerprint ?? derived,
    confidence: attempt.confidence,
    method: attempt.method,
    semanticValue: attempt.semanticValue,
  };
}

function attemptFastPathFallback(
  doc: Document,
  fp: ElementFingerprint,
  exactElement: Element,
  extractMode: 'text' | 'attribute',
  attributeName: string | null,
  win: Window | undefined,
): LocateAndExtractResult | null {
  // The exact selector resolved and scored well, but the slot holds no
  // usable value (empty skeleton, or a frame-echo rejection): rather
  // than locking onto that one slot, run the same bounded ranked
  // recovery used for the recovery path — identical combined signal
  // bundle, identical kind/sign gates (attempts run as non-exact, so
  // they are strictly *more* demanding than the exact read that just
  // failed). One extra scan, only on this failure path: the happy path
  // still costs a single scan, so Check Now stays fast.
  const fallback = rankRecoveryCandidates(fp, doc, {
    acceptThreshold: ACCEPT_THRESHOLD,
    attributeName: extractMode === 'attribute' ? attributeName : null,
  });
  for (const cand of fallback.ranked) {
    if (cand.element === exactElement) continue; // already read above
    // Labeled as a recovery-scan read (not the fast path that just
    // failed), so the diagnostic honestly reports how the value was
    // actually found.
    const attempt = attemptExtraction(cand.element, cand.score, 'recovery-scan', fp, extractMode, attributeName, win, false);
    if (attempt.value !== null) return attempt;
  }
  return null;
}

function attemptExtraction(
  element: Element,
  score: number,
  method: string,
  fp: ElementFingerprint,
  extractMode: 'text' | 'attribute',
  attributeName: string | null,
  win: Window | undefined,
  wasExactMatch: boolean,
): LocateAndExtractResult {
  const extracted = extractValue(element, extractMode, attributeName, fp);

  const initialSemantic = extracted !== null ? detectSemanticValue(extracted) : null;
  const anchorSemantic = fp.textAnchor?.value ? detectSemanticValue(fp.textAnchor.value) : null;
  const isAnchorNumeric =
    anchorSemantic !== null && anchorSemantic.type !== 'text' && anchorSemantic.normalized !== null;
  const snapshotSemantic = fp.textSnapshot ? detectSemanticValue(fp.textSnapshot) : null;
  const isSnapshotNumeric =
    snapshotSemantic !== null && snapshotSemantic.type !== 'text' && snapshotSemantic.normalized !== null;
  const isPatternNumeric =
    fp.textPattern === 'numeric' || fp.textPattern === 'currency' || fp.textPattern === 'percentage';
  const isNumericMonitor =
    isAnchorNumeric ||
    isPatternNumeric ||
    isSnapshotNumeric ||
    (fp.textAnchor == null && initialSemantic !== null && initialSemantic.type !== 'text' && initialSemantic.normalized !== null);

  let isNumeric = false;
  let resolvedSemantic = isNumericMonitor
    ? initialSemantic
    : (extracted !== null ? { type: 'text' as SemanticValueType, normalized: null, unit: null, raw: extracted } : null);
  let value: string | null = null;

  if (extracted !== null) {
    // The anchored slice above already failed (a changed delta
    // invalidated the frame) and the element's whole text holds more
    // than one numeric token: the generic detector below would just
    // take whichever token comes first, which is very often the
    // change indicator ("Unique visitors 1002 +6.1%" -> "+6.1%")
    // rather than the metric the monitor was picked for. Prefer the
    // single token that matches the anchored value's own kind and
    // sign shape instead - but only when exactly one such token
    // exists, so a genuinely multi-metric element never gets
    // resolved by guessing between its own values. `null` whenever
    // the anchor is missing, non-numeric, or the text doesn't narrow
    // to one anchor-like token, leaving every existing path below
    // exactly as it was.
    const anchorPreferred =
      isNumericMonitor && extractMode === 'text'
        ? preferAnchorKindToken(extracted, fp.textAnchor?.value ?? null)
        : null;
    const preferredSemantic =
      anchorPreferred !== null ? detectSemanticValue(anchorPreferred) : null;
    const hasPreferred =
      anchorPreferred !== null &&
      preferredSemantic !== null &&
      preferredSemantic.type !== 'text' &&
      preferredSemantic.normalized !== null;
    if (!isNumericMonitor) {
      value = extracted;
    } else if (hasPreferred) {
      isNumeric = true;
      resolvedSemantic = preferredSemantic;
      value = anchorPreferred;
    } else if (initialSemantic !== null && initialSemantic.type !== 'text' && initialSemantic.normalized !== null) {
      isNumeric = true;
      resolvedSemantic = initialSemantic;
      value = extractNumericToken(extracted, resolvedSemantic);
    } else {
      const fallbackType: SemanticValueType = isAnchorNumeric
        ? anchorSemantic.type
        : (isSnapshotNumeric
          ? snapshotSemantic.type
          : (fp.textPattern === 'currency'
            ? 'currency'
            : fp.textPattern === 'percentage'
            ? 'percentage'
            : 'number'));

      const hintSemantic: SemanticValue = {
        type: fallbackType,
        normalized: isAnchorNumeric
          ? anchorSemantic.normalized
          : (isSnapshotNumeric ? snapshotSemantic.normalized : 1),
        unit: anchorSemantic?.unit ?? snapshotSemantic?.unit ?? null,
        raw: '',
      };

      const token = extractNumericToken(extracted, hintSemantic);
      if (token && token !== extracted) {
        const tokenSemantic = detectSemanticValue(token);
        if (tokenSemantic.type !== 'text' && tokenSemantic.normalized !== null) {
          const type =
            (fallbackType === 'followers' || fallbackType === 'views' || fallbackType === 'revenue') &&
            (tokenSemantic.type === 'count' || tokenSemantic.type === 'currency')
              ? fallbackType
              : tokenSemantic.type;
          resolvedSemantic = {
            ...tokenSemantic,
            type,
            unit: tokenSemantic.unit ?? (isAnchorNumeric ? anchorSemantic.unit : (isSnapshotNumeric ? snapshotSemantic.unit : null)),
          };
          isNumeric = true;
          value = token;
        }
      }
      // A numeric monitor with no valid numeric token reports failure
      // rather than falling back to the raw text (e.g. "Out of stock"):
      // storing that text as a successful value would silently flip the
      // monitor's type, poison lastSemanticValue, and suppress numeric
      // alert conditions while looking healthy. Text monitors are
      // unaffected - they keep the raw text path above.
    }
  }

  const updatedAnchor: TextAnchor | null = fp.textAnchor
    ? {
        value: value ?? fp.textAnchor.value,
        before: fp.textAnchor.before,
        after: fp.textAnchor.after,
      }
    : null;
  const valueChanged =
    value !== null &&
    (value !== fp.textSnapshot || (fp.textAnchor?.value !== undefined && value !== fp.textAnchor.value));
  const healedFingerprint =
    (!wasExactMatch && score >= ACCEPT_THRESHOLD) || (wasExactMatch && valueChanged)
      ? buildFingerprint(element, win, updatedAnchor)
      : null;

  if (extracted === null || (isNumericMonitor && value === null)) {
    // Never heal toward an empty read: the fingerprint must keep
    // pointing at the last known good slot so the next retry (and the
    // next check) re-resolves from proven identity signals instead of
    // locking onto a skeleton/placeholder. The caller preserves the
    // last known value; the outer settle loop retries the extraction
    // itself rather than waiting on page-wide quiet.
    return {
      value: null,
      diagnostic: diagnostic('EXTRACTION_EMPTY'),
      updatedFingerprint: null,
      confidence: score,
      method,
      semanticValue: null,
    };
  }

  // A monitor's value must keep the same KIND it was picked for:
  // recovery scores structure, not meaning, so without this a
  // structurally identical neighbor (a delta like "+5.2%" next to a
  // count like "20") can win and its value gets stored - and then
  // self-healed onto, permanently hijacking the monitor. Kinds compare
  // by magnitude family, not exact equality (see
  // `isCompatibleSemanticKind`): a bare "21k" (count) and its labeled
  // renderings ("22 thousand subscribers", "22K views") are the same
  // kind of value in different clothes — pickers canonicalize one way,
  // live pages render the other — while percentages, currency,
  // durations, and every other kind still require an exact match. A
  // slot that used to hold a count but now holds a percentage is the
  // page showing a neighboring change indicator, not the watched value
  // restyled. Genuine in-place restyles keep a compatible kind
  // ("$49.99" -> "$44.99", "147" -> "150") and are unaffected, as are
  // text monitors (no kind to agree with). Rejection preserves the last
  // value and retries instead of storing the wrong one - and crucially
  // never heals toward the mismatched element.
  const anchorKind =
    anchorSemantic !== null &&
    anchorSemantic.type !== 'text' &&
    anchorSemantic.normalized !== null
      ? anchorSemantic.type
      : null;
  const resolvedKind =
    resolvedSemantic !== null &&
    resolvedSemantic.type !== 'text' &&
    resolvedSemantic.normalized !== null
      ? resolvedSemantic.type
      : null;
  const kindMismatch =
    value !== null &&
    anchorKind !== null &&
    resolvedKind !== null &&
    !isCompatibleSemanticKind(anchorKind, resolvedKind);
  // Same kind but a different sign shape: the slot now shows an
  // explicitly signed value where the picked one was unsigned, or vice
  // versa ("87%" -> "+5.2%"). On dashboards that shape is the change
  // indicator next to the metric, not the metric itself - far more
  // likely a neighboring delta than the watched value with a genuinely
  // flipped sign, whether the slot was recovered or resolved exactly.
  // The one exception is a candidate that still carries the anchor's
  // full frame (every non-empty before/after part present): same slot,
  // same context, so a flipped sign there reads as a genuine update,
  // not a switch to a nearby value.
  const anchorSigned = hasExplicitSign(fp.textAnchor?.value ?? '');
  const resolvedSigned = value !== null ? hasExplicitSign(value) : false;
  const signMismatch =
    value !== null &&
    anchorKind !== null &&
    resolvedKind !== null &&
    isCompatibleSemanticKind(anchorKind, resolvedKind) &&
    anchorSigned !== resolvedSigned &&
    !hasFullFrameEvidence(fp.textAnchor, normalizeText(element.textContent ?? ''));
  // A reading that merely echoes the anchor's own frame (its before or
  // after context) without containing the anchored value is surrounding
  // context masquerading as the value - e.g. a slot now holding the old
  // label or delta. Like kindMismatch above, positional certainty says
  // *where*, but frame-echo says the slot no longer holds the metric,
  // and storing context as a reading is never right.
  const frameEcho = value !== null && isFrameEcho(fp.textAnchor, value);
  if (kindMismatch || signMismatch || frameEcho) {
    const detail = kindMismatch
      ? `relocated value is ${resolvedKind}, expected ${anchorKind} like "${fp.textAnchor?.value ?? ''}"`
      : signMismatch
        ? `relocated value "${value}" has a different sign shape than expected like "${fp.textAnchor?.value ?? ''}" (a nearby change indicator, not the watched value)`
        : `extracted text repeats the anchor frame instead of its value ("${value}")`;
    return {
      value: null,
      diagnostic: diagnostic('SELECTOR_RECOVERY_LOW_CONFIDENCE', detail),
      updatedFingerprint: null,
      confidence: score,
      method,
      semanticValue: null,
    };
  }

  const code = wasExactMatch ? 'OK' : 'OK_RECOVERED';
  const detail = wasExactMatch
    ? undefined
    : `relocated with ${score}/100 confidence via ${method}${
        score >= HIGH_CONFIDENCE ? '' : ' (below high-confidence threshold, worth reviewing)'
      }`;

  return {
    value,
    diagnostic: diagnostic(code, detail),
    updatedFingerprint: healedFingerprint,
    confidence: score,
    method,
    semanticValue: resolvedSemantic,
  };
}

function extractValue(
  element: Element,
  extractMode: 'text' | 'attribute',
  attributeName: string | null,
  fp: ElementFingerprint,
): string | null {
  if (extractMode === 'attribute') {
    if (!attributeName) return null;
    const attr = element.getAttribute(attributeName);
    if (attr === null) return null;
    const trimmed = attr.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const anchored = extractAnchoredText(element, fp.textAnchor);
  if (anchored) return anchored;
  // The frame is intact (whatever of it exists is still there) yet
  // nothing inside it resolved: the landmarks are watching a different
  // arrangement, so guessing the whole element text here (and, for
  // numeric monitors, a token out of it) would manufacture a
  // plausible-but-wrong value. Report empty and let the check-level
  // fallback and retry handling deal with it. A partially or fully
  // missing frame instead means a reshaped element, where the whole
  // visible text remains the best available reading.
  const anchor = fp.textAnchor;
  if (anchor && (anchor.before || anchor.after)) {
    const full = normalizeText(element.textContent ?? '');
    const beforeOk = !anchor.before || full.includes(anchor.before);
    const afterOk = !anchor.after || full.includes(anchor.after);
    if (beforeOk && afterOk) return null;
  }
  const text = extractVisibleText(element);
  return text.length > 0 ? text : null;
}

/**
 * True when `text` carries an explicit leading `+`/`-` sign. On
 * analytics dashboards that shape is almost always a change
 * indicator annotating a nearby metric ("+5.2%", "-4.5%"), not the
 * metric itself - the same distinction the picker's signed-delta
 * demotion (see `pickerTarget.ts`) draws at capture time.
 */
function hasExplicitSign(text: string): boolean {
  return /^[+-]/.test(text.trim());
}

/**
 * Whether the numeric token starting at `start` in `full` is signed,
 * looking one non-space character past the token's own start. Needed
 * because the plain-number pattern below (like the picker's) captures
 * only the digits ("+12" tokenizes as "12"): the sign lives in the
 * surrounding text, not the token. A `-` preceded by a digit or a
 * closing paren is subtraction/a range ("100-5"), not a sign, so it
 * doesn't count; a `+` is never an operator in this position and
 * always counts.
 */
function hasSignByLookback(full: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(full[i])) i -= 1;
  if (i < 0) return false;
  const c = full[i];
  if (c === '+') return true;
  if (c !== '-') return false;
  const prev = i > 0 ? full[i - 1] : '';
  return !(prev !== '' && /[0-9)]/.test(prev));
}

interface AnchorKindToken {
  token: string;
  start: number;
  end: number;
  type: SemanticValueType;
  signed: boolean;
}

/**
 * Every numeric token in `text` (currency, percentage, scaled count,
 * stars, storage, duration, plain number), in document order, each
 * classified on its own and marked for an explicit sign. Mirrors the
 * picker's `findNumericCandidates` pattern families so capture and
 * check agree on what counts as a token; overlapping spans resolve
 * to the most specific family first via the covered-span scheme.
 */
function collectNumericTokens(text: string): AnchorKindToken[] {
  const out: AnchorKindToken[] = [];
  const covered = new Array<boolean>(text.length).fill(false);

  function isOverlapping(start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
      if (covered[i]) return true;
    }
    return false;
  }

  function markCovered(start: number, end: number): void {
    for (let i = start; i < end; i++) {
      covered[i] = true;
    }
  }

  function add(token: string, start: number, end: number): void {
    if (isOverlapping(start, end)) return;
    const trimmed = token.trim();
    if (!trimmed || !/\d/.test(trimmed)) return;
    const semantic = detectSemanticValue(trimmed);
    if (semantic.type === 'text' || semantic.normalized === null) return;
    markCovered(start, end);
    out.push({
      token: trimmed,
      start,
      end,
      type: semantic.type,
      signed: hasExplicitSign(trimmed) || hasSignByLookback(text, start),
    });
  }

  function addRegex(regex: RegExp): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const full = match[1] ?? match[0];
      const start = match.index + match[0].indexOf(full);
      add(full, start, start + full.length);
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }

  for (const [symbol] of CURRENCY_SYMBOLS) {
    if (!text.includes(symbol)) continue;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    addRegex(new RegExp(`(?:^|[^\\w$])([-+]?\\s*${escaped}\\s*[-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?)\\b`, 'gi'));
    addRegex(new RegExp(`(?:^|[^\\w$])([-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?\\s*${escaped})(?=[^\\w$]|$)`, 'gi'));
  }
  for (const code of CURRENCY_CODES) {
    if (!text.includes(code)) continue;
    addRegex(new RegExp(`\\b(${code}\\s*[-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?)\\b`, 'gi'));
    addRegex(new RegExp(`\\b([-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?\\s*${code})\\b`, 'gi'));
  }
  addRegex(/([+-]?\s*[\d,]+(?:\.\d+)?\s*%)/g);
  addRegex(/\b(-?[\d,]+(?:\.\d+)?\s*(?:k|mm|m|bn|b|t))\b/gi);
  addRegex(/\b(\d+(?:\.\d+)?\s*(?:\/\s*\d+|out of\s*\d+|★|stars?))\b/gi);
  addRegex(/(-?[\d,]+(?:\.\d+)?\s*(?:pib|tib|gib|mib|kib|pb|tb|gb|mb|kb|bytes?|b))\b/gi);
  addRegex(/\b(\d+:\d{2}(?::\d{2})?)\b/g);
  addRegex(/(\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s*\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s))*)\b/gi);
  addRegex(/\b(-?[\d,]+(?:\.\d+)?)\b/g);

  return out.sort((a, b) => a.start - b.start);
}

/**
 * The single token in `text` matching the anchored value's own
 * semantic kind and sign shape, or `null` unless exactly one such
 * token exists. `null` anchor (monitors captured before text anchors
 * existed) or a non-numeric anchor (text monitors) always yields
 * `null`, so those paths behave exactly as before.
 */
function preferAnchorKindToken(text: string, anchorValue: string | null): string | null {
  if (!anchorValue) return null;
  const anchorSemantic = detectSemanticValue(anchorValue);
  if (anchorSemantic.type === 'text' || anchorSemantic.normalized === null) return null;
  const anchorSigned = hasExplicitSign(anchorValue);
  const matches = collectNumericTokens(text).filter(
    (t) => t.type === anchorSemantic.type && t.signed === anchorSigned,
  );
  if (matches.length !== 1) return null;
  return matches[0]!.token;
}

/**
 * End offset of the latest `before` occurrence that still has `after`
 * following it (-1 when no such frame exists). Repeated labels
 * ("Total … Total $100") must slice from the nearest frame, not the
 * first one - otherwise the window swallows the span in between and a
 * run inside it looks anchored when it isn't. Identical to a plain
 * first-occurrence slice when the label occurs once.
 */
function latestBeforeEnd(full: string, before: string, after: string | null | undefined): number {
  let best = -1;
  let from = 0;
  for (;;) {
    const idx = full.indexOf(before, from);
    if (idx === -1) break;
    const endIdx = idx + before.length;
    if (!after || full.indexOf(after, endIdx) !== -1) best = endIdx;
    from = endIdx;
  }
  return best;
}

/**
 * Verifies the sliced candidate really sits as before < value < after:
 * a candidate containing its own frame text means the window overshot
 * (repeated labels), and a still-present anchor value must lie inside
 * the window. An anchor value that already changed is unverifiable and
 * skips that sub-check - the frame checks still apply.
 */
function isOrderedCandidate(
  full: string,
  start: number,
  end: number,
  anchor: TextAnchor,
  candidate: string,
): boolean {
  if (anchor.before && candidate.includes(anchor.before)) return false;
  if (anchor.after && candidate.includes(anchor.after)) return false;
  if (anchor.value) {
    const valueIndex = full.indexOf(anchor.value, start);
    if (valueIndex !== -1 && valueIndex + anchor.value.length > end) return false;
  }
  return true;
}

/**
 * True when every non-empty part of the anchor's frame is still
 * present in `fullText` (and at least one such part exists). A
 * frameless anchor carries no evidence either way, so this is false
 * for it: with nothing to confirm the slot, a sign flip on a
 * relocated element reads as a switch, not an update.
 */
function hasFullFrameEvidence(
  anchor: TextAnchor | null | undefined,
  fullText: string,
): boolean {
  if (!anchor) return false;
  const parts = [anchor.before, anchor.after].filter((p) => p && p.length > 0);
  if (parts.length === 0) return false;
  return parts.every((p) => fullText.includes(p!));
}

/**
 * True when `text` merely echoes the anchor's own frame (its before or
 * after context) without containing the anchored value: surrounding
 * context masquerading as the value. That happens when a slot now
 * holds old context instead of the metric - a relabeled row, a delta
 * sitting where the value was, a label left behind after its value
 * unmounted. Returning such text stores context as if it were a
 * reading; rejecting (null) preserves the last value and retries.
 * Only exact frame equality counts (both sides normalized), and text
 * containing the anchor value itself always passes - so genuine
 * updates, reshaped elements, and label monitors are unaffected.
 */
function isFrameEcho(anchor: TextAnchor | null | undefined, text: string): boolean {
  if (!anchor || !text) return false;
  const echoesFrame =
    (!!anchor.before && text === anchor.before) || (!!anchor.after && text === anchor.after);
  if (!echoesFrame) return false;
  return !(anchor.value && text.includes(anchor.value));
}

/**
 * Prefer the exact text node/range that was clicked. If a framework has
 * replaced that text node, a single visible text run remains a safe dynamic
 * replacement (e.g. 147 → 150); when a multi-value container becomes
 * ambiguous we return null instead of silently reading the whole card.
 */
function extractAnchoredText(element: Element, anchor: TextAnchor | null | undefined): string | null {
  if (!anchor) return null;
  const runs = visibleTextRuns(element);
  const full = normalizeText(element.textContent ?? '');

  if (anchor.before || anchor.after) {
    const hasBefore = !anchor.before || full.includes(anchor.before);
    const hasAfter = !anchor.after || full.includes(anchor.after);
    if (hasBefore && hasAfter) {
      const start = anchor.before ? latestBeforeEnd(full, anchor.before, anchor.after) : 0;
      const end = start >= 0 && anchor.after ? full.indexOf(anchor.after, start) : full.length;
      if (start >= 0 && end > start) {
        const candidate = full.slice(start, end).trim();
        if (candidate.length > 0 && isOrderedCandidate(full, start, end, anchor, candidate)) {
          const matchingRun = runs.find((r) => r === candidate || candidate.includes(r));
          return matchingRun ?? candidate;
        }
        // Positionally invalid: fall through to the parent gate and
        // the exact/single-run fallbacks below rather than returning a
        // plausible-but-wrong value from an oversized span.
      }
    }
    const parentFull = element.parentElement ? normalizeText(element.parentElement.textContent ?? '') : '';
    const parentHasBefore = !anchor.before || parentFull.includes(anchor.before);
    const parentHasAfter = !anchor.after || parentFull.includes(anchor.after);
    if (!parentHasBefore || !parentHasAfter) {
      return null;
    }
  }

  const exact = runs.find((run) => run === anchor.value);
  if (exact) return exact;

  if (runs.length === 1) return runs[0] ?? null;

  if (anchor.value && runs.length > 1) {
    const targetSemantic = detectSemanticValue(anchor.value);
    if (targetSemantic.type !== 'text') {
      const matchingRuns = runs.filter((r) => {
        const s = detectSemanticValue(r);
        return s.type === targetSemantic.type;
      });
      if (matchingRuns.length === 1) return matchingRuns[0];
    }
  }

  return null;
}

/**
 * Like `element.textContent`, but skips subtrees hidden from assistive
 * tech or sighted users. Icon-only buttons very commonly repeat their
 * label twice — once visible, once in an `aria-hidden` or
 * `sr-only`/`visually-hidden` span for screen readers — and a plain
 * `textContent` read concatenates both ("Open chat Open chat"). That's
 * harmless for a human glancing at the page but corrupts an extracted
 * value, and it also means a wrongly-recovered element (see
 * `locateElement`'s confidence threshold) produces an obviously
 * malformed value rather than a plausible-looking wrong one — a useful
 * signal on its own, but not one this function should manufacture by
 * double-counting a correct element's own accessible-name duplication.
 */
export { extractVisibleText } from './fingerprint';

function visibleTextRuns(root: Element): string[] {
  const runs: string[] = [];
  // See `extractVisibleText` in fingerprint.ts: the aria-label fallback
  // covers hidden content described by the label, never a truly empty
  // element (whose label would otherwise be stored as a successful
  // value instead of letting the check wait for real text).
  let skippedHiddenLength = 0;
  function walk(node: Node): void {
    if (node.nodeType === 3) {
      const text = normalizeText(node.textContent ?? '');
      if (text && !isEffectivelyEmpty(text)) runs.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isVisuallyHidden(el)) {
      skippedHiddenLength += normalizeText(el.textContent ?? '').length;
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }
  walk(root);
  if (runs.length === 0 && skippedHiddenLength > 0) {
    const ariaLabel = root.getAttribute('aria-label');
    if (ariaLabel) {
      const normalized = normalizeText(ariaLabel);
      if (normalized) return [normalized];
    }
  }
  return runs;
}

export interface ResolveSettledValueOptions {
  maxTotalWaitMs?: number;
  /** How long to wait before re-reading a just-found value to confirm it's settled. */
  confirmDelayMs?: number;
  delaysMs?: number[];
}

/**
 * Backoff schedule used once a read comes back as
 * `ANTI_AUTOMATION_DETECTED` (a CAPTCHA/bot-verification/interstitial
 * page in place of the real one - see `antiAutomation.ts`). Slower and
 * longer-reaching than the default schedule: a passive "just a
 * moment"-style challenge shell typically needs a few seconds of real
 * wall-clock time to auto-clear (it's waiting on a timer or a
 * background JS check, not on the DOM settling), so retrying at the
 * default schedule's pace mostly just re-reads the same still-showing
 * challenge. This never attempts to solve or interact with the
 * challenge in any way — it only waits, then re-reads the DOM to see
 * whether the site has already moved past it on its own.
 */
const CHALLENGE_RETRY_DELAYS_MS = [800, 1500, 3000, 4000, 4000];
/**
 * Hard ceiling on how many times a challenge page is re-read within one
 * check, independent of the outer time budget. Bounded so a site whose
 * challenge never clears on its own (e.g. one waiting on a human to
 * solve a puzzle) still gets a fixed number of looks - never an
 * unbounded scan - before this check reports it as temporarily
 * unavailable and lets the monitor's normal schedule (and its forced
 * strategy re-probe, see `FORCE_REPROBE_CODES`) try again later.
 */
const CHALLENGE_MAX_ATTEMPTS = CHALLENGE_RETRY_DELAYS_MS.length;

/**
 * Repeatedly waits for readiness and reads a value via `read()` until
 * two consecutive reads agree, or the time budget runs out.
 *
 * A single successful `read()` isn't proof the value is final. Dashboards
 * routinely render a placeholder ("0", "--", a skeleton) before their
 * data fetch resolves, and animated counters sweep through intermediate
 * values on the way to the real one - DOM-quiet readiness alone can't
 * tell "genuinely done" apart from "quiet right now, about to change
 * again". So every found value gets a short confirmation re-read; if it
 * moved, the newer reading replaces it as the new baseline (it's closer
 * to correct than the one that just failed to hold) and the loop keeps
 * going rather than either trusting the stale value or discarding the
 * newer one.
 *
 * Page-wide activity (an unrelated in-flight request, a loading
 * indicator sitting somewhere else in the document) is treated as a
 * weak signal, not a gate: `read()` is attempted on every single
 * attempt regardless, because the target's own repeated-identical-read
 * confirmation below is a strictly stronger correctness check than any
 * page-wide heuristic - it's asking the actual value whether it's
 * settled, not guessing from surrounding chatter. A dashboard with a
 * permanently-live widget elsewhere (a chat badge, a ticker, an
 * analytics beacon) would otherwise stall every read for the entire
 * time budget despite the monitored target having been stable and
 * readable from the very first attempt.
 *
 * An earlier version also gave real weight to a page-wide in-flight
 * request count fed by a `fetch`/`XMLHttpRequest` patch, specifically
 * to catch the case two back-to-back identical reads can't - a value
 * that renders a placeholder (`"0"`, `"--"`) synchronously, then only
 * replaces it once a pending fetch resolves well after the confirmation
 * window would otherwise have already locked it in. That patch was
 * removed (see `entrypoints/visibilityPatch.content.ts` - it reassigned
 * `window.fetch`, which broke Reddit's preload/credentials matching
 * even when made fully transparent). Without it, a target that holds a
 * placeholder value across the whole confirmation window can finalize
 * on that placeholder; the outer `withExponentialBackoff` retries and
 * the fact that most real placeholder-to-value transitions are
 * themselves DOM mutations (which reset `readiness.ts`'s DOM-quiet
 * timer and delay the *next* attempt's readiness) mitigate this in
 * practice, but it's no longer a hard guarantee for a page whose only
 * activity is a single slow fetch with no other DOM or loading-indicator
 * signal.
 *
 * Framework-independent (no `window`/content-script globals) so it's
 * usable both from the live-tab page agent and directly in tests -
 * `waitForReady` and `read` are the only two things that differ between
 * "a real page" and "a simulated one".
 */
const PLACEHOLDER_VALUE_REGEX = /^(\s*[-—–]{1,3}\s*|\.{3,}|…|loading\.{0,3})$/i;
export function isPlaceholderValue(value: string | null): boolean {
  if (!value) return false;
  return PLACEHOLDER_VALUE_REGEX.test(value.trim());
}

export function resolveSettledValue(
  waitForReady: (maxWaitMs: number) => Promise<ReadinessResult>,
  read: () => LocateAndExtractResult,
  options?: ResolveSettledValueOptions,
): Promise<LocateAndExtractResult> {
  const maxTotalWaitMs = options?.maxTotalWaitMs ?? 16_000;
  const confirmDelayMs = options?.confirmDelayMs ?? 400;
  const defaultDelaysMs = options?.delaysMs ?? [0, 500, 1200, 2500];
  const start = nowMs();
  let lastResult: LocateAndExtractResult | null = null;
  // How many attempts in a row have come back as a challenge page -
  // used only to pick the right backoff schedule and to cap challenge
  // retries independently of the (possibly much larger) outer time
  // budget. Reset the instant a read stops looking like a challenge,
  // so a page that flips between "challenge" and "genuinely not found"
  // for unrelated reasons doesn't inherit the wrong schedule.
  let challengeAttempts = 0;
  // Whether `waitForReady` has *ever*, across any attempt so far,
  // reported the page as genuinely settled (see `ReadinessResult.ready`).
  // A freshly-injected recovery pass (extension just reloaded, service
  // worker just restarted, or a background/live tab that only just
  // navigated) can land its very first `read()` while the target hasn't
  // rendered yet at all - that read is real and gets retried like any
  // other, but if the *entire* time budget elapses without readiness
  // ever settling even once, a plain "not found"/"low confidence"
  // diagnostic is misleading: it implies the element was searched for on
  // a stable page and genuinely isn't there, when what actually happened
  // is the page itself never finished loading. `withPageNotReadyNote`
  // below re-labels that specific case honestly.
  let everReady = false;

  return withExponentialBackoff<LocateAndExtractResult>(
    async (attemptNumber) => {
      const remaining = maxTotalWaitMs - (nowMs() - start);
      const isChallenge = lastResult?.diagnostic.code === 'ANTI_AUTOMATION_DETECTED';
      if (remaining <= 0 || (isChallenge && challengeAttempts >= CHALLENGE_MAX_ATTEMPTS)) {
        // If the budget expired while waiting or sleeping, give the live
        // DOM one final read before giving up - a target element that
        // mounted or settled during the last sleep interval would
        // otherwise be ignored in favor of a stale previous `null`.
        if (remaining <= 0 && (!lastResult || lastResult.value === null || isPlaceholderValue(lastResult.value)) && !isChallenge) {
          const finalAttempt = read();
          if (finalAttempt.value !== null && !isPlaceholderValue(finalAttempt.value)) {
            return { done: true, value: finalAttempt };
          }
          if (finalAttempt.value !== null) {
            lastResult = finalAttempt;
          }
        }

        return {
          done: true,
          // A page-wide "quiet" signal is advisory. Preserve the actual
          // locator outcome instead of replacing it with PAGE_NOT_READY on
          // a dashboard that keeps unrelated widgets animating forever -
          // except when the page was *never once* observed settled, in
          // which case the locator outcome is relabeled honestly (see
          // `withPageNotReadyNote`).
          value: lastResult
            ? withPageNotReadyNote(
                withExhaustedChallengeNote(lastResult, isChallenge, challengeAttempts, nowMs() - start),
                everReady,
              )
            : {
                value: null,
                diagnostic: diagnostic('PAGE_NOT_READY', 'time budget exhausted before the target appeared'),
                updatedFingerprint: null,
                confidence: 0,
                method: 'none',
                semanticValue: null,
              },
        };
      }

      // Capped well under the full budget, especially on the first
      // attempt: `waitForReady`'s network-quiet signal can go
      // unsatisfied for a long time (or indefinitely) on sites with
      // constant background chatter - ads, analytics beacons, a live
      // chat widget - even once the actual monitored value rendered
      // seconds ago. Waiting out that full window before ever reading
      // once was the single biggest source of "why is this so slow":
      // it burned most of the check's time budget on a signal that may
      // never fire, before the code had looked at the DOM even once.
      // A short wait + an early read, retried with backoff via the
      // outer loop if it comes back empty, gets the common case (value
      // already there) in a couple seconds instead of routinely eating
      // the whole ceiling on busy pages.
      // Do not make a specific value wait for unrelated React/SPA churn
      // elsewhere in the document. Readiness still protects against known
      // loading states and in-flight requests, but is kept as a short
      // sampling window; target-level confirmation below is the authority.
      // When the previous read already located the slot but found it
      // empty, the element exists and only needs population — spending
      // another full second waiting for page-wide quiet just burns the
      // budget that should go to re-extracting the candidate itself.
      // Use a short sampling wait there so the same time budget buys
      // more extraction retries instead of longer waits (Check Now
      // stays fast; no global timeout is raised).
      const prevEmpty = lastResult?.diagnostic.code === 'EXTRACTION_EMPTY' && lastResult.value === null;
      const waitCap = prevEmpty ? 250 : attemptNumber === 0 ? 750 : 1_000;
      const readiness = await waitForReady(Math.min(remaining, waitCap));
      if (readiness.ready) everReady = true;

      // Read unconditionally - see the comment above `resolveSettledValue`
      // for why page-wide signals no longer gate this call.
      const result = read();
      lastResult = result;
      challengeAttempts = result.diagnostic.code === 'ANTI_AUTOMATION_DETECTED' ? challengeAttempts + 1 : 0;
      if (result.value === null || (isPlaceholderValue(result.value) && remaining > confirmDelayMs)) {
        return { done: false, value: result };
      }

      const confirmBudget = maxTotalWaitMs - (nowMs() - start);
      if (confirmBudget <= confirmDelayMs) {
        // Out of time to double-check further either way - hand back
        // the best reading available rather than exceeding the budget.
        return { done: true, value: result };
      }

      await sleep(Math.min(confirmDelayMs, confirmBudget));
      const confirmation = read();
      lastResult = confirmation;
      if (confirmation.value === result.value) {
        return { done: true, value: confirmation };
      }
      // The value moved between reads - not settled yet. Keep the newer
      // reading as the best-known value and let the loop try again.
      return { done: false, value: confirmation };
    },
    {
      // While the most recent read looked like a challenge page, pace
      // retries with `CHALLENGE_RETRY_DELAYS_MS` instead of the default
      // schedule (see that constant for why). Any other outcome -
      // including the very first read - uses the normal schedule.
      delaysMs: (attemptNumber, previous) => {
        const raw =
          previous?.diagnostic.code === 'ANTI_AUTOMATION_DETECTED'
            ? CHALLENGE_RETRY_DELAYS_MS[Math.min(challengeAttempts - 1, CHALLENGE_RETRY_DELAYS_MS.length - 1)] ?? 0
            : defaultDelaysMs[Math.min(attemptNumber, defaultDelaysMs.length - 1)] ?? 0;
        // Never sleep past the outer time budget - a delay this function
        // proposes is only ever a suggestion, `remaining` inside the
        // attempt callback is the actual authority on when to stop.
        const remaining = maxTotalWaitMs - (nowMs() - start);
        return Math.max(0, Math.min(raw, remaining));
      },
      // A generous attempt ceiling so the attempt callback's own time-budget
      // check (`remaining <= 0`) is what decides when to terminate and attach
      // notes, rather than being cut off prematurely from the outside.
      maxAttempts: (attemptNumber, previous) => {
        if (previous?.diagnostic.code === 'ANTI_AUTOMATION_DETECTED' && challengeAttempts >= CHALLENGE_MAX_ATTEMPTS) {
          return false;
        }
        return attemptNumber < 25;
      },
    },
  );
}

/**
 * When a challenge page persisted for the whole retry budget (either
 * the outer time budget or `CHALLENGE_MAX_ATTEMPTS`, whichever came
 * first), attaches a short, honest summary of what was tried - so the
 * eventual diagnostic reads as "temporarily blocked, retried N times,
 * will try again on schedule" rather than a bare, unexplained failure.
 * Leaves every other outcome (including a still-fresh, first-attempt
 * challenge detection, or any non-challenge diagnostic) untouched.
 */
function withExhaustedChallengeNote(
  result: LocateAndExtractResult,
  isChallenge: boolean,
  attempts: number,
  elapsedMs: number,
): LocateAndExtractResult {
  if (!isChallenge || attempts === 0 || result.diagnostic.code !== 'ANTI_AUTOMATION_DETECTED') return result;
  const seconds = (elapsedMs / 1000).toFixed(1);
  const base = result.diagnostic.detail;
  const retrySummary = `checked again ${attempts} time${attempts === 1 ? '' : 's'} over ~${seconds}s while waiting for the real page to load; still showing the challenge, so this check is reporting it as temporarily unavailable rather than guessing`;
  return {
    ...result,
    diagnostic: {
      ...result.diagnostic,
      detail: base ? `${base}; ${retrySummary}` : retrySummary,
    },
  };
}

/**
 * Relabels a `null`-value outcome as `PAGE_NOT_READY` when the page was
 * never once observed settled during the whole retry budget - so a
 * recovery pass that ran entirely against a still-loading/still-
 * hydrating page reports an honest "never finished loading" rather than
 * a confident-sounding "the original element is gone" or "closest match
 * only partially resembles the original". Those two diagnostics are
 * appropriate when the page *was* stable and the scan genuinely came up
 * empty/low-confidence; they're misleading when readiness never settled
 * even once, which is exactly the shape of "first (and every) recovery
 * attempt happened before the page was ready" - e.g. right after an
 * extension reload/service-worker restart reinitializes recovery against
 * a page that hasn't finished its own render yet.
 *
 * Deliberately narrow: only overrides the two "nothing matched well
 * enough" codes, and only when `value` is still `null` - a genuinely
 * found value, an auth wall, an anti-automation challenge, or an empty-
 * extraction result are all accurate regardless of the readiness signal
 * and are left untouched.
 */
function withPageNotReadyNote(
  result: LocateAndExtractResult,
  everReady: boolean,
): LocateAndExtractResult {
  if (everReady || result.value !== null) return result;
  if (result.diagnostic.code !== 'ELEMENT_NOT_FOUND' && result.diagnostic.code !== 'SELECTOR_RECOVERY_LOW_CONFIDENCE') {
    return result;
  }
  const base = result.diagnostic.detail;
  const note = 'the page never finished loading/settling during this check, so this result may just be too early';
  return {
    ...result,
    diagnostic: diagnostic('PAGE_NOT_READY', base ? `${note} (${base})` : note),
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
