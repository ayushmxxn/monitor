/**
 * Element fingerprinting & adaptive recovery.
 *
 * A `Monitor` no longer pins a single CSS selector. Instead it stores an
 * `ElementFingerprint`: a bundle of independent signals captured about
 * the watched element at pick time (stable attributes, semantic/ARIA
 * info, DOM position, nearby label text, text shape, a CSS selector,
 * and an XPath). None of these signals is trusted on its own — modern
 * SPAs routinely regenerate class names, re-mount subtrees, and shuffle
 * DOM order on every render. Recovery instead *scores* every plausible
 * candidate element against the full signal bundle and picks the best
 * match, the same way a human would say "well the label still says
 * 'Total' and it's still the second row, so it's probably this one"
 * even though the exact selector broke.
 *
 * This module is pure DOM + TypeScript with no `chrome.*` calls, so it
 * can be imported directly by the on-demand content script
 * (`entrypoints/pageAgent.content.ts`) as well as by the offscreen
 * document (which has a real `Document` from `DOMParser` but no live
 * page, so bounding boxes/computed styles aren't available there —
 * every signal here degrades gracefully when unavailable).
 */

import { detectSemanticValue, extractNumericToken, isCompatibleSemanticKind, type SemanticValueType } from './semanticValue';

export interface ElementFingerprint {
  version: 4 | 5 | 6;
  /** Element's own `id`, kept only if it doesn't look framework-generated (see isStableId). */
  id: string | null;
  /** First match among data-testid, data-test, data-qa, data-cy, data-automation-id. */
  dataTestId: string | null;
  ariaLabel: string | null;
  role: string | null;
  name: string | null;
  tag: string;
  /** Best-effort selector at capture time. May contain ` >>> ` shadow-DOM segments. */
  cssSelector: string;
  /** Absolute XPath from document root, as a fallback locator. */
  xpath: string;
  /** Tag[:nth-of-type] chain from the nearest ancestor with a stable id (or documentElement). */
  domPath: string[];
  /** Curated, filtered class list (hashed/utility/random-looking classes excluded). */
  classSignature: string[];
  /** Curated attribute snapshot: aria-*, data-*, role, type, name, href (origin+path only), alt, title. */
  attributes: Record<string, string>;
  /** Text of an associated <label>, aria-labelledby target, or nearest preceding label-like sibling. */
  nearbyLabelText: string | null;
  /** Normalized text content at capture time. Used only for shape/length comparison, never exact match. */
  textSnapshot: string;
  textPattern: TextPattern;
  /** Exact value and a small surrounding text context captured from the clicked text range. */
  textAnchor?: TextAnchor | null;
  /** Index among same-tag siblings under the same parent. */
  siblingIndex: number;
  siblingCount: number;
  /** Depth from document root. */
  depth: number;
  /** Position as a fraction of the viewport at capture time, if visible. */
  relativeBox: { x: number; y: number; w: number; h: number } | null;
  /** Text of the nearest heading/landmark ancestor-or-preceding element, for contextual anchoring. */
  landmarkText: string | null;
  /**
   * Identity of the enclosing feed/list item (a tweet, post, comment,
   * row), independent of where that item currently sits in the DOM.
   * `null` when `el` isn't inside anything that looks like one - see
   * `findItemAnchor`.
   */
  itemAnchor: ItemAnchor | null;
  capturedAt: number;
}

export interface TextAnchor {
  value: string;
  before: string;
  after: string;
}

export interface ItemAnchor {
  /** Path+query of a permalink-shaped `<a href>` found inside the item (see `isPermalinkPath`). */
  href: string | null;
  /**
   * `true` when `href` came from an actual permalink-shaped match
   * (`isPermalinkPath`) - one specific piece of content with its own
   * page. `false` when `href` is present but only the weaker
   * fallback (a table/dashboard row's own detail link, kept for lack
   * of anything better - see `looksLikeRowLink`). Kept as its own flag
   * rather than re-deriving it from `href` later: `isPermalinkPath` is
   * a best-effort heuristic (e.g. it can accidentally match a
   * hash-shaped id in an unrelated URL segment), so re-testing a
   * stored href after the fact can disagree with what actually
   * happened at capture time. Callers that need to trust a permalink
   * enough to navigate an entire check to it (see
   * `lib/monitors/itemUrl.ts`) should require this to be `true`, not
   * just `href` to be non-null - a dashboard row's own page is not
   * guaranteed to contain the watched cell at all, unlike a feed
   * item's own permalink.
   */
  isPermalink: boolean;
  /** `datetime` of a `<time>` element found inside the item. */
  datetime: string | null;
  /**
   * A stable identifier attribute found on the item root itself, e.g.
   * `data-row-key="acme.com"` or `id="row-42"` on a table/grid row —
   * captured as `"attrName=value"` so two different attributes that
   * happen to share a value never collide. This is what most
   * dashboard/table UIs (Cloudflare, Stripe, Shopify, GA, CoinMarketCap,
   * admin grids built on AG Grid/MUI DataGrid/TanStack Table) expose in
   * place of a feed's permalink+timestamp — a table row rarely links
   * anywhere or carries a `<time>`, but very often carries a row/record
   * id on the row element. Deliberately excludes purely positional
   * attributes like `data-index`/`aria-rowindex` (see `ROW_KEY_ATTRS`) -
   * those describe *where* a virtualized row currently sits, not *which*
   * record it holds, and would silently defeat the whole point of this
   * signal (surviving a reorder/re-sort).
   */
  rowKey: string | null;
  /**
   * A short, non-numeric text run found inside the item that isn't the
   * fingerprinted value itself — usually the row's "name" column (a
   * domain, a company, a product, a username). Softer than `href` /
   * `datetime` / `rowKey`: never treated as an authoritative override,
   * only as one more point of similarity, since two unrelated rows can
   * legitimately share a label (e.g. two "Active" status cells). Exists
   * for the common case where a table/grid genuinely has no id/link/time
   * anywhere on the row - only text.
   */
  primaryText: string | null;
}

export type TextPattern =
  | 'empty'
  | 'numeric'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'short-text'
  | 'long-text';

export interface ScoredCandidate {
  element: Element;
  score: number;
  signals: Record<string, number>;
}

export interface LocateResult {
  element: Element | null;
  score: number;
  signals: Record<string, number>;
  candidatesConsidered: number;
  method: 'fast-path-selector' | 'fast-path-xpath' | 'recovery-scan' | 'none';
}

const TESTID_ATTRS = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-automation-id',
  'data-test-id',
];

const CURATED_ATTR_PREFIXES = ['aria-', 'data-'];
const CURATED_ATTRS = ['role', 'type', 'name', 'href', 'alt', 'title', 'placeholder'];

/** Framework-generated ids look like `radix-:r4:`, `mui-12`, `:R2j7:`, long hex/uuid blobs, etc. */
function isStableId(id: string): boolean {
  if (!id) return false;
  if (id.length > 60) return false;
  if (/^:.*:$/.test(id)) return false; // React useId() default pattern
  if (/^(radix|mui|headlessui|react|ember|ng|css)[-:]/i.test(id)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false; // uuid
  if (/\d{4,}/.test(id) && /^[a-z]*[-_]?\d{4,}$/i.test(id)) return false; // trailing-number id soup
  return true;
}

/** Utility/CSS-module/hashed classes churn on every build; only keep human-authored-looking ones. */
function isStableClass(cls: string): boolean {
  if (!cls || cls.length > 40) return false;
  if (cls === 'style-scope') return false;
  if (/^(css|sc|styled|jsx|emotion|mui|MuiBox|ng-|_)/.test(cls)) return false;
  if (/[0-9a-f]{6,}/i.test(cls)) return false; // looks like a content hash
  if (/^[a-z]+-\d+$/i.test(cls) && /\d{3,}/.test(cls)) return false;
  if (/--?[a-z0-9]{5,}$/i.test(cls) && /\d/.test(cls)) return false; // trailing hash-ish suffix
  return true;
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * True when text carries no visible characters at all - empty,
 * whitespace-only, or only zero-width/format characters (`\u200b` etc.
 * survive both `trim()` and `\s`, so a bare check would treat them as
 * content). Such text is never a value; callers use this to keep
 * invisible-only runs from becoming extracted values that the settle
 * loop would then confirm and lock in instead of waiting for real text.
 */
export function isEffectivelyEmpty(text: string): boolean {
  return normalizeText(text).replace(/[\u200b-\u200d\u2060]/g, '') === '';
}

/** Recognized naming conventions for a visually-hidden/screen-reader-only element. Only a fallback signal - see `isVisuallyHidden`. */
const SR_ONLY_CLASS_RE =
  /(^|\s)(sr-only|visually-hidden|screen-reader-only|screenreader-only|a11y-hidden|visuallyhidden|assistive-text|offscreen)(\s|$)/i;

/**
 * `true` for an element whose text is exposed to assistive tech but not
 * rendered visibly to a sighted user - the "visually hidden" pattern
 * used across virtually every design system (Bootstrap's `.sr-only`,
 * Tailwind's, the WAI-ARIA Authoring Practices reference CSS, and
 * countless bespoke ones) to give an icon-only control or a bare number
 * a readable accessible name ("Views", "Likes") alongside the value
 * that's actually shown on screen ("5.7K").
 *
 * Matching only a known class name (the original check here) silently
 * misses the common case: CSS-in-JS/atomic-CSS systems apply the exact
 * same clip-to-nothing recipe through a generated/hashed class whose
 * rules live in a stylesheet, not through a name any of these regexes
 * would recognize. Left unhandled, that hidden duplicate text can be
 * read as if it were the displayed value - a generic accessibility
 * label like "Views" reported as a monitor's value instead of the "5.7K"
 * actually on screen. This checks the real, rendered box (via computed
 * style) for the standard "shrink to ~1px and clip the overflow"
 * technique in addition to the class-name shortcut, so detection holds
 * regardless of *how* a site chose to hide the text - no site-specific
 * class names or selectors required. Degrades to the class-name/
 * attribute checks alone when no live `window` is available (the
 * offscreen document parsing fetched HTML has no computed styles to
 * consult), same as every other viewport-dependent signal in this file.
 */
export function isVisuallyHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).hidden) return true;

  const className = typeof el.className === 'string' ? el.className : '';
  if (SR_ONLY_CLASS_RE.test(className)) return true;

  const view = el.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  let cs: CSSStyleDeclaration;
  try {
    cs = view.getComputedStyle(el);
  } catch {
    return false;
  }
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;

  // The classic "clip to nothing" recipe: absolutely/fixed positioned,
  // shrunk to a ~1px box, with overflow (or an explicit clip/clip-path)
  // making sure nothing spills out visibly. Every mainstream sr-only
  // recipe is exactly this box geometry, independent of the class name
  // used to apply it.
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    const width = parseFloat(cs.width);
    const height = parseFloat(cs.height);
    const clipped =
      cs.overflow === 'hidden' ||
      (cs.clip && cs.clip !== 'auto') ||
      (cs.getPropertyValue('clip-path') && cs.getPropertyValue('clip-path') !== 'none');
    if (Number.isFinite(width) && Number.isFinite(height) && width <= 1 && height <= 1 && clipped) {
      return true;
    }
  }

  return false;
}

