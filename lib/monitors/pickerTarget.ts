/**
 * Hover target resolution for the interactive picker.
 *
 * `document.elementFromPoint()` returns whatever's literally under the
 * cursor - which, on a real dashboard, is very often a wrapper `<div>`
 * around a "label + value" pair, a padding area inside a card, or an
 * icon sitting next to the number someone actually wants. Blindly
 * fingerprinting that raw hit would monitor the wrong thing (a whole
 * card's concatenated text, an icon with no text at all, a label
 * instead of its value).
 *
 * This module looks at a bounded neighborhood of the raw hit - itself,
 * a few levels of descendants, a few levels of ancestors - and scores
 * each candidate on how much it looks like "a single monitorable
 * value", reusing the same text extraction and semantic classification
 * the monitoring engine itself uses so a value previewed here is
 * exactly what a saved monitor would later read.
 */
import { classifyTextPattern, findLabelText, normalizeText, isVisuallyHidden, type TextAnchor } from './fingerprint';
import { extractVisibleText } from './locate';
import {
  detectSemanticValue,
  extractNumericToken,
  CURRENCY_SYMBOLS,
  CURRENCY_CODES,
  type SemanticValue,
  type SemanticValueType,
} from './semanticValue';

export interface PickerTarget {
  element: Element;
  text: string;
  canonicalValue: string;
  semanticValue: SemanticValue;
  /** Nearby label text, if any - used to name the monitor without asking. */
  label: string | null;
  /** Text-range identity when the browser exposes a caret at the cursor. */
  textAnchor: TextAnchor;
  /** Used only for the picker highlight; never persisted because Range nodes go stale on rerender. */
  range: Range | null;
  /** Confidence in the resolved value: 'high' | 'medium' | 'low'. */
  confidence?: 'high' | 'medium' | 'low';
  /** True when multiple plausible numeric candidates exist or confidence is low. */
  isAmbiguous?: boolean;
  /** Plausible numeric candidate tokens found in the target. */
  candidates?: string[];
  /** Explanation or label describing why this target is ambiguous. */
  ambiguityReason?: string | null;
}

const MAX_DESCEND_DEPTH = 3;
const MAX_ASCEND_HOPS = 4;
const MAX_VALUE_LENGTH = 80;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const INLINE_FORMATTING_TAGS = new Set([
  'B', 'I', 'EM', 'STRONG', 'SMALL', 'U', 'MARK', 'SUP', 'SUB', 'BR', 'SPAN', 'ABBR',
]);

/** True if `el`'s own children are only inline formatting (or none) - i.e. it doesn't wrap other structural blocks. */
function isLeafLike(el: Element): boolean {
  const children = Array.from(el.children);
  if (children.length === 0) return true;
  return children.every((c) => INLINE_FORMATTING_TAGS.has(c.tagName) && c.children.length === 0);
}

/** Collects a small, bounded neighborhood around `start`: itself, shallow descendants, and shallow ancestors. */
function collectCandidates(start: Element): { element: Element; hops: number }[] {
  const seen = new Set<Element>();
  const out: { element: Element; hops: number }[] = [];

  function add(el: Element | null, hops: number): void {
    if (!el || seen.has(el) || SKIP_TAGS.has(el.tagName) || isVisuallyHidden(el)) return;
    seen.add(el);
    out.push({ element: el, hops });
  }

  add(start, 0);

  function descend(el: Element, depth: number, hops: number): void {
    if (depth <= 0) return;
    for (const child of Array.from(el.children)) {
      if (isVisuallyHidden(child)) continue;
      add(child, hops);
      descend(child, depth - 1, hops + 1);
    }
  }
  descend(start, MAX_DESCEND_DEPTH, 1);

  let up = start.parentElement;
  let hops = 1;
  while (up && hops <= MAX_ASCEND_HOPS) {
    add(up, hops);
    up = up.parentElement;
    hops += 1;
  }

  return out;
}

/** Higher is better. Rewards recognized value patterns and tight, leaf-like elements; penalizes distance from the cursor and bloat. */
function scoreCandidate(el: Element, text: string, hops: number): number {
  const semantic = detectSemanticValue(text);
  const pattern = classifyTextPattern(text);

  let score = 0;
  if (semantic.type !== 'text') score += 60;
  else if (pattern === 'short-text') score += 25;
  else if (pattern === 'long-text') score += 5;

  if (isLeafLike(el)) score += 25;
  score -= Math.min(20, el.querySelectorAll('*').length * 2);
  score -= hops * 8;
  score -= Math.min(30, text.length * 0.3);

  return score;
}

