/**
 * Detects when a page has been replaced by a bot-verification / anti-
 * automation challenge (Cloudflare, DataDome, PerimeterX/HUMAN, generic
 * "enable JavaScript" interstitials, etc.) instead of its real content.
 * This is detection only — recognizing *why* a check failed so the
 * diagnostic is accurate — never anything that attempts to solve or
 * bypass a challenge.
 */

const TITLE_PATTERNS = [
  /just a moment/i,
  /attention required/i,
  /checking your browser/i,
  /verify you are human/i,
  /access denied/i,
  /are you a robot/i,
  /security check/i,
  /ddos protection/i,
];

const BODY_TEXT_PATTERNS = [
  /checking (your browser|if the site connection is secure)/i,
  /enable javascript and cookies to continue/i,
  /verify you are (a )?human/i,
  /this process is automatic/i,
  /ray id:/i,
];

const CHALLENGE_SELECTORS = [
  '#challenge-running',
  '#challenge-form',
  '.cf-browser-verification',
  '#cf-challenge-running',
  'iframe[src*="challenges.cloudflare"]',
  'iframe[title*="challenge" i]',
  'iframe[src*="captcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="recaptcha" i]',
  '[class*="captcha" i]',
  '#px-captcha',
  '.datadome-captcha',
];

export interface AntiAutomationResult {
  detected: boolean;
  reason: string | null;
}

export function detectAntiAutomation(doc: Document): AntiAutomationResult {
  const title = doc.title ?? '';
  for (const pattern of TITLE_PATTERNS) {
    if (pattern.test(title)) {
      return { detected: true, reason: `page title matched a challenge pattern ("${title.slice(0, 60)}")` };
    }
  }

  for (const selector of CHALLENGE_SELECTORS) {
    try {
      if (doc.querySelector(selector)) {
        return { detected: true, reason: `found a known challenge element (${selector})` };
      }
    } catch {
      // Selector unsupported in this engine — ignore and keep checking others.
    }
  }

  const bodyText = (doc.body?.textContent ?? '').slice(0, 2000);
  for (const pattern of BODY_TEXT_PATTERNS) {
    if (pattern.test(bodyText)) {
      return { detected: true, reason: 'page text matched a bot-verification pattern' };
    }
  }

  // A near-empty body with a very small script-only document is a common
  // signature of a JS-challenge shell before it swaps in real content.
  //
  // `bodyText` above is light-DOM only — `Element.textContent` never
  // descends into a shadow root by spec, so a real, fully-rendered page
  // built as a single web component (YouTube's `<ytd-app>`, Reddit's
  // `<shreddit-app>`, and most modern design-system-based sites) looks
  // *identical* to a genuinely empty challenge shell by this measure:
  // a body with one child and no visible text of its own, even though
  // it's full of real, legitimate content one shadow boundary down.
  // `deepTextLength` accounts for that so this heuristic still means
  // what it says - "nothing is actually rendered here" - rather than
  // firing on every shadow-DOM site's honest "no match found" result
  // and mislabeling it as a challenge page.
  const visibleTextLength = Math.max(normalizedLength(bodyText), deepTextLength(doc));
  const scriptCount = doc.scripts.length;
  if (visibleTextLength < 40 && scriptCount <= 3 && doc.body && doc.body.children.length <= 2) {
    return { detected: true, reason: 'page body is nearly empty with only a handful of scripts loaded' };
  }

  return { detected: false, reason: null };
}

function normalizedLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/**
 * Light-DOM `textContent` plus the text of every open shadow root
 * reachable from `doc.body`, recursively — see the call site above for
 * why this needs to look past shadow boundaries at all. Bounded on
 * both depth and element count: this only ever runs on the "nothing
 * matched" path (once per failed check, not per candidate), but a
 * pathological page shouldn't be able to make it expensive.
 */
function deepTextLength(doc: Document): number {
  if (!doc.body) return 0;
  let total = 0;
  let visited = 0;
  const MAX_ELEMENTS = 2000;
  const MAX_DEPTH = 12;

  const walk = (root: Document | ShadowRoot, depth: number): void => {
    if (depth > MAX_DEPTH || visited >= MAX_ELEMENTS) return;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      visited += 1;
      if (visited >= MAX_ELEMENTS) return;
      if (el.shadowRoot) {
        total += normalizedLength(el.shadowRoot.textContent ?? '');
        if (total >= 40) return;
        walk(el.shadowRoot, depth + 1);
        if (total >= 40) return;
      }
    }
  };

  walk(doc, 0);
  return total;
}

/** Heuristic: does this look like a login/sign-in wall rather than the real page? */
export function detectAuthWall(doc: Document, targetFound: boolean): boolean {
  if (targetFound) return false;
  // A password field alone proves nothing - settings, checkout, and
  // admin pages all have them. It stays a necessary gate (a login wall
  // without one isn't a login wall), but only an auth-looking URL or
  // title actually classifies. Otherwise a merely-missing element on an
  // ordinary page is misdiagnosed AUTH_REQUIRED, which also wrongly
  // skips the scroll-recovery path a genuine ELEMENT_NOT_FOUND gets.
  const hasPasswordField = !!doc.querySelector('input[type="password"]');
  if (!hasPasswordField) return false;
  // Pathname only: the full href includes query values like
  // `?next=/login`, which describe where to go next - not a login
  // page - and must not classify.
  let path = '';
  try {
    path = new URL(doc.location?.href ?? '').pathname;
  } catch {
    path = (doc.location?.href ?? '').split(/[?#]/)[0] ?? '';
  }
  const pathLooksAuthy = /\/(login|signin|sign-in|auth|sso)(\/|$|\?)/i.test(path);
  const titleLooksAuthy = /(log in|sign in|sign up|authenticate)/i.test(doc.title ?? '');
  return pathLooksAuthy || titleLooksAuthy;
}