/**
 * True when `el` itself or any ancestor up to the document root is
 * hidden from sighted users. `isVisuallyHidden` above only describes
 * the element's own box — but `display` is not inherited, so a
 * `display: none` (or `hidden` / `visibility: hidden`) ancestor still
 * reports a perfectly visible box for the element itself while
 * rendering nothing on screen. Reading such a subtree returns stale
 * content (a hidden tab pane, a toggled-off section, pre-swap content)
 * as if it were the current value — demonstrated on both strategies,
 * since computed styles describe the element, never its ancestors.
 *
 * Deliberately narrow: the `hidden` attribute, inline
 * `display: none` / `visibility: hidden|collapse`, and (when a window
 * is available) their computed equivalents. `aria-hidden` ancestors
 * never count (assistive-tech-only hiding; the content is still
 * visibly rendered — single-page rolling counters depend on this),
 * and class-driven hiding is only trusted via computed styles, never
 * by class name alone. Bounded walk; never throws.
 */
export function isHiddenFromView(el: Element, win?: Window): boolean {
  if (isVisuallyHidden(el)) return true;
  const view =
    win && typeof win.getComputedStyle === 'function'
      ? win
      : el.ownerDocument?.defaultView &&
          typeof el.ownerDocument.defaultView.getComputedStyle === 'function'
        ? el.ownerDocument.defaultView
        : null;
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 25) {
    if ((node as HTMLElement).hidden || (node.hasAttribute?.('hidden') ?? false)) return true;
    const inline = node.getAttribute?.('style') ?? '';
    if (/(^|;)\s*display\s*:\s*none(\s|;|$|!)/i.test(inline)) return true;
    if (/(^|;)\s*visibility\s*:\s*(hidden|collapse)(\s|;|$|!)/i.test(inline)) return true;
    if (view) {
      try {
        const cs = view.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
          return true;
        }
      } catch {
        // Unreadable node (detached mid-check, cross-origin): keep walking.
      }
    }
    if (node === node.ownerDocument?.documentElement) break;
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

/**
 * Extracts visible text while skipping subtrees hidden from assistive tech
 * or sighted users. If all child nodes are visually hidden (e.g. animated rolling
 * digit counters marked aria-hidden="true" on YouTube), falls back to the container's
 * aria-label attribute.
 */