/**
 * Resolves whatever's literally under the cursor to the best nearby
 * element to actually monitor, or `null` if nothing in the
 * neighborhood looks like a readable value.
 */
export function resolvePickerTarget(start: Element): PickerTarget | null {
  const hiddenRoot = start.getAttribute('aria-hidden') === 'true' ? start : start.closest?.('[aria-hidden="true"]');
  const effectiveStart = hiddenRoot?.parentElement ?? start;

  const startText = extractVisibleText(effectiveStart);
  const semanticContainer = findSemanticContainer(effectiveStart, startText);
  if (semanticContainer) {
    const containerSemantic = detectSemanticValue(semanticContainer.text);
    const startSemantic = detectSemanticValue(startText);
    if (containerSemantic.type !== 'text' && (startSemantic.type === 'text' || startSemantic.type === 'number')) {
      return toPickerTarget(semanticContainer.element, semanticContainer.text, null);
    }
  }

  let best: { element: Element; text: string; score: number } | null = null;

  for (const { element, hops } of collectCandidates(effectiveStart)) {
    const text = extractVisibleText(element);
    if (!text || text.length > MAX_VALUE_LENGTH) continue;

    const s = scoreCandidate(element, text, hops);
    if (!best || s > best.score) best = { element, text, score: s };
  }

  if (!best) return null;

  return toPickerTarget(best.element, best.text, null);
}

/**
 * Range-first hit testing. Modern browsers expose the text node beneath the
 * cursor; using it avoids collapsing a number inside a complex button/card
 * into the entire parent element. Falls back to the existing bounded element
 * resolver when a browser does not expose caret geometry (or the pointer is
 * over non-text UI).
 */
export function resolvePickerTargetAtPoint(doc: Document, x: number, y: number): PickerTarget | null {
  const hit = deepElementFromPoint(doc, x, y);
  // Same-origin/extension-accessible frames can be resolved locally. A
  // cross-origin frame deliberately returns null: reading it would violate
  // browser isolation, so the picker fails safely rather than guessing.
  if (hit?.tagName === 'IFRAME') {
    try {
      const frame = hit as HTMLIFrameElement;
      const childDoc = frame.contentDocument;
      const rect = frame.getBoundingClientRect();
      if (childDoc) return resolvePickerTargetAtPoint(childDoc, x - rect.left, y - rect.top);
    } catch {
      return null;
    }
  }
  const caret = directCaretAtPoint(doc, x, y);
  const textNode = caret?.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer : null;
  if (textNode?.parentElement && !textNode.parentElement.closest?.('[aria-hidden="true"]')) {
    const text = normalizeText(textNode.textContent ?? '');
    if (isMeaningfulText(text)) {
      // Currency/date/percentage widgets often split one displayed value
      // across nested spans ("$" + "49.99"). Expand only to the nearest
      // inline value container when that creates a stronger semantic unit.
      const range = expandRangeToTextNode(caret!);
      const caretOffset = caret?.startOffset ?? null;
      const semanticContainer = findSemanticContainer(textNode.parentElement, text);
      if (semanticContainer) {
        const containerSemantic = detectSemanticValue(semanticContainer.text);
        const startSemantic = detectSemanticValue(text);
        if (containerSemantic.type !== 'text' && (startSemantic.type === 'text' || startSemantic.type === 'number')) {
          return toPickerTarget(semanticContainer.element, semanticContainer.text, range, caretOffset);
        }
      }
      return toPickerTarget(textNode.parentElement, text, range, caretOffset);
    }
  }
  return hit ? resolvePickerTarget(hit) : null;
}

function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
  if (typeof doc.elementFromPoint !== 'function') return null;
  let hit = doc.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function findSemanticContainer(start: Element, childText: string): { element: Element; text: string } | null {
  let node: Element | null = start;
  for (let hop = 0; node && hop < 5; hop += 1, node = node.parentElement) {
    const text = extractVisibleText(node);
    const pattern = classifyTextPattern(text);
    const semantic = detectSemanticValue(text);
    if (
      text !== childText &&
      text.length <= MAX_VALUE_LENGTH &&
      (pattern === 'currency' ||
        pattern === 'percentage' ||
        pattern === 'date' ||
        pattern === 'numeric' ||
        semantic.type !== 'text')
    ) {
      return { element: node, text };
    }
  }
  return null;
}

