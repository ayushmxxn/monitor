/**
 * Generic account/session-scope-change detection.
 *
 * Problem: a monitor can go terminal `NEEDS_REPICK` when the user
 * switches accounts (or workspaces/organizations) on a site. The app
 * shell — and even the monitored element's selector — may be
 * unchanged; what changed is whose data the page shows. Telling the
 * user to delete and re-pick is wrong there: the stored fingerprint
 * is still perfectly good and recovers on its own the moment the
 * original account is back. The honest diagnosis is an
 * access/authentication problem, with Retry kept available.
 *
 * This module answers one question — "is this locate failure plausibly
 * caused by an account/session scope change rather than selector or
 * layout drift?" — using only the monitor's own fingerprint and the
 * live document. Deliberately generic: no per-site selectors, no URL
 * allow-lists, no brand names. Two independent, conservative signals:
 *
 * 1. Explicit access messaging: the reachable page itself says the
 *    viewer lacks access (unauthorized / access denied / forbidden /
 *    account-picker wording). HTTP 401/403 and login walls are already
 *    classified upstream (`fetchStrategy`, `detectAuthWall`); this
 *    covers the softer in-app variants on an otherwise rendered page.
 *
 * 2. Wholesale context absence: the page is substantially rendered
 *    (not a shell, skeleton, or challenge husk — those already have
 *    their own diagnoses) yet *none* of the fingerprint's captured
 *    context strings (landmark, nearby label, anchor frame) appear
 *    anywhere in it. One drifted element leaves its neighborhood
 *    behind; a different account's dataset leaves none of it. Genuine
 *    single-element removal therefore keeps flowing to NEEDS_REPICK,
 *    while a swapped dataset reads as a scope change.
 *
 * Conservative by construction (a miss just keeps today's behavior):
 * - Requires at least one substantive context string; anchorless or
 *   context-free fingerprints can never trigger signal 2.
 * - Requires a substantially rendered page; sparse/loading documents
 *   never trigger signal 2.
 * - Case-insensitive substring matching can only *suppress* signal 2
 *   (more matches → no fire), never cause it.
 *
 * Known limitation: a full same-account page redesign that wipes every
 * captured context string reads as a scope change too. The remedy
 * stays safe anyway (Retry, checks keep running, fingerprint kept
 * intact) — it just labels a redesign as an access problem until the
 * user looks closer at the detail panel, which still carries the
 * underlying identity trace.
 */

import { normalizeText, type ElementFingerprint } from './fingerprint';

/** Context strings shorter than this are too generic to prove anything (`$`, `•`) and are ignored. */
export const MIN_CONTEXT_LENGTH = 4;

/**
 * Normalized visible-text length below which a document is treated as
 * not-rendered-enough to judge scope from: shells, skeletons, and
 * challenge husks must never read as "a different account's data".
 */
export const MIN_RENDERED_TEXT_LENGTH = 100;

/** How much leading body text explicit access messaging is searched in (account notices render near the top). */
export const ACCESS_MESSAGE_SCAN_LENGTH = 4000;

/**
 * Generic in-app access/session-change phrasing. Deliberately tight:
 * words that appear in ordinary logged-in chrome ("log out" menu
 * items, "sign in" marketing) are excluded — login walls already have
 * their own diagnosis (`detectAuthWall`), and this list is only for
 * the post-login wrong-scope case. No site names, no selectors.
 */
const ACCESS_MESSAGE_PATTERNS: RegExp[] = [
  /unauthori[sz]ed/i,
  /access denied/i,
  /\bforbidden\b/i,
  /permission denied/i,
  /you (do not|don't) have (access|permission)/i,
  /no (access|permission) to/i,
  /choose an account/i,
  /select an account/i,
  /switch (account|workspace|organization|organisation|team)s?\b/i,
  /session (has )?expired/i,
];

/** Normalized, substantive context strings captured with the fingerprint (landmark, labels, anchor frame). */
export function fingerprintContextStrings(fp: ElementFingerprint): string[] {
  const raw = [
    fp.landmarkText,
    fp.nearbyLabelText,
    fp.textAnchor?.before,
    fp.textAnchor?.after,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw) {
    if (!part) continue;
    const normalized = normalizeText(part);
    if (normalized.length < MIN_CONTEXT_LENGTH) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function documentHaystack(doc: Document): string {
  let title = '';
  try {
    title = doc.title ?? '';
  } catch {
    title = '';
  }
  let body = '';
  try {
    body = doc.body?.textContent ?? '';
  } catch {
    body = '';
  }
  return `${title}\n${body}`;
}

/** True when the document carries explicit generic access/session-change messaging. */
export function hasExplicitAccessMessage(doc: Document): boolean {
  let haystack: string;
  try {
    haystack = documentHaystack(doc).slice(0, ACCESS_MESSAGE_SCAN_LENGTH);
  } catch {
    return false;
  }
  return ACCESS_MESSAGE_PATTERNS.some((pattern) => pattern.test(haystack));
}

/** Normalized length of the document's rendered body text. */
export function renderedTextLength(doc: Document): number {
  try {
    return normalizeText(doc.body?.textContent ?? '').length;
  } catch {
    return 0;
  }
}

/**
 * True when the document is substantially rendered yet contains none
 * of the fingerprint's captured context — the whole expected content
 * scope is absent, not just one drifted element.
 */
export function hasWholesaleContextAbsence(doc: Document, fp: ElementFingerprint): boolean {
  const contexts = fingerprintContextStrings(fp);
  if (contexts.length === 0) return false;
  if (renderedTextLength(doc) < MIN_RENDERED_TEXT_LENGTH) return false;
  let haystack: string;
  try {
    haystack = documentHaystack(doc).toLowerCase();
  } catch {
    return false;
  }
  return !contexts.some((context) => haystack.includes(context.toLowerCase()));
}

export interface AccessChangeDetection {
  detected: boolean;
  /** Short machine-readable evidence note for the diagnostic detail (UI shows the fixed copy, not this). */
  reason: string | null;
}

/**
 * Generic account/session-scope-change verdict for a locate failure.
 * Callers must already have established the preconditions this module
 * cannot see: a stale-identity primary failure on an existing monitor
 * (prior value present), with challenge shells and login walls handled
 * upstream. Never throws.
 */
export function detectAccessChange(doc: Document, fp: ElementFingerprint): AccessChangeDetection {
  try {
    if (hasExplicitAccessMessage(doc)) {
      return { detected: true, reason: 'page shows generic access/session-change messaging' };
    }
    if (hasWholesaleContextAbsence(doc, fp)) {
      return { detected: true, reason: 'none of the captured page context is present in the rendered page' };
    }
  } catch {
    return { detected: false, reason: null };
  }
  return { detected: false, reason: null };
}