export function extractVisibleText(root: Element): string {
  const parts: string[] = [];
  // Text skipped as hidden: the aria-label fallback below exists for
  // content that IS there but hidden (e.g. an aria-hidden digit strip
  // described by the label) - never for a truly empty element, where
  // the label would masquerade as a value instead of letting the
  // caller wait for real text.
  let skippedHiddenLength = 0;

  function walk(node: Node): void {
    if (node.nodeType === 3) {
      const t = node.textContent ?? '';
      if (!t || isEffectivelyEmpty(t)) return;
      parts.push(t);
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
  const text = normalizeText(parts.join(' '));
  if (text) return text;

  if (skippedHiddenLength === 0) return '';

  const ariaLabel = root.getAttribute('aria-label');
  if (ariaLabel) {
    const normalized = normalizeText(ariaLabel);
    if (normalized) return normalized;
  }

  return '';
}

export function classifyTextPattern(text: string): TextPattern {
  const t = normalizeText(text);
  if (!t) return 'empty';
  if (/^[+-]?[\d,.\s]+%$/.test(t)) return 'percentage';
  if (/^[+-]?[$€£¥₹]\s?[\d,.\s]+$/.test(t) || /^[+-]?[\d,.\s]+\s?(usd|eur|gbp|inr)$/i.test(t)) {
    return 'currency';
  }
  if (/^[+-]?[\d,.\s]+$/.test(t)) return 'numeric';
  if (
    /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(t) ||
    /^[a-z]{3,9}\s+\d{1,2},?\s+\d{4}$/i.test(t) ||
    /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/i.test(t)
  ) {
    return 'date';
  }
  return t.length <= 40 ? 'short-text' : 'long-text';
}

export function findLabelText(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id) {
    const doc = el.ownerDocument;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    try {
      const label = doc.querySelector(`label[for="${escaped}"]`);
      if (label?.textContent) return normalizeText(label.textContent);
    } catch {
      // Invalid id for a selector (e.g. contains characters CSS.escape didn't cover) — skip.
    }
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const doc = el.ownerDocument;
    const parts = labelledBy
      .split(/\s+/)
      .map((refId) => doc.getElementById(refId)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return normalizeText(parts.join(' '));
  }

  const closestLabel = el.closest('label');
  if (closestLabel?.textContent) return normalizeText(closestLabel.textContent);

  // A preceding sibling *element* that reads like a label (short text, ends without terminal
  // punctuation mid-sentence) is a common pattern for dashboard "Label: Value" pairs without
  // semantic markup.
  let sib = el.previousElementSibling;
  let hops = 0;
  while (sib && hops < 3) {
    const text = normalizeText(sib.textContent ?? '');
    if (text && text.length <= 60) return text;
    sib = sib.previousElementSibling;
    hops += 1;
  }

  // No preceding label *element* — but a unit/label word is just as
  // often plain text sitting directly alongside the value with nothing
  // marking it up as its own element at all ("<span>1,234</span>
  // followers", "$<span>49.99</span>", "<b>42</b> comments"), or in a
  // trailing element rather than a leading one. `previousElementSibling`
  // above only ever sees *leading element* siblings; this covers the
  const siblingLabel = findSiblingNodeLabel(el);
  if (siblingLabel) return siblingLabel;

  return null;
}

/**
 * Scans `el`'s immediate siblings inside its parent - both raw text
 * nodes and elements - for something that reads like a label, trailing
 * siblings first. See the fallback comment in `findLabelText` above for
 * why this exists as a separate pass from the leading-element-only
 * check there.
 */
function findSiblingNodeLabel(el: Element): string | null {
  const parent = el.parentElement;
  if (!parent) return null;
  const children = Array.from(parent.childNodes);
  const index = children.indexOf(el as unknown as ChildNode);
  if (index === -1) return null;

  return scanSiblingNodesForLabel(children, index + 1, 1) ?? scanSiblingNodesForLabel(children, index - 1, -1);
}

function scanSiblingNodesForLabel(nodes: ChildNode[], start: number, step: 1 | -1): string | null {
  let hops = 0;
  for (let i = start; i >= 0 && i < nodes.length && hops < 3; i += step, hops += 1) {
    const node = nodes[i]!;
    if (node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE) continue;
    const text = normalizeText(node.textContent ?? '');
    if (text && text.length <= 60) return text;
  }
  return null;
}

/**
 * `true` for a path that looks like it identifies one specific piece of
 * content rather than a generic nav destination - a path *segment*
 * that's a bare, long-enough digit run (tweet/comment/video ids are
 * almost always this) or a well-known permalink keyword (`/status/`,
 * `/comments/`, `/watch/`, `/p/`, etc). Best-effort by design: it only
 * has to be right often enough to beat "no identity signal at all",
 * not be a universal permalink parser.
 *
 * The digit check is deliberately anchored to a whole path *segment*
 * (`/^\d{4,}$/` per segment, not `/\d{4,}/` against the full pathname)
 * - the latter also matches a long digit run embedded inside an
 * unrelated alphanumeric segment, e.g. an account/tenant hash like
 * `4f3126d047aa8d4ba12493821ed9dbce` in a dashboard URL. That's a
 * generic nav destination, not a piece of content with its own
 * permalink, and callers that redirect an entire check to this path
 * (see `lib/monitors/itemUrl.ts`) need that distinction to actually
 * hold, not just be true often enough for scoring.
 */
export function isPermalinkPath(pathname: string): boolean {
  if (/\/(status|statuses|comments?|posts?|p|watch|videos?|shorts|live)(\/|$)/i.test(pathname)) return true;
  return pathname.split('/').some((segment) => /^\d{4,}$/.test(segment));
}

/**
 * Cross-site tracking/session query parameters that commonly vary
 * between two renders of the exact same permalink (a referral source
 * Twitter/X attaches inconsistently, a share token, a click-tracking
 * id) without indicating a different piece of content at all. Stripped
 * before comparing two permalinks' identity so this kind of noise never
 * causes a false "different item" conflict.
 *
 * Deliberately not a blanket "drop the whole query string": some sites
 * put the actual content id in the query rather than the path (YouTube's
 * `/watch?v=…`, and the same shape elsewhere) — for those, the query
 * *is* the identity, exactly like a path segment would be on a site
 * shaped like Twitter's `/status/…`. A param not on this list is kept
 * and treated as part of the item's identity.
 */
export const TRACKING_QUERY_PARAMS = new Set([
  's', 't', 'ref', 'ref_src', 'ref_url', 'si', 'feature', 'pp',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'igshid', 'mc_cid', 'mc_eid', 'spm', 'context',
  '_hsenc', '_hsmi',
]);

/**
 * Identity key for a confirmed permalink `href`, used only for the
 * item-identity equality check in `scoreCandidate` — never for
 * navigation (`resolveCheckUrl` still uses the full, unmodified
 * `href`). Two renders of the *same* permalink (before a scroll/rerender
 * and after, or the feed vs. the item's own page) can carry different
 * tracking query strings even though the path — which is what actually
 * identifies the specific post/tweet/comment on most sites (see
 * `isPermalinkPath`, which only ever looks at path segments) — is
 * unchanged. Comparing the raw strings would treat that as a *different*
 * item — backwards, and actively harmful two ways at once: it falsely
 * clamps the genuinely correct candidate as a conflict, while leaving a
 * truly different item's candidate free of that same clamp because *its*
 * href doesn't collide either. A trailing slash is normalized away for
 * the same reason — some renders include one, some don't, for the
 * identical path. Only known tracking params (see `TRACKING_QUERY_PARAMS`)
 * are dropped from the query — any other param is kept and sorted for a
 * stable comparison, since on some sites (YouTube's `/watch?v=…`) it's
 * the query, not the path, that actually names the content.
 */
function permalinkIdentity(href: string): string {
  const [rawPath, query] = href.split('?');
  const path = (rawPath ?? href).replace(/\/+$/, '');
  if (!query) return path;
  const params = new URLSearchParams(query);
  for (const key of Array.from(params.keys())) {
    if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) params.delete(key);
  }
  params.sort();
  const remaining = params.toString();
  return remaining ? `${path}?${remaining}` : path;
}

/**
 * Link text — or, more generally, any short row-level text — that
 * identifies nothing about which row it's on because it's the same
 * boilerplate on every row alike ("Edit", "View", "Permalink", "Read
 * more"). Must never be trusted as that row's identity, whether it
 * comes from a link (`looksLikeRowLink`) or from general row text
 * (`findPrimaryText`) - a value that's identical across every
 * candidate doesn't discriminate between them, it just inflates every
 * candidate's score equally, which is actively counterproductive for
 * telling the right one apart from the wrong one.
 */
const GENERIC_ROW_TEXT =
  /^(edit|delete|remove|view|open|more|menu|options?|details?|manage|settings|share|download|export|permalink|link|post|tweet|comment|reply|item|row|entry|record|see more|read more|learn more|show more|\.{2,3}|…|→|›|»)$/i;

/**
 * `true` for a link that plausibly identifies *this* row rather than
 * being a generic action shared by every row - a non-trivial path
 * (more than just a query string or single trivial segment) whose
 * link text isn't one of the generic action words above. This is the
 * fallback identity source for dashboard/table rows that link to a
 * detail page without an ID-shaped path (e.g. a domain's own overview
 * page: `/domains/example.com/overview`).
 */
function looksLikeRowLink(url: URL, linkText: string): boolean {
  if (GENERIC_ROW_TEXT.test(linkText.trim())) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length > 0 && segments.some((s) => s.length > 2);
}

/**
 * Attributes that identify *which* record a row holds, as opposed to
 * *where* it currently sits. Intentionally excludes positional
 * attributes virtualization libraries commonly stamp on rows -
 * `data-index`, `data-rowindex`/`data-row-index`, `aria-rowindex` - all
 * of which describe the row's current visual slot and get reassigned
 * to a *different* record the moment the list scrolls or re-sorts,
 * which is exactly the failure mode a row identity signal exists to
 * avoid.
 */
const ROW_KEY_ATTRS = [
  'data-row-key',
  'data-rowid',
  'data-row-id',
  'data-item-id',
  'data-record-id',
  'data-entity-id',
  'data-key',
  'data-node-id',
];

/** Reads a stable record-identity attribute off `el` itself, if any — see `ROW_KEY_ATTRS`. */
function findRowKey(el: Element): string | null {
  for (const attr of ROW_KEY_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return `${attr}=${value}`;
  }
  // A hand-authored `id` (not framework-generated, see `isStableId`) on
  // a row-shaped element is just as much a record identifier as the
  // attributes above.
  if (el.id && isStableId(el.id)) return `id=${el.id}`;
  return null;
}

const INLINE_CUSTOM_TAGS = new Set([
  'YT-FORMATTED-STRING',
  'YT-ICON',
  'YT-ICON-BUTTON',
  'BADGE-SHAPE',
  'TP-YT-PAPER-TOOLTIP',
  'YT-TOUCH-FEEDBACK-SHAPE',
  'YT-INTERACTION',
]);

const ITEM_RENDERER_TAG_RE =
  /(item|video|thread|post|reel|entry|card|row)-renderer$/i;

/** `true` for tag/role/attribute patterns that commonly mark one repeated feed/list/table entry (a tweet, post, comment, table row, grid row) as opposed to a generic layout wrapper. */
function looksLikeItemRoot(el: Element): boolean {
  if (INLINE_CUSTOM_TAGS.has(el.tagName)) return false;
  if (el.tagName === 'ARTICLE' || el.tagName === 'LI' || el.tagName === 'TR') return true;
  const role = el.getAttribute('role');
  if (role === 'article' || role === 'listitem' || role === 'row') return true;
  const testid = TESTID_ATTRS.map((a) => el.getAttribute(a)).find(Boolean);
  if (testid && /cell|item|card|row|post|comment|tweet|thread|story|message|activity|notification|reply/i.test(testid)) return true;
  // Virtualized/data-grid libraries (react-window, react-virtualized,
  // AG Grid, MUI DataGrid, TanStack Table, and most bespoke dashboard
  // tables built the same way) mark their per-record row wrapper with
  // one of these rather than a semantic tag or role.
  if (ROW_KEY_ATTRS.some((attr) => el.hasAttribute(attr))) return true;
  if (ITEM_RENDERER_TAG_RE.test(el.tagName) || el.tagName === 'SHREDDIT-POST') return true;
  if (!el.tagName.includes('-')) return false;
  const parent = el.parentElement;
  if (!parent) return false;
  for (const sibling of parent.children) {
    if (sibling !== el && sibling.tagName === el.tagName) return true;
  }
  return false;
}

/**
 * Up to `MAX_TEXT_RUNS_PER_ROOT` short, non-numeric-looking text runs
 * inside `root`, in document order — candidate proxies for "this row's
 * name/label column" when nothing more authoritative (link, timestamp,
 * record-id attribute) is available. Bounded (not just first-match) so
 * the result is cacheable per `root` across every candidate that maps
 * to it (see `findItemAnchor`'s `cache` parameter): each candidate's
 * own text is excluded from the pool *after* this runs, so the same
 * few runs found once can serve every candidate under that root rather
 * than each one re-walking the subtree with its own exclusion baked
 * in. Deliberately loose: this only ever feeds a soft similarity
 * signal (see `scoreCandidate`), never an authoritative override, so a
 * false match just contributes a little rather than silently
 * mis-anchoring a monitor.
 */
function findPrimaryTextRuns(root: Element, limit: number): string[] {
  // Manual walk (not `TreeWalker`) so this behaves identically whether
  // `NodeFilter` happens to be a global in this environment (a real page,
  // via `window`) or not (the offscreen `DOMParser` document, or a test
  // harness) - the same reasoning `extractVisibleText`/`visibleTextRuns`
  // in `locate.ts` already follow.
  const runs: string[] = [];
  function walk(node: Node): void {
    if (runs.length >= limit) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeText(node.textContent ?? '');
      if (
        text &&
        text.length <= 60 &&
        !GENERIC_ROW_TEXT.test(text) &&
        classifyTextPattern(text) !== 'numeric' &&
        classifyTextPattern(text) !== 'percentage'
      ) {
        runs.push(text);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (isVisuallyHidden(el)) return;
    if (SKIP_TEXT_TAGS.has(el.tagName)) return;
    for (const child of Array.from(node.childNodes)) {
      walk(child);
      if (runs.length >= limit) return;
    }
  }
  for (const child of Array.from(root.childNodes)) {
    walk(child);
    if (runs.length >= limit) break;
  }
  return runs;
}

const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// Deliberately generous: production feed markup (X's action-bar icon+count
// buttons chief among them - independently documented as deeply-nested
// "div soup", https://css-tricks.com/twitters-div-soup-and-uglyfied-css-explained/)
// routinely puts 10-16 wrapper elements between a metric's own text node and
// its enclosing <article>. A limit tuned for a "normal" site's nesting depth
// silently produces a null itemAnchor for exactly the deeply-nested feed
// sites this signal exists to help most - the failure mode is invisible at
// capture time (buildFingerprint doesn't error, it just anchors to nothing)
// and only shows up later as a wrongly-recovered sibling item's value or a
// "No value" result. The walk itself stays cheap either way - it's a single
// upward pointer-chase per call, not a subtree scan.
const MAX_ITEM_ROOT_HOPS = 20;
/** How many candidate label-text runs to collect per item root - enough headroom for one of them to not be whichever candidate's own text is being excluded, without an unbounded subtree walk. */
const MAX_TEXT_RUNS_PER_ROOT = 8;

/** The part of `findItemAnchor`'s result that depends only on the item root, not on which specific descendant asked - see `findItemAnchor`'s `cache` parameter. */
interface RootAnchorData {
  datetime: string | null;
  rowKey: string | null;
  href: string | null;
  isPermalink: boolean;
  textRuns: string[];
}

/** Per-root memo for `findItemAnchor` - see its `cache` parameter. */
export type ItemAnchorCache = Map<Element, RootAnchorData>;

/** The expensive part of `findItemAnchor`: scanning `root`'s own subtree for its identity signals. Factored out so it can be computed once per root and cached (see `findItemAnchor`). */
function computeRootAnchorData(root: Element): RootAnchorData {
  const time = root.querySelector?.('time[datetime]');
  const datetime = time?.getAttribute('datetime') ?? null;

  const rowKey = findRowKey(root);

  let href: string | null = null;
  let weakHref: string | null = null;
  let isPermalink = false;
  const links = root.querySelectorAll?.('a[href]') ?? [];
  for (const link of Array.from(links)) {
    const raw = link.getAttribute('href');
    if (!raw) continue;
    try {
      const url = new URL(raw, root.ownerDocument.baseURI);
      if (isPermalinkPath(url.pathname)) {
        href = url.pathname + url.search;
        isPermalink = true;
        break;
      }
      // A dashboard/table row very often links to its own detail page
      // without an ID-shaped path (a domain, a project slug, an order
      // reference) - keep the first plausible one as a fallback identity
      // if no permalink-shaped link turns up anywhere in the row.
      if (!weakHref && looksLikeRowLink(url, normalizeText(link.textContent ?? ''))) {
        weakHref = url.pathname + url.search;
      }
    } catch {
      // Unparseable href (e.g. "javascript:void(0)") - skip it.
    }
  }
  if (!href) href = weakHref;

  const textRuns = findPrimaryTextRuns(root, MAX_TEXT_RUNS_PER_ROOT);

  return { datetime, rowKey, href, isPermalink, textRuns };
}

/**
 * Finds the identity of the feed/list item `el` lives inside, if any -
 * see `ItemAnchor`. This is what lets recovery tell "the like button on
 * the tweet I'm actually watching" apart from "the like button on
 * whichever tweet happens to occupy the same sibling index right now",
 * which is the difference between a monitor that survives a virtualized
 * list re-rendering, recycling, or reordering its items (X/Twitter's
 * timeline chief among them - every tweet's action row is structurally
 * identical to every other tweet's, so position is the *only* thing
 * that otherwise tells two tweets' like buttons apart) and one that
 * quietly starts reading a different item's number.
 *
 * Walks up to the nearest ancestor that looks like an item boundary
 * (`looksLikeItemRoot`), bounded by `MAX_ITEM_ROOT_HOPS` — so this stays
 * a single bounded scan even when called once per candidate during a
 * recovery scan of hundreds of elements. If no such boundary is found
 * within that limit, this returns `null` rather than falling back to
 * whatever ancestor it stopped at: that ancestor could easily span
 * *multiple* items (a whole feed's scroll container, a table's
 * `<tbody>`) rather than exactly one, and deriving an identity from a
 * subtree that broad is worse than having no identity signal at all —
 * it risks picking up a *neighboring* item's link/timestamp/row-id and
 * presenting it as this one's, which is exactly the false-positive this
 * signal exists to prevent.
 *
 * `cache`, when supplied, memoizes the expensive root-subtree scan
 * (`computeRootAnchorData` - a `querySelector`/`querySelectorAll` pass
 * plus a bounded text walk) per item root rather than per call. A
 * single recovery scan routinely calls this once per *candidate*, and
 * many candidates (every cell in the same table row, every child of
 * the same feed item) resolve to the very same root - without a cache
 * that root's subtree gets rescanned from scratch for each one of
 * them. Only the tiny, `el`-specific part (excluding this particular
 * candidate's own text from the cached label-text pool) runs on every
 * call regardless. Callers that don't pass a cache (e.g. the one-off
 * call from `buildFingerprint` at capture time) get the same result as
 * before, just always computed fresh.
 */
export function findItemAnchor(el: Element, cache?: ItemAnchorCache): ItemAnchor | null {
  let node: Element | null = el;
  let hops = 0;
  let bestAnchor: ItemAnchor | null = null;
  while (node && hops < MAX_ITEM_ROOT_HOPS) {
    if (looksLikeItemRoot(node)) {
      const root = node;
      let data = cache?.get(root);
      if (!data) {
        data = computeRootAnchorData(root);
        cache?.set(root, data);
      }
      const ownText = normalizeText(el.textContent ?? '');
      const primaryText = data.textRuns.find((text) => text !== ownText) ?? null;
      if (data.datetime || data.href || data.rowKey || primaryText) {
        const anchor: ItemAnchor = {
          href: data.href,
          isPermalink: data.isPermalink,
          datetime: data.datetime,
          rowKey: data.rowKey,
          primaryText,
        };
        if (anchor.isPermalink || anchor.rowKey) {
          return anchor;
        }
        if (!bestAnchor) bestAnchor = anchor;
      }
    }
    node = node.parentElement;
    hops += 1;
  }
  return bestAnchor;
}

function isLevelOneHeading(el: Element): boolean {
  if (el.tagName === 'H1') return true;
  return el.getAttribute('role') === 'heading' && el.getAttribute('aria-level') === '1';
}

function isAnyHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
}

function findLandmarkText(el: Element): string | null {
  // Two-phase walk: page identity (H1 / level-1 heading) wins over
  // section headings (H2/H3, e.g. a lazily-mounted "Up next" shelf
  // inserted between the title and the target). A single-pass
  // nearest-heading search lets that insertion hijack the landmark and
  // trip the identity-conflict clamp for the correct element. H1-first
  // keeps same-page recovery stable while a genuine H1 change (a
  // different video/article) still mismatches and stays rejected.
  for (let phase = 0; phase < 2; phase += 1) {
    const levelOneOnly = phase === 0;
    let node: Element | null = el;
    let hops = 0;
    while (node && hops < 8) {
      let sib = node.previousElementSibling;
      let sibHops = 0;
      while (sib && sibHops < 6) {
        const isMatch = levelOneOnly ? isLevelOneHeading(sib) : isAnyHeading(sib);
        if (isMatch) {
          const text = normalizeText(sib.textContent ?? '');
          if (text) return text.slice(0, 80);
        }
        sib = sib.previousElementSibling;
        sibHops += 1;
      }
      const heading = node.querySelector?.(
        levelOneOnly ? 'h1, [role="heading"][aria-level="1"]' : 'h1, h2, h3, [role="heading"]',
      );
      if (heading && heading !== el) {
        const text = normalizeText(heading.textContent ?? '');
        if (text) return text.slice(0, 80);
      }
      node = node.parentElement;
      hops += 1;
    }
  }
  return null;
}

function buildDomPath(el: Element): string[] {
  const path: string[] = [];
  let node: Element | null = el;
  let hops = 0;
  while (node && node.nodeType === 1 && hops < 12) {
    if (node.id && isStableId(node.id)) {
      path.unshift(`#${node.id}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    let segment = node.tagName.toLowerCase();
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTagSiblings.length > 1) {
        segment += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
      }
    }
    path.unshift(segment);
    node = parent;
    hops += 1;
    if (!parent) break;
  }
  return path;
}

function buildXPath(el: Element): string {
  if (el.id && isStableId(el.id)) {
    return `//*[@id="${el.id}"]`;
  }
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    let index = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) index += 1;
      sib = sib.previousElementSibling;
    }
    segments.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = node.parentElement;
  }
  return `/${segments.join('/')}`;
}