function directCaretAtPoint(doc: Document, x: number, y: number): Range | null {
  const anyDoc = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const direct = anyDoc.caretRangeFromPoint?.(x, y);
  if (direct) return direct;
  const position = anyDoc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = doc.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function caretRangeAtPoint(doc: Document, x: number, y: number): Range | null {
  const direct = directCaretAtPoint(doc, x, y);
  return direct ? expandRangeToTextNode(direct) : null;
}

function expandRangeToTextNode(range: Range): Range | null {
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const node = range.startContainer;
  const expanded = node.ownerDocument!.createRange();
  expanded.selectNodeContents(node);
  return expanded;
}

function isMeaningfulText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_VALUE_LENGTH && classifyTextPattern(text) !== 'long-text';
}

interface NumericCandidate {
  token: string;
  canonicalValue: string;
  semanticValue: SemanticValue;
  start: number;
  end: number;
  score: number;
}

function getCursorOffsetInElement(
  element: Element,
  range: Range | null,
  caretOffset?: number | null,
): number | null {
  if (caretOffset !== undefined && caretOffset !== null && range) {
    const targetNode = range.startContainer;
    let offset = 0;
    function walk(node: Node): boolean {
      if (node === targetNode) {
        offset += caretOffset!;
        return true;
      }
      if (node.nodeType === 3 /* TEXT_NODE */) {
        offset += (node.textContent ?? '').length;
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (walk(child)) return true;
      }
      return false;
    }
    if (walk(element)) return offset;
  }
  if (!range) return null;
  const targetNode = range.startContainer;
  if (!targetNode) return null;
  const startOffset = range.startOffset;

  let offset = 0;
  function walk(node: Node): boolean {
    if (node === targetNode) {
      offset += startOffset;
      return true;
    }
    if (node.nodeType === 3 /* TEXT_NODE */) {
      offset += (node.textContent ?? '').length;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (walk(child)) return true;
    }
    return false;
  }

  if (walk(element)) return offset;
  return null;
}

function findNumericCandidates(
  text: string,
  cursorOffset: number | null,
): NumericCandidate[] {
  const candidates: NumericCandidate[] = [];
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

  // Pre-cover version strings (e.g. 2.4.1) and dates so they are never split into numbers
  const versionRegex = /\b\d+(\.\d+){2,}\b/g;
  let vMatch: RegExpExecArray | null;
  while ((vMatch = versionRegex.exec(text)) !== null) {
    markCovered(vMatch.index, vMatch.index + vMatch[0].length);
  }

  const dateRegex = /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
  let dMatch: RegExpExecArray | null;
  while ((dMatch = dateRegex.exec(text)) !== null) {
    markCovered(dMatch.index, dMatch.index + dMatch[0].length);
  }

  // Detect whether the text represents a comparison or range (e.g. "85 vs 90", "10 to 20", "between 10 and 20")
  const isComparisonText = /\b(vs\.?|to|-|\/)\b/i.test(text) || /\b(between|from)\b/i.test(text);

  function addCandidate(
    token: string,
    start: number,
    end: number,
    baseScore: number,
    forceType?: SemanticValueType,
  ): void {
    if (isOverlapping(start, end)) return;
    const trimmed = token.trim();
    if (!trimmed) return;

    let semantic = detectSemanticValue(trimmed);
    if (semantic.type === 'text' && forceType) {
      const parsed = parseFloat(trimmed.replace(/,/g, ''));
      if (!Number.isNaN(parsed)) {
        semantic = { type: forceType, normalized: parsed, unit: null, raw: trimmed };
      }
    }

    const isNumeric = semantic.type !== 'text' && semantic.normalized !== null;
    const canonicalValue = isNumeric ? extractNumericToken(trimmed, semantic) : trimmed;

    const before = text.slice(Math.max(0, start - 25), start);
    const after = text.slice(end, Math.min(text.length, end + 25));

    let score = baseScore;

    // Bonus for metric label before (only when not part of a comparison/range between multiple values)
    if (!isComparisonText && /\b(likes?|balance|total|price|cost|amount|rate|score|views?|visits?|visitors?|pageviews?|sessions?|bounces?|followers?|subscribers?|subs?|points?|pts?|stock|rating|rev(?:enue)?)\b[:\s(]*$/i.test(before)) {
      score += 30;
    }

    // Bonus for metric unit after (only when not part of a comparison/range between multiple values)
    if (!isComparisonText && /^[:\s)]*(pts?|points?|likes?|views?|subs?|subscribers?|followers?|shares?|upvotes?|votes?|items?|units?|stars?|comments?)\b/i.test(after)) {
      score += 25;
    }

    // Demotion for an explicitly signed percentage (+5.2%, -4.5%): on
    // analytics dashboards this shape is almost always a change
    // indicator annotating a nearby metric, not the metric itself. It
    // stays fully eligible on its own (single candidate) and keeps its
    // relative order against other signed deltas - it only loses to an
    // unsigned value it would otherwise tie or narrowly beat.
    if (/^[+-]/.test(trimmed) && semantic.type === 'percentage') {
      score -= 25;
    }

    // Penalty for index, rank, time or secondary limiter context
    if (/\b(item|step|page|rank|#|level|no\.?|min|max|at least|at most|every|over|under|ago|months?|days?|hours?|mins?|years?|sec(?:ond)?s?)\b/i.test(before) ||
        /\b(ago|months?|days?|hours?|mins?|years?|sec(?:ond)?s?)\b/i.test(after)) {
      score -= 25;
    }

    // Small integer index penalty (e.g. "1 Bitcoin" or "Item 1 of 5")
    if (/^[0-1]$/.test(trimmed) && !/\b(likes?|pts?|points?|views?|balance)\b/i.test(before + after)) {
      score -= 15;
    }

    // Cursor proximity bonus
    if (cursorOffset !== null) {
      const center = (start + end) / 2;
      const dist = Math.abs(cursorOffset - center);
      if (cursorOffset >= start && cursorOffset <= end) {
        score += 60;
      } else if (dist <= 3) {
        score += 40;
      } else if (dist <= 6) {
        score += 20;
      }
    }

    markCovered(start, end);
    candidates.push({
      token: trimmed,
      canonicalValue,
      semanticValue: semantic,
      start,
      end,
      score,
    });
  }

  // 1. Currency
  for (const [symbol] of CURRENCY_SYMBOLS) {
    if (!text.includes(symbol)) continue;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRegex = new RegExp(`(?:^|[^\\w$])([-+]?\\s*${escaped}\\s*[-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?)\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = prefixRegex.exec(text)) !== null) {
      const full = match[1];
      const start = match.index + match[0].indexOf(full);
      addCandidate(full, start, start + full.length, 60, 'currency');
    }
    const suffixRegex = new RegExp(`(?:^|[^\\w$])([-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?\\s*${escaped})(?=[^\\w$]|$)`, 'gi');
    while ((match = suffixRegex.exec(text)) !== null) {
      const full = match[1];
      const start = match.index + match[0].indexOf(full);
      addCandidate(full, start, start + full.length, 60, 'currency');
    }
  }

  for (const code of CURRENCY_CODES) {
    if (!text.includes(code)) continue;
    const isoRegex = new RegExp(`\\b(${code}\\s*[-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?)\\b`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = isoRegex.exec(text)) !== null) {
      addCandidate(match[1], match.index, match.index + match[1].length, 60, 'currency');
    }
    const isoSuffixRegex = new RegExp(`\\b([-+]?[\\d,]+(?:\\.\\d+)?\\s*(?:k|mm|m|bn|b|t)?\\s*${code})\\b`, 'gi');
    while ((match = isoSuffixRegex.exec(text)) !== null) {
      addCandidate(match[1], match.index, match.index + match[1].length, 60, 'currency');
    }
  }

  // 2. Percentages
  const percentRegex = /([+-]?\s*[\d,]+(?:\.\d+)?\s*%)/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = percentRegex.exec(text)) !== null) {
    addCandidate(pMatch[1], pMatch.index, pMatch.index + pMatch[1].length, 50, 'percentage');
  }

  // 3. Scaled counts
  const scaledRegex = /\b(-?[\d,]+(?:\.\d+)?\s*(?:k|mm|m|bn|b|t))\b/gi;
  let sMatch: RegExpExecArray | null;
  while ((sMatch = scaledRegex.exec(text)) !== null) {
    addCandidate(sMatch[1], sMatch.index, sMatch.index + sMatch[1].length, 45, 'count');
  }

  // 4. Stars
  const starRegex = /\b(\d+(?:\.\d+)?\s*(?:\/\s*\d+|out of\s*\d+|★|stars?))\b/gi;
  let stMatch: RegExpExecArray | null;
  while ((stMatch = starRegex.exec(text)) !== null) {
    addCandidate(stMatch[1], stMatch.index, stMatch.index + stMatch[1].length, 45, 'stars');
  }

  // 5. Plain numbers
  const numRegex = /\b(-?[\d,]+(?:\.\d+)?)\b/g;
  let nMatch: RegExpExecArray | null;
  while ((nMatch = numRegex.exec(text)) !== null) {
    const raw = nMatch[1];
    if (/\d/.test(raw)) {
      addCandidate(raw, nMatch.index, nMatch.index + raw.length, 20, 'number');
    }
  }

  return candidates.sort((a, b) => a.start - b.start);
}

function formatAmbiguityText(candidates: string[]): string {
  if (candidates.length === 2) {
    return `multiple values (${candidates[0]} vs ${candidates[1]})`;
  }
  if (candidates.length > 2) {
    return `multiple values (${candidates.slice(0, 3).join(', ')}${candidates.length > 3 ? ', …' : ''})`;
  }
  return 'multiple values';
}

function toPickerTarget(
  element: Element,
  text: string,
  range: Range | null,
  caretOffset?: number | null,
): PickerTarget {
  const full = normalizeText(element.textContent ?? '');
  const cursorOffset = getCursorOffsetInElement(element, range, caretOffset);
  const candidates = findNumericCandidates(text, cursorOffset);
  const fullSemantic = detectSemanticValue(text);

  let canonicalValue = text;
  let semanticValue = fullSemantic;
  let confidence: 'high' | 'medium' | 'low' = 'high';
  let isAmbiguous = false;
  let ambiguityReason: string | null = null;
  let plausibleCandidates: string[] = [];

  if (candidates.length === 0) {
    canonicalValue = text;
    semanticValue = fullSemantic;
    confidence = 'high';
    isAmbiguous = false;
  } else if (candidates.length === 1) {
    const single = candidates[0];
    canonicalValue = single.canonicalValue;
    semanticValue = fullSemantic.type !== 'text'
      ? fullSemantic
      : (single.semanticValue.type !== 'text' ? single.semanticValue : detectSemanticValue(canonicalValue));
    confidence = 'high';
    isAmbiguous = false;
    plausibleCandidates = [canonicalValue];
  } else {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const second = sorted[1];
    const scoreDiff = best.score - second.score;

    plausibleCandidates = candidates.map((c) => c.canonicalValue);

    if (scoreDiff >= 20) {
      canonicalValue = best.canonicalValue;
      semanticValue = fullSemantic.type !== 'text' && (fullSemantic.type === best.semanticValue.type || best.semanticValue.type === 'number' || best.semanticValue.type === 'count')
        ? fullSemantic
        : (best.semanticValue.type !== 'text' ? best.semanticValue : detectSemanticValue(canonicalValue));
      confidence = 'high';
      isAmbiguous = false;
    } else {
      confidence = 'low';
      isAmbiguous = true;
      ambiguityReason = `multiple values (${plausibleCandidates.slice(0, 2).join(' vs ')})`;
      canonicalValue = best.canonicalValue;
      semanticValue = best.semanticValue.type !== 'text' ? best.semanticValue : fullSemantic;
    }
  }

  const targetValue = canonicalValue && full.includes(canonicalValue) ? canonicalValue : text;
  const start = full.indexOf(targetValue);
  let before = start > 0 ? full.slice(Math.max(0, start - 32), start) : '';
  let after = start >= 0 ? full.slice(start + targetValue.length, start + targetValue.length + 32) : '';

  if (!before && !after && element.parentElement) {
    const parentFull = normalizeText(element.parentElement.textContent ?? '');
    const parentStart = parentFull.indexOf(targetValue);
    if (parentStart !== -1) {
      before = parentFull.slice(Math.max(0, parentStart - 32), parentStart);
      after = parentFull.slice(parentStart + targetValue.length, parentStart + targetValue.length + 32);
    }
  }

  const textAnchor: TextAnchor = {
    value: targetValue,
    before,
    after,
  };
  return {
    element,
    text,
    canonicalValue,
    semanticValue,
    label: normalizeLabel(findLabelText(element)),
    textAnchor,
    range,
    confidence,
    isAmbiguous,
    candidates: plausibleCandidates,
    ambiguityReason,
  };
}

export function formatPickerTooltip(target: PickerTarget): string {
  if (target.isAmbiguous) {
    const detail = target.candidates && target.candidates.length > 1
      ? formatAmbiguityText(target.candidates)
      : (target.ambiguityReason ?? 'multiple values found');
    return target.label ? `⚠ Ambiguous: ${target.label} · ${detail}` : `⚠ Ambiguous: ${detail}`;
  }
  const semantic = target.semanticValue ?? detectSemanticValue(target.text);
  const isNumeric = semantic.type !== 'text' && semantic.normalized !== null;
  const canonicalValue = target.canonicalValue ?? (isNumeric ? extractNumericToken(target.text, semantic) : target.text);
  return target.label ? `✓ ${target.label} · ${canonicalValue}` : `✓ ${canonicalValue}`;
}

function normalizeLabel(label: string | null): string | null {
  if (!label) return null;
  const trimmed = normalizeText(label);
  return trimmed.length > 0 && trimmed.length <= 60 ? trimmed : null;
}