/**
 * CSS selector for the fast path. Prefers a stable id; otherwise builds
 * a short tag+class+nth-of-type chain, crossing shadow-DOM boundaries
 * with ` >>> ` (matching DevTools' convention) since `querySelector`
 * cannot pierce shadow roots on its own.
 */
function buildCssSelector(el: Element): string {
  const segments: string[] = [];
  let parts: string[] = [];
  let node: Element | null = el;
  let steps = 0;

  while (node && node.nodeType === 1 && steps < 10) {
    if (node.id && isStableId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      // A stable id is sufficient to anchor the rest of *this* segment -
      // no need to keep walking plain ancestor parts within the same
      // root. But stopping the walk outright here (as opposed to merely
      // stopping *this segment's* parts) would produce a bare `#id`
      // selector for an id'd element that lives inside one or more
      // shadow roots - a selector `querySelector`/`deepQuerySelector`
      // can never resolve, since it never gets the `>>> ` prefix needed
      // to actually reach that shadow root first. Web-component-heavy
      // pages very often give a *descendant* inside their shadow DOM a
      // plain, stable, human-authored id (YouTube's Polymer components
      // do this throughout - `#subscriber-count`, `#count`, `#menu`) -
      // exactly the case this must keep working for. So: fall through to
      // the same shadow-boundary check every other node hits, instead of
      // unconditionally stopping, and only actually stop once there's no
      // further shadow root to cross.
      const idRoot = node.getRootNode();
      if (idRoot instanceof ShadowRoot) {
        segments.unshift(parts.join(' > '));
        parts = [];
        node = idRoot.host;
        steps += 1;
        continue;
      }
      node = null;
      break;
    }
    let part = node.tagName.toLowerCase();
    const stableClasses = Array.from(node.classList).filter(isStableClass).slice(0, 2);
    if (stableClasses.length > 0) {
      part += stableClasses.map((c) => `.${CSS.escape(c)}`).join('');
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((s) => s.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    steps += 1;

    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      segments.unshift(parts.join(' > '));
      parts = [];
      node = root.host;
    } else {
      node = null;
    }
  }
  if (parts.length > 0) segments.unshift(parts.join(' > '));
  return segments.join(' >>> ');
}

function curatedAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const isCurated =
      CURATED_ATTR_PREFIXES.some((p) => name.startsWith(p)) || CURATED_ATTRS.includes(name);
    if (!isCurated) continue;
    if (name === 'href') {
      try {
        const url = new URL(attr.value, el.ownerDocument.baseURI);
        out[name] = url.pathname + url.search;
      } catch {
        out[name] = attr.value;
      }
      continue;
    }
    if (attr.value.length > 200) continue;
    out[name] = attr.value;
  }
  return out;
}

/** Resolves a selector that may contain ` >>> ` shadow-piercing segments. */
export function deepQuerySelector(
  root: Document | Element,
  fullSelector: string,
): Element | null {
  const segments = fullSelector
    .split('>>>')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  let currentRoot: Document | Element | ShadowRoot = root;
  let element: Element | null = null;

  for (let i = 0; i < segments.length; i++) {
    element = (currentRoot as Document | Element).querySelector(segments[i]!);
    if (!element) return null;
    if (i < segments.length - 1) {
      if (!element.shadowRoot) return null;
      currentRoot = element.shadowRoot;
    }
  }
  return element;
}

function resolveXPath(doc: Document, xpath: string): Element | null {
  try {
    const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = result.singleNodeValue;
    return node && node.nodeType === 1 ? (node as Element) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort search for the nearest still-resolvable ANCESTOR of the
 * originally-captured element, using nothing but `fp.cssSelector` (the
 * root-to-leaf ancestor chain `buildCssSelector` already builds at
 * capture time, potentially crossing shadow boundaries via ` >>> `).
 *
 * This exists purely as a *readiness* hint - "does the target's own
 * neighborhood exist in the DOM yet, so a wait can be scoped to just
 * that region instead of the whole page" - never as a match. The
 * element `locateElement` actually accepts always still comes from its
 * own full, confidence-scored scan, completely independent of whatever
 * this function returns; a wrong or overly-generic guess here can only
 * cost time (a wait scoped to the wrong place, or no scoping at all),
 * never produce a false-positive extraction.
 *
 * Walks upward starting one level above the captured leaf (the leaf's
 * own segment is deliberately skipped - if it still resolved, the
 * fast-path selector in `locateElement` would already have found the
 * element and none of this would run) until some ancestor segment
 * resolves, or gives up and returns `null` once nothing does - the
 * caller falls back to page-wide readiness in that case, unchanged
 * from before this existed. A resolved ancestor that turns out to be
 * `<body>`/`<html>` itself is treated as no-container: too broad to
 * meaningfully scope a wait to, no better than the page-wide signal it
 * would otherwise replace.
 */
export function findLikelyContainer(doc: Document, fp: ElementFingerprint): Element | null {
  if (!fp.cssSelector) return null;
  const shadowSegments = fp.cssSelector.split('>>>').map((s) => s.trim()).filter(Boolean);
  if (shadowSegments.length === 0) return null;

  // Resolve any outer (shadow-crossing) prefix first - the ancestor
  // walk below only ever happens within the innermost shadow root (or
  // the light document, when there's no shadow crossing at all).
  // Every successfully resolved host is remembered so a leaf-only
  // innermost segment (the normal shape for a stable-id target in
  // shadow DOM, e.g. `#subscriber-count`) can still fall back to its
  // nearest outer host instead of giving up and forcing a page-wide
  // wait on a page that may never go fully quiet.
  const resolvedHosts: Element[] = [];
  let scanRoot: Document | Element | ShadowRoot = doc;
  for (const seg of shadowSegments.slice(0, -1)) {
    let host: Element | null;
    try {
      host = (scanRoot as Document | Element).querySelector(seg);
    } catch {
      break;
    }
    if (!host?.shadowRoot) break;
    if (host !== doc.body && host !== doc.documentElement) resolvedHosts.push(host);
    scanRoot = host.shadowRoot;
  }
  // If the prefix broke partway, only the hosts resolved so far are
  // usable — anything deeper was never reached. The innermost walk
  // below still runs against the deepest reachable root; when it finds
  // nothing, the outward fallback underneath returns the deepest host.
  const prefixFullyResolved =
    resolvedHosts.length === Math.max(0, shadowSegments.length - 1);

  const lastSegment = shadowSegments[shadowSegments.length - 1] ?? '';
  const parts = lastSegment.split('>').map((s) => s.trim()).filter(Boolean);
  // When the prefix itself broke, the stored innermost segment belongs
  // to an unreachable shadow root — resolving it against the deepest
  // reachable root would be a wrong-tree guess, so skip it and fall
  // straight through to the outward host fallback.
  if (prefixFullyResolved) {
    for (let i = parts.length - 2; i >= 0; i--) {
      const selector = parts.slice(0, i + 1).join(' > ');
      let el: Element | null;
      try {
        el = (scanRoot as Document | Element).querySelector(selector);
      } catch {
        continue;
      }
      if (el && el !== doc.body && el !== doc.documentElement) return el;
    }
  }
  // Outward fallback: the innermost segment was leaf-only (a bare
  // stable id) or its ancestors no longer resolve — scope the wait to
  // the nearest still-mounted outer shadow host rather than the whole
  // page. Readiness-only hint, never a match, so a broader-than-ideal
  // host only costs time, never correctness.
  for (let k = resolvedHosts.length - 1; k >= 0; k -= 1) {
    const host = resolvedHosts[k]!;
    if (host.isConnected && host !== doc.body && host !== doc.documentElement) return host;
  }
  // Leaf fallback: a light-DOM leaf-only selector (a bare stable id
  // like `#owner-sub-count`) has neither ancestor parts nor outer
  // hosts to fall back to. If the leaf itself still resolves, scope to
  // its parent — the target's own neighborhood — rather than the whole
  // endlessly-mutating page. Readiness-only hint, never a match.
  try {
    const leaf = deepQuerySelector(doc, fp.cssSelector);
    if (leaf?.isConnected) {
      const parent = leaf.parentElement;
      if (parent && parent.isConnected && parent !== doc.body && parent !== doc.documentElement) return parent;
      if (leaf !== doc.body && leaf !== doc.documentElement) return leaf;
    }
  } catch {
    // Invalid selector — no container.
  }
  return null;
}

/** Builds a full fingerprint for `el`. `win` defaults to the element's own view (absent in parsed-HTML documents). */
export function buildFingerprint(el: Element, win?: Window, textAnchor: TextAnchor | null = null): ElementFingerprint {
  const doc = el.ownerDocument;
  const parent = el.parentElement;
  const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === el.tagName) : [el];

  let depth = 0;
  let node: Element | null = el;
  while (node.parentElement) {
    node = node.parentElement;
    depth += 1;
  }

  const testIdAttr = TESTID_ATTRS.find((a) => el.hasAttribute(a));
  const visible = extractVisibleText(el);
  const text = visible || normalizeText(el.getAttribute('aria-label') ?? '') || normalizeText(el.textContent ?? '');

  let relativeBox: ElementFingerprint['relativeBox'] = null;
  const view = win ?? el.ownerDocument.defaultView;
  if (view && typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect();
    const vw = view.innerWidth || 1;
    const vh = view.innerHeight || 1;
    if (rect.width > 0 || rect.height > 0) {
      relativeBox = {
        x: rect.left / vw,
        y: (rect.top + (view.scrollY ?? 0)) / (view.document.documentElement.scrollHeight || vh),
        w: rect.width / vw,
        h: rect.height / vh,
      };
    }
  }

  return {
    version: 6,
    id: el.id && isStableId(el.id) ? el.id : null,
    dataTestId: testIdAttr ? el.getAttribute(testIdAttr) : null,
    ariaLabel: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    name: el.getAttribute('name'),
    tag: el.tagName.toLowerCase(),
    cssSelector: buildCssSelector(el),
    xpath: buildXPath(el),
    domPath: buildDomPath(el),
    classSignature: Array.from(el.classList).filter(isStableClass).slice(0, 6),
    attributes: curatedAttributes(el),
    nearbyLabelText: findLabelText(el),
    textSnapshot: text.slice(0, 200),
    textPattern: classifyTextPattern(text),
    textAnchor,
    siblingIndex: siblings.indexOf(el),
    siblingCount: siblings.length,
    depth,
    relativeBox,
    landmarkText: findLandmarkText(el),
    itemAnchor: findItemAnchor(el),
    capturedAt: Date.now(),
  };
}

/**
 * Builds a last-resort re-anchor fingerprint from an existing monitor's
 * own trusted data: the stored fingerprint's full structural/context/
 * identity signals (selector, domPath, classes, attributes, labels,
 * landmark, item anchor — everything describing *where* the value
 * lives) combined with fresh value memory (snapshot, pattern, anchor)
 * rebuilt from the monitor's last known good value.
 *
 * This addresses exactly one corruption class: stale or hijacked
 * *value memory*. A stored anchor/snapshot from a neighboring element
 * (persisted before the kind gates existed) or from a value the page
 * has long since moved past actively misleads recovery three ways at
 * once — the anchor-value/text-shape/semantic similarity signals all
 * vote against the true element, `preferAnchorKindToken` narrows to
 * the wrong kind, and the kind gate can outright reject the true
 * element. Rebuilding value memory from `lastValue` removes all three
 * while changing nothing else, so the standard pipeline (same
 * thresholds, same kind/sign/frame-echo gates, same ambiguity rule)
 * judges the re-anchor attempt with identical strictness.
 *
 * Returns `null` when there is no usable value memory to rebuild from
 * (no value yet, or an effectively empty one) — the caller then keeps
 * the primary failure untouched. Never invents structural signals: a
 * fingerprint whose *structure* no longer matches anything still fails
 * honestly (and the checker names that terminal state separately),
 * rather than guessing from a bare value.
 */
export function buildReanchorFingerprint(
  stored: ElementFingerprint,
  lastValue: string | null | undefined,
): ElementFingerprint | null {
  if (!lastValue || isEffectivelyEmpty(lastValue)) return null;
  const snapshot = normalizeText(lastValue).slice(0, 200);
  if (!snapshot) return null;
  const anchor: TextAnchor = stored.textAnchor
    ? { value: lastValue, before: stored.textAnchor.before, after: stored.textAnchor.after }
    : { value: lastValue, before: '', after: '' };
  return {
    ...stored,
    textSnapshot: snapshot,
    textPattern: classifyTextPattern(lastValue),
    textAnchor: anchor,
  };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function attrJaccard(a: Record<string, string>, b: Record<string, string>): number {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length === 0 && keysB.length === 0) return 1;
  if (keysA.length === 0 || keysB.length === 0) return 0;
  let matches = 0;
  for (const k of keysA) {
    if (b[k] !== undefined && b[k] === a[k]) matches += 1;
    else if (b[k] !== undefined) matches += 0.4; // key present but value drifted (e.g. a counter)
  }
  return matches / Math.max(keysA.length, keysB.length);
}

function domPathSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Compare from the end (closest to the element) since that's the part
  // least likely to have shifted; ancestor chains near the root are
  // more prone to unrelated restructuring.
  let matches = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 1; i <= len; i++) {
    if (a[a.length - i] === b[b.length - i]) matches += 1;
    else break;
  }
  return matches / Math.max(a.length, b.length);
}

function textSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0.3;
  const la = a.length;
  const lb = b.length;
  const diff = Math.abs(la - lb);
  const maxLen = Math.max(la, lb, 1);
  const startsSame = a.slice(0, 3) === b.slice(0, 3) ? 0.2 : 0;
  return Math.max(0, 1 - diff / maxLen) * 0.8 + startsSame;
}

/**
 * Scores how well `candidate` matches the captured `fp`. Weighted,
 * signal-transparent. `itemAnchorCache`, when supplied, is forwarded to
 * `findItemAnchor` so repeated calls across candidates that share an
 * item root reuse that root's already-scanned data - see
 * `findItemAnchor`'s `cache` parameter.
 */
export function scoreCandidate(
  fp: ElementFingerprint,
  candidate: Element,
  itemAnchorCache?: ItemAnchorCache,
  options?: { allowEmpty?: boolean; attributeName?: string | null; samePage?: boolean },
): ScoredCandidate {
  const signals: Record<string, number> = {};
  let weightedSum = 0;
  let weightTotal = 0;
  // Set when a strong identity signal — either a row/item-level one
  // (rowKey/href/datetime) or the page-level one (the nearest heading,
  // see `landmarkText` below) — is applicable on both sides and
  // definitively disagrees — i.e. this candidate has been positively
  // confirmed to belong to a *different* record, or a different
  // page/video/post entirely, than the one captured, not merely "no
  // identity signal available either way". See the clamp applied to
  // the final score below for why this needs to override everything
  // else rather than just losing that one signal's points of weight
  // like an ordinary mismatch would: on a page where every row (or
  // every instance of the same page template) is structurally
  // near-identical — which is exactly why these signals exist in the
  // first place — enough coincidental agreement on generic structural
  // signals can otherwise still add up to an acceptable score for the
  // *wrong* row, or the wrong page's own version of the same widget.
  let itemIdentityConflict = false;

  function add(name: string, weight: number, applicable: boolean, fraction: number): void {
    if (!applicable) return;
    signals[name] = fraction;
    weightedSum += weight * fraction;
    weightTotal += weight;
  }

  add('id', 25, fp.id !== null, candidate.id === fp.id ? 1 : 0);
  add(
    'dataTestId',
    25,
    fp.dataTestId !== null,
    TESTID_ATTRS.some((a) => candidate.getAttribute(a) === fp.dataTestId) ? 1 : 0,
  );
  add('name', 10, fp.name !== null, candidate.getAttribute('name') === fp.name ? 1 : 0);
  add('ariaLabel', 12, fp.ariaLabel !== null, (() => {
    const val = candidate.getAttribute('aria-label');
    if (val === fp.ariaLabel) return 1;
    if (val && fp.ariaLabel && val.toLowerCase().includes(fp.ariaLabel.toLowerCase())) return 0.6;
    return 0;
  })());
  add('role', 5, fp.role !== null, candidate.getAttribute('role') === fp.role ? 1 : 0);
  add('classSignature', 10, fp.classSignature.length > 0, jaccard(fp.classSignature, Array.from(candidate.classList).filter(isStableClass)));
  add('attributes', 10, Object.keys(fp.attributes).length > 0, attrJaccard(fp.attributes, curatedAttributes(candidate)));
  add('nearbyLabelText', 12, fp.nearbyLabelText !== null, (() => {
    const label = findLabelText(candidate);
    if (!label) return 0;
    if (label === fp.nearbyLabelText) return 1;
    return label.toLowerCase().includes((fp.nearbyLabelText ?? '').toLowerCase()) ? 0.5 : 0;
  })());
  add('domPath', 10, fp.domPath.length > 0, domPathSimilarity(fp.domPath, buildDomPath(candidate)));
  add('siblingIndex', 5, fp.siblingCount > 1, (() => {
    const parent = candidate.parentElement;
    if (!parent) return 0;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === candidate.tagName);
    const idx = siblings.indexOf(candidate);
    return Math.max(0, 1 - Math.abs(idx - fp.siblingIndex) / Math.max(fp.siblingCount, siblings.length, 1));
  })());
  add('depth', 4, true, (() => {
    let d = 0;
    let n: Element | null = candidate;
    while (n.parentElement) {
      n = n.parentElement;
      d += 1;
    }
    return Math.max(0, 1 - Math.abs(d - fp.depth) / 10);
  })());
  // A page's own nearest heading (its video/article/thread title) is a
  // strong, page-level identity signal - normally just an ordinary
  // weighted signal like any other, worth 8 points either way. But
  // when it's *applicable on both sides and definitively disagrees*,
  // that's not "a bit less similar" - it's proof the candidate lives
  // under a different heading entirely, e.g. a different video after
  // an SPA navigation. On a page whose template is otherwise identical
  // between any two videos/posts (same tag, same classes, same DOM
  // shape, same position - everything a positional signal can see),
  // the heading is often the *only* thing that actually distinguishes
  // "this video" from "some other video with the same layout", so
  // losing only 8 points of weight for a definite mismatch lets those
  // structural coincidences carry an unrelated candidate over the
  // threshold anyway. Treated the same way an `itemAnchor` conflict
  // already is below: capped rather than zeroed, and only when both
  // sides actually have a heading to compare (a page with no heading
  // at all - e.g. a table/dashboard - never triggers this).
  const candidateLandmarkText = fp.landmarkText !== null ? findLandmarkText(candidate) : null;
  if (fp.landmarkText !== null && candidateLandmarkText !== null) {
    const a = candidateLandmarkText.toLowerCase();
    const b = fp.landmarkText.toLowerCase();
    const isMatch = a === b || a.includes(b) || b.includes(a);
    if (!isMatch) {
      // Same canonical page (e.g. a title edit on the same video):
      // penalize via the ordinary landmark signal below, don't clamp.
      // Different page (e.g. SPA navigation to another video): keep the
      // severe clamp — every template twin shares tag/classes/position,
      // the heading is the only thing telling them apart. `samePage`
      // absent (older callers/tests) stays strict to preserve existing
      // cross-page protection. Item-identity conflicts below always
      // clamp, same page or not.
      if (options?.samePage !== true) {
        itemIdentityConflict = true;
      }
    }
  }
  add('landmarkText', 8, fp.landmarkText !== null, (() => {
    if (!candidateLandmarkText) return 0;
    if (candidateLandmarkText === fp.landmarkText) return 1;
    const a = candidateLandmarkText.toLowerCase();
    const b = (fp.landmarkText ?? '').toLowerCase();
    return a.includes(b) || b.includes(a) ? 0.7 : 0;
  })());
  // Computed once and reused by both item-identity signals below -
  // `findItemAnchor` walks ancestors and queries the row subtree, so
  // this matters on a large recovery scan (hundreds of scored
  // candidates on a big table/feed).
  const candidateItemAnchor =
    fp.itemAnchor && (fp.itemAnchor.href || fp.itemAnchor.datetime || fp.itemAnchor.rowKey || fp.itemAnchor.primaryText)
      ? findItemAnchor(candidate, itemAnchorCache)
      : null;
  add(
    'itemAnchor',
    22,
    Boolean(fp.itemAnchor?.href || fp.itemAnchor?.datetime || fp.itemAnchor?.rowKey),
    (() => {
      if (!candidateItemAnchor) return 0;
      // rowKey (an explicit record-id attribute on the row) and href
      // (a permalink, or the row's own detail link) are the most
      // specific identifiers when both sides have one - authoritative
      // either way, so a disagreement here must not be overridden by a
      // datetime that happens to match (e.g. two posts seconds apart
      // truncated to the same minute, or a quote-tweet sharing its
      // quoted post's timestamp nearby in the DOM) or by primary text
      // that happens to coincide (two rows both reading "Active").
      if (fp.itemAnchor?.rowKey && candidateItemAnchor.rowKey) {
        const match = fp.itemAnchor.rowKey === candidateItemAnchor.rowKey;
        if (!match) itemIdentityConflict = true;
        return match ? 1 : 0;
      }
      if (fp.itemAnchor?.href && candidateItemAnchor.href) {
        const match =
          fp.itemAnchor.isPermalink && candidateItemAnchor.isPermalink
            ? permalinkIdentity(fp.itemAnchor.href) === permalinkIdentity(candidateItemAnchor.href)
            : fp.itemAnchor.href === candidateItemAnchor.href;
        if (!match) itemIdentityConflict = true;
        return match ? 1 : 0;
      }
      if (fp.itemAnchor?.datetime && candidateItemAnchor.datetime) {
        const match = fp.itemAnchor.datetime === candidateItemAnchor.datetime;
        if (!match) itemIdentityConflict = true;
        return match ? 1 : 0;
      }
      return 0;
    })(),
  );
  // Separate, lower-weight signal: a soft "row label" match for the
  // common case of a table/grid row with no link, timestamp, or
  // record-id attribute anywhere on it - only text. Never authoritative
  // (see `findPrimaryText`'s doc comment) - just one more point of
  // similarity among many, so a coincidental match on its own can't
  // push an unrelated candidate over the acceptance threshold.
  add('itemPrimaryText', 8, fp.itemAnchor?.primaryText != null, (() => {
    const candidateText = candidateItemAnchor?.primaryText;
    if (!candidateText) return 0;
    if (candidateText === fp.itemAnchor!.primaryText) return 1;
    const a = candidateText.toLowerCase();
    const b = (fp.itemAnchor!.primaryText ?? '').toLowerCase();
    return a.includes(b) || b.includes(a) ? 0.5 : 0;
  })());
  const candidateText =
    fp.ariaLabel && candidate.getAttribute('aria-label')
      ? normalizeText(candidate.getAttribute('aria-label')!)
      : normalizeText(candidate.textContent ?? '');
  add('textPattern', 6, true, classifyTextPattern(candidateText) === fp.textPattern ? 1 : 0.2);
  add('textShape', 4, fp.textSnapshot.length > 0, textSimilarity(fp.textSnapshot, candidateText));
  add('textAnchorContext', 10, Boolean(fp.textAnchor?.before || fp.textAnchor?.after), (() => {
    const text = normalizeText(candidate.textContent ?? '');
    const before = fp.textAnchor?.before ?? '';
    const after = fp.textAnchor?.after ?? '';
    const beforeMatch = !before || text.includes(before);
    const afterMatch = !after || text.includes(after);
    return beforeMatch && afterMatch ? 1 : beforeMatch || afterMatch ? 0.45 : 0;
  })());

  add(
    'textAnchorValue',
    8,
    Boolean(fp.textAnchor?.value),
    (() => {
      const val = fp.textAnchor?.value?.trim();
      if (!val) return 0;
      if (candidateText === val) return 1;
      if (candidateText.includes(val)) return 0.85;
      const rawText = normalizeText(candidate.textContent ?? '');
      if (rawText.includes(val)) return 0.8;
      return 0;
    })(),
  );

  const targetSemantic = fp.textAnchor?.value
    ? detectSemanticValue(fp.textAnchor.value)
    : fp.textSnapshot
      ? detectSemanticValue(fp.textSnapshot)
      : null;
  const isTargetSemanticValid = targetSemantic !== null && targetSemantic.type !== 'text';
  add(
    'semanticValue',
    8,
    isTargetSemanticValid,
    (() => {
      if (!targetSemantic || targetSemantic.type === 'text') return 0;
      let candSemantic = detectSemanticValue(candidateText);
      if (candSemantic.type === 'text') {
        const token = extractNumericToken(candidateText);
        if (token) {
          const tokenSemantic = detectSemanticValue(token);
          if (tokenSemantic.type !== 'text') {
            candSemantic = tokenSemantic;
          }
        }
      }
      if (candSemantic.type !== targetSemantic.type) return 0;
      if (targetSemantic.unit && candSemantic.unit) {
        return targetSemantic.unit.toLowerCase() === candSemantic.unit.toLowerCase() ? 1 : 0.75;
      }
      return 0.85;
    })(),
  );

  if (fp.relativeBox && candidate.getBoundingClientRect) {
    const view = candidate.ownerDocument.defaultView;
    if (view) {
      const rect = candidate.getBoundingClientRect();
      const vw = view.innerWidth || 1;
      const vh = view.innerHeight || 1;
      const scrollH = view.document.documentElement.scrollHeight || vh;
      if (rect.width > 0 || rect.height > 0) {
        const cx = rect.left / vw;
        const cy = (rect.top + (view.scrollY ?? 0)) / scrollH;
        const dist = Math.sqrt((cx - fp.relativeBox.x) ** 2 + (cy - fp.relativeBox.y) ** 2);
        add('position', 6, true, Math.max(0, 1 - dist * 2));
      }
    }
  }

  const rawScore = weightTotal === 0 ? 0 : Math.round((weightedSum / weightTotal) * 100);
  // A confirmed different-record match can't be rescued by generic
  // structural similarity, however strong - see `itemIdentityConflict`
  // above. Capped rather than zeroed so the diagnostic/signals payload
  // still shows *how* structurally similar it was, which is useful
  // context ("this really does look like the same kind of row, just a
  // different one") without ever letting that similarity cross the
  // acceptance threshold.
  let score = itemIdentityConflict ? Math.min(rawScore, 20) : rawScore;
  // An effectively empty candidate (no visible text, no aria-label to
  // speak of — and, for attribute monitors, none of the monitored
  // attribute either) must never clear the acceptance threshold via a
  // recovery scan: structural similarity alone cannot make emptiness
  // a value. Capped — not zeroed — so diagnostics still show how
  // similar it was. Exact/fast-path matches are exempt (see
  // `allowEmpty`): an element found at its exact prior location that
  // is currently empty is honestly "found but empty"
  // (EXTRACTION_EMPTY, retryable), not "low confidence".
  if (options?.allowEmpty === false) {
    const visible = extractVisibleText(candidate);
    const aria = candidate.getAttribute('aria-label');
    const hasVisible = visible !== '' && !isEffectivelyEmpty(visible);
    const hasAria = aria !== null && aria !== '' && !isEffectivelyEmpty(aria);
    // Attribute-mode awareness: a text-empty element can still be a
    // genuine value holder when the monitored attribute itself is
    // populated (e.g. an `<input value="...">` or a `data-*` readout
    // with no rendered text). The guard only treats the candidate as
    // empty when *all* applicable value sources are empty.
    const attrName = options?.attributeName ?? null;
    const attrRaw = attrName ? candidate.getAttribute(attrName) : null;
    const hasAttr = attrRaw !== null && attrRaw.trim() !== '' && !isEffectivelyEmpty(attrRaw);
    if (!hasVisible && !hasAria && !hasAttr) {
      score = Math.min(score, 20);
    }
  }
  return { element: candidate, score, signals };
}

const MAX_CANDIDATES_SCANNED = 4000;
const MAX_SCORED = 800;

/**
 * Collects elements matching `predicate`, descending into open shadow
 * roots as it goes. Plain `querySelectorAll`/`getElementsByTagName`
 * never see into a shadow root — they only return light-DOM descendants
 * of the node they're called on — so a page built from web components
 * (Reddit's `shreddit-post`, most design-system component libraries)
 * would otherwise have entire subtrees invisible to recovery, including
 * potentially the exact element being relocated. Closed shadow roots
 * are unreachable by any extension short of patching the page's own
 * `attachShadow` calls before they run, which is out of scope here.
 */
function collectDeep(
  root: Document | ShadowRoot,
  predicate: (el: Element) => boolean,
  limit: number,
  out: Element[],
): void {
  if (out.length >= limit) return;
  const all = root.querySelectorAll('*');
  for (const el of Array.from(all)) {
    if (predicate(el)) {
      out.push(el);
      if (out.length >= limit) return;
    }
    if (el.shadowRoot) {
      collectDeep(el.shadowRoot, predicate, limit, out);
      if (out.length >= limit) return;
    }
  }
}

/** Gathers a bounded, relevant pool of candidate elements to score against `fp`, including inside shadow roots. `itemAnchorCache` is forwarded to `findMatchingItemRoot` - see `findItemAnchor`'s `cache` parameter. */
function gatherCandidates(doc: Document, fp: ElementFingerprint, itemAnchorCache?: ItemAnchorCache): Element[] {
  const seen = new Set<Element>();
  const merged: Element[] = [];

  function addAll(predicate: (el: Element) => boolean): void {
    if (merged.length >= MAX_CANDIDATES_SCANNED) return;
    const found: Element[] = [];
    collectDeep(doc, predicate, MAX_CANDIDATES_SCANNED, found);
    for (const el of found) {
      if (seen.has(el)) continue;
      seen.add(el);
      merged.push(el);
      if (merged.length >= MAX_CANDIDATES_SCANNED) return;
    }
  }

  // Targeted pass first: if the captured element lived inside a
  // record with a strong identity (a row/record-id attribute, a
  // permalink, or a timestamp), find that exact record's current
  // subtree and scan it before anything else. This is what makes
  // recovery on a large table/feed (a Cloudflare domains table, a
  // Stripe/Shopify/GA dashboard grid, a virtualized timeline) reliably
  // land on the *same row's* value instead of merely "a" row's value
  // that happens to score similarly on generic signals - every row in
  // a table is structurally near-identical, so without this the
  // matching element is just one of hundreds of equally-plausible
  // same-tag candidates. Purely additive: if no single matching record
  // is found, this is a no-op and the pools below run exactly as
  // before, so it can only ever narrow *first*, never replace, the
  // existing recovery net.
  const matchedRoot = findMatchingItemRoot(doc, fp, itemAnchorCache);
  if (matchedRoot) {
    addAll((el) => el !== matchedRoot && matchedRoot.contains(el));
    // The row root itself is occasionally the fingerprinted element
    // (e.g. a whole `<tr>` was the monitored value) - include it too.
    if (!seen.has(matchedRoot)) {
      seen.add(matchedRoot);
      merged.push(matchedRoot);
    }
  }

  // Scoped pass: if an ancestor container of the target still resolves,
  // prioritize candidates within that container ahead of global scan.
  const container = findLikelyContainer(doc, fp);
  if (container) {
    addAll((el) => el !== container && container.contains(el) && el.tagName.toLowerCase() === fp.tag);
  }

  // Value-anchored pass: prioritize elements whose text directly includes the captured text anchor
  if (fp.textAnchor?.value) {
    const val = fp.textAnchor.value.trim();
    if (val) {
      addAll((el) => el.tagName.toLowerCase() === fp.tag && (el.textContent ?? '').includes(val));
    }
  }

  if (fp.dataTestId) {
    addAll((el) => TESTID_ATTRS.some((attr) => el.hasAttribute(attr)));
  }
  if (fp.ariaLabel) {
    addAll((el) => el.hasAttribute('aria-label'));
  }
  if (fp.classSignature.length > 0) {
    const wanted = new Set(fp.classSignature.filter((c) => c !== 'style-scope').slice(0, 2));
    if (wanted.size > 0) {
      addAll((el) => {
        for (const cls of el.classList) if (wanted.has(cls)) return true;
        return false;
      });
    }
  }
  // Tag pool last and always, as the broadest fallback net.
  addAll((el) => el.tagName.toLowerCase() === fp.tag);

  // Value-kind pool, after every structural pool: elements whose own
  // text carries a watched semantic kind (anchor → snapshot). Kinds
  // compare by the existing magnitude-family compatibility (see
  // `isCompatibleSemanticKind`), not exact equality: a bare "21k"
  // (count) and its labeled rendering ("22 thousand subscribers" →
  // followers) are the same kind of value, so either one pools the
  // other. This is the net for the case every structural signal missed
  // at once: tag changed across renders, stable attributes churned, the
  // captured value text itself moved on (so the value-anchored pool is
  // empty), and no item/container anchor resolves. Scoring is
  // untouched — pooled candidates still need 55+, ambiguity and
  // kind/sign gates still apply — so this only converts "never scored"
  // into "scored strictly". Positioned last so the existing pool order
  // (and which candidates fill the scoring cap on huge pages) is
  // unchanged whenever earlier pools already match. Text monitors (no
  // known value kind) skip it: without a kind there is nothing to
  // filter on.
  const wantedKinds = new Set<SemanticValueType>();
  for (const source of [fp.textAnchor?.value, fp.textSnapshot]) {
    if (!source) continue;
    const sem = detectSemanticValue(source);
    if (sem.type !== 'text' && sem.normalized !== null) wantedKinds.add(sem.type);
  }
  if (wantedKinds.size > 0) {
    addAll((el) => {
      const text = el.textContent ?? '';
      if (!text || !/\d/.test(text)) return false;
      const sem = detectSemanticValue(text);
      if (sem.type === 'text') return false;
      for (const wanted of wantedKinds) {
        if (isCompatibleSemanticKind(wanted, sem.type)) return true;
      }
      return false;
    });
  }

  return merged;
}

/**
 * Bounded search for the single item/row currently holding the same
 * record identity (`rowKey` > `href` > `datetime`, in that priority -
 * matching `scoreCandidate`'s own precedence) as `fp.itemAnchor`.
 * Returns `null` when there's nothing to go on (no strong identity was
 * captured), or when more than one current item matches (ambiguous -
 * safer to let the full, unrestricted scan and its own ambiguity
 * handling sort it out than to guess which one is real). `itemAnchorCache`
 * is forwarded to `findItemAnchor` so this pass's results are reused by
 * the later candidate-scoring pass over the same roots (and vice versa) -
 * see `findItemAnchor`'s `cache` parameter.
 */
function findMatchingItemRoot(doc: Document, fp: ElementFingerprint, itemAnchorCache?: ItemAnchorCache): Element | null {
  const wantRowKey = fp.itemAnchor?.rowKey ?? null;
  const wantHref = fp.itemAnchor?.href ?? null;
  const wantDatetime = fp.itemAnchor?.datetime ?? null;
  if (!wantRowKey && !wantHref && !wantDatetime) return null;

  const roots: Element[] = [];
  collectDeep(doc, looksLikeItemRoot, 2000, roots);

  let match: Element | null = null;
  for (const root of roots) {
    const anchor = findItemAnchor(root, itemAnchorCache);
    if (!anchor) continue;
    const isMatch = wantRowKey
      ? anchor.rowKey === wantRowKey
      : wantHref
        ? anchor.href === wantHref
        : anchor.datetime === wantDatetime;
    if (!isMatch) continue;
    if (match && match !== root) return null; // more than one current match - ambiguous, don't guess
    match = root;
  }
  return match;
}

/**
 * Single shared recovery scan: gathers candidates once and scores them
 * with the full combined signal bundle (semantic type, nearby
 * labels/context, stable attributes, anchor text, structural and item
 * identity signals) under the non-empty requirement. Both
 * `locateElement` (single best) and `rankRecoveryCandidates` (ranked
 * fallback) build on this so one DOM read costs one gather+score pass,
 * not two — Check Now stays fast on large pages without raising any
 * timeout.
 */
function runRecoveryScan(
  fp: ElementFingerprint,
  doc: Document,
  itemAnchorCache: ItemAnchorCache,
  acceptThreshold: number,
  scanOptions?: { attributeName?: string | null; samePage?: boolean },
): {
  candidates: Element[];
  sorted: ScoredCandidate[];
  best: ScoredCandidate | null;
  runnerUp: ScoredCandidate | null;
  ambiguous: boolean;
} {
  const candidates = gatherCandidates(doc, fp, itemAnchorCache);
  // Full sort path (used when the caller needs the ranked fallback
  // list): score the bounded pool, then sort once. Bounded by
  // MAX_SCORED either way.
  const scored: ScoredCandidate[] = [];
  for (const el of candidates) {
    if (scored.length >= MAX_SCORED) break;
    scored.push(scoreCandidate(fp, el, itemAnchorCache, { allowEmpty: false, attributeName: scanOptions?.attributeName ?? null, samePage: scanOptions?.samePage }));
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  const runnerUp = scored[1] ?? null;
  const ambiguous = Boolean(
    best && runnerUp && best.score < 90 && runnerUp.score >= best.score - 3 &&
      !(fp.itemAnchor?.href || fp.itemAnchor?.datetime || fp.itemAnchor?.rowKey),
  );
  return { candidates, sorted: scored, best, runnerUp, ambiguous };
}

/**
 * Attempts to (re)locate the element `fp` describes within `doc`,
 * together with the ranked recovery list from the same single scan.
 * Tries the captured selector and XPath first (cheap, and correct the
 * overwhelming majority of the time when the DOM hasn't changed) before
 * falling back to a full scored recovery scan.
 *
 * This is the single-scan core `locateAndExtract` uses: one
 * gather+score pass yields both the locate verdict and the ranked
 * fallback, so a dynamic page's empty-skeleton-vs-populated-value
 * decision never pays for the same scan twice. `locateElement` and
 * `rankRecoveryCandidates` below are thin wrappers over it preserving
 * their exact existing contracts.
 */
export function locateElementWithRanking(
  fp: ElementFingerprint,
  doc: Document,
  options?: { acceptThreshold?: number; limit?: number; attributeName?: string | null; samePage?: boolean },
): {
  locate: LocateResult;
  ranked: ScoredCandidate[];
  ambiguous: boolean;
} {
  const acceptThreshold = options?.acceptThreshold ?? 55;
  const limit = options?.limit ?? MAX_RECOVERY_FALLBACK_CANDIDATES;
  const attributeName = options?.attributeName ?? null;
  const samePage = options?.samePage;
  // Shared for the whole call so every candidate that shares an item
  // root (every cell in the same table row, every child of the same
  // feed item) reuses that root's already-scanned identity data instead
  // of each re-scanning it from scratch - see `findItemAnchor`'s `cache`
  // parameter.
  const itemAnchorCache: ItemAnchorCache = new Map();

  const fastSelector = deepQuerySelector(doc, fp.cssSelector);
  if (fastSelector) {
    const scored = scoreCandidate(fp, fastSelector, itemAnchorCache, { samePage });
    if (scored.score >= acceptThreshold) {
      return {
        locate: { ...scored, candidatesConsidered: 1, method: 'fast-path-selector' },
        ranked: [],
        ambiguous: false,
      };
    }
  }

  const fastXpath = resolveXPath(doc, fp.xpath);
  // Note: XPath (`document.evaluate`) has no shadow-DOM-piercing
  // capability at all — this fast path only ever resolves for elements
  // that were reachable in light DOM at capture time. `cssSelector`
  // above (built with `>>>` shadow segments) is the one that actually
  // covers shadow-DOM elements on the fast path; the recovery scan
  // below covers them for everything else via `collectDeep`.
  if (fastXpath && fastXpath !== fastSelector) {
    const scored = scoreCandidate(fp, fastXpath, itemAnchorCache, { samePage });
    if (scored.score >= acceptThreshold) {
      return {
        locate: { ...scored, candidatesConsidered: 1, method: 'fast-path-xpath' },
        ranked: [],
        ambiguous: false,
      };
    }
  }

  const scan = runRecoveryScan(fp, doc, itemAnchorCache, acceptThreshold, { attributeName, samePage });
  // A recovered candidate that is effectively tied with another item is
  // not trustworthy enough to monitor. This intentionally favors a clear
  // "needs review" result over silently switching to a duplicate metric.
  if (scan.ambiguous) {
    return {
      locate: {
        element: null,
        score: scan.best?.score ?? 0,
        signals: scan.best?.signals ?? {},
        candidatesConsidered: scan.candidates.length,
        method: scan.best ? 'recovery-scan' : 'none',
      },
      ranked: [],
      ambiguous: true,
    };
  }
  const ranked = scan.sorted.filter((s) => s.score >= acceptThreshold).slice(0, limit);
  if (scan.best && scan.best.score >= acceptThreshold) {
    return {
      locate: { ...scan.best, candidatesConsidered: scan.candidates.length, method: 'recovery-scan' },
      ranked,
      ambiguous: false,
    };
  }

  // Below threshold: report the best candidate's score/signals for
  // diagnostics (so a SELECTOR_RECOVERY_LOW_CONFIDENCE message can say
  // *how* close it got), but never hand back the element itself here.
  // Returning it would let a caller that only checks "is element
  // non-null" silently extract from a match we've just decided isn't
  // good enough — which is exactly how a wrong candidate (e.g. an
  // unrelated button that happens to share a tag name) can end up
  // treated as a successful, high-trust recovery instead of a failure.
  return {
    locate: {
      element: null,
      score: scan.best?.score ?? 0,
      signals: scan.best?.signals ?? {},
      candidatesConsidered: scan.candidates.length,
      method: scan.best ? 'recovery-scan' : 'none',
    },
    ranked: [],
    ambiguous: false,
  };
}

/**
 * Attempts to (re)locate the element `fp` describes within `doc`.
 * Tries the captured selector and XPath first (cheap, and correct the
 * overwhelming majority of the time when the DOM hasn't changed) before
 * falling back to a full scored recovery scan.
 */
export function locateElement(
  fp: ElementFingerprint,
  doc: Document,
  options?: { acceptThreshold?: number; samePage?: boolean },
): LocateResult {
  return locateElementWithRanking(fp, doc, options).locate;
}

/**
 * Ranked recovery candidates for value-aware extraction fallback.
 *
 * Same scoring as `locateElement`'s recovery scan (including the
 * non-empty requirement), but returns the top candidates sorted by
 * score instead of only the single best. `locateAndExtract` uses this
 * to skip a top-ranked candidate whose extraction comes back empty
 * (a loading skeleton that is structurally right but holds no value
 * yet) in favor of the next-best non-empty one — reusing the exact
 * same combined signal bundle (semantic type, nearby labels/context,
 * stable attributes, anchor text, structural relationships) rather
 * than a site-specific rule.
 *
 * Returns at most `limit` candidates, all at or above
 * `acceptThreshold`, in descending score order. Empty when the scan
 * is ambiguous or nothing clears the threshold (same bar as
 * `locateElement`).
 */
export const MAX_RECOVERY_FALLBACK_CANDIDATES = 12;

export function rankRecoveryCandidates(
  fp: ElementFingerprint,
  doc: Document,
  options?: { acceptThreshold?: number; limit?: number; attributeName?: string | null; samePage?: boolean },
): { ranked: ScoredCandidate[]; candidatesConsidered: number; ambiguous: boolean } {
  // Standalone contract (unchanged): always a full recovery scan,
  // independent of whether the fast path would hit. `locateAndExtract`
  // calls this only on the exact-failure path (the fast-path slot
  // itself came back empty) as well as for the recovery fallback.
  const acceptThreshold = options?.acceptThreshold ?? 55;
  const limit = options?.limit ?? MAX_RECOVERY_FALLBACK_CANDIDATES;
  const itemAnchorCache: ItemAnchorCache = new Map();
  const scan = runRecoveryScan(fp, doc, itemAnchorCache, acceptThreshold, {
    attributeName: options?.attributeName ?? null,
    samePage: options?.samePage,
  });
  if (scan.ambiguous) {
    return { ranked: [], candidatesConsidered: scan.candidates.length, ambiguous: true };
  }
  return {
    ranked: scan.sorted.filter((s) => s.score >= acceptThreshold).slice(0, limit),
    candidatesConsidered: scan.candidates.length,
    ambiguous: false,
  };
}
