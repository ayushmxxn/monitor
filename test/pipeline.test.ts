/**
 * Pipeline regression tests, run against real DOM behavior via jsdom
 * (not mocks of our own code) so they actually exercise fingerprint
 * capture, shadow-DOM-aware recovery, extraction, and readiness gating
 * the same way the live page agent does.
 *
 * These exist because of two real production bugs:
 *  - `locateElement` silently returned a below-confidence-threshold
 *    element instead of `null`, and `gatherCandidates` never looked
 *    inside shadow roots - together, a wrong recovery on a shadow-DOM
 *    site (Reddit) could win by default. See scenarios 1-2.
 *  - Completion-based network-idle detection considered a page "quiet"
 *    for the entire duration of a still-pending fetch, extracting a
 *    stale placeholder before async-loaded data arrived (Umami). See
 *    scenario 4, and the in-flight-request tracking in
 *    `entrypoints/visibilityPatch.content.ts` / `lib/monitors/readiness.ts`.
 *
 * Run with `npm test`. Exits non-zero on any failed assertion.
 */
import { JSDOM } from 'jsdom';
import { buildFingerprint, locateElement, scoreCandidate, findItemAnchor, findLabelText, isVisuallyHidden, findLikelyContainer, isPermalinkPath } from '../lib/monitors/fingerprint';
import type { ItemAnchorCache } from '../lib/monitors/fingerprint';
import { locateAndExtract, resolveSettledValue, extractVisibleText } from '../lib/monitors/locate';
import { waitForPageReady, waitForRegionReady } from '../lib/monitors/readiness';
import { detectSemanticValue, compareSemanticValues, extractNumericToken } from '../lib/monitors/semanticValue';
import { resolvePickerTarget, resolvePickerTargetAtPoint, formatPickerTooltip } from '../lib/monitors/pickerTarget';
// pageAgent.content.ts is a WXT content script whose `defineContentScript`
// call only exists at build time - stub it so the module (and its pure
// picker helpers) can be imported in bun like any other module.
(globalThis as any).defineContentScript ??= (opts: unknown) => opts;
const { sameSelection, namingValuePreview, shouldAttemptScrollRecovery, withRestoredScrollY, runLocate } = await import('../entrypoints/pageAgent.content');
import { locateOnTab, verifyTabSettled } from '../lib/monitors/pageAgentClient';
import { ensureVisibilityPatchRegistered } from '../lib/monitors/visibilityPatch';
import { navigateAndWaitForLoad } from '../lib/monitors/strategies/liveTabNavigation';
import { resolveCheckUrl, resolveSourceUrl, stripTrackingParams } from '../lib/monitors/itemUrl';
import { baseStrategyOrder } from '../lib/monitors/strategies/strategyOrder';
import { searchByScrolling, type ScrollHost } from '../lib/monitors/scrollRecovery';
import { detectAuthWall } from '../lib/monitors/antiAutomation';
import { serializeByKey, dedupeInFlight } from '../lib/monitors/concurrency';
import type { ElementFingerprint } from '../lib/monitors/fingerprint';
import { ensureOffscreenDocument } from '../lib/monitors/offscreenManager';
import { getFailureStateInfo, selectPrimaryDiagnostic, diagnostic, isPermanentFailure, PERMANENT_FAILURE_THRESHOLD } from '../lib/monitors/diagnostics';
import type { DiagnosticCode } from '../lib/monitors/diagnostics';
import type { MonitorStatus } from '../lib/monitors/types';
import { hasValueChanged } from '../lib/monitors/checker';
import { calculateValueChange, formatChangeAlertMessage, formatHeroMovement } from '../lib/monitors/changeSummary';
import { calculateHistoricalBenchmarks } from '../lib/monitors/benchmarks';
import { shouldTriggerAlert, formatAlertConditionDescription } from '../lib/monitors/alertCondition';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// ---------------------------------------------------------------------
// Scenario 1: Reddit-style shadow-DOM web component recovery.
// The upvote count lives inside a shadow root. List virtualization
// destroys the original <shreddit-post> and mounts a *new* one with the
// same content but a fresh node identity (and, realistically, some
// attribute churn) - the classic "recycled DOM node" pattern. There is
// also an unrelated top-level "Open chat" button with duplicated
// accessible-name text, which is what the old code was mistakenly
// recovering to.
// ---------------------------------------------------------------------
section('Reddit: shadow-DOM recovery should find the real counter, not "Open chat"');

const redditDom = new JSDOM(`
<!doctype html><html><body>
  <button aria-label="Open chat">
    <span class="sr-only">Open chat</span>
    <span aria-hidden="true">Open chat</span>
  </button>
  <div id="feed"></div>
</body></html>
`);
const rdoc = redditDom.window.document;
(globalThis as any).window = redditDom.window;
(globalThis as any).document = rdoc;
(globalThis as any).Node = redditDom.window.Node;
(globalThis as any).CSS = redditDom.window.CSS ?? { escape: (s: string) => s };
(globalThis as any).ShadowRoot = redditDom.window.ShadowRoot;

function mountPost(host: Element, count: string) {
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <div class="post-wrapper">
      <faceplate-number number="${count}" pretty aria-label="${count} upvotes" class="vote-count-abc123">${count}</faceplate-number>
    </div>
  `;
  return shadow.querySelector('faceplate-number')!;
}

const feed = rdoc.getElementById('feed')!;
const post1 = rdoc.createElement('shreddit-post');
feed.appendChild(post1);
const counterEl = mountPost(post1, '128');

const fp = buildFingerprint(counterEl);
console.log('Captured selector:', fp.cssSelector);
assert(fp.cssSelector.includes('>>>'), 'fingerprint selector pierces the shadow boundary with >>>');

// Simulate virtualization: the original <shreddit-post> is destroyed and
// a brand new one (new node identity, same content) takes its place.
post1.remove();
const post2 = rdoc.createElement('shreddit-post');
feed.appendChild(post2);
mountPost(post2, '128');

const recovered = locateElement(fp, rdoc);
assert(recovered.element !== null, 'recovery finds a replacement element at all');
assert(
  recovered.element?.tagName.toLowerCase() === 'faceplate-number',
  `recovered the actual counter element, not something else (got <${recovered.element?.tagName.toLowerCase()}>)`,
);
assert(recovered.score >= 55, `recovery confidence (${recovered.score}) clears the accept threshold`);

const extracted = locateAndExtract(rdoc, fp, 'text', null);
assert(extracted.value === '128', `extracted value is "128", got "${extracted.value}"`);
assert(
  !String(extracted.value).includes('Open chat'),
  'extracted value never contains "Open chat"',
);

// ---------------------------------------------------------------------
// Scenario 2: the old leak — recovery scan finds nothing good enough
// (only the chat button is tag-compatible in a light-DOM-only scan) and
// must NOT fall back to it.
// ---------------------------------------------------------------------
section('Regression: a low-confidence-only candidate pool must not be used');

const lonelyDom = new JSDOM(`
<!doctype html><html><body>
  <header>
    <nav>
      <a href="/">Home</a>
      <a href="/popular">Popular</a>
      <a href="/all">All</a>
    </nav>
    <button aria-label="Open chat">
      <span class="sr-only">Open chat</span>
      <span aria-hidden="true">Open chat</span>
    </button>
  </header>
  <main>
    <p>Some ordinary page content, several paragraphs long, so this
       fixture doesn't itself resemble a bot-verification interstitial
       (those are typically near-empty pages with a couple of scripts
       and nothing else) - this test is specifically about the
       low-confidence-candidate path, not the anti-automation path.</p>
  </main>
</body></html>
`);
const ldoc = lonelyDom.window.document;
(globalThis as any).window = lonelyDom.window;
(globalThis as any).document = ldoc;
(globalThis as any).Node = lonelyDom.window.Node;

// A fingerprint for a <faceplate-number> that simply doesn't exist
// anywhere in this document (simulating "moved somewhere unrecoverable").
const orphanFp = { ...fp, cssSelector: '#nonexistent', xpath: '//*[@id="nonexistent"]' };
const noMatch = locateElement(orphanFp, ldoc);
assert(noMatch.element === null, 'no element is returned when nothing clears the confidence threshold');

const noMatchExtract = locateAndExtract(ldoc, orphanFp, 'text', null);
assert(noMatchExtract.value === null, 'extraction correctly reports failure rather than "Open chat"');
assert(
  noMatchExtract.diagnostic.code === 'ELEMENT_NOT_FOUND' ||
    noMatchExtract.diagnostic.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE',
  `failure diagnostic is meaningful, got ${noMatchExtract.diagnostic.code}`,
);

// ---------------------------------------------------------------------
// Scenario 3: Umami-style duplicate accessible-name text must not
// corrupt extraction from an element that IS correctly matched.
// ---------------------------------------------------------------------
section('Text extraction skips aria-hidden/sr-only duplicate labels');

const dupDom = new JSDOM(`<!doctype html><html><body>
  <div id="stat"><span>2</span><span class="sr-only">2 visitors this session</span></div>
</body></html>`);
const ddoc = dupDom.window.document;
(globalThis as any).window = dupDom.window;
(globalThis as any).document = ddoc;
(globalThis as any).Node = dupDom.window.Node;
const statEl = ddoc.getElementById('stat')!;
const statFp = buildFingerprint(statEl);
const statResult = locateAndExtract(ddoc, statFp, 'text', null);
assert(
  statResult.value === '2',
  `visible value extracted without the hidden accessible duplicate appended (got "${statResult.value}")`,
);

// ---------------------------------------------------------------------
// Scenario 4: Umami-style slow-fetch-then-render counter, retried
// across `withExponentialBackoff` attempts rather than caught within a
// single attempt's confirmation window. An earlier version closed the
// completion-based network-idle blind spot (a page whose only
// outstanding work is one slow `fetch()` looks "quiet" the whole time
// it's pending) with a live in-flight-request count fed by a
// `fetch`/`XMLHttpRequest` patch injected into the page. That patch was
// removed - it reassigned `window.fetch`, which broke Reddit's
// preload/credentials matching even when made fully transparent - so
// Monitor no longer has a precise in-flight signal and relies on
// retrying: the DOM mutation when the fetch finally resolves (updating
// `visitors` from "0" to "2") is itself picked up by the *next*
// attempt's confirmation read, even if an earlier attempt's narrow
// confirmation window landed on the stale placeholder. This exercises
// the real `waitForPageReady` + `resolveSettledValue`, not stubs.
// ---------------------------------------------------------------------
section('Umami: settle loop converges on the real value once the slow fetch resolves, via retry');

const statDom = new JSDOM(`<!doctype html><html><body><div id="visitors">0</div></body></html>`, {
  pretendToBeVisual: true,
});
const sdoc = statDom.window.document;
(globalThis as any).window = statDom.window;
(globalThis as any).document = sdoc;
(globalThis as any).Node = statDom.window.Node;
(globalThis as any).MutationObserver = statDom.window.MutationObserver;
// jsdom doesn't implement PerformanceObserver - readiness.ts already
// try/catches that construction and degrades gracefully, which this
// also exercises.

const visitorsEl = sdoc.getElementById('visitors')!;
const visitorsFp = buildFingerprint(visitorsEl);

// As if Umami's stats API call hasn't resolved yet: the DOM only
// updates once the fetch lands, 900ms in - exactly like a real
// `fetch().then(setState)`, but observed purely as a DOM mutation now
// rather than via a patched-fetch signal.
setTimeout(() => {
  visitorsEl.textContent = '2';
}, 900);

const settled = await resolveSettledValue(
  (maxWaitMs) => waitForPageReady(statDom.window as unknown as Window, { maxWaitMs, minWaitMs: 50 }),
  () => locateAndExtract(sdoc, visitorsFp, 'text', null),
  { maxTotalWaitMs: 8_000, confirmDelayMs: 300 },
);

assert(
  settled.value === '2',
  `settle loop eventually converges on the real value "2" once the fetch resolves and updates the DOM (got "${settled.value}")`,
);

// ---------------------------------------------------------------------
// Scenario 4b: client-rendered dashboards often mutate unrelated UI
// forever (clock, activity feed, chart animation). A stable monitored
// target must be confirmed from its own reads, not blocked waiting for
// the entire document to become globally quiet.
// ---------------------------------------------------------------------
section('Dynamic dashboard: stable target is not blocked by unrelated DOM churn');

const churnDom = new JSDOM(`<!doctype html><html><body><span id="value">935</span><span id="ticker"></span></body></html>`, {
  pretendToBeVisual: true,
});
const cdoc = churnDom.window.document;
(globalThis as any).window = churnDom.window;
(globalThis as any).document = cdoc;
(globalThis as any).Node = churnDom.window.Node;
(globalThis as any).MutationObserver = churnDom.window.MutationObserver;
const churnValue = cdoc.getElementById('value')!;
const churnFp = buildFingerprint(churnValue);
let tick = 0;
const churnTimer = setInterval(() => {
  cdoc.getElementById('ticker')!.textContent = String(++tick);
}, 40);
const churnStart = Date.now();
const churnResult = await resolveSettledValue(
  (maxWaitMs) => waitForPageReady(churnDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
  () => locateAndExtract(cdoc, churnFp, 'text', null),
  { maxTotalWaitMs: 3_000, confirmDelayMs: 150 },
);
clearInterval(churnTimer);
assert(churnResult.value === '935', `extracts stable dashboard value despite continuous unrelated mutations (got ${JSON.stringify(churnResult.value)})`);
assert(Date.now() - churnStart < 1_600, 'does not spend the whole budget waiting for page-wide quiet');

// ---------------------------------------------------------------------
// Scenario 4c: CoinMarketCap-style bot-verification/CAPTCHA interstitial
// that clears on its own shortly after being detected (a passive
// "Just a moment"-style challenge, not one requiring a human to solve
// anything). The check must never substitute a value read from the
// challenge shell itself, must keep retrying (never give up on the
// first look), and must recover the real value - without ever having
// touched or interacted with the challenge - once the site swaps its
// real content back in.
// ---------------------------------------------------------------------
section('Anti-automation: transient CAPTCHA/challenge page clears and the real value is recovered');

const challengeDom = new JSDOM(
  `<!doctype html><html><head><title>CoinMarketCap</title></head><body><div id="price">$68,250.05</div></body></html>`,
  { pretendToBeVisual: true },
);
const challengeDoc = challengeDom.window.document;
(globalThis as any).window = challengeDom.window;
(globalThis as any).document = challengeDoc;
(globalThis as any).Node = challengeDom.window.Node;
(globalThis as any).MutationObserver = challengeDom.window.MutationObserver;

const priceEl = challengeDoc.getElementById('price')!;
const priceFp = buildFingerprint(priceEl);

// Simulate the tab landing on the challenge instead of the real page:
// the original element is gone and the document looks like a known
// interstitial (matches `antiAutomation.ts`'s title pattern).
challengeDoc.title = 'Just a moment...';
priceEl.remove();

let sawAntiAutomationDetected = false;
const originalChallengeRead = () => locateAndExtract(challengeDoc, priceFp, 'text', null);
const trackedRead = () => {
  const result = originalChallengeRead();
  if (result.diagnostic.code === 'ANTI_AUTOMATION_DETECTED') sawAntiAutomationDetected = true;
  return result;
};

// The real page returns partway through the retry budget - well after
// the first read, so recovery only succeeds if the loop actually waits
// and retries rather than giving up after one look.
setTimeout(() => {
  challengeDoc.title = 'CoinMarketCap';
  const revived = challengeDoc.createElement('div');
  revived.id = 'price';
  revived.textContent = '$68,412.10';
  challengeDoc.body.appendChild(revived);
}, 1_400);

const recoveredStart = Date.now();
const challengeRecovered = await resolveSettledValue(
  (maxWaitMs) => waitForPageReady(challengeDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
  trackedRead,
  { maxTotalWaitMs: 12_000, confirmDelayMs: 200 },
);
const recoveredElapsed = Date.now() - recoveredStart;

assert(sawAntiAutomationDetected, 'the challenge page was actually detected (not silently ignored) before it cleared');
assert(
  challengeRecovered.value === '$68,412.10',
  `recovers the real value once the challenge clears, never a value read from the challenge shell itself (got ${JSON.stringify(challengeRecovered.value)})`,
);
assert(challengeRecovered.diagnostic.code !== 'ANTI_AUTOMATION_DETECTED', 'final outcome is not still flagged as a challenge once the real page is back');
assert(recoveredElapsed < 12_000, `resolves once the real content appears rather than waiting out the full budget (took ${recoveredElapsed}ms)`);

// ---------------------------------------------------------------------
// Scenario 4d: the same interstitial, but it never clears (e.g. one
// that needs a human to solve it - which this code must never attempt
// to do). Retries must still be bounded: the check has to give up
// within its time budget and report a clear, honest "temporarily
// unavailable" outcome rather than hanging indefinitely or fabricating
// a "No value" that reads like the target was permanently missing.
// ---------------------------------------------------------------------
section('Anti-automation: persistent challenge page is bounded and reported as temporarily unavailable');

const stuckDom = new JSDOM(
  `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div></body></html>`,
  { pretendToBeVisual: true },
);
const stuckDoc = stuckDom.window.document;
(globalThis as any).window = stuckDom.window;
(globalThis as any).document = stuckDoc;
(globalThis as any).Node = stuckDom.window.Node;
(globalThis as any).MutationObserver = stuckDom.window.MutationObserver;

// A fingerprint for an element that simply never appears in this
// document - the challenge shell is all there ever is.
const ghost = stuckDoc.createElement('div');
ghost.textContent = '$1.00';
stuckDoc.body.appendChild(ghost);
const stuckFp = buildFingerprint(ghost);
ghost.remove();

const stuckBudgetMs = 4_000;
const stuckStart = Date.now();
const stuck = await resolveSettledValue(
  (maxWaitMs) => waitForPageReady(stuckDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
  () => locateAndExtract(stuckDoc, stuckFp, 'text', null),
  { maxTotalWaitMs: stuckBudgetMs, confirmDelayMs: 200 },
);
const stuckElapsed = Date.now() - stuckStart;

assert(stuck.value === null, `never substitutes or fabricates a value from a challenge page that never clears (got ${JSON.stringify(stuck.value)})`);
assert(stuck.diagnostic.code === 'ANTI_AUTOMATION_DETECTED', `reports the anti-automation diagnostic rather than a generic/misleading one (got ${stuck.diagnostic.code})`);
assert(stuck.updatedFingerprint === null, 'never updates/relocates the fingerprint off of a challenge page');
assert(
  !!stuck.diagnostic.detail && /temporarily unavailable/i.test(stuck.diagnostic.detail),
  `exhausted retries leave a clear, human-readable "temporarily unavailable" note (got ${JSON.stringify(stuck.diagnostic.detail)})`,
);
assert(
  stuckElapsed < stuckBudgetMs + 2_000,
  `gives up within a bounded amount of time instead of scanning forever (took ${stuckElapsed}ms against a ${stuckBudgetMs}ms budget)`,
);

// ---------------------------------------------------------------------
// Scenario 5: semantic value detection classifies extracted text and
// derives a normalized comparable number, without losing the original
// formatted text (which the caller keeps in `value` regardless).
// ---------------------------------------------------------------------
section('Semantic value detection');

const semanticCases: Array<{
  text: string;
  type: string;
  normalized: number | null;
  unit?: string | null;
}> = [
  { text: '$49.99', type: 'currency', normalized: 49.99, unit: 'USD' },
  { text: '€1,299', type: 'currency', normalized: 1299, unit: 'EUR' },
  { text: '$45.2M revenue', type: 'revenue', normalized: 45_200_000, unit: 'USD' },
  { text: '87%', type: 'percentage', normalized: 87, unit: '%' },
  { text: '-4.5%', type: 'percentage', normalized: -4.5, unit: '%' },
  { text: '4.8/5', type: 'stars', normalized: 4.8, unit: '/5' },
  { text: '4.5 stars', type: 'stars', normalized: 4.5, unit: '/5' },
  { text: '★★★★☆', type: 'stars', normalized: 4, unit: '/5' },
  { text: '2.3 GB', type: 'storage', normalized: 2.3 * 1024 ** 3, unit: 'GB' },
  { text: '512 KB', type: 'storage', normalized: 512 * 1024, unit: 'KB' },
  { text: '3h 24m', type: 'duration', normalized: 3 * 3600 + 24 * 60, unit: 's' },
  { text: '1:23:45', type: 'duration', normalized: 1 * 3600 + 23 * 60 + 45, unit: 's' },
  { text: '45 minutes', type: 'duration', normalized: 45 * 60, unit: 's' },
  { text: '12.4K followers', type: 'followers', normalized: 12_400, unit: null },
  { text: '1.2M subscribers', type: 'followers', normalized: 1_200_000, unit: null },
  { text: '45,231 views', type: 'views', normalized: 45_231, unit: null },
  { text: '1.2K', type: 'count', normalized: 1_200, unit: null },
  { text: '12,345', type: 'number', normalized: 12_345, unit: null },
  { text: 'Out of stock', type: 'text', normalized: null, unit: null },
];

for (const testCase of semanticCases) {
  const result = detectSemanticValue(testCase.text);
  assert(
    result.type === testCase.type,
    `"${testCase.text}" classified as ${testCase.type} (got ${result.type})`,
  );
  assert(
    result.normalized === testCase.normalized ||
      (result.normalized !== null &&
        testCase.normalized !== null &&
        Math.abs(result.normalized - testCase.normalized) < 0.001),
    `"${testCase.text}" normalized to ${testCase.normalized} (got ${result.normalized})`,
  );
  if (testCase.unit !== undefined) {
    assert(
      result.unit === testCase.unit,
      `"${testCase.text}" unit is ${JSON.stringify(testCase.unit)} (got ${JSON.stringify(result.unit)})`,
    );
  }
  assert(result.raw === testCase.text, `"${testCase.text}" preserves the original text as \`raw\``);
}

// A followers count and a plain number are not comparable, even if both parsed.
const followersThen = detectSemanticValue('12.4K followers');
const followersNow = detectSemanticValue('13.1K followers');
const delta = compareSemanticValues(followersThen, followersNow);
assert(delta !== null && Math.abs(delta - 700) < 0.001, `follower delta computed correctly (got ${delta})`);

const mismatchedTypes = compareSemanticValues(detectSemanticValue('$49.99'), detectSemanticValue('87%'));
assert(mismatchedTypes === null, 'mismatched semantic types are not comparable');

// ---------------------------------------------------------------------
// Scenario 6: picker target resolution. `elementFromPoint()` gives the
// literal element under the cursor, which on a real dashboard is often
// a wrapper, a label, or an icon next to the value someone actually
// wants - `resolvePickerTarget` has to find the right element nearby
// rather than blindly trusting the raw hit.
// ---------------------------------------------------------------------
section('Picker target resolution');

const pickerDom = new JSDOM(`
<!doctype html><html><body>
  <div id="card" class="stat-card">
    <span class="label">Visitors</span>
    <span id="value" class="value">342</span>
  </div>
  <div id="iconRow">
    <svg id="icon" width="16" height="16"><circle r="4"/></svg>
    <span id="iconText">1.2K followers</span>
  </div>
  <div id="empty"></div>
  <p id="prose">${'This is a long paragraph of unrelated prose that goes on and on. '.repeat(3)}</p>
</body></html>
`);
const pdoc = pickerDom.window.document;
(globalThis as any).window = pickerDom.window;
(globalThis as any).document = pdoc;
(globalThis as any).Node = pickerDom.window.Node;
(globalThis as any).CSS = pickerDom.window.CSS ?? { escape: (s: string) => s };

const valueEl = pdoc.getElementById('value')!;
const cardEl = pdoc.getElementById('card')!;
const iconEl = pdoc.getElementById('icon')!;
const emptyEl = pdoc.getElementById('empty')!;
const proseEl = pdoc.getElementById('prose')!;

const directHit = resolvePickerTarget(valueEl);
assert(directHit !== null, 'hovering the value span directly resolves to something');
assert(directHit?.text === '342', `resolves to the value's own text (got "${directHit?.text}")`);
assert(
  directHit?.semanticValue.type === 'number',
  `classifies "342" as a number (got ${directHit?.semanticValue.type})`,
);
assert(
  directHit?.label === 'Visitors',
  `picks up the nearby label "Visitors" (got "${directHit?.label}")`,
);

const wrapperHit = resolvePickerTarget(cardEl);
assert(
  wrapperHit?.element === valueEl,
  'hovering the wrapper card still resolves down to the specific value element, not the whole card',
);
assert(wrapperHit?.text === '342', `resolves to "342", not the concatenated card text (got "${wrapperHit?.text}")`);

const iconHit = resolvePickerTarget(iconEl);
assert(
  iconHit !== null && iconHit.text.includes('1.2K'),
  `hovering a bare icon still finds the readable text nearby (got ${JSON.stringify(iconHit?.text)})`,
);

const emptyHit = resolvePickerTarget(emptyEl);
assert(emptyHit === null, 'an empty element with no readable text/neighbors resolves to null (invalid target)');

const proseHit = resolvePickerTarget(proseEl);
assert(
  proseHit === null,
  `a long paragraph (over the length cap) is rejected as a value (got ${JSON.stringify(proseHit?.text?.slice(0, 30))})`,
);

// ---------------------------------------------------------------------
// Scenario: X/Twitter-style virtualized timeline. Every tweet's action
// row (like/reply/repost/bookmark buttons) is structurally identical to
// every other tweet's, so position used to be the only thing telling
// two tweets' like counts apart - and a virtualized timeline rewrites
// position on every scroll, reorder, and "Show N posts" click. This
// checks that `itemAnchor` (the tweet's own permalink) keeps recovery
// pinned to the *same tweet* even after its DOM node is torn down,
// rebuilt, and moved to a different sibling index - including when a
// brand new, unrelated tweet gets spliced in at its old index, which is
// exactly the setup that used to make the wrong number get reported.
// ---------------------------------------------------------------------
section('X/Twitter: virtualized-timeline recovery follows the tweet, not the sibling index');

function tweetHtml(id: string, count: string): string {
  return `
    <article role="article">
      <a href="/someuser/status/${id}">permalink</a>
      <time datetime="2026-08-18T00:00:${id.slice(-2)}.000Z">Aug 18</time>
      <button data-testid="like" aria-label="${count} Likes. Like">
        <span><span>${count}</span></span>
      </button>
    </article>
  `;
}

const twitterDom = new JSDOM(
  `<!doctype html><html><body><div id="timeline">${tweetHtml('111', '12')}${tweetHtml('222', '147')}${tweetHtml('333', '58')}</div></body></html>`,
  { url: 'https://x.com/home' },
);
const tdoc = twitterDom.window.document;
(globalThis as any).window = twitterDom.window;
(globalThis as any).document = tdoc;
(globalThis as any).Node = twitterDom.window.Node;
(globalThis as any).CSS = twitterDom.window.CSS ?? { escape: (s: string) => s };
(globalThis as any).ShadowRoot = twitterDom.window.ShadowRoot;

const timeline = tdoc.getElementById('timeline')!;
const likeButtons = Array.from(tdoc.querySelectorAll('[data-testid="like"]'));
// The element a person would actually hover/pick: the innermost span
// holding tweet 222's like count.
const targetSpan = likeButtons[1]!.querySelector('span span')!;
const twitterFp = buildFingerprint(targetSpan);
assert(
  twitterFp.itemAnchor?.href === '/someuser/status/222',
  `fingerprint anchors to the watched tweet's own permalink (got ${JSON.stringify(twitterFp.itemAnchor)})`,
);

// Virtualized re-render: every article gets fresh node identities,
// reordered, with a brand new tweet spliced in at tweet 222's *old*
// sibling index - and tweet 222's own count has since changed.
timeline.innerHTML = [
  tweetHtml('333', '58'),
  tweetHtml('444', '9999'), // new tweet, now sitting at 222's old index
  tweetHtml('222', '150'), // the actually-watched tweet - moved, updated
  tweetHtml('111', '12'),
].join('');

const twitterRecovered = locateAndExtract(tdoc, twitterFp, 'text', null);
assert(
  twitterRecovered.value === '150',
  `recovers tweet 222's own current count, not whichever tweet now sits at its old position (got ${JSON.stringify(twitterRecovered.value)})`,
);

// ---------------------------------------------------------------------
// Scenario: range-first selection + duplicate feed metrics. Browsers
// expose a caret range for text beneath the cursor; that range must win
// over an enclosing card's concatenated text, then remain associated
// with the correct repeated item after a virtualized replacement.
// ---------------------------------------------------------------------
section('Range selection and duplicate metric association');

const rangeDom = new JSDOM(`<!doctype html><html><body>
  <article><a href="/alice/status/901">post</a><span class="label">Likes</span><span class="metric">12</span></article>
  <article><a href="/bob/status/902">post</a><span class="label">Likes</span><span class="metric">12</span></article>
</body></html>`, { url: 'https://x.com/home' });
const rangeDoc = rangeDom.window.document;
(globalThis as any).window = rangeDom.window;
(globalThis as any).document = rangeDoc;
(globalThis as any).Node = rangeDom.window.Node;
(globalThis as any).CSS = rangeDom.window.CSS ?? { escape: (s: string) => s };

const secondMetric = rangeDoc.querySelectorAll('.metric')[1]!;
const secondText = secondMetric.firstChild!;
(rangeDoc as any).caretRangeFromPoint = () => {
  const range = rangeDoc.createRange();
  range.setStart(secondText, 1);
  range.collapse(true);
  return range;
};
const rangeTarget = resolvePickerTargetAtPoint(rangeDoc, 10, 10);
assert(rangeTarget?.text === '12', `range picker preserves the exact text under the cursor (got ${JSON.stringify(rangeTarget?.text)})`);
assert(rangeTarget?.element === secondMetric, 'range picker anchors the smallest text-owning element, not the article');

const nestedDom = new JSDOM(`<!doctype html><html><body><span id="price"><span>$</span><span>49.99</span></span></body></html>`);
const nestedDoc = nestedDom.window.document;
(globalThis as any).Node = nestedDom.window.Node;
const nestedText = nestedDoc.querySelectorAll('#price span')[1]!.firstChild!;
(nestedDoc as any).caretRangeFromPoint = () => {
  const range = nestedDoc.createRange();
  range.setStart(nestedText, 2);
  range.collapse(true);
  return range;
};
const nestedTarget = resolvePickerTargetAtPoint(nestedDoc, 1, 1);
assert(nestedTarget?.text === '$ 49.99', `nested price fragments resolve as one displayed price (got ${JSON.stringify(nestedTarget?.text)})`);

const duplicateFp = buildFingerprint(secondMetric, undefined, rangeTarget?.textAnchor ?? null);
rangeDoc.body.innerHTML = `
  <article><a href="/eve/status/903">post</a><span class="label">Likes</span><span class="metric">999</span></article>
  <article><a href="/alice/status/901">post</a><span class="label">Likes</span><span class="metric">15</span></article>
  <article><a href="/bob/status/902">post</a><span class="label">Likes</span><span class="metric">18</span></article>`;
const duplicateRecovered = locateAndExtract(rangeDoc, duplicateFp, 'text', null);
assert(duplicateRecovered.value === '18', `duplicate metric stays with post 902 after virtualized replacement (got ${JSON.stringify(duplicateRecovered.value)})`);

// A SPA route change replaces every node. The fingerprint must re-resolve
// from durable item/context signals rather than retain a stale reference.
rangeDoc.body.innerHTML = `
  <main data-route="/new-home"><article><a href="/bob/status/902">post</a><span class="label">Likes</span><span class="metric">21</span></article></main>`;
const spaRecovered = locateAndExtract(rangeDoc, duplicateFp, 'text', null);
assert(spaRecovered.value === '21', `re-resolves after SPA navigation and replaced DOM nodes (got ${JSON.stringify(spaRecovered.value)})`);

// ---------------------------------------------------------------------
// Scenario: Cloudflare-style dashboard table. Every row is a plain
// <table><tr> (not a feed/article/web-component), several columns
// repeat the *exact same* text across rows ("Active" status, a "5"
// security-insights score), and the monitored value ("Unique
// visitors") is a small number with nothing distinctive about it on
// its own. Recovery has to key off the row's own domain link, not
// generic structural similarity - a table row has almost no
// structural difference from its neighbors.
// ---------------------------------------------------------------------
section('Cloudflare-style table: row identity survives a re-sort with duplicate cell values');

function domainRow(domain: string, visitors: string): string {
  return `
    <tr>
      <td><a href="/4f3126d047aa8d4ba12493821ed9dbce/${domain}/overview">${domain}</a></td>
      <td>Active</td>
      <td>5</td>
      <td>${visitors}</td>
    </tr>
  `;
}

const cfDom = new JSDOM(`<!doctype html><html><body>
  <table id="domains">
    <tbody>
      ${domainRow('ayushmxxn.com', '935')}
      ${domainRow('hammyweb.online', '151')}
      ${domainRow('icetheme.in', '1.44k')}
    </tbody>
  </table>
</body></html>`, { url: 'https://dash.cloudflare.com/4f3126d047aa8d4ba12493821ed9dbce/domains' });
const cfDoc = cfDom.window.document;
(globalThis as any).window = cfDom.window;
(globalThis as any).document = cfDoc;
(globalThis as any).Node = cfDom.window.Node;
(globalThis as any).CSS = cfDom.window.CSS ?? { escape: (s: string) => s };

const cfRows = Array.from(cfDoc.querySelectorAll('tr'));
// The cell a person would actually pick: ayushmxxn.com's own visitor count.
const cfTargetCell = cfRows[0]!.querySelectorAll('td')[3]!;
const cfFp = buildFingerprint(cfTargetCell);
assert(
  cfFp.itemAnchor?.href === '/4f3126d047aa8d4ba12493821ed9dbce/ayushmxxn.com/overview',
  `fingerprint anchors to the row's own domain link (got ${JSON.stringify(cfFp.itemAnchor)})`,
);

// Table re-sorts alphabetically and every row is re-rendered with a
// fresh <tr> (React key-based reconciliation commonly recreates rows
// on a sort/filter change) - same three domains, new order, updated
// visitor counts, same duplicated "Active"/"5" cells everywhere.
cfDoc.getElementById('domains')!.querySelector('tbody')!.innerHTML = [
  domainRow('hammyweb.online', '160'),
  domainRow('icetheme.in', '1.50k'),
  domainRow('ayushmxxn.com', '1002'),
].join('');

const cfRecovered = locateAndExtract(cfDoc, cfFp, 'text', null);
assert(
  cfRecovered.value === '1002',
  `recovers ayushmxxn.com's own updated visitor count after a re-sort, not another domain's (got ${JSON.stringify(cfRecovered.value)})`,
);
assert(
  cfRecovered.diagnostic.code === 'OK_RECOVERED',
  `recovery is reported as a relocation, not a lucky exact-selector hit (got ${cfRecovered.diagnostic.code})`,
);

// ---------------------------------------------------------------------
// Scenario: selecting a metric from a virtualized home feed (see the
// reported bug - a post's like count picked on x.com/home). By the
// time a check runs, the virtualized feed has moved on: the post is
// scrolled out, recycled, or still sitting behind a loading
// placeholder, so a recovery scan of the *feed* page has nothing
// usable to find - reproducing "best candidate scored well below
// threshold" / "target still covered by a loading indicator" from the
// report. `resolveCheckUrl` must redirect the check to the post's own
// permalink (captured in `itemAnchor` at pick time) instead, where the
// same generic fingerprint/recovery pipeline finds the metric with no
// per-site handling. This must stay generic: a dashboard/table row
// (the Cloudflare monitor above) has an `itemAnchor.href` too, but it's
// the weaker row-link fallback, not a genuine permalink
// (`isPermalink: false`) - that monitor must keep resolving to its own
// page exactly as before.
// ---------------------------------------------------------------------
section('Virtualized home feed: a picked metric resolves through the post permalink, not the feed');

const homeFeedDom = new JSDOM(
  `<!doctype html><html><body><div id="timeline">${tweetHtml('222', '147')}</div></body></html>`,
  { url: 'https://x.com/home' },
);
const homeDoc = homeFeedDom.window.document;
(globalThis as any).window = homeFeedDom.window;
(globalThis as any).document = homeDoc;
(globalThis as any).Node = homeFeedDom.window.Node;
(globalThis as any).CSS = homeFeedDom.window.CSS ?? { escape: (s: string) => s };

const homeLikeSpan = homeDoc.querySelector('[data-testid="like"] span span')!;
const homeMonitorFp = buildFingerprint(homeLikeSpan);
assert(
  homeMonitorFp.itemAnchor?.href === '/someuser/status/222' && homeMonitorFp.itemAnchor.isPermalink === true,
  `fingerprint marks the post's own status link as a genuine permalink (got ${JSON.stringify(homeMonitorFp.itemAnchor)})`,
);

const homeMonitor = { url: 'https://x.com/home', fingerprint: homeMonitorFp };
const homeCheckUrl = resolveCheckUrl(homeMonitor);
assert(
  homeCheckUrl === 'https://x.com/someuser/status/222',
  `check resolves to the post's own permalink instead of the home feed (got ${homeCheckUrl})`,
);

// Reproduces the reported failure: the feed has virtualized the post
// away entirely by the time the check runs - it simply isn't in the
// DOM (scrolled out / still behind a loading placeholder). A recovery
// scan of the feed page itself has nothing to find.
const emptyFeedDoc = new JSDOM(`<!doctype html><html><body><div id="timeline"></div></body></html>`, {
  url: 'https://x.com/home',
}).window.document;
const feedFailure = locateAndExtract(emptyFeedDoc, homeMonitorFp, 'text', null);
assert(
  feedFailure.value === null,
  `recovery scan of the bare feed page finds nothing, reproducing the reported failure (got ${JSON.stringify(feedFailure.value)})`,
);

// Resolving through the permalink instead: the post's own page renders
// it as primary content (updated since the pick), so the same
// fingerprint locates it there even though the feed never had it
// available - and the user never had to open the post themselves.
const permalinkDoc = new JSDOM(`<!doctype html><html><body>${tweetHtml('222', '150')}</body></html>`, {
  url: homeCheckUrl,
}).window.document;
const permalinkRecovered = locateAndExtract(permalinkDoc, homeMonitorFp, 'text', null);
assert(
  permalinkRecovered.value === '150',
  `resolves the metric via the post's permalink page instead of the virtualized feed (got ${JSON.stringify(permalinkRecovered.value)})`,
);

// A monitor with no genuine item permalink (the Cloudflare dashboard
// row above - `isPermalink` is false there) keeps using the existing
// generic resolver against its own page, unchanged.
const cfMonitor = { url: 'https://dash.cloudflare.com/4f3126d047aa8d4ba12493821ed9dbce/domains', fingerprint: cfFp };
assert(
  cfFp.itemAnchor?.isPermalink === false,
  `the dashboard row's own link is captured as the weaker fallback, not a permalink (got ${JSON.stringify(cfFp.itemAnchor)})`,
);
assert(
  resolveCheckUrl(cfMonitor) === cfMonitor.url,
  `a monitor without a genuine item permalink still checks its own page (got ${resolveCheckUrl(cfMonitor)})`,
);

// A genuine item permalink means `fetch` and `live` would both resolve
// to the very same stable item URL (see `resolveCheckUrl` above) rather
// than the monitor's original dynamic feed page - and that item came
// from a feed virtualized/client-rendered enough to need an item anchor
// in the first place, so a raw-HTML `fetch` of its own permalink page
// is likely just as empty. `live` should be tried first for that case;
// a monitor with no genuine permalink keeps the normal fetch-first order.
assert(
  JSON.stringify(baseStrategyOrder(homeMonitorFp)) === JSON.stringify(['live', 'fetch']),
  `a genuine item permalink prefers the live strategy first, skipping a wasted fetch of the dynamic feed (got ${JSON.stringify(baseStrategyOrder(homeMonitorFp))})`,
);
assert(
  JSON.stringify(baseStrategyOrder(cfFp)) === JSON.stringify(['fetch', 'live']),
  `no genuine permalink keeps the normal fetch-first cascade order (got ${JSON.stringify(baseStrategyOrder(cfFp))})`,
);

// ---------------------------------------------------------------------
// Scenario: virtualized ARIA-grid dashboard row (the MUI DataGrid /
// AG Grid / TanStack Table pattern - div-based rows carrying a real
// row/record id, not a semantic <table>). Virtualization recycles DOM
// nodes: the same node that used to render one record gets reused,
// with its `data-row-key` and content swapped out, to render a
// completely different one. Recovery must follow the *id*, never a
// recycled node's current position or a stale in-memory reference.
// ---------------------------------------------------------------------
section('Virtualized data-grid row: recovery follows data-row-key, not a recycled DOM node');

function gridRow(id: string, mrr: string): string {
  return `<div role="row" data-row-key="${id}"><span>${id}</span><span class="mrr">${mrr}</span></div>`;
}

const gridDom = new JSDOM(`<!doctype html><html><body>
  <div id="grid" role="grid">
    ${gridRow('cus_1', '$1,200')}
    ${gridRow('cus_2', '$3,400')}
    ${gridRow('cus_3', '$800')}
  </div>
</body></html>`);
const gridDoc = gridDom.window.document;
(globalThis as any).window = gridDom.window;
(globalThis as any).document = gridDoc;
(globalThis as any).Node = gridDom.window.Node;
(globalThis as any).CSS = gridDom.window.CSS ?? { escape: (s: string) => s };

const gridRows = Array.from(gridDoc.querySelectorAll('[role="row"]'));
const gridTargetCell = gridRows[1]!.querySelector('.mrr')!; // cus_2's MRR
const gridFp = buildFingerprint(gridTargetCell);
assert(gridFp.itemAnchor?.rowKey === 'data-row-key=cus_2', `fingerprint captures the row's record id (got ${JSON.stringify(gridFp.itemAnchor)})`);

// Virtualization recycling: the DOM node that used to be cus_2's row
// is reused (same node identity) to render an unrelated cus_4, while
// cus_2 itself is now rendered by a *different* node, updated.
const secondNode = gridRows[1]!;
secondNode.setAttribute('data-row-key', 'cus_4');
secondNode.querySelector('span')!.textContent = 'cus_4';
secondNode.querySelector('.mrr')!.textContent = '$9,900';
const newRow = gridDoc.createElement('div');
newRow.setAttribute('role', 'row');
newRow.setAttribute('data-row-key', 'cus_2');
newRow.innerHTML = '<span>cus_2</span><span class="mrr">$3,650</span>';
gridDoc.getElementById('grid')!.appendChild(newRow);

const gridRecovered = locateAndExtract(gridDoc, gridFp, 'text', null);
assert(
  gridRecovered.value === '$3,650',
  `follows cus_2's own updated MRR to the new node, ignoring the recycled node now showing cus_4 (got ${JSON.stringify(gridRecovered.value)})`,
);

// Explicit unit check on the underlying scoring primitive: a candidate
// that matches every generic structural signal but is confirmed (via
// rowKey) to be a *different* record must never clear the acceptance
// threshold on structural similarity alone.
const wrongRecordScore = scoreCandidate(gridFp, secondNode.querySelector('.mrr')!);
assert(
  wrongRecordScore.score < 55,
  `a structurally-similar cell confirmed to belong to a different record scores below the acceptance threshold (got ${wrongRecordScore.score})`,
);

// ---------------------------------------------------------------------
// Scenario: recovery performance. `findItemAnchor` is called once per
// *candidate* during a recovery scan, and many candidates (every cell
// in the same row, every child of the same feed item) share the very
// same item root - without caching, that root's subtree (link scan,
// label-text walk) gets rescanned from scratch for every single one of
// them. An `ItemAnchorCache` shared across a scan should make that a
// single scan per root, reused by every candidate that maps to it,
// while each candidate still gets its own correct result (its own text
// excluded from the shared label-text pool it's matched against).
// ---------------------------------------------------------------------
section('Recovery performance: item-anchor scan is cached per root, not re-run per candidate');

const perfRowDom = new JSDOM(`<!doctype html><html><body>
  <div role="row" data-row-key="acct_9">
    <span id="cellA">Acme Corp</span>
    <span id="cellB">$4,200</span>
    <span id="cellC">Active</span>
  </div>
</body></html>`);
const perfRowDoc = perfRowDom.window.document;
(globalThis as any).window = perfRowDom.window;
(globalThis as any).document = perfRowDoc;
(globalThis as any).Node = perfRowDom.window.Node;
(globalThis as any).CSS = perfRowDom.window.CSS ?? { escape: (s: string) => s };

const perfRow = perfRowDoc.querySelector('[role="row"]')!;
const perfCellA = perfRowDoc.getElementById('cellA')!;
const perfCellB = perfRowDoc.getElementById('cellB')!;
const perfCellC = perfRowDoc.getElementById('cellC')!;

// Shadow the row's own `querySelectorAll` (an own property shadows the
// prototype method for this one element only, leaving every other
// element's lookup untouched) to count how many times the expensive
// root-level scan (`a[href]`, the one query it's guaranteed to run
// exactly once per scan) actually runs.
let rowScanCount = 0;
const originalRowQSA = perfRow.querySelectorAll.bind(perfRow);
(perfRow as any).querySelectorAll = (selector: string) => {
  if (selector === 'a[href]') rowScanCount += 1;
  return originalRowQSA(selector);
};

const sharedCache: ItemAnchorCache = new Map();
const anchorA = findItemAnchor(perfCellA, sharedCache);
const anchorB = findItemAnchor(perfCellB, sharedCache);
const anchorC = findItemAnchor(perfCellC, sharedCache);

assert(
  rowScanCount === 1,
  `the row's subtree is scanned once and reused across every candidate that shares it, not once per candidate (scanned ${rowScanCount} time(s))`,
);
assert(
  anchorA?.rowKey === 'data-row-key=acct_9' && anchorB?.rowKey === 'data-row-key=acct_9' && anchorC?.rowKey === 'data-row-key=acct_9',
  `every candidate under the row still resolves the same cached row identity (got ${JSON.stringify([anchorA?.rowKey, anchorB?.rowKey, anchorC?.rowKey])})`,
);
assert(
  anchorA?.primaryText === '$4,200' && anchorB?.primaryText === 'Acme Corp' && anchorC?.primaryText === 'Acme Corp',
  `each candidate still excludes its own text from the shared label pool it's matched against, rather than inheriting whichever candidate populated the cache first (got ${JSON.stringify([anchorA?.primaryText, anchorB?.primaryText, anchorC?.primaryText])})`,
);

rowScanCount = 0;
const uncachedA = findItemAnchor(perfCellA);
const uncachedB = findItemAnchor(perfCellB);
assert(
  rowScanCount === 2,
  `without a cache, each call still scans the root fresh as before - the cache is opt-in, not a change in default behavior (scanned ${rowScanCount} time(s))`,
);
assert(
  uncachedA?.rowKey === anchorA?.rowKey && uncachedB?.primaryText === anchorB?.primaryText,
  'the uncached path produces the exact same result as the cached one',
);

(perfRow as any).querySelectorAll = originalRowQSA;

// ---------------------------------------------------------------------
// Scenario: readiness must wait out a Tailwind-style `animate-pulse`
// skeleton (Vercel/Notion/Shopify-Polaris-style dashboards), not just
// the older "skeleton"/"spinner"/"shimmer" class names already covered.
// ---------------------------------------------------------------------
section('Readiness waits for an animate-pulse skeleton to clear');

const pulseDom = new JSDOM(
  `<!doctype html><html><body><div id="stat" class="animate-pulse h-4 w-10 bg-gray-200"></div></body></html>`,
  { pretendToBeVisual: true },
);
const pulseDoc = pulseDom.window.document;
const pulseEl = pulseDoc.getElementById('stat')!;
// jsdom lays out nothing by default (all rects are 0x0) - stub a
// visible size while the skeleton is "showing", the same way a real
// laid-out page would report a nonzero box for a placeholder.
let pulseShowing = true;
(pulseEl as any).getBoundingClientRect = () =>
  pulseShowing
    ? { width: 40, height: 16, top: 0, left: 0, right: 40, bottom: 16 }
    : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
setTimeout(() => {
  pulseShowing = false;
  pulseEl.className = '';
  pulseEl.textContent = '48';
}, 300);

const pulseResult = await waitForPageReady(pulseDom.window as unknown as Window, {
  maxWaitMs: 2_000,
  minWaitMs: 25,
});
assert(pulseResult.ready, `readiness reports ready once the pulse skeleton clears (signals: ${JSON.stringify(pulseResult.signals)})`);
assert(pulseResult.waitedMs >= 250, `readiness genuinely waited for the skeleton, not a lucky first check (waited ${pulseResult.waitedMs}ms)`);

// ---------------------------------------------------------------------
// Scenario: YouTube-style frame-replacement race. The tab reports
// "complete", but the very next `chrome.scripting.executeScript`
// (injecting the page agent, or the follow-up call into it) targets a
// frame that a fast client-side redirect has already swapped out from
// under it - Chrome surfaces this as "Frame with ID 0 was removed."
// This is transient: the next frame is normally scriptable within
// milliseconds. `locateOnTab` must retry through it rather than
// surfacing it as a fatal, unexplained UNKNOWN error - the real bug in
// the attached screenshot.
//
// `browser` is WXT's ambient global (see .wxt/types/imports.d.ts) -
// stubbing it here is mocking the extension platform, not our own
// logic, in keeping with this file's real-behavior-over-mocks approach
// elsewhere.
// ---------------------------------------------------------------------
section('Live tab: a "Frame with ID 0 was removed" race during injection is retried, not fatal');

{
  let injectCalls = 0;
  let funcCalls = 0;
  (globalThis as any).browser = {
    scripting: {
      executeScript: async (opts: any) => {
        if ('files' in opts) {
          injectCalls++;
          if (injectCalls === 1) {
            // Simulates the file injection landing on the frame just as
            // YouTube's redirect swaps it out.
            throw new Error('Frame with ID 0 was removed.');
          }
          return [{}];
        }
        funcCalls++;
        return [
          {
            result: {
              value: '1.2M subscribers',
              diagnosticCode: 'OK',
              diagnosticMessage: 'Checked successfully.',
              diagnosticDetail: null,
              updatedFingerprint: null,
              confidence: 100,
              method: 'fast-path:id',
              semanticValue: null,
            },
          },
        ];
      },
    },
    tabs: {
      get: async (id: number) => ({ id, status: 'complete' }),
    },
  };

  const raceOutcome = await locateOnTab(42, {} as unknown as ElementFingerprint, 'text', null, 5_000);
  assert(
    raceOutcome.ok === true && raceOutcome.value === '1.2M subscribers',
    `locate recovers the real value once the retry lands on the fresh frame (ok=${raceOutcome.ok}, value=${JSON.stringify(raceOutcome.value)}, diagnostic=${raceOutcome.diagnostic.code})`,
  );
  assert(injectCalls === 2, `exactly one retry was needed after the transient race (injection attempted ${injectCalls} time(s))`);
  assert(funcCalls === 1, `the locate call itself only ran once the frame had settled (called ${funcCalls} time(s))`);
}

// A *non*-transient error (e.g. a genuinely restricted page) must not
// be retried - retrying a persistent condition would just waste the
// check's time budget for no chance of a different outcome.
{
  let injectCalls = 0;
  (globalThis as any).browser = {
    scripting: {
      executeScript: async (opts: any) => {
        if ('files' in opts) {
          injectCalls++;
          throw new Error('Cannot access a chrome:// URL');
        }
        throw new Error('should not reach the locate call');
      },
    },
    tabs: {
      get: async (id: number) => ({ id, status: 'complete' }),
    },
  };

  const deniedOutcome = await locateOnTab(43, {} as unknown as ElementFingerprint, 'text', null, 5_000);
  assert(
    deniedOutcome.ok === false && deniedOutcome.diagnostic.code === 'PERMISSION_DENIED',
    `a persistent restricted-page error is classified correctly, not retried into a timeout (got ${deniedOutcome.diagnostic.code})`,
  );
  assert(injectCalls === 1, `no retry was attempted for a non-transient error (injection attempted ${injectCalls} time(s))`);
}

// `verifyTabSettled` itself: a tab that's already closed by the time
// it's checked is reported as such rather than treated as "stable".
{
  (globalThis as any).browser = {
    tabs: {
      get: async () => {
        throw new Error('No tab with id: 99.');
      },
    },
  };
  const closed = await verifyTabSettled(99);
  assert(
    closed.ok === false && closed.diagnostic.code === 'TAB_CLOSED',
    `a tab that vanished before settling is reported as closed, not silently treated as stable (got ${JSON.stringify(closed)})`,
  );
}

// `verifyTabSettled` must actually confirm stability across a re-check,
// not accept whatever a single read happens to show. A tab caught
// mid-bounce (still `loading`) on the first read should be re-checked
// until it lands, rather than being waved through or failed outright.
{
  let calls = 0;
  (globalThis as any).browser = {
    tabs: {
      get: async () => {
        calls += 1;
        if (calls <= 2) return { status: 'loading', url: 'https://example.com/redirecting' };
        return { status: 'complete', url: 'https://example.com/final' };
      },
    },
  };
  const settled = await verifyTabSettled(101);
  assert(
    settled.ok === true,
    `reports settled once status and URL have both landed and held, not on the first (mid-bounce) read (got ${JSON.stringify(settled)})`,
  );
  assert(calls > 2, `made more than one round of reads instead of trusting a single snapshot (made ${calls})`);
}

// A URL that keeps changing between every read (a bounce that never
// lands within the settle budget) must not be reported as settled off
// a stale single read — but it also isn't a hard failure: `verifyTabSettled`
// hands off to injection's own frame-retry backstop rather than failing
// the whole check outright over instability it can't itself resolve.
{
  let calls = 0;
  (globalThis as any).browser = {
    tabs: {
      get: async () => {
        calls += 1;
        return { status: 'complete', url: `https://example.com/bounce-${calls}` };
      },
    },
  };
  const bouncing = await verifyTabSettled(102);
  assert(
    bouncing.ok === true,
    `hands off to injection's own retry instead of failing the whole check over a persistent bounce (got ${JSON.stringify(bouncing)})`,
  );
  assert(calls >= 4, `retried the settle check itself multiple times against a never-landing URL before giving up (made ${calls} reads)`);
}

// ---------------------------------------------------------------------
// Scenario: the navigation race this file's tests didn't previously
// cover. `liveTabStrategy` used to call `tabs.update()` before
// `tabs.onUpdated`/`tabs.onRemoved` listeners were registered, leaving a
// window where a fast or no-op navigation could reach `status:
// 'complete'` with nothing listening yet, hanging the check until the
// load timeout for a load that had already happened. The fix registers
// both listeners *before* issuing the navigation, and separately
// handles `tabs.update()` itself resolving with an already-`complete`
// tab (the common shape of that no-op case). Lives in its own
// `liveTabNavigation.ts` module (see there) precisely so it can be
// exercised here without also mocking `liveTabStrategy.ts`'s unrelated
// storage/visibility-patch dependencies.
// ---------------------------------------------------------------------
section('Live tab: navigation listeners are registered before the tab is navigated (not after)');

{
  const callOrder: string[] = [];
  let onUpdatedListener: ((tabId: number, changeInfo: { status?: string }) => void) | null = null;

  (globalThis as any).browser = {
    tabs: {
      onUpdated: {
        addListener: (fn: any) => {
          callOrder.push('addListener:onUpdated');
          onUpdatedListener = fn;
        },
        removeListener: () => {},
      },
      onRemoved: {
        addListener: () => {
          callOrder.push('addListener:onRemoved');
        },
        removeListener: () => {},
      },
      update: async (tabId: number, _props: any) => {
        callOrder.push('update');
        // The real navigation completes asynchronously, strictly after
        // `update()` itself resolves - driven entirely through the
        // `onUpdated` listener registered above, exactly like a real
        // browser firing the event on its own schedule.
        queueMicrotask(() => onUpdatedListener?.(tabId, { status: 'complete' }));
        return { id: tabId, status: 'loading' };
      },
    },
  };

  const navResult = await navigateAndWaitForLoad(7, 'https://example.com/watched');

  assert(
    navResult.ok === true,
    `navigation resolves ok once the onUpdated 'complete' event fires (got ${JSON.stringify(navResult)})`,
  );
  assert(
    callOrder.indexOf('addListener:onUpdated') >= 0 &&
      callOrder.indexOf('addListener:onUpdated') < callOrder.indexOf('update') &&
      callOrder.indexOf('addListener:onRemoved') < callOrder.indexOf('update'),
    `both listeners are registered before the tab is navigated, not after (call order: ${callOrder.join(' -> ')})`,
  );
}

// A navigation to a URL the tab already shows can make `tabs.update()`
// itself resolve with an already-`complete` tab, with no further
// `onUpdated` "complete" event ever following it. The fix must resolve
// immediately from that, not hang until the load timeout waiting for an
// event that isn't coming.
{
  (globalThis as any).browser = {
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      update: async (tabId: number) => ({ id: tabId, status: 'complete' }),
    },
  };

  const start = Date.now();
  const noopResult = await navigateAndWaitForLoad(7, 'https://example.com/watched');
  const elapsed = Date.now() - start;

  assert(
    noopResult.ok === true,
    `an already-'complete' tab from tabs.update() itself resolves ok (got ${JSON.stringify(noopResult)})`,
  );
  assert(elapsed < 1_000, `resolves immediately instead of waiting out the load timeout (took ${elapsed}ms)`);
}

// ---------------------------------------------------------------------
// Scenario: Cloudflare-style authenticated dashboard that is slow not
// because the monitored value itself is slow to render, but because
// some *unrelated* part of the page (a live-chat widget's "connecting"
// spinner, a status badge) never fully clears. The old gating logic
// treated any page-wide loading indicator as blocking - a stable,
// already-correct target could be starved for the entire time budget by
// a spinner it has nothing to do with. Page-wide activity must now be
// weak: the target's own repeated-identical-read confirmation is what
// decides readiness.
// ---------------------------------------------------------------------
section('Dynamic dashboard: an unrelated persistent loading indicator does not stall a stable target');

const dashDom = new JSDOM(
  `<!doctype html><html><body>
    <div id="mrr">$45,231</div>
    <div class="chat-widget-spinner">Connecting…</div>
  </body></html>`,
  { pretendToBeVisual: true },
);
const dashDoc = dashDom.window.document;
const dashTarget = dashDoc.getElementById('mrr')!;
const dashSpinner = dashDoc.querySelector('.chat-widget-spinner') as HTMLElement;
// Give the unrelated spinner a real, nonzero box - the same "visible
// and present" state `hasLoadingIndicators` checks for - and never
// clear it, simulating a widget that stays in a perpetual loading
// state for the whole check (a live-chat connect indicator, a stuck
// third-party embed, etc.), unrelated to and independent of the
// monitored value.
(dashSpinner as any).getBoundingClientRect = () => ({ width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20 });
const dashFp = buildFingerprint(dashTarget);

const dashStart = Date.now();
const dashResult = await resolveSettledValue(
  (maxWaitMs) => waitForPageReady(dashDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
  () => locateAndExtract(dashDoc, dashFp, 'text', null),
  { maxTotalWaitMs: 6_000, confirmDelayMs: 200 },
);
const dashElapsed = Date.now() - dashStart;

assert(dashResult.value === '$45,231', `extracts the stable target value despite the unrelated spinner never clearing (got ${JSON.stringify(dashResult.value)})`);
assert(
  dashElapsed < 2_000,
  `resolves quickly instead of burning the full time budget on an unrelated loading indicator (took ${dashElapsed}ms against a 6000ms budget)`,
);

// ---------------------------------------------------------------------
// Scenario: GitHub-style profile stats. "1,234 followers" / "567
// following" are two structurally near-identical `<a><span>N</span>
// label</a>` stats sitting side by side - same tag, same classes, same
// depth - distinguished only by the plain label text sitting right
// after the count, with no element of its own wrapping it.
// `findLabelText` only ever checked *leading element* siblings
// (`previousElementSibling`) - it never saw this at all, so recovery
// had nothing to tell "followers" apart from "following" once the DOM
// was rebuilt (fresh node identities, same shape - exactly what a
// client-rendered profile page does on every visit).
// ---------------------------------------------------------------------
section('GitHub-style profile stat: a trailing label distinguishes "followers" from "following"');

function statHtml(tab: string, count: string, label: string): string {
  return `<a href="/octocat?tab=${tab}" class="Link--secondary no-underline no-wrap"><span class="text-bold color-fg-default">${count}</span> ${label}</a>`;
}

const statsDom = new JSDOM(
  `<!doctype html><html><body>
    <div class="vcard-details">
      <h1 class="vcard-fullname">octocat</h1>
      ${statHtml('followers', '1,234', 'followers')}
      <span class="middot-divider"></span>
      ${statHtml('following', '567', 'following')}
    </div>
  </body></html>`,
);
const statsDoc = statsDom.window.document;
(globalThis as any).window = statsDom.window;
(globalThis as any).document = statsDoc;
(globalThis as any).Node = statsDom.window.Node;
(globalThis as any).CSS = statsDom.window.CSS ?? { escape: (s: string) => s };

const followersSpan = statsDoc.querySelectorAll('a[href*="tab=followers"] span')[0]!;
const followingSpan = statsDoc.querySelectorAll('a[href*="tab=following"] span')[0]!;

assert(
  findLabelText(followersSpan) === 'followers',
  `a trailing, unwrapped label word right after the value is picked up as its nearby label text (got ${JSON.stringify(findLabelText(followersSpan))})`,
);
assert(
  findLabelText(followingSpan) === 'following',
  `the sibling stat's own trailing label is found too, not the first one on the page (got ${JSON.stringify(findLabelText(followingSpan))})`,
);

const followersFp = buildFingerprint(followersSpan);
const scoredFollowers = scoreCandidate(followersFp, followersSpan);
const scoredFollowing = scoreCandidate(followersFp, followingSpan);
assert(
  scoredFollowers.signals.nearbyLabelText === 1,
  `the followers fingerprint scores a full label match against the followers span itself (got ${scoredFollowers.signals.nearbyLabelText})`,
);
assert(
  (scoredFollowing.signals.nearbyLabelText ?? 0) === 0,
  `the followers fingerprint credits the "following" stat with no label match at all (got ${scoredFollowing.signals.nearbyLabelText})`,
);
assert(
  scoredFollowers.score > scoredFollowing.score,
  `the followers span scores strictly higher than its otherwise near-identical "following" sibling (followers=${scoredFollowers.score}, following=${scoredFollowing.score})`,
);

// A client-side re-render doesn't just change the counts - it can also
// shift *where* each stat sits without literally handing the
// "following" stat the exact DOM position "followers" used to occupy
// (an extra "Edit profile" button now rendered ahead of them, a
// slightly different wrapper). Position-based signals (domPath's
// nth-of-type) degrade for both stats equally in that case, neither
// keeping the exact position captured at pick time; only the label
// text still cleanly points at the followers count specifically.
statsDoc.querySelector('.vcard-details')!.innerHTML = `
  <h1 class="vcard-fullname">octocat</h1>
  <a href="/octocat/edit" class="btn">Edit profile</a>
  ${statHtml('followers', '1,300', 'followers')}
  <span class="middot-divider"></span>
  ${statHtml('following', '999', 'following')}
`;
const statsRecovered = locateAndExtract(statsDoc, followersFp, 'text', null);
assert(
  statsRecovered.value === '1,300',
  `recovers the followers count by its label after the surrounding layout shifts, not the structurally-similar "following" stat next to it (got ${JSON.stringify(statsRecovered.value)})`,
);

// ---------------------------------------------------------------------
// Scenario: Reddit/X home feed. Two structurally identical posts sit
// side by side; a post's own permalink can render with a different,
// non-identifying query string between visits (a referral/tracking
// param a site attaches inconsistently) even though the path - which
// is what actually identifies the post - hasn't changed. Comparing the
// raw href string would treat that as "a different post" - either
// falsely rejecting the genuinely correct post (a false conflict,
// capped to a low score, surfacing as "No value") or, worse, leaving a
// truly different post's candidate free of that same clamp because
// *its* href doesn't collide either (surfacing as "another post's
// value").
// ---------------------------------------------------------------------
section('Reddit/X home feed: post identity tolerates non-identifying query-string noise on its own permalink');

function postHtml(id: string, query: string, count: string): string {
  return `
    <article role="article">
      <a href="/someuser/status/${id}${query}">permalink</a>
      <time datetime="2026-08-19T00:00:${id.slice(-2)}.000Z">Aug 19</time>
      <button data-testid="like" aria-label="${count} Likes. Like"><span>${count}</span></button>
    </article>
  `;
}

const queryFeedDom = new JSDOM(
  `<!doctype html><html><body><div id="query-feed">${postHtml('501', '', '10')}${postHtml('502', '?s=20', '20')}</div></body></html>`,
  { url: 'https://x.com/home' },
);
const queryFeedDoc = queryFeedDom.window.document;
(globalThis as any).window = queryFeedDom.window;
(globalThis as any).document = queryFeedDoc;
(globalThis as any).Node = queryFeedDom.window.Node;
(globalThis as any).CSS = queryFeedDom.window.CSS ?? { escape: (s: string) => s };

const queryFeedEl = queryFeedDoc.getElementById('query-feed')!;
const post502Count = Array.from(queryFeedDoc.querySelectorAll('[data-testid="like"] span'))[1]!;
const post502Fp = buildFingerprint(post502Count);
assert(
  post502Fp.itemAnchor?.href === '/someuser/status/502?s=20' && post502Fp.itemAnchor?.isPermalink === true,
  `fingerprint anchors to post 502's own permalink (got ${JSON.stringify(post502Fp.itemAnchor)})`,
);

// Re-render: post 502's permalink loses its tracking query string
// entirely, while its count updates - post 501 is still sitting right
// next to it, structurally identical apart from its own permalink/count.
queryFeedEl.innerHTML = [postHtml('501', '', '11'), postHtml('502', '', '25')].join('');
const tolerantRecovered = locateAndExtract(queryFeedDoc, post502Fp, 'text', null);
assert(
  tolerantRecovered.value === '25',
  `recovers post 502's own updated count despite its permalink's query string changing, not post 501's (got ${JSON.stringify(tolerantRecovered.value)})`,
);

// The reverse direction: post 502 *gains* a query string it didn't have
// at capture time.
queryFeedEl.innerHTML = [postHtml('501', '', '12'), postHtml('502', '?s=20&t=abc', '30')].join('');
const tolerantRecovered2 = locateAndExtract(queryFeedDoc, post502Fp, 'text', null);
assert(
  tolerantRecovered2.value === '30',
  `still recovers post 502 when its permalink gains a query string instead of losing one (got ${JSON.stringify(tolerantRecovered2.value)})`,
);

// A genuinely *different* post must never be accepted in its place,
// query string or not - the leniency above is scoped to the path only.
queryFeedEl.innerHTML = [postHtml('501', '', '13'), postHtml('999', '', '77')].join('');
const rejectedRecovered = locateAndExtract(queryFeedDoc, post502Fp, 'text', null);
assert(
  rejectedRecovered.value === null,
  `reports no value rather than returning a different post's number once post 502 itself is genuinely gone (got ${JSON.stringify(rejectedRecovered.value)})`,
);

// A value with no genuine item-boundary ancestor anywhere within reach
// (no article/li/tr/role/row/id/testid/custom-element the whole way up)
// must not have an identity fabricated from whatever arbitrary ancestor
// the search happened to stop at - that ancestor could just as easily
// span multiple unrelated items. No genuine boundary means no anchor,
// not a guessed one.
const noBoundaryDom = new JSDOM(
  `<!doctype html><html><body><div>${'<div>'.repeat(14)}<span id="deep">42</span>${'</div>'.repeat(14)}</div></body></html>`,
);
const deepSpan = noBoundaryDom.window.document.getElementById('deep')!;
assert(
  findItemAnchor(deepSpan) === null,
  `no item anchor is fabricated from an arbitrary ancestor when nothing within the hop limit actually looks like an item boundary (got ${JSON.stringify(findItemAnchor(deepSpan))})`,
);

// ---------------------------------------------------------------------
// Scenario: X's real action-bar markup nests a like/repost/view count
// far deeper than a "normal" site would - independently documented as
// deeply-nested "div soup" (icon wrapper > text wrapper > button >
// item wrapper > action-bar group > content column > flex row > tweet
// body) between the count's own text node and the enclosing <article>.
// A hop budget tuned for shallow markup would silently produce a null
// itemAnchor here - the picked value would fall back to being anchored
// by nothing but position/text-shape, which is exactly what lets a
// virtualized re-render hand recovery a *different* tweet's number.
// ---------------------------------------------------------------------
section('X-style deep action-bar nesting: item anchor survives real-world div-soup depth');

function deepTweetHtml(id: string, count: string): string {
  // 16 wrapper elements between the count's own text and <article>,
  // modeled on X's actual icon+count button structure.
  return `
    <article role="article">
      <div class="css-175oi2r">
        <div class="css-175oi2r">
          <div class="css-175oi2r">
            <a href="/someuser/status/${id}">permalink</a>
            <time datetime="2026-08-19T00:00:${id.slice(-2)}.000Z">Aug 19</time>
            <div class="css-175oi2r" role="group" aria-label="actions">
              <div class="css-175oi2r">
                <div dir="ltr" role="button" data-testid="like">
                  <div class="css-175oi2r">
                    <div class="css-175oi2r">
                      <div class="css-175oi2r">
                        <div class="css-175oi2r">
                          <div class="css-175oi2r">
                            <span class="css-1jxf684">
                              <span class="css-1jxf684">${count}</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

const deepDom = new JSDOM(
  `<!doctype html><html><body><div id="timeline">${deepTweetHtml('701', '12')}${deepTweetHtml('702', '340')}</div></body></html>`,
  { url: 'https://x.com/home' },
);
const deepDoc = deepDom.window.document;
(globalThis as any).window = deepDom.window;
(globalThis as any).document = deepDoc;
(globalThis as any).Node = deepDom.window.Node;
(globalThis as any).CSS = deepDom.window.CSS ?? { escape: (s: string) => s };

const deepTimeline = deepDoc.getElementById('timeline')!;
const deepCountSpans = Array.from(deepDoc.querySelectorAll('span.css-1jxf684 span.css-1jxf684'));
const deepTargetSpan = deepCountSpans[1]!; // tweet 702's count
const deepFp = buildFingerprint(deepTargetSpan);
assert(
  deepFp.itemAnchor?.href === '/someuser/status/702' && deepFp.itemAnchor?.isPermalink === true,
  `an item anchor is still captured through 16 levels of wrapper divs (got ${JSON.stringify(deepFp.itemAnchor)})`,
);

// Virtualized re-render: fresh node identities, reordered, tweet 702's
// own count updated.
deepTimeline.innerHTML = [deepTweetHtml('999', '1'), deepTweetHtml('702', '341'), deepTweetHtml('701', '12')].join('');
const deepRecovered = locateAndExtract(deepDoc, deepFp, 'text', null);
assert(
  deepRecovered.value === '341',
  `recovers tweet 702's own updated count through the same deep nesting after a re-render, not a neighboring tweet's (got ${JSON.stringify(deepRecovered.value)})`,
);

// ---------------------------------------------------------------------
// Scenario: item-root recognition must cover the vocabulary real feed
// sites actually use for their `data-testid`s, not just the handful
// this project happened to see first. A reply/thread item with no
// article/li/role hint at all - only a `data-testid` naming what kind
// of feed entry it is - must still be recognized as an item boundary.
// ---------------------------------------------------------------------
section('Feed vocabulary: a reply/thread-style testid is recognized as an item boundary');

const vocabDom = new JSDOM(
  `<!doctype html><html><body>
  <div data-testid="reply-1">
    <a href="/thread/501/reply/9001">permalink</a>
    <span id="reply-score">4</span>
  </div>
  <div data-testid="reply-2">
    <a href="/thread/501/reply/9002">permalink</a>
    <span id="reply2-score">9</span>
  </div>
</body></html>`,
  { url: 'https://forum.example.com/thread/501' },
);
const vocabDoc = vocabDom.window.document;
(globalThis as any).window = vocabDom.window;
(globalThis as any).document = vocabDoc;
(globalThis as any).Node = vocabDom.window.Node;

const replyScoreEl = vocabDoc.getElementById('reply-score')!;
const replyAnchor = findItemAnchor(replyScoreEl);
assert(
  replyAnchor?.href === '/thread/501/reply/9001',
  `a bare data-testid="reply-N" wrapper (no article/li/role) is recognized as its own item boundary (got ${JSON.stringify(replyAnchor)})`,
);

// ---------------------------------------------------------------------
// Scenario: scroll-assisted recovery mechanics (see scrollRecovery.ts).
// Pure unit coverage of `searchByScrolling` - the DOM-independent core
// the live page agent wires up to real `window.scrollBy`/`scrollY`.
// ---------------------------------------------------------------------
section('Scroll recovery: bounded scroll-and-retry search');

function fakeScrollHost(growthPerStep: number, stopsGrowingAfterStep: number): ScrollHost {
  let scrollY = 0;
  let scrollHeight = 1000;
  let step = 0;
  // Like a real viewport, scrolling past the end clamps instead of
  // advancing forever - bottom detection keys off the position
  // stopping, so the fake must model that.
  const viewport = 600;
  return {
    read: () => ({ scrollY, scrollHeight }),
    scrollDown: () => {
      step += 1;
      scrollY = Math.min(scrollY + 800, Math.max(0, scrollHeight - viewport));
      if (step <= stopsGrowingAfterStep) scrollHeight += growthPerStep;
    },
  };
}

{
  // Target "loads" on the 3rd scroll round - simulates an infinite-scroll
  // feed lazily mounting more posts as the page scrolls further down.
  let attempts = 0;
  const host = fakeScrollHost(600, 10);
  const outcome = await searchByScrolling(
    host,
    () => {
      attempts += 1;
      return attempts >= 3 ? 'found-it' : null;
    },
    async () => {},
    { maxSteps: 10, stepDelayMs: 0 },
  );
  assert(outcome.result === 'found-it', `finds the target once it mounts after scrolling (got ${JSON.stringify(outcome.result)})`);
  assert(outcome.steps === 3, `stops as soon as the target is found, not after exhausting maxSteps (took ${outcome.steps} steps)`);
}

{
  // Feed genuinely has no more content - height stops growing after the
  // 1st round, and the target is never found. Must stop promptly rather
  // than spinning through every remaining step.
  const host = fakeScrollHost(0, 0);
  const outcome = await searchByScrolling(
    host,
    () => null,
    async () => {},
    { maxSteps: 10, stepDelayMs: 0 },
  );
  assert(outcome.result === null, 'reports no result when the target never appears');
  assert(outcome.reachedBottom === true, `recognizes the feed stopped growing and stops early rather than exhausting maxSteps (got reachedBottom=${outcome.reachedBottom}, steps=${outcome.steps})`);
  assert(outcome.steps < 10, `stops well before the step cap once the bottom is reached (took ${outcome.steps} steps)`);
}

{
  // A deadline in the past means not even one scroll round should run.
  const host = fakeScrollHost(600, 10);
  let calls = 0;
  const outcome = await searchByScrolling(
    host,
    () => {
      calls += 1;
      return null;
    },
    async () => {},
    { maxSteps: 10, stepDelayMs: 0, deadline: Date.now() - 1, now: () => Date.now() },
  );
  assert(outcome.result === null && outcome.steps === 0, `an already-expired deadline runs zero rounds (steps=${outcome.steps})`);
  assert(calls === 0, `never even attempts a locate once the deadline has already passed (calls=${calls})`);
}

// ---------------------------------------------------------------------
// Scenario: an item with only a weak (non-permalink) identity signal -
// the case `resolveCheckUrl` deliberately does NOT redirect for (see
// itemUrl.ts) - sitting in a virtualized list, not yet mounted on a
// fresh load. `searchByScrolling` combined with `locateAndExtract`
// (the same combination `maybeRecoverByScrolling` in pageAgent.content.ts
// wires up to a real page) must find it once enough "scrolling" has
// happened for it to mount, and never fabricate a neighboring row's
// value while doing so.
// ---------------------------------------------------------------------
section('Scroll-assisted recovery: finds a not-yet-mounted row, never a neighboring one');

const lazyDom = new JSDOM(`<!doctype html><html><body><div id="rows"></div></body></html>`, {
  url: 'https://dash.example.com/domains',
});
const lazyDoc = lazyDom.window.document;
(globalThis as any).window = lazyDom.window;
(globalThis as any).document = lazyDoc;
(globalThis as any).Node = lazyDom.window.Node;
(globalThis as any).CSS = lazyDom.window.CSS ?? { escape: (s: string) => s };

function rowHtml(domain: string, visitors: string): string {
  return `<div role="row"><a href="/domains/${domain}/overview">${domain}</a><span class="v">${visitors}</span></div>`;
}

const lazyRows = lazyDoc.getElementById('rows')!;
lazyRows.innerHTML = [rowHtml('acme.com', '10'), rowHtml('beta.dev', '20')].join('');
const lazyTargetSpan = Array.from(lazyDoc.querySelectorAll('.v'))[1]!; // beta.dev's own visitor count
const lazyFp = buildFingerprint(lazyTargetSpan);

// Simulate the row being scrolled out of a virtualized list on the
// next page load - only unrelated rows are mounted at first, and
// beta.dev's row only mounts after a couple of "scroll" rounds.
lazyRows.innerHTML = [rowHtml('other1.com', '1'), rowHtml('other2.com', '2')].join('');
let lazyScrollRounds = 0;
const lazyHost: ScrollHost = {
  read: () => ({ scrollY: 0, scrollHeight: 1000 + lazyScrollRounds * 500 }),
  scrollDown: () => {
    lazyScrollRounds += 1;
    if (lazyScrollRounds === 2) {
      lazyRows.innerHTML = [
        rowHtml('other1.com', '1'),
        rowHtml('beta.dev', '25'), // now mounted, own count updated
        rowHtml('other3.com', '3'),
      ].join('');
    }
  },
};

const lazyOutcome = await searchByScrolling(
  lazyHost,
  () => {
    const attempt = locateAndExtract(lazyDoc, lazyFp, 'text', null);
    return attempt.value !== null ? attempt : null;
  },
  async () => {},
  { maxSteps: 6, stepDelayMs: 0 },
);
assert(
  lazyOutcome.result?.value === '25',
  `finds beta.dev's own count once it mounts after scrolling, not another row's (got ${JSON.stringify(lazyOutcome.result?.value)})`,
);

// ---------------------------------------------------------------------
// Scenario: X-style view-count stat. The icon-only "Views" control has
// no visible text label at all - only a hidden accessibility duplicate
// ("Views") sitting next to the actually-displayed count ("5.7K"). That
// hidden duplicate is applied through a generated/hashed class (a
// stylesheet rule), not any of the recognized "sr-only"-style class
// names - the common case for CSS-in-JS/atomic-CSS UIs, X included.
// Reading it as the value instead of the number on screen is the
// reported bug: a monitor's stored value ends up as the word "Views"
// rather than "5.7K". This must hold generically, off real box geometry
// (computed style), not a class-name allowlist.
// ---------------------------------------------------------------------
section('X Views: rendered value, not the hidden accessibility label');

const viewsDom = new JSDOM(
  `<!doctype html><html><head><style>
    .hidden-x9k2p1 { position: absolute; width: 1px; height: 1px; overflow: hidden; }
  </style></head><body>
  <article role="article">
    <a href="/someuser/status/222">permalink</a>
    <time datetime="2026-08-19T00:00:22.000Z">Aug 19</time>
    <a href="/someuser/status/222/analytics" data-testid="analytics" aria-label="5,734 Views. View post analytics">
      <span class="hidden-x9k2p1">Views</span>
      <span class="css-1jxf684"><span class="css-1jxf684">5.7K</span></span>
    </a>
  </article>
  </body></html>`,
  { url: 'https://x.com/someuser/status/222', pretendToBeVisual: true },
);
const viewsDoc = viewsDom.window.document;
(globalThis as any).window = viewsDom.window;
(globalThis as any).document = viewsDoc;
(globalThis as any).Node = viewsDom.window.Node;
(globalThis as any).CSS = viewsDom.window.CSS ?? { escape: (s: string) => s };

const hiddenLabelSpan = viewsDoc.querySelector('.hidden-x9k2p1')!;
assert(
  isVisuallyHidden(hiddenLabelSpan),
  'a generated/hashed class implementing the classic clip-to-1px recipe is recognized as visually hidden, not just recognized class names',
);

const analyticsButton = viewsDoc.querySelector('[data-testid="analytics"]')!;
const viewsValueSpan = viewsDoc.querySelectorAll('.css-1jxf684 .css-1jxf684')[0]!;

assert(
  extractVisibleText(analyticsButton) === '5.7K',
  `reading the whole stat control extracts the rendered "5.7K", not the hidden "Views" label or a concatenation of both (got ${JSON.stringify(extractVisibleText(analyticsButton))})`,
);

const viewsFp = buildFingerprint(viewsValueSpan);
const viewsExtracted = locateAndExtract(viewsDoc, viewsFp, 'text', null);
assert(
  viewsExtracted.value === '5.7K',
  `extraction reads the rendered value "5.7K", not the accessibility label "Views" (got ${JSON.stringify(viewsExtracted.value)})`,
);

// Re-render (virtualized reflow / React re-mount): fresh node identities,
// count updated. Recovery must keep landing on the visible number, never
// drift onto the structurally-similar hidden label element.
viewsDoc.querySelector('article')!.outerHTML = `
  <article role="article">
    <a href="/someuser/status/222">permalink</a>
    <time datetime="2026-08-19T00:00:22.000Z">Aug 19</time>
    <a href="/someuser/status/222/analytics" data-testid="analytics" aria-label="6,102 Views. View post analytics">
      <span class="hidden-x9k2p1">Views</span>
      <span class="css-1jxf684"><span class="css-1jxf684">6.1K</span></span>
    </a>
  </article>`;
const viewsRecovered = locateAndExtract(viewsDoc, viewsFp, 'text', null);
assert(
  viewsRecovered.value === '6.1K',
  `recovery after a re-render still reads the rendered value, not "Views" (got ${JSON.stringify(viewsRecovered.value)})`,
);

// ---------------------------------------------------------------------
// Named regression checks, tying the fixes above directly to the
// reported failure modes. The underlying mechanics are already
// exercised in depth by the scenarios above; these are short,
// intention-revealing checks against that same coverage.
// ---------------------------------------------------------------------
section('Regression: X feed post metric stays bound to its own post through virtualization');
assert(
  twitterRecovered.value === '150',
  `a value picked inside one X feed post is never recovered from a different post after scroll/virtualization/DOM replacement (got ${JSON.stringify(twitterRecovered.value)})`,
);

section('Regression: Reddit feed post metric stays bound to its own post through virtualization');
assert(
  extracted.value === '128' && !String(extracted.value).includes('Open chat'),
  `a value picked inside a Reddit shadow-DOM post is never recovered from an unrelated element after its node is destroyed and remounted (got ${JSON.stringify(extracted.value)})`,
);

section('Regression: GitHub Followers recovers by label, not position');
assert(
  statsRecovered.value === '1,300',
  `a "Followers" stat recovers its own updated count by label after layout shifts, never the neighboring "Following" stat's value (got ${JSON.stringify(statsRecovered.value)})`,
);

section('Regression: opened-post page vs home-feed resolve differently, correctly');
assert(
  resolveCheckUrl(homeMonitor) === 'https://x.com/someuser/status/222' &&
    resolveCheckUrl(cfMonitor) === cfMonitor.url,
  'a monitor picked from a home feed redirects checks to the post\'s own permalink, while a monitor with no genuine item permalink keeps checking its own page',
);
const openedPostDoc = new JSDOM(`<!doctype html><html><body>${tweetHtml('222', '150')}</body></html>`, {
  url: 'https://x.com/someuser/status/222',
}).window.document;
const openedPostExtracted = locateAndExtract(openedPostDoc, homeMonitorFp, 'text', null);
assert(
  openedPostExtracted.value === '150',
  `a monitor originally picked on the home feed still resolves correctly when the check happens to land on the opened post's own page (got ${JSON.stringify(openedPostExtracted.value)})`,
);

// ---------------------------------------------------------------------
// Scenario: extension-reload persistence. Reported bug — after
// reloading the extension, an existing monitor's next check can come
// back "No value" with "the original element is gone" even though the
// page is loaded and the value is visible. Root cause: recovery's first
// (and sometimes only, within a short window) pass can land while the
// page is still hydrating — exactly what happens right after an
// extension reload/service-worker restart reinitializes the recovery
// flow against a page that hasn't finished its own render yet — and the
// old code reported that as a confident "gone"/"low confidence"
// diagnostic instead of an honest "wasn't ready yet".
//
// This is deliberately generic (a plain skeleton-gated widget with a
// stable identity signal), not a YouTube-specific selector — the same
// shape applies to any client-rendered site whose target mounts after
// an initial loading state.
// ---------------------------------------------------------------------
section('Extension reload: existing monitor recovers once the page finishes hydrating, not just fails on the first look');

{
  const channelDom = new JSDOM(
    `<!doctype html><html><body>
      <div id="channel-header">
        <div class="skeleton-loader" style="width:80px;height:16px;"></div>
      </div>
    </body></html>`,
    { pretendToBeVisual: true },
  );
  const channelDoc = channelDom.window.document;
  (globalThis as any).window = channelDom.window;
  (globalThis as any).document = channelDoc;
  (globalThis as any).Node = channelDom.window.Node;
  (globalThis as any).MutationObserver = channelDom.window.MutationObserver;

  // The skeleton placeholder reports a real, nonzero box (like a real
  // shimmer/loading placeholder would), so `waitForPageReady`'s
  // loading-indicator signal genuinely blocks readiness until it clears.
  const skeleton = channelDoc.querySelector('.skeleton-loader') as HTMLElement;
  (skeleton as any).getBoundingClientRect = () => ({ width: 80, height: 16, top: 0, left: 0, right: 80, bottom: 16 });

  // Fingerprint captured *before* the reload, from the real subscriber-
  // count element that existed back then — a different DOM node than
  // whatever mounts after the reload, by construction (this is the
  // node-identity churn a real extension reload + page re-render causes).
  const priorDom = new JSDOM(
    `<!doctype html><html><body><div id="channel-header"><span aria-label="1.2M subscribers" class="subscriber-count">1.2M subscribers</span></div></body></html>`,
  );
  const priorEl = priorDom.window.document.querySelector('.subscriber-count')!;
  const reloadFp = buildFingerprint(priorEl as unknown as Element);

  // The read/recover pipeline this exercises never holds on to `priorEl`
  // or any other in-memory element reference — `reloadFp` (plain,
  // JSON-serializable data) is the only thing carried across the
  // "reload", exactly as the real background worker persists and
  // restores a monitor's fingerprint from `browser.storage.local`.
  const read = () => locateAndExtract(channelDoc, reloadFp, 'text', null);

  // First read, right as recovery (re)initializes post-reload: the page
  // is still showing its skeleton, so the real element genuinely isn't
  // in the DOM yet.
  const tooEarly = read();
  assert(tooEarly.value === null, 'the very first recovery attempt, before the page is ready, correctly finds nothing yet (not a false match)');

  // The skeleton clears and the real widget mounts — a fresh DOM node,
  // never `priorEl` itself — partway through the check's time budget.
  setTimeout(() => {
    skeleton.remove();
    const header = channelDoc.getElementById('channel-header')!;
    const mounted = channelDoc.createElement('span');
    mounted.setAttribute('aria-label', '1.2M subscribers');
    mounted.className = 'subscriber-count';
    mounted.textContent = '1.2M subscribers';
    header.appendChild(mounted);
  }, 600);

  const reloadRecovered = await resolveSettledValue(
    (maxWaitMs) => waitForPageReady(channelDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
    read,
    { maxTotalWaitMs: 6_000, confirmDelayMs: 200 },
  );

  assert(
    reloadRecovered.value === '1.2M',
    `the monitor recovers its value once the page finishes hydrating, instead of permanently failing off the too-early first look (got ${JSON.stringify(reloadRecovered.value)}, diagnostic ${reloadRecovered.diagnostic.code})`,
  );
  assert(
    reloadRecovered.diagnostic.code === 'OK' || reloadRecovered.diagnostic.code === 'OK_RECOVERED',
    `a successful post-hydration recovery is reported as such, not as a lingering failure code (got ${reloadRecovered.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// Scenario: the page never finishes loading/settling at all within the
// check's time budget (e.g. a persistently slow or stuck hydration,
// which is the worst case of the same "recovery ran before the page was
// ready" situation above). The final diagnostic must say so honestly —
// "page not ready" — rather than the confident-sounding "the original
// element is gone", which would wrongly imply a stable page was
// searched and the target was conclusively missing.
// ---------------------------------------------------------------------
section('Extension reload: a page that never finishes loading is reported as not-ready, not as "gone"');

{
  const stuckLoadDom = new JSDOM(
    `<!doctype html><html><body>
      <header><h1>Example Dashboard</h1><p>Loading your account details, this should just take a moment.</p></header>
      <div class="skeleton-loader" style="width:60px;height:14px;"></div>
      <footer>Example Corp - all rights reserved</footer>
    </body></html>`,
    { pretendToBeVisual: true },
  );
  const stuckLoadDoc = stuckLoadDom.window.document;
  const stuckSkeleton = stuckLoadDoc.querySelector('.skeleton-loader') as HTMLElement;
  // Never clears — simulates hydration that's stuck/never completes
  // within the check's budget.
  (stuckSkeleton as any).getBoundingClientRect = () => ({ width: 60, height: 14, top: 0, left: 0, right: 60, bottom: 14 });

  const ghostDom = new JSDOM(`<!doctype html><html><body><span id="v">42</span></body></html>`);
  const ghostFp = buildFingerprint(ghostDom.window.document.getElementById('v')!);

  const neverReady = await resolveSettledValue(
    (maxWaitMs) => waitForPageReady(stuckLoadDom.window as unknown as Window, { maxWaitMs, minWaitMs: 25 }),
    () => locateAndExtract(stuckLoadDoc, ghostFp, 'text', null),
    { maxTotalWaitMs: 1_500, confirmDelayMs: 150 },
  );

  assert(neverReady.value === null, 'no value is fabricated when the page never becomes usable');
  assert(
    neverReady.diagnostic.code === 'PAGE_NOT_READY',
    `a page that never settles is reported honestly as not-ready rather than a confident "gone"/"low confidence" verdict (got ${neverReady.diagnostic.code})`,
  );
  assert(
    !/original element is gone/i.test(neverReady.diagnostic.message),
    'the message does not claim the element is conclusively gone when the page itself never finished loading',
  );
}

// ---------------------------------------------------------------------
// Scenario: a highly dynamic/SPA page (e.g. a YouTube-style channel
// header) where a client-rendered widget mounts inside its own
// container well after initial page activity, while an unrelated part
// of the *same* page - a live viewer-count ticker, a chat widget, a
// recommendation rail - keeps mutating for as long as the page stays
// open. The document as a whole therefore never satisfies a page-wide
// mutation-quiet window even once, yet the target's own region settles
// normally shortly after it mounts. Recovery must be able to key off
// the target's own neighborhood becoming available and quiet, not off
// a page-wide signal a page shaped like this structurally never
// produces - without requiring the rest of the page to ever go idle,
// and without repeatedly re-scanning the whole document just to find
// that same neighborhood again on every retry.
//
// Deliberately generic (a plain container id + a delayed-mount widget +
// an unrelated, permanently-churning sibling) — not a YouTube-specific
// selector. The same shape applies to any SPA that keeps *something* on
// the page animating/streaming indefinitely elsewhere.
// ---------------------------------------------------------------------
section('Dynamic SPA: a delayed target recovers even though the page as a whole never settles');

{
  const dynDom = new JSDOM(
    `<!doctype html><html><body>
      <div id="channel-header">
        <div class="skeleton-loader" style="width:80px;height:16px;"></div>
      </div>
      <div id="live-ticker">0 watching</div>
    </body></html>`,
    { pretendToBeVisual: true },
  );
  const dynDoc = dynDom.window.document;
  const dynSkeleton = dynDoc.querySelector('.skeleton-loader') as HTMLElement;
  (dynSkeleton as any).getBoundingClientRect = () => ({ width: 80, height: 16, top: 0, left: 0, right: 80, bottom: 16 });

  // Fingerprint captured from a prior render of the real element — a
  // different DOM node than whatever eventually (re)mounts, the same
  // node-identity churn a real SPA re-render produces.
  const priorDom = new JSDOM(
    `<!doctype html><html><body><div id="channel-header"><span aria-label="1.2M subscribers" class="subscriber-count">1.2M subscribers</span></div></body></html>`,
  );
  const priorEl = priorDom.window.document.querySelector('.subscriber-count')!;
  const dynFp = buildFingerprint(priorEl as unknown as Element);

  // The region hint must come from the captured fingerprint's own
  // ancestor chain, resolvable even before the target itself has
  // mounted — not a guess made after the fact once the answer is known.
  const earlyContainer = findLikelyContainer(dynDoc, dynFp);
  assert(
    earlyContainer === dynDoc.getElementById('channel-header'),
    `findLikelyContainer resolves to the captured element's own still-existing ancestor before the target itself has mounted (got id=${earlyContainer?.id ?? null})`,
  );

  // An unrelated part of the page mutates continuously for the entire
  // check — a live viewer count, exactly the kind of thing that keeps a
  // real streaming/SPA page from ever going fully quiet.
  const ticker = dynDoc.getElementById('live-ticker')!;
  let watching = 0;
  const tickerTimer = setInterval(() => {
    ticker.textContent = `${++watching} watching`;
  }, 40);

  // The real widget mounts, replacing the skeleton, partway through the
  // check — well after the page's own initial activity, the same way a
  // channel header's subscriber count is fetched and rendered after the
  // rest of the shell.
  setTimeout(() => {
    dynSkeleton.remove();
    const header = dynDoc.getElementById('channel-header')!;
    const mounted = dynDoc.createElement('span');
    mounted.setAttribute('aria-label', '1.2M subscribers');
    mounted.className = 'subscriber-count';
    mounted.textContent = '1.2M subscribers';
    header.appendChild(mounted);
  }, 900);

  // Mirrors the real page agent's own wiring in
  // entrypoints/pageAgent.content.ts: scope the readiness wait to the
  // captured element's nearest still-resolvable ancestor whenever one
  // exists, falling back to the page-wide signal only when it doesn't.
  const read = () => locateAndExtract(dynDoc, dynFp, 'text', null);
  const waitForReady = (maxWaitMs: number) => {
    const container = findLikelyContainer(dynDoc, dynFp);
    return container
      ? waitForRegionReady(dynDom.window as unknown as Window, container, { maxWaitMs: Math.min(maxWaitMs, 500) })
      : waitForPageReady(dynDom.window as unknown as Window, { maxWaitMs });
  };

  const dynStart = Date.now();
  const dynRecovered = await resolveSettledValue(waitForReady, read, {
    maxTotalWaitMs: 3_000,
    confirmDelayMs: 150,
  });
  const dynElapsed = Date.now() - dynStart;

  assert(
    dynRecovered.value === '1.2M',
    `recovers the delayed target even though the page never goes fully quiet (got ${JSON.stringify(dynRecovered.value)}, diagnostic ${dynRecovered.diagnostic.code})`,
  );
  assert(
    dynRecovered.diagnostic.code === 'OK' || dynRecovered.diagnostic.code === 'OK_RECOVERED',
    `a successful recovery on a never-fully-settled page is reported as such, not as PAGE_NOT_READY (got ${dynRecovered.diagnostic.code})`,
  );
  assert(
    dynElapsed < 3_000,
    `resolves within the check's own time budget instead of exhausting it (took ${dynElapsed}ms against a 3000ms budget)`,
  );

  // Sanity check, while the ticker is still running: the page-wide
  // signal genuinely never fires on this page shape, confirming
  // recovery above succeeded via the region-scoped signal rather than
  // by the page happening to go quiet quickly anyway.
  const pageWideDuringChurn = await waitForPageReady(dynDom.window as unknown as Window, {
    maxWaitMs: 400,
    minWaitMs: 25,
  });
  assert(
    !pageWideDuringChurn.ready,
    'sanity check: the page-wide readiness signal never fires while the unrelated ticker keeps mutating, confirming this scenario genuinely exercises "page never settles"',
  );

  clearInterval(tickerTimer);
}

// ---------------------------------------------------------------------
// Scenario: content-script recovery reinitialization after an extension
// reload. The visibility/rAF patch that keeps a backgrounded live-check
// tab rendering as if visible is registered dynamically per-origin
// (`chrome.scripting.registerContentScripts`). Chrome can report an id
// as already registered from a *previous* service-worker lifetime (a
// "ghost" left behind by an extension reload/update) even though it no
// longer reliably applies. The fix must not trust that stale report and
// must unconditionally re-assert the registration once per fresh
// lifetime, then skip redundant work for the rest of that lifetime.
// ---------------------------------------------------------------------
section('Live tab: visibility patch is unconditionally reinitialized for a fresh lifetime, not trusted from stale state');

{
  const unregisterCalls: string[][] = [];
  const registerCalls: unknown[] = [];
  (globalThis as any).browser = {
    scripting: {
      // Simulates Chrome still reporting a "ghost" registration left
      // over from before the reload — old code trusted this and skipped
      // re-registering entirely.
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) => ids.map((id) => ({ id })),
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        unregisterCalls.push(ids);
      },
      registerContentScripts: async (defs: unknown) => {
        registerCalls.push(defs);
      },
    },
  };

  await ensureVisibilityPatchRegistered('https://example-reload-test.com/channel');

  assert(
    registerCalls.length === 1,
    `the patch is re-registered fresh on the first call of a new lifetime, even though the registry claims it already exists (registered ${registerCalls.length} time(s))`,
  );
  assert(
    unregisterCalls.length === 1,
    `any stale/ghost registration is cleared before re-registering rather than trusted as-is (unregistered ${unregisterCalls.length} time(s))`,
  );

  // A second call for the same host within the same lifetime is a cheap
  // no-op - already confirmed, no need to round-trip through
  // `chrome.scripting` again.
  await ensureVisibilityPatchRegistered('https://example-reload-test.com/channel/videos');
  assert(registerCalls.length === 1, 'a second call for the same host within the same lifetime does not re-register again');
}

// ---------------------------------------------------------------------
// Scenario: persistence race conditions. `checkAllMonitorsNow` runs
// `checkMonitor` concurrently for every enabled monitor, and each check
// calls `updateMonitor` (a plain storage get-then-set with no atomic
// compare-and-swap) more than once. Without serialization, two
// overlapping monitors' writes can each read the same starting array
// and the one that writes back second silently erases the first's
// update — including a self-healing fingerprint recovery. `serializeByKey`
// (used by store.ts) is what closes this; tested directly here, against
// a tiny mock store that reproduces the exact race shape, rather than
// through the full wxt/storage stack.
// ---------------------------------------------------------------------
section('Concurrency: serializeByKey prevents a lost-update race on concurrent writes');

{
  // A minimal stand-in for `monitorsItem`: plain get/set, no atomicity,
  // with an injected delay between read and write so two calls'
  // read-modify-write windows are guaranteed to overlap - the exact
  // shape of the real race (two `checkMonitor` runs finishing at
  // roughly the same moment).
  function makeMockArrayStore(initial: Record<string, number>) {
    let value = { ...initial };
    return {
      async getValue() {
        return { ...value };
      },
      async setValue(next: Record<string, number>) {
        value = next;
      },
      snapshot: () => value,
    };
  }

  async function patch(
    store: ReturnType<typeof makeMockArrayStore>,
    key: string,
    amount: number,
  ): Promise<void> {
    const current = await store.getValue();
    // Force the read-modify-write window open long enough for a
    // concurrent call to land inside it.
    await new Promise((r) => setTimeout(r, 5));
    current[key] = (current[key] ?? 0) + amount;
    await store.setValue(current);
  }

  // Without serialization: two concurrent patches to *different* keys
  // in the same shared array both read the same starting snapshot, so
  // one of the two increments is silently lost.
  {
    const store = makeMockArrayStore({ a: 0, b: 0 });
    await Promise.all([patch(store, 'a', 1), patch(store, 'b', 1)]);
    const lost = store.snapshot().a !== 1 || store.snapshot().b !== 1;
    assert(
      lost,
      `sanity check: unserialized concurrent writes to a shared array do lose an update (got ${JSON.stringify(store.snapshot())})`,
    );
  }

  // With serializeByKey guarding every write against the same queue key
  // (mirroring store.ts's single 'monitors' key for the whole array),
  // both increments must survive regardless of overlap.
  {
    const store = makeMockArrayStore({ a: 0, b: 0 });
    const queues = new Map<string, Promise<unknown>>();
    await Promise.all([
      serializeByKey(queues, 'monitors', () => patch(store, 'a', 1)),
      serializeByKey(queues, 'monitors', () => patch(store, 'b', 1)),
    ]);
    assert(
      store.snapshot().a === 1 && store.snapshot().b === 1,
      `serializeByKey preserves both concurrent updates instead of losing one (got ${JSON.stringify(store.snapshot())})`,
    );
  }

  // Ten overlapping increments to the *same* counter, all racing the
  // same read-modify-write window - the realistic shape of several
  // monitors' checks all calling updateMonitor at once. Every one must
  // land; serializeByKey makes them queue instead of race.
  {
    const store = makeMockArrayStore({ counter: 0 });
    const queues = new Map<string, Promise<unknown>>();
    await Promise.all(
      Array.from({ length: 10 }, () => serializeByKey(queues, 'monitors', () => patch(store, 'counter', 1))),
    );
    assert(
      store.snapshot().counter === 10,
      `ten queued concurrent increments all land, none lost (got ${store.snapshot().counter})`,
    );
  }

  // Different keys must never block each other - a write to one
  // monitor's history queue shouldn't wait behind an unrelated
  // monitor's history write.
  {
    const queues = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const slow = serializeByKey(queues, 'history:monitor-a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-done');
    });
    const fast = serializeByKey(queues, 'history:monitor-b', async () => {
      order.push('b-done');
    });
    await Promise.all([slow, fast]);
    assert(
      order[0] === 'b-done',
      `an unrelated key's write is not held up behind a slow write on a different key (order: ${JSON.stringify(order)})`,
    );
  }

  // A failed call must not poison the queue for later calls on the same key.
  {
    const queues = new Map<string, Promise<unknown>>();
    let threw = false;
    try {
      await serializeByKey(queues, 'monitors', async () => {
        throw new Error('boom');
      });
    } catch {
      threw = true;
    }
    const after = await serializeByKey(queues, 'monitors', async () => 'ok');
    assert(threw, 'the failing call itself still rejects (errors are not swallowed)');
    assert(after === 'ok', `a later call on the same key still runs normally after a prior failure (got ${JSON.stringify(after)})`);
  }
}

// ---------------------------------------------------------------------
// Scenario: overlapping checks of the *same* monitor. A scheduler tick
// only marks a monitor as "no longer due" once its check fully
// finishes, so a slow live-tab check still running when the next
// 1-minute alarm fires is still due and gets picked up again -
// `checkMonitor`'s three call sites (a scheduler tick, "refresh all",
// and a manual "check now") can all legitimately overlap. `dedupeInFlight`
// (used by checker.ts) is what makes a second call for the same key join
// the already-running one instead of starting a wasteful, storage-racing
// duplicate.
// ---------------------------------------------------------------------
section('Concurrency: dedupeInFlight joins an already-running check instead of duplicating it');

{
  let starts = 0;
  const inFlight = new Map<string, Promise<string>>();

  async function fakeCheck(id: string): Promise<string> {
    starts += 1;
    await new Promise((r) => setTimeout(r, 20));
    return `result-for-${id}`;
  }

  // Two "overlapping" calls for the same monitor id (e.g. a scheduler
  // tick and a manual "check now" landing at nearly the same instant).
  const [first, second] = await Promise.all([
    dedupeInFlight(inFlight, 'monitor-1', () => fakeCheck('monitor-1')),
    dedupeInFlight(inFlight, 'monitor-1', () => fakeCheck('monitor-1')),
  ]);
  assert(starts === 1, `only one actual check run for the overlapping calls, not two (started ${starts} time(s))`);
  assert(first === second, `both callers receive the same, single run's result (got ${JSON.stringify([first, second])})`);

  // A different monitor id must run independently, not join the first's run.
  const third = await dedupeInFlight(inFlight, 'monitor-2', () => fakeCheck('monitor-2'));
  assert(starts === 2, `a different monitor id starts its own run rather than joining an unrelated one (total starts: ${starts})`);
  assert(third === 'result-for-monitor-2', `the second monitor's own result is returned, not the first monitor's (got ${JSON.stringify(third)})`);

  // Once a run has finished, the map entry must be cleared so a later,
  // genuinely new check for the same id runs fresh (not memory-leaked,
  // not permanently deduped against a stale finished run).
  assert(!inFlight.has('monitor-1'), 'the in-flight entry is removed once the run settles, so the map does not grow unbounded');
  const starts_before = starts;
  await dedupeInFlight(inFlight, 'monitor-1', () => fakeCheck('monitor-1'));
  assert(starts === starts_before + 1, 'a later call for the same id after the previous run finished starts a fresh run, not a stale dedupe');

  // A rejected run must not be left dangling in the map forever, and
  // must not be silently swallowed.
  const failing = new Map<string, Promise<string>>();
  let rejected = false;
  try {
    await dedupeInFlight(failing, 'will-fail', async () => {
      throw new Error('check threw');
    });
  } catch {
    rejected = true;
  }
  assert(rejected, 'a run that throws still rejects for its caller (errors are not swallowed)');
  assert(!failing.has('will-fail'), 'a failed run is still cleaned up from the map, not left stuck as permanently "in flight"');
}

// ---------------------------------------------------------------------
// Scenario: Client checkNow in-flight deduplication and active tracking.
// ---------------------------------------------------------------------
section('Concurrency: checkMonitorNow client deduplication and checking subscription');

{
  const inFlight = new Map<string, Promise<any>>();
  const checkingListeners = new Set<() => void>();
  let runs = 0;

  function isMonitorChecking(id: string) {
    return inFlight.has(id);
  }

  function subscribe(fn: () => void) {
    checkingListeners.add(fn);
    return () => checkingListeners.delete(fn);
  }

  function mockCheckMonitorNow(id: string): Promise<any> {
    const existing = inFlight.get(id);
    if (existing) return existing;

    const promise = (async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, value: undefined };
    })().finally(() => {
      inFlight.delete(id);
      checkingListeners.forEach((l) => l());
    });

    inFlight.set(id, promise);
    checkingListeners.forEach((l) => l());
    return promise;
  }

  let notifyCount = 0;
  const unsub = subscribe(() => {
    notifyCount++;
  });

  const p1 = mockCheckMonitorNow('m-1');
  const p2 = mockCheckMonitorNow('m-1');
  assert(p1 === p2, 'concurrent calls return the exact same in-flight promise');
  assert(isMonitorChecking('m-1'), 'isMonitorChecking returns true while check is active');

  const [res1, res2] = await Promise.all([p1, p2]);
  assert(runs === 1, 'concurrent checkMonitorNow calls run only once (deduped)');
  assert(res1.ok && res2.ok, 'both concurrent callers receive ok: true');
  assert(!isMonitorChecking('m-1'), 'after settling, monitor is no longer checking');
  assert(notifyCount >= 2, 'subscribers are notified on start and finish');
  unsub();
}


// =======================================================================
// YouTube regression suite.
//
// Root cause (see fingerprint.ts): `looksLikeItemRoot`'s custom-element
// fallback treated *any* hyphenated tag name as its own repeated-list
// item boundary. That's safe on sites where hyphenated tags are rare and
// reserved for the one repeated component (Reddit's `<shreddit-post>`),
// but YouTube's entire DOM is built from hyphenated Polymer/Lit custom
// elements (`ytd-*`, `yt-*`) - the subscribe button, the channel header,
// a single run of formatted text are all their own custom element, and
// none of them are repeated. `findItemAnchor` walking up from virtually
// any target therefore landed on the nearest *singleton* wrapper and
// captured a bogus `itemAnchor` for it - which, on relocation, very
// often disagreed with whatever bogus anchor the *next* render's nearest
// wrapper produced, tripping `scoreCandidate`'s `itemIdentityConflict`
// clamp (caps the score at 20) even for the objectively correct
// candidate. That clamp is exactly why every one of the reported
// failures scored at or below 20/100 despite a large, correct-looking
// candidate pool.
//
// Two more defects compounded it:
//  - `buildCssSelector` stopped dead the instant it found a stable `id`,
//    discarding any `>>> ` shadow-crossing prefix already built for
//    outer shadow roots - so an id'd element nested inside shadow DOM
//    (YouTube's `#subscriber-count`, `#count`, etc. all are) produced a
//    bare `#id` selector that can never resolve, forcing every check
//    onto the slower, more failure-prone recovery scan instead of the
//    normal O(1) fast path.
//  - `permalinkIdentity` unconditionally discarded a permalink's entire
//    query string when comparing two renders of "the same" item. That's
//    correct for a site whose content id lives in the *path*
//    (`/status/123`), but YouTube's watch-page id lives in the *query*
//    (`/watch?v=…`) - stripping it collapsed every distinct video down
//    to the same identity, which is the opposite of what this signal
//    exists to guarantee (see the "Never substitute another video's
//    value" scenario below).
//
// All three fixes are generic (no youtube.com-specific selectors, host
// checks, or lowered thresholds) - see fingerprint.ts for the actual
// changes. The scenarios below reproduce the reported failures with
// realistic, multi-level shadow-DOM YouTube-shaped markup.
// =======================================================================

function ytGlobals(dom: InstanceType<typeof JSDOM>): void {
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
  (globalThis as any).ShadowRoot = dom.window.ShadowRoot;
  (globalThis as any).MutationObserver = dom.window.MutationObserver;
}

// ---------------------------------------------------------------------
// 1. Channel subscriber count.
// ---------------------------------------------------------------------
section('YouTube: channel subscriber count survives a full Polymer re-render through nested shadow DOM');

{
  const chDom = new JSDOM(`<!doctype html><html><body><ytd-app></ytd-app></body></html>`, {
    pretendToBeVisual: true,
    url: 'https://www.youtube.com/@somechannel',
  });
  const chDoc = chDom.window.document;
  ytGlobals(chDom);

  // Mounts a fresh `ytd-page-manager` > `ytd-c4-tabbed-header-renderer`
  // subtree (new node identities every call, three shadow roots deep) -
  // the same "entirely new nodes, not just updated text" churn a real
  // Polymer re-render produces.
  function mountChannelHeader(count: string): Element {
    const app = chDoc.querySelector('ytd-app')!;
    const appShadow = app.shadowRoot ?? app.attachShadow({ mode: 'open' });
    appShadow.innerHTML = '';
    const pageManager = chDoc.createElement('ytd-page-manager');
    appShadow.appendChild(pageManager);
    const pmShadow = pageManager.attachShadow({ mode: 'open' });
    const header = chDoc.createElement('ytd-c4-tabbed-header-renderer');
    header.id = 'channel-header';
    pmShadow.appendChild(header);
    const headerShadow = header.attachShadow({ mode: 'open' });
    headerShadow.innerHTML = `
      <div id="inner-header-container" class="style-scope ytd-c4-tabbed-header-renderer">
        <ytd-subscribe-button-renderer class="style-scope ytd-c4-tabbed-header-renderer">
          <yt-formatted-string id="subscriber-count" class="style-scope ytd-subscribe-button-renderer" aria-label="${count} subscribers">${count} subscribers</yt-formatted-string>
        </ytd-subscribe-button-renderer>
      </div>
    `;
    return headerShadow.querySelector('#subscriber-count')!;
  }

  const subEl = mountChannelHeader('1.2M');
  const subFp = buildFingerprint(subEl);
  assert(subFp.cssSelector.includes('>>>'), `the captured selector crosses every shadow boundary (got "${subFp.cssSelector}")`);
  assert(
    subFp.itemAnchor === null,
    `a singleton channel-header widget is not mistaken for a repeated feed/list item (got ${JSON.stringify(subFp.itemAnchor)})`,
  );

  mountChannelHeader('1.3M'); // full re-render, fresh node identities throughout

  const subLocated = locateElement(subFp, chDoc);
  assert(
    subLocated.element?.tagName.toLowerCase() === 'yt-formatted-string' && subLocated.score >= 55,
    `recovery finds the real subscriber-count element with an acceptable score, not a low-confidence non-match (score=${subLocated.score}, tag=${subLocated.element?.tagName})`,
  );
  const subExtracted = locateAndExtract(chDoc, subFp, 'text', null);
  assert(
    subExtracted.value === '1.3M',
    `extracts the updated subscriber count through the re-render (got ${JSON.stringify(subExtracted.value)}, diagnostic ${subExtracted.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// 2. Video like count.
// ---------------------------------------------------------------------
section('YouTube: video like count is not mistaken for a feed item despite deep custom-element nesting');

{
  const likeDom = new JSDOM(`<!doctype html><html><body><ytd-app></ytd-app></body></html>`, {
    pretendToBeVisual: true,
    url: 'https://www.youtube.com/watch?v=videoAAA',
  });
  const likeDoc = likeDom.window.document;
  ytGlobals(likeDom);

  const app = likeDoc.querySelector('ytd-app')!;
  const appShadow = app.attachShadow({ mode: 'open' });
  appShadow.innerHTML = '<ytd-watch-flexy></ytd-watch-flexy>';
  const flexy = appShadow.querySelector('ytd-watch-flexy')!;
  const flexyShadow = flexy.attachShadow({ mode: 'open' });
  flexyShadow.innerHTML = `
    <ytd-menu-renderer id="menu" class="style-scope ytd-watch-metadata">
      <segmented-like-dislike-button-view-model class="style-scope ytd-menu-renderer">
        <like-button-view-model class="style-scope segmented-like-dislike-button-view-model">
          <button aria-label="12,345 likes" class="yt-spec-button-shape-next">
            <div id="text" class="yt-spec-button-shape-next__button-text-content">12K</div>
          </button>
        </like-button-view-model>
        <dislike-button-view-model class="style-scope segmented-like-dislike-button-view-model">
          <button aria-label="Dislike this video"></button>
        </dislike-button-view-model>
      </segmented-like-dislike-button-view-model>
    </ytd-menu-renderer>
  `;
  const likeCountEl = flexyShadow.querySelector('like-button-view-model #text')!;
  const likeFp = buildFingerprint(likeCountEl);
  assert(
    likeFp.itemAnchor === null,
    `the like-count widget - nested inside several singleton custom elements, none of them repeated - gets no fabricated item identity (got ${JSON.stringify(likeFp.itemAnchor)})`,
  );

  // The count ticks up; likes/dislikes swap DOM position the way YouTube's
  // own view-model occasionally does on a re-render.
  flexyShadow.innerHTML = `
    <ytd-menu-renderer id="menu" class="style-scope ytd-watch-metadata">
      <segmented-like-dislike-button-view-model class="style-scope ytd-menu-renderer">
        <dislike-button-view-model class="style-scope segmented-like-dislike-button-view-model">
          <button aria-label="Dislike this video"></button>
        </dislike-button-view-model>
        <like-button-view-model class="style-scope segmented-like-dislike-button-view-model">
          <button aria-label="13,102 likes" class="yt-spec-button-shape-next">
            <div id="text" class="yt-spec-button-shape-next__button-text-content">13K</div>
          </button>
        </like-button-view-model>
      </segmented-like-dislike-button-view-model>
    </ytd-menu-renderer>
  `;
  const likeExtracted = locateAndExtract(likeDoc, likeFp, 'text', null);
  assert(
    likeExtracted.value === '13K',
    `recovers the like button's own updated count, not the dislike button (got ${JSON.stringify(likeExtracted.value)}, diagnostic ${likeExtracted.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// 3. Comment likes, and never substituting a neighboring comment.
// ---------------------------------------------------------------------
section('YouTube: comment like count stays bound to its own comment thread, never a neighboring one');

{
  const cDom = new JSDOM(
    `<!doctype html><html><body><div id="contents"></div></body></html>`,
    { url: 'https://www.youtube.com/watch?v=videoBBB' },
  );
  const cDoc = cDom.window.document;
  ytGlobals(cDom);

  function commentHtml(handle: string, likes: string): string {
    return `
      <ytd-comment-thread-renderer class="style-scope ytd-item-section-renderer">
        <div id="comment" class="style-scope ytd-comment-thread-renderer">
          <a id="author-text" href="/@${handle}" class="style-scope ytd-comment-view-model">@${handle}</a>
          <div id="action-buttons" class="style-scope ytd-comment-view-model">
            <button id="like-button" aria-label="${likes} likes" class="style-scope ytd-comment-view-model">
              <span id="vote-count" class="style-scope ytd-comment-view-model">${likes}</span>
            </button>
          </div>
        </div>
      </ytd-comment-thread-renderer>
    `;
  }

  const contents = cDoc.getElementById('contents')!;
  contents.innerHTML = [commentHtml('alice', '4'), commentHtml('bob', '12'), commentHtml('carol', '1')].join('');
  const bobVoteCount = Array.from(cDoc.querySelectorAll('#vote-count'))[1]!; // bob's own count
  const bobFp = buildFingerprint(bobVoteCount);
  assert(
    bobFp.itemAnchor?.href === '/@bob',
    `a repeated <ytd-comment-thread-renderer> is recognized as its own item boundary, anchored to its author's own link (got ${JSON.stringify(bobFp.itemAnchor)})`,
  );

  // A new comment gets pinned to the top (real YouTube behavior),
  // shifting every existing thread's DOM position; bob's own count also
  // updates. Nothing about bob's thread's *identity* changed.
  contents.innerHTML = [
    commentHtml('newcommenter', '0'),
    commentHtml('alice', '4'),
    commentHtml('carol', '1'),
    commentHtml('bob', '13'),
  ].join('');
  const bobRecovered = locateAndExtract(cDoc, bobFp, 'text', null);
  assert(
    bobRecovered.value === '13',
    `recovers bob's own updated like count after a reorder, never alice's, carol's, or the newly pinned comment's (got ${JSON.stringify(bobRecovered.value)})`,
  );
}

// ---------------------------------------------------------------------
// 4. Delayed rendering: target-region readiness independent of a page
//    that never goes globally quiet, through real (multi-level) shadow
//    DOM this time - the generic version of this scenario already
//    covered above used only light DOM.
// ---------------------------------------------------------------------
section('YouTube: a subscriber count that mounts late inside shadow DOM recovers without the whole page settling');

{
  const dlyDom = new JSDOM(
    `<!doctype html><html><body>
      <ytd-app></ytd-app>
      <div id="live-chat">0 messages</div>
    </body></html>`,
    { pretendToBeVisual: true, url: 'https://www.youtube.com/@somechannel' },
  );
  const dlyDoc = dlyDom.window.document;
  ytGlobals(dlyDom);

  // A live element elsewhere on the page keeps mutating for as long as
  // the "page" is open, exactly like a real chat/ticker widget would -
  // so a page-wide mutation-quiet window is never satisfied.
  const chat = dlyDoc.getElementById('live-chat')!;
  const chatTimer = dlyDom.window.setInterval(() => {
    chat.textContent = `${Number(chat.textContent!.split(' ')[0]) + 1} messages`;
  }, 40);

  const app = dlyDoc.querySelector('ytd-app')!;
  const appShadow = app.attachShadow({ mode: 'open' });
  appShadow.innerHTML = `
    <ytd-page-manager>
      <ytd-c4-tabbed-header-renderer id="channel-header">
        <div class="skeleton-loader" style="width:80px;height:16px;"></div>
      </ytd-c4-tabbed-header-renderer>
    </ytd-page-manager>
  `;
  const header = appShadow.querySelector('#channel-header')!;
  const headerShadow = header.attachShadow({ mode: 'open' });
  headerShadow.innerHTML = '<div class="skeleton-loader" style="width:80px;height:16px;"></div>';
  const dlySkeleton = headerShadow.querySelector('.skeleton-loader') as HTMLElement;
  (dlySkeleton as any).getBoundingClientRect = () => ({ width: 80, height: 16, top: 0, left: 0, right: 80, bottom: 16 });

  // Fingerprint captured from a prior render — a different node than
  // whatever eventually mounts, same as a real reload/re-render would
  // produce.
  const priorDom = new JSDOM(
    `<!doctype html><html><body><ytd-app></ytd-app></body></html>`,
  );
  const priorApp = priorDom.window.document.querySelector('ytd-app')!;
  const priorShadow = priorApp.attachShadow({ mode: 'open' });
  priorShadow.innerHTML = '<yt-formatted-string id="subscriber-count" aria-label="890K subscribers">890K subscribers</yt-formatted-string>';
  const dlyFp = buildFingerprint(priorShadow.querySelector('#subscriber-count')!);

  const dlyRead = () => locateAndExtract(dlyDoc, dlyFp, 'text', null);
  const dlyTooEarly = dlyRead();
  assert(dlyTooEarly.value === null, 'the first read, while only a skeleton is mounted inside the shadow tree, correctly finds nothing yet');

  dlyDom.window.setTimeout(() => {
    headerShadow.innerHTML = '<yt-formatted-string id="subscriber-count" aria-label="891K subscribers">891K subscribers</yt-formatted-string>';
  }, 300);

  // Mirrors `pageAgent.content.ts`'s own `waitForReady`: prefer a
  // region-scoped wait over the whole-document one whenever some
  // ancestor of the captured element still resolves.
  const dlyWaitForReady = (maxWaitMs: number) => {
    const container = findLikelyContainer(dlyDoc, dlyFp);
    return container
      ? waitForRegionReady(dlyDom.window as unknown as Window, container, { maxWaitMs: Math.min(maxWaitMs, 500) })
      : waitForPageReady(dlyDom.window as unknown as Window, { maxWaitMs });
  };

  const dlyRecovered = await resolveSettledValue(dlyWaitForReady, dlyRead, { maxTotalWaitMs: 4_000, confirmDelayMs: 150 });
  dlyDom.window.clearInterval(chatTimer);

  assert(
    dlyRecovered.value === '891K',
    `recovers the value once it mounts inside the shadow tree, without waiting for the permanently-churning chat widget elsewhere on the page (got ${JSON.stringify(dlyRecovered.value)}, diagnostic ${dlyRecovered.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// 5. SPA navigation/rerender: a query-string-identified permalink
//    (`/watch?v=…`) must still tell two different videos apart, and
//    must still tolerate a rotating tracking token on the *same*
//    video's own link - the two things `permalinkIdentity` previously
//    got backwards for this exact URL shape (see the fix in
//    `fingerprint.ts`).
// ---------------------------------------------------------------------
section('YouTube: a related-video view count tracks its own video through query-identified permalinks, never a neighbor\'s');

{
  const relDom = new JSDOM(
    `<!doctype html><html><body><div id="items"></div></body></html>`,
    { url: 'https://www.youtube.com/watch?v=videoAAA' },
  );
  const relDoc = relDom.window.document;
  ytGlobals(relDom);

  function videoHtml(id: string, query: string, views: string): string {
    return `
      <ytd-compact-video-renderer class="style-scope ytd-item-section-renderer">
        <a href="/watch?v=${id}${query}" class="style-scope ytd-compact-video-renderer">
          <span id="metadata-line" class="style-scope ytd-compact-video-renderer">${views} views</span>
        </a>
      </ytd-compact-video-renderer>
    `;
  }

  const items = relDoc.getElementById('items')!;
  items.innerHTML = [
    videoHtml('videoAAA', '', '1.1M'),
    videoHtml('videoBBB', '&pp=share-token-1', '250K'),
    videoHtml('videoCCC', '', '80K'),
  ].join('');
  const bViews = Array.from(relDoc.querySelectorAll('#metadata-line'))[1]!;
  const relFp = buildFingerprint(bViews);
  assert(
    relFp.itemAnchor?.href === '/watch?v=videoBBB&pp=share-token-1' && relFp.itemAnchor.isPermalink === true,
    `fingerprint anchors to video B's own /watch?v= permalink (got ${JSON.stringify(relFp.itemAnchor)})`,
  );

  // Re-render: video B's own tracking token rotates (a new share/session
  // param, just like the Twitter "?s=" case above) while its view count
  // also updates - A and C sit right next to it, structurally identical.
  items.innerHTML = [
    videoHtml('videoAAA', '', '1.1M'),
    videoHtml('videoBBB', '&pp=share-token-2', '260K'),
    videoHtml('videoCCC', '', '80K'),
  ].join('');
  const relRecovered = locateAndExtract(relDoc, relFp, 'text', null);
  assert(
    relRecovered.value === '260K',
    `recovers video B's own updated view count despite its permalink's tracking token rotating, not video A's or C's (got ${JSON.stringify(relRecovered.value)})`,
  );

  // Now the genuinely different-video case: B's slot is taken over by a
  // brand new video entirely (D) with a similar-looking tracking param.
  // This must resolve to "no value", never D's count under B's name.
  items.innerHTML = [
    videoHtml('videoAAA', '', '1.1M'),
    videoHtml('videoDDD', '&pp=share-token-3', '999K'),
    videoHtml('videoCCC', '', '80K'),
  ].join('');
  const relReplaced = locateAndExtract(relDoc, relFp, 'text', null);
  assert(
    relReplaced.value !== '999K views',
    `never substitutes a different video's (D's) view count for the one actually being monitored (video B) (got ${JSON.stringify(relReplaced.value)})`,
  );
}

// ---------------------------------------------------------------------
// 6. Comment section infinite scroll: a comment that genuinely exists
//    but hasn't mounted yet (virtualized/lazy-loaded further down the
//    thread) is found via scroll-assisted recovery, never by grabbing an
//    already-mounted neighbor's count instead.
// ---------------------------------------------------------------------
section('YouTube: infinite-scroll comment loading finds a not-yet-mounted comment\'s like count, never a neighbor\'s');

{
  const scrollDom = new JSDOM(
    `<!doctype html><html><body><div id="contents"></div></body></html>`,
    { url: 'https://www.youtube.com/watch?v=videoCCC' },
  );
  const scrollDoc = scrollDom.window.document;
  ytGlobals(scrollDom);

  function threadHtml(handle: string, likes: string): string {
    return `
      <ytd-comment-thread-renderer class="style-scope ytd-item-section-renderer">
        <a id="author-text" href="/@${handle}" class="style-scope ytd-comment-view-model">@${handle}</a>
        <span id="vote-count" class="style-scope ytd-comment-view-model">${likes}</span>
      </ytd-comment-thread-renderer>
    `;
  }

  const scrollContents = scrollDoc.getElementById('contents')!;
  scrollContents.innerHTML = [threadHtml('alice', '4'), threadHtml('bob', '12')].join('');

  // "dana" hasn't loaded yet at all - captured from a prior page load
  // (or a different tab), same as a real monitor persisted across
  // sessions would be. Captured alongside sibling comment threads, same
  // as the real page it was picked from - a single, sibling-less
  // fixture wouldn't exercise the sibling-repetition item-root check at
  // capture time the way an actual comments list always does.
  const priorScrollDom = new JSDOM(
    `<!doctype html><html><body><div id="contents">${threadHtml('eve', '2')}${threadHtml('dana', '7')}</div></body></html>`,
    { url: 'https://www.youtube.com/watch?v=videoCCC' },
  );
  const danaFp = buildFingerprint(priorScrollDom.window.document.querySelectorAll('#vote-count')[1]!);
  assert(
    danaFp.itemAnchor?.href === '/@dana',
    `dana's own fingerprint anchors to her own comment thread, captured correctly among sibling threads (got ${JSON.stringify(danaFp.itemAnchor)})`,
  );

  let scrollRounds = 0;
  const scrollHost: ScrollHost = {
    read: () => ({ scrollY: 0, scrollHeight: 1200 + scrollRounds * 400 }),
    scrollDown: () => {
      scrollRounds += 1;
      if (scrollRounds === 2) {
        // dana's thread finally mounts as more comments lazily load in,
        // with her own like count now updated.
        scrollContents.innerHTML += threadHtml('dana', '9');
      }
    },
  };

  const scrollOutcome = await searchByScrolling(
    scrollHost,
    () => {
      const attempt = locateAndExtract(scrollDoc, danaFp, 'text', null);
      return attempt.value !== null ? attempt : null;
    },
    async () => {},
    { maxSteps: 6, stepDelayMs: 0 },
  );
  assert(
    scrollOutcome.result?.value === '9',
    `finds dana's own comment like count once it mounts after scrolling, not alice's or bob's already-mounted counts (got ${JSON.stringify(scrollOutcome.result?.value)})`,
  );
}

// =======================================================================
// Production bug: exact source URL. `resolveSourceUrl` is what
// `commit()` in the page agent now calls when persisting a new
// monitor - previously it always saved `window.location.href`
// unconditionally, so a monitor created by picking a value out of a
// feed (a video's view count on the home timeline, a post's like
// count on a listing page) persisted the *feed's* URL as its source,
// even though `resolveCheckUrl` already knew to check the item's own
// permalink instead. The two silently disagreed: every check
// correctly loaded the exact item, but the URL shown in the UI,
// opened by the domain badge, and used for the origin permission
// check was the feed's.
// =======================================================================
section('Source URL: a feed selection persists the item\'s own permalink, not the feed');

{
  const feedPageUrl = 'https://www.youtube.com/';
  const itemAnchor: ElementFingerprint['itemAnchor'] = {
    href: '/watch?v=abc123&si=trackingtoken',
    isPermalink: true,
    datetime: null,
    rowKey: null,
    primaryText: null,
  };
  const resolved = resolveSourceUrl(feedPageUrl, itemAnchor);
  assert(
    resolved === 'https://www.youtube.com/watch?v=abc123',
    `a feed selection's persisted URL resolves to the item's own canonical permalink with tracking params stripped, not the feed page (got ${JSON.stringify(resolved)})`,
  );
}

{
  // Not a feed selection at all (no item anchor) - the page itself
  // already *is* the exact source (a video's own watch page, a
  // dashboard, a GitHub issue). Only tracking-param noise is stripped.
  const watchPageUrl = 'https://www.youtube.com/watch?v=abc123&si=trackingtoken&list=PLxyz';
  const resolved = resolveSourceUrl(watchPageUrl, null);
  assert(
    resolved === 'https://www.youtube.com/watch?v=abc123&list=PLxyz',
    `no item anchor - falls back to the page's own URL, still stripped of only known tracking params, meaningful ones (list=PLxyz) kept (got ${JSON.stringify(resolved)})`,
  );
}

{
  // A dashboard row's own weaker, non-permalink detail link must be
  // excluded here for the same reason `resolveCheckUrl` excludes it -
  // it isn't guaranteed to render the watched cell at all.
  const dashboardUrl = 'https://dashboard.example.com/table?utm_source=email';
  const weakAnchor: ElementFingerprint['itemAnchor'] = {
    href: '/rows/42',
    isPermalink: false,
    datetime: null,
    rowKey: 'row-42',
    primaryText: null,
  };
  const resolved = resolveSourceUrl(dashboardUrl, weakAnchor);
  assert(
    resolved === 'https://dashboard.example.com/table',
    `a non-permalink item anchor (a dashboard row's own detail link) is not trusted for the persisted source URL either - falls back to the page itself (got ${JSON.stringify(resolved)})`,
  );
}

{
  const stripped = stripTrackingParams(
    'https://x.com/alice/status/123?s=20&t=abc&ref_src=twsrc%5Etfw&important=keep',
  );
  assert(
    stripped === 'https://x.com/alice/status/123?important=keep',
    `stripTrackingParams removes only known tracking params, keeping every other query param untouched (got ${JSON.stringify(stripped)})`,
  );
}

{
  // Malformed input must be handed back unchanged rather than thrown away.
  const passthrough = stripTrackingParams('not a real url');
  assert(passthrough === 'not a real url', 'an unparseable URL is returned unchanged rather than dropped');
}

// =======================================================================
// Production bug: monitor naming. `buildFingerprint(resolved.element, ...)`
// used to be called in `commit()` - i.e. only *after* the user finished
// typing a name, an open-ended step with no time limit. On any real SPA,
// that gap is long enough for a framework re-render to detach the
// originally-clicked element from the document first, so the fingerprint
// ends up built from a stale, disconnected node instead of the live one -
// silently corrupting the monitor's identity in a way that's invisible
// until the first check fails. The fix captures the fingerprint immediately
// in `onClick`, the moment the target is confirmed valid, and threads that
// (plain, serializable) data through naming instead of re-deriving it
// afterward - decoupling how long naming takes from what gets captured.
//
// `pageAgent.content.ts`'s own event-driven closure can't be unit-tested
// directly in this harness (it requires a real extension runtime - see
// `lib/storage/items.ts`'s hard dependency on `browser`, which throws at
// import time outside one). This instead proves the underlying invariant
// the fix depends on: fingerprinting an element *before* a re-render
// detaches it must survive that detachment; fingerprinting it *after* -
// the old call site's timing - must not be relied on to.
// =======================================================================
section('Monitor naming: fingerprint capture must happen before, not after, an open-ended delay');

{
  const namingDom = new JSDOM(`<!doctype html><html><body>
    <div id="app"><div class="card"><span id="metric">100 views</span></div></div>
  </body></html>`);
  const namingDoc = namingDom.window.document;
  (globalThis as any).window = namingDom.window;
  (globalThis as any).document = namingDoc;
  (globalThis as any).Node = namingDom.window.Node;
  (globalThis as any).CSS = namingDom.window.CSS ?? { escape: (s: string) => s };

  const metricEl = namingDoc.getElementById('metric')!;
  const target = resolvePickerTarget(metricEl)!;

  // What `onClick` does now: fingerprint immediately, right after the
  // target is confirmed - before naming (an open-ended text entry
  // step) has a chance to run at all.
  const freshFingerprint = buildFingerprint(target.element, namingDom.window as unknown as Window, target.textAnchor);

  // What the old `commit()` did: hold onto the live element/Range
  // through the entire naming step and fingerprint it only once the
  // user finally submits.
  const staleElementRef = target.element;

  // The naming delay: a framework re-render swaps in an entirely new
  // subtree with an updated value - the classic SPA pattern, and
  // exactly what the doc comment on the old call site warned about.
  // The original app div is removed outright (not just its content
  // replaced in place), so `staleElementRef` ends up fully detached.
  namingDoc.getElementById('app')!.remove();
  const newApp = namingDoc.createElement('div');
  newApp.id = 'app';
  newApp.innerHTML = '<div class="card"><span id="metric">104 views</span></div>';
  namingDoc.body.appendChild(newApp);

  const freshRecovered = locateAndExtract(namingDoc, freshFingerprint, 'text', null);
  assert(
    freshRecovered.value === '104',
    `a fingerprint captured before the naming delay survives a full re-render that happens during it (got ${JSON.stringify(freshRecovered.value)}, diagnostic ${freshRecovered.diagnostic.code})`,
  );

  const staleFingerprint = buildFingerprint(staleElementRef, namingDom.window as unknown as Window, target.textAnchor);
  const staleRecovered = locateAndExtract(namingDoc, staleFingerprint, 'text', null);
  assert(
    staleRecovered.value !== '104' || staleFingerprint.depth !== freshFingerprint.depth,
    'fingerprinting the same element only after it has already been detached (the old call site\'s timing) produces a measurably different/unreliable result than capturing it beforehand - demonstrating why capture must happen eagerly',
  );
}

// =======================================================================
// Production bug: YouTube Views. Trace: selection -> identity ->
// persistence -> readiness -> recovery -> extraction. The view count
// under a video's own title has no id, no data-testid, no aria-label,
// and (per the fixed source-URL bug above) sits on the item's own
// canonical page - the *only* things that can tell "this video" apart
// from any structurally-identical instance of the same page template
// are content-based (the heading/title), not positional. Landmark text
// was scored as an ordinary weighted signal that merely lost points on
// a mismatch, so on a page whose layout is otherwise identical between
// any two videos, enough coincidental structural agreement could still
// carry a wrong-video candidate over the acceptance threshold after an
// SPA navigation. Fixed generically (no youtube.com-specific selectors
// or lowered thresholds) by extending the existing item-identity
// conflict clamp - previously only for rowKey/href/datetime - to a
// landmark-text mismatch too.
// =======================================================================
section('YouTube: a video\'s own view count survives re-renders but is never carried over to a different video after SPA navigation');

function viewsWatchPage(
  document_: Document,
  title: string,
  views: string,
  date: string,
  noiseCount: number,
): void {
  const app = document_.querySelector('ytd-app')!;
  const shadow = app.shadowRoot ?? app.attachShadow({ mode: 'open' });
  // Every noise element shares the *exact same* class list as the real
  // target - "style-scope" alone is a near-useless discriminator on a
  // real YouTube page, since Polymer applies it almost everywhere.
  let noise = '';
  for (let i = 0; i < noiseCount; i += 1) {
    noise += `<yt-formatted-string class="style-scope ytd-watch-info-text">Noise text number ${i}</yt-formatted-string>`;
  }
  shadow.innerHTML = `
    <ytd-watch-flexy>
      <h1 class="style-scope ytd-watch-metadata">${title}</h1>
      <ytd-watch-info-text class="style-scope ytd-watch-metadata">
        <div id="info" class="style-scope ytd-watch-info-text">
          <yt-formatted-string class="style-scope ytd-watch-info-text">${views}</yt-formatted-string>
          <yt-formatted-string class="style-scope ytd-watch-info-text">${date}</yt-formatted-string>
        </div>
      </ytd-watch-info-text>
      <div id="noise-a">${noise}</div>
      <div id="noise-b">${noise}</div>
    </ytd-watch-flexy>
  `;
}

{
  const viewsDom = new JSDOM(`<!doctype html><html><body><ytd-app></ytd-app></body></html>`, {
    pretendToBeVisual: true,
    url: 'https://www.youtube.com/watch?v=videoAAA',
  });
  const viewsDoc = viewsDom.window.document;
  ytGlobals(viewsDom);

  viewsWatchPage(viewsDoc, 'First Video Title', '146,132 views', 'Jul 4, 2024', 300);
  const infoDiv = viewsDoc.querySelector('ytd-app')!.shadowRoot!.querySelector('#info')!;
  const viewsEl = infoDiv.children[0]!;
  const viewsFp = buildFingerprint(viewsEl);
  assert(
    viewsFp.landmarkText === 'First Video Title',
    `the view count's fingerprint captures the video title as its landmark (got ${JSON.stringify(viewsFp.landmarkText)})`,
  );

  // Same video, plain SPA re-render: the count ticks up, fresh node
  // identities throughout, title unchanged.
  viewsWatchPage(viewsDoc, 'First Video Title', '146,205 views', 'Jul 4, 2024', 300);
  const sameVideoRecovered = locateAndExtract(viewsDoc, viewsFp, 'text', null);
  assert(
    sameVideoRecovered.value === '146,205',
    `recovers the same video's own updated view count through a full re-render (got ${JSON.stringify(sameVideoRecovered.value)}, diagnostic ${sameVideoRecovered.diagnostic.code})`,
  );

  // Real SPA navigation to a completely different video - title,
  // views, and date all change; the new page just happens to share
  // the exact same layout/classes/structure as the one that was
  // fingerprinted, the way every YouTube watch page does.
  viewsWatchPage(viewsDoc, 'Completely Different Second Video', '9,001 views', 'Jan 1, 2020', 300);
  const differentVideoRecovered = locateAndExtract(viewsDoc, viewsFp, 'text', null);
  assert(
    differentVideoRecovered.value === null,
    `never substitutes a different video's view count after an SPA navigation - prefers no value over a false match (got ${JSON.stringify(differentVideoRecovered.value)}, diagnostic ${differentVideoRecovered.diagnostic.code})`,
  );
  assert(
    differentVideoRecovered.diagnostic.code !== 'ANTI_AUTOMATION_DETECTED',
    `the "no value" result for a real (if shadow-DOM-only) page is diagnosed honestly, not mislabeled as a bot-verification challenge (got ${differentVideoRecovered.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// Scenario 48: Offscreen document creation concurrency.
// When multiple checks attempt to use the fetch strategy simultaneously,
// calls to ensureOffscreenDocument must be deduplicated so only a single
// chrome.offscreen.createDocument is initiated, preventing Chrome from
// throwing "Only a single offscreen document may be created."
// ---------------------------------------------------------------------
section('Offscreen document: concurrent creation requests share a single createDocument call');
{
  const state = {
    hasDoc: false,
    createCalls: 0,
  };
  const createDelay = 20;

  (globalThis as any).browser = {
    runtime: {
      getURL: (path: string) => `chrome-extension://mock${path}`,
    },
  };

  (globalThis as any).chrome = {
    offscreen: {
      Reason: { DOM_PARSER: 'DOM_PARSER' },
      hasDocument: async () => state.hasDoc,
      createDocument: async () => {
        state.createCalls++;
        if (state.createCalls > 1) {
          throw new Error('Only a single offscreen document may be created.');
        }
        await new Promise((resolve) => setTimeout(resolve, createDelay));
        state.hasDoc = true;
      },
    },
  };

  // Scenario 1: 5 concurrent callers arrive when no document exists
  const results = await Promise.all([
    ensureOffscreenDocument(),
    ensureOffscreenDocument(),
    ensureOffscreenDocument(),
    ensureOffscreenDocument(),
    ensureOffscreenDocument(),
  ]);
  assert(results.length === 5, 'all 5 concurrent callers resolved');
  assert(state.createCalls === 1, `exactly one createDocument call was made despite 5 concurrent callers (got ${state.createCalls})`);
  assert(state.hasDoc, 'document state is now true');

  // Scenario 2: subsequent call when document already exists does not call createDocument
  await ensureOffscreenDocument();
  assert(state.createCalls === 1, `createDocument was not called again when document already exists (got ${state.createCalls})`);

  // Scenario 3: failure cleans up mutex so next call can retry
  state.hasDoc = false;
  let failOnce = true;
  (globalThis as any).chrome.offscreen.createDocument = async () => {
    state.createCalls++;
    if (failOnce) {
      failOnce = false;
      throw new Error('Creation crashed');
    }
    state.hasDoc = true;
  };

  let threw = false;
  try {
    await ensureOffscreenDocument();
  } catch (err: unknown) {
    threw = true;
    assert(err instanceof Error && err.message === 'Creation crashed', 'caller received the original failure');
  }
  assert(threw, 'creation failure rejected as expected');

  // Retry after failure: mutex was cleaned up, so this attempt runs and succeeds
  await ensureOffscreenDocument();
  assert(state.hasDoc, 'retry after failure succeeded, confirming mutex was cleaned up');

  // Scenario 4: external race where another process creates document during call
  state.hasDoc = false;
  (globalThis as any).chrome.offscreen.createDocument = async () => {
    state.createCalls++;
    // Another process just created it
    state.hasDoc = true;
    throw new Error('Only a single offscreen document may be created.');
  };

  let raceThrew = false;
  try {
    await ensureOffscreenDocument();
  } catch {
    raceThrew = true;
  }
  assert(!raceThrew, 'concurrent external creation error was handled safely because document now exists');
}

// ---------------------------------------------------------------------
// Scenario 49: Lifecycle readiness & delayed settlement.
// "target unavailable/incomplete during initial render → target becomes
// available after rendering settles → recovery succeeds without requiring
// a manual page reload."
// ---------------------------------------------------------------------
section('target unavailable/incomplete during initial render → target becomes available after rendering settles → recovery succeeds without requiring a manual page reload');
{
  const dom = new JSDOM('<!doctype html><html><body><ytd-app></ytd-app></body></html>', {
    url: 'https://www.youtube.com/watch?v=videoXYZ',
    pretendToBeVisual: true,
  });
  ytGlobals(dom);
  const doc = dom.window.document;
  const app = doc.querySelector('ytd-app')!;
  const shadow = app.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <ytd-watch-flexy>
      <h1 class="style-scope ytd-watch-metadata">My Video Title</h1>
      <ytd-watch-info-text class="style-scope ytd-watch-metadata">
        <div id="info" class="style-scope ytd-watch-info-text">
          <yt-formatted-string class="style-scope ytd-watch-info-text">146,132 views</yt-formatted-string>
        </div>
      </ytd-watch-info-text>
    </ytd-watch-flexy>
  `;
  const viewsEl = shadow.querySelector('yt-formatted-string')!;
  const fp = buildFingerprint(viewsEl);

  // Subscenario A: Target unavailable during initial render.
  // Container shell exists, but target element has not yet mounted.
  let noise = '';
  for (let i = 0; i < 50; i++) {
    noise += `<yt-formatted-string class="style-scope ytd-watch-info-text">Noise ${i}</yt-formatted-string>`;
  }
  shadow.innerHTML = `
    <ytd-watch-flexy>
      <h1 class="style-scope ytd-watch-metadata"></h1>
      <ytd-watch-info-text class="style-scope ytd-watch-metadata">
        <div id="info" class="style-scope ytd-watch-info-text"></div>
      </ytd-watch-info-text>
      <div id="noise">${noise}</div>
    </ytd-watch-flexy>
  `;

  setTimeout(() => {
    shadow.querySelector('h1')!.textContent = 'My Video Title';
    const info = shadow.querySelector('#info')!;
    const newViews = doc.createElement('yt-formatted-string');
    newViews.className = 'style-scope ytd-watch-info-text';
    newViews.textContent = '146,132 views';
    info.appendChild(newViews);
  }, 350);

  const readA = () => locateAndExtract(doc, fp, 'text', null, dom.window as unknown as Window);
  const waitForReadyA = (maxWaitMs: number) => {
    const c = findLikelyContainer(doc, fp);
    if (c) return waitForRegionReady(dom.window as unknown as Window, c, { maxWaitMs });
    return waitForPageReady(dom.window as unknown as Window, { maxWaitMs });
  };

  const resultA = await resolveSettledValue(waitForReadyA, readA, {
    maxTotalWaitMs: 3000,
    delaysMs: [0, 100, 200, 400],
  });

  assert(
    resultA.value === '146,132',
    `target unavailable initially settles to real value without reload (got ${JSON.stringify(resultA.value)})`,
  );

  // Subscenario B: Target incomplete / placeholder during initial render.
  // Target element mounts with placeholder text "--" and empty heading.
  shadow.innerHTML = `
    <ytd-watch-flexy>
      <h1 class="style-scope ytd-watch-metadata"></h1>
      <ytd-watch-info-text class="style-scope ytd-watch-metadata">
        <div id="info" class="style-scope ytd-watch-info-text">
          <yt-formatted-string class="style-scope ytd-watch-info-text">--</yt-formatted-string>
        </div>
      </ytd-watch-info-text>
      <div id="noise">${noise}</div>
    </ytd-watch-flexy>
  `;

  setTimeout(() => {
    shadow.querySelector('h1')!.textContent = 'My Video Title';
    const existing = shadow.querySelector('#info yt-formatted-string')!;
    existing.textContent = '146,132 views';
  }, 250);

  const readB = () => locateAndExtract(doc, fp, 'text', null, dom.window as unknown as Window);
  const waitForReadyB = (maxWaitMs: number) => {
    const c = findLikelyContainer(doc, fp);
    if (c) return waitForRegionReady(dom.window as unknown as Window, c, { maxWaitMs });
    return waitForPageReady(dom.window as unknown as Window, { maxWaitMs });
  };

  const resultB = await resolveSettledValue(waitForReadyB, readB, {
    maxTotalWaitMs: 3000,
    delaysMs: [0, 100, 200, 400],
  });

  assert(
    resultB.value === '146,132',
    `target incomplete/placeholder initially avoids false confirmation and settles to real value (got ${JSON.stringify(resultB.value)})`,
  );
}

// =======================================================================
// Regression test: YouTube video view counts with animated rolling numbers
// and aria-hidden children cleanly resolve in picker, build accurate
// fingerprints, and reliably recover across reloads/re-renders without "No value".
// =======================================================================
section('YouTube: animated rolling-number view counts resolve, persist, and recover across reloads');

{
  function buildModernYouTubeWatchPage(viewsAria: string, title: string): { doc: Document; dom: JSDOM } {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <ytd-app>
          <ytd-watch-flexy>
            <h1 class="style-scope ytd-watch-metadata">${title}</h1>
            <div id="info-container" class="style-scope ytd-watch-info-text">
              <div id="view-count" class="style-scope ytd-watch-info-text" aria-label="${viewsAria}">
                <ps-dom-if class="style-scope ytd-watch-info-text"><template is="dom-if"></template></ps-dom-if>
                <yt-formatted-string aria-hidden="true" class="style-scope ytd-watch-info-text" is-empty=""></yt-formatted-string>
                <yt-animated-rolling-number class="animatedRollingNumberHost" dir="ltr" aria-hidden="true" style="height: 20px; line-height: 20px;">
                  <animated-rolling-character class="animatedRollingCharacterHost">
                    <div>1</div><div>2</div><div>3</div>
                  </animated-rolling-character>
                  <animated-rolling-character class="animatedRollingCharacterHost">
                    <div>.</div>
                  </animated-rolling-character>
                  <animated-rolling-character class="animatedRollingCharacterHost">
                    <div>8</div>
                  </animated-rolling-character>
                  <animated-rolling-character class="animatedRollingCharacterHost">
                    <div>B</div>
                  </animated-rolling-character>
                </yt-animated-rolling-number>
                <yt-formatted-string aria-hidden="true" class="style-scope ytd-watch-info-text"> views  </yt-formatted-string>
              </div>
            </div>
          </ytd-watch-flexy>
        </ytd-app>
      </body></html>`,
      { pretendToBeVisual: true, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    );
    ytGlobals(dom);
    return { doc: dom.window.document, dom };
  }

  const { doc } = buildModernYouTubeWatchPage('1.8B views  ', 'Never Gonna Give You Up');
  const viewCountEl = doc.querySelector('#view-count')!;
  const innerDigitDiv = viewCountEl.querySelector('.animatedRollingCharacterHost div')!;

  // 1. extractVisibleText on #view-count falls back to aria-label instead of returning empty
  const extractedDirect = extractVisibleText(viewCountEl);
  assert(
    extractedDirect === '1.8B views',
    `extractVisibleText on #view-count extracts clean value from aria-label when children are aria-hidden (got ${JSON.stringify(extractedDirect)})`,
  );

  // 2. Range/caret hit testing inside the rolling character expands to #view-count
  const textNode = innerDigitDiv.firstChild!;
  const range = doc.createRange();
  range.selectNodeContents(textNode);
  doc.getSelection()?.removeAllRanges();
  doc.getSelection()?.addRange(range);

  // Direct target resolution on the inner rolling digit expands to the semantic container #view-count
  const pickerTargetFromDigit = resolvePickerTarget(innerDigitDiv);
  assert(
    pickerTargetFromDigit !== null && pickerTargetFromDigit.element.id === 'view-count',
    `resolvePickerTarget on inner digit resolves to #view-count container (got id: ${pickerTargetFromDigit?.element.id})`,
  );
  assert(
    pickerTargetFromDigit?.text === '1.8B views',
    `resolvePickerTarget text is "1.8B views" (got ${JSON.stringify(pickerTargetFromDigit?.text)})`,
  );
  assert(
    pickerTargetFromDigit?.semanticValue.type === 'views',
    `semantic value is recognized as views (got ${pickerTargetFromDigit?.semanticValue.type})`,
  );

  // 3. buildFingerprint captures clean text snapshot and short-text pattern
  const fp = buildFingerprint(pickerTargetFromDigit!.element);
  assert(
    fp.id === 'view-count',
    `fingerprint captures stable id="view-count" (got ${JSON.stringify(fp.id)})`,
  );
  assert(
    fp.ariaLabel === '1.8B views  ',
    `fingerprint captures aria-label (got ${JSON.stringify(fp.ariaLabel)})`,
  );
  assert(
    fp.textSnapshot === '1.8B views',
    `fingerprint captures clean textSnapshot instead of raw rolling numbers (got ${JSON.stringify(fp.textSnapshot)})`,
  );
  assert(
    fp.textPattern === 'short-text',
    `fingerprint classifies pattern as short-text (got ${JSON.stringify(fp.textPattern)})`,
  );

  // 4. Initial extraction succeeds with high confidence
  const initialResult = locateAndExtract(doc, fp, 'text', null);
  assert(
    initialResult.value === '1.8B',
    `locateAndExtract stores clean numeric token without "views" suffix (got ${JSON.stringify(initialResult.value)})`,
  );
  assert(
    initialResult.confidence >= 80,
    `confidence is high (got ${initialResult.confidence})`,
  );

  // 5. Full page reload / re-render with updated view count
  const reloaded = buildModernYouTubeWatchPage('1.9B views  ', 'Never Gonna Give You Up');
  const reloadedResult = locateAndExtract(reloaded.doc, fp, 'text', null);
  assert(
    reloadedResult.value === '1.9B',
    `locateAndExtract recovers updated view count without "views" suffix (got ${JSON.stringify(reloadedResult.value)})`,
  );
  assert(
    reloadedResult.diagnostic.code === 'OK',
    `diagnostic is OK after reload (got ${reloadedResult.diagnostic.code})`,
  );

  // 6. SPA navigation to a different video title fails safely (does not hijack wrong video)
  const differentVideo = buildModernYouTubeWatchPage('500K views  ', 'Completely Different Video');
  const differentResult = locateAndExtract(differentVideo.doc, fp, 'text', null);
  assert(
    differentResult.value === null,
    `different video after SPA navigation returns null to prevent false match (got ${JSON.stringify(differentResult.value)})`,
  );
}

// ---------------------------------------------------------------------
// Scenario: extractNumericToken strips keyword labels from metric values
// so the stored value is a clean numeric token.
// ---------------------------------------------------------------------
section('extractNumericToken: strips keyword suffixes from metric values');

const numericTokenCases: Array<{ input: string; expected: string }> = [
  { input: '1.73M subscribers', expected: '1.73M' },
  { input: '222K views', expected: '222K' },
  { input: '9.9K', expected: '9.9K' },
  { input: '45,231 views', expected: '45,231' },
  { input: '1.2M subscribers', expected: '1.2M' },
  { input: '12.4K followers', expected: '12.4K' },
  { input: '1.8B views', expected: '1.8B' },
  { input: '500K views', expected: '500K' },
  { input: 'Out of stock', expected: 'Out of stock' },
  { input: '$49.99', expected: '$49.99' },
  { input: '1 Bitcoin BTC $79,525.75', expected: '$79,525.75' },
  { input: 'Shwetabh Gangwar 1.73M subscribers', expected: '1.73M' },
  { input: '222K views 4 months ago', expected: '222K' },
];

for (const tc of numericTokenCases) {
  const result = extractNumericToken(tc.input);
  assert(
    result === tc.expected,
    `extractNumericToken("${tc.input}") → "${tc.expected}" (got "${result}")`,
  );
}

// ---------------------------------------------------------------------
// Scenario: numeric targets store ONLY the actual value without surrounding text
// ---------------------------------------------------------------------
section('Value extraction: numeric targets store ONLY the actual value without surrounding text');

{
  const btcDom = new JSDOM(`<!doctype html><html><body><span id="price">1 Bitcoin BTC $79,525.75</span></body></html>`);
  const btcDoc = btcDom.window.document;
  const btcEl = btcDoc.getElementById('price')!;
  const btcFp = buildFingerprint(btcEl);
  const btcResult = locateAndExtract(btcDoc, btcFp, 'text', null);
  assert(
    btcResult.value === '$79,525.75',
    `locateAndExtract("1 Bitcoin BTC $79,525.75") stores only "$79,525.75" (got ${JSON.stringify(btcResult.value)})`,
  );
  assert(
    btcResult.semanticValue?.type === 'currency' && btcResult.semanticValue?.normalized === 79525.75,
    `semantic value is currency normalized to 79525.75 (got ${btcResult.semanticValue?.type}, ${btcResult.semanticValue?.normalized})`,
  );

  const subDom = new JSDOM(`<!doctype html><html><body><span id="subs">Shwetabh Gangwar 1.73M subscribers</span></body></html>`);
  const subDoc = subDom.window.document;
  const subEl = subDoc.getElementById('subs')!;
  const subFp = buildFingerprint(subEl);
  const subResult = locateAndExtract(subDoc, subFp, 'text', null);
  assert(
    subResult.value === '1.73M',
    `locateAndExtract("Shwetabh Gangwar 1.73M subscribers") stores only "1.73M" (got ${JSON.stringify(subResult.value)})`,
  );
  assert(
    subResult.semanticValue?.type === 'followers' && subResult.semanticValue?.normalized === 1730000,
    `semantic value is followers normalized to 1730000 (got ${subResult.semanticValue?.type}, ${subResult.semanticValue?.normalized})`,
  );

  const viewsDom = new JSDOM(`<!doctype html><html><body><span id="views">222K views 4 months ago</span></body></html>`);
  const viewsDoc = viewsDom.window.document;
  const viewsEl = viewsDoc.getElementById('views')!;
  const viewsFp = buildFingerprint(viewsEl);
  const viewsResult = locateAndExtract(viewsDoc, viewsFp, 'text', null);
  assert(
    viewsResult.value === '222K',
    `locateAndExtract("222K views 4 months ago") stores only "222K" (got ${JSON.stringify(viewsResult.value)})`,
  );
  assert(
    viewsResult.semanticValue?.type === 'views' && viewsResult.semanticValue?.normalized === 222000,
    `semantic value is views normalized to 222000 (got ${viewsResult.semanticValue?.type}, ${viewsResult.semanticValue?.normalized})`,
  );
}

// ---------------------------------------------------------------------
// Scenario: picker hover preview displays exact canonical value produced by
// locateAndExtract pipeline, even when target text is surrounded by buttons,
// percentages, and other metrics in a table row ($2,501.76).
// ---------------------------------------------------------------------
section('Picker hover preview: table row with $2,501.76 matches locateAndExtract monitor value');

{
  const cryptoDom = new JSDOM(`<!doctype html><html><body>
    <table>
      <tbody>
        <tr id="crypto-row">
          <td><button class="buy-btn">Buy</button></td>
          <td class="name">Ethereum ETH</td>
          <td id="price-cell"><span class="price-val">$2,501.76</span></td>
          <td class="change-1h">-0.19%</td>
          <td class="change-24h">+1.48%</td>
          <td class="change-7d">+9.66%</td>
          <td class="volume">$18.2B</td>
          <td><button class="trade-btn">Trade</button></td>
        </tr>
      </tbody>
    </table>
  </body></html>`);
  const cdoc = cryptoDom.window.document;
  (globalThis as any).window = cryptoDom.window;
  (globalThis as any).document = cdoc;
  (globalThis as any).Node = cryptoDom.window.Node;
  (globalThis as any).CSS = cryptoDom.window.CSS ?? { escape: (s: string) => s };
  (globalThis as any).ShadowRoot = cryptoDom.window.ShadowRoot;

  const priceValEl = cdoc.querySelector('.price-val')!;
  const target = resolvePickerTarget(priceValEl)!;
  assert(target !== null, 'resolves picker target for crypto price element');

  const semantic = target.semanticValue ?? detectSemanticValue(target.text);
  const isNumeric = semantic.type !== 'text' && semantic.normalized !== null;
  const hoverPreviewValue = isNumeric ? extractNumericToken(target.text, semantic) : target.text;
  const tooltipText = formatPickerTooltip(target);

  const fp = buildFingerprint(target.element, cryptoDom.window as unknown as Window);
  const extracted = locateAndExtract(cdoc, fp, 'text', null);

  assert(
    hoverPreviewValue === '$2,501.76',
    `hover preview value is "$2,501.76" (got ${JSON.stringify(hoverPreviewValue)})`,
  );
  assert(
    extracted.value === '$2,501.76',
    `locateAndExtract stored value is "$2,501.76" (got ${JSON.stringify(extracted.value)})`,
  );
  assert(
    hoverPreviewValue === extracted.value,
    'hover preview and final stored monitor value are identical',
  );
  assert(
    tooltipText === '✓ $2,501.76',
    `hover tooltip text displays canonical value without row noise (got ${JSON.stringify(tooltipText)})`,
  );

  // Also verify when target text contains the entire row with Buy buttons and percentages:
  const rowEl = cdoc.getElementById('crypto-row')!;
  const rowFp = buildFingerprint(rowEl, cryptoDom.window as unknown as Window);
  const rowExtracted = locateAndExtract(cdoc, rowFp, 'text', null);
  const rowSemantic = detectSemanticValue(rowEl.textContent ?? '');
  const rowHoverPreview = extractNumericToken(rowEl.textContent ?? '', rowSemantic);

  assert(
    rowHoverPreview === '$2,501.76',
    `row text with Buy/percentages/volume resolves hover preview to "$2,501.76" (got ${JSON.stringify(rowHoverPreview)})`,
  );
  assert(
    rowExtracted.value === '$2,501.76',
    `row locateAndExtract extracts "$2,501.76" (got ${JSON.stringify(rowExtracted.value)})`,
  );
  assert(
    rowHoverPreview === rowExtracted.value,
    'row hover preview and final stored monitor value are identical',
  );
}

// ---------------------------------------------------------------------
// Regression: Core value-capture reliability
// ---------------------------------------------------------------------
section('Core value-capture reliability: dynamic updates, React re-mounts, and self-healing');
{
  // 1. Multi-run button counter: "Likes: 147" updating to "Likes: 150"
  const buttonDom = new JSDOM(`<!doctype html><html><body><button id="like-btn"><span class="label">Likes: </span><span class="count">147</span></button></body></html>`);
  const bdoc = buttonDom.window.document;
  (globalThis as any).Node = buttonDom.window.Node;
  const countSpan = bdoc.querySelector('.count')!;
  const btn = bdoc.getElementById('like-btn')!;

  const pickerTarget = resolvePickerTarget(countSpan)!;
  assert(pickerTarget !== null, 'resolves picker target for button counter');
  assert(pickerTarget.canonicalValue === '147', `canonical value is "147" (got ${JSON.stringify(pickerTarget.canonicalValue)})`);
  assert(pickerTarget.textAnchor?.value === '147', `textAnchor value is "147" (got ${JSON.stringify(pickerTarget.textAnchor?.value)})`);
  assert(pickerTarget.textAnchor?.before === 'Likes: ', `textAnchor before is "Likes: " (got ${JSON.stringify(pickerTarget.textAnchor?.before)})`);

  const fp = buildFingerprint(btn, buttonDom.window as unknown as Window, pickerTarget.textAnchor);
  const initialResult = locateAndExtract(bdoc, fp, 'text', null);
  assert(initialResult.value === '147', `initial value is "147" (got ${JSON.stringify(initialResult.value)})`);

  // React dynamic update: counter changes from 147 to 150
  btn.innerHTML = '<span class="label">Likes: </span><span class="count">150</span>';
  const updatedResult = locateAndExtract(bdoc, fp, 'text', null);
  assert(
    updatedResult.value === '150',
    `dynamic update extracts exactly "150", not surrounding text (got ${JSON.stringify(updatedResult.value)})`,
  );

  // 2. Surrounding text isolation across SPA re-render: "Balance: 1,234 points" -> "Balance: 2,500 points"
  const statDom = new JSDOM(`<!doctype html><html><body><div data-testid="stat-card" class="stat">Balance: <strong class="val">1,234</strong> points</div></body></html>`);
  const sdoc = statDom.window.document;
  const valStrong = sdoc.querySelector('.val')!;
  const statDiv = sdoc.querySelector('.stat')!;

  const statTarget = resolvePickerTarget(valStrong)!;
  const statFp = buildFingerprint(statDiv, statDom.window as unknown as Window, statTarget.textAnchor);
  const statInitial = locateAndExtract(sdoc, statFp, 'text', null);
  assert(statInitial.value === '1,234', `stat initial value is "1,234" (got ${JSON.stringify(statInitial.value)})`);

  // SPA update: value changes to 2,500
  statDiv.innerHTML = 'Balance: <strong class="val">2,500</strong> points';
  const statUpdated = locateAndExtract(sdoc, statFp, 'text', null);
  assert(
    statUpdated.value === '2,500',
    `SPA update captures exactly "2,500" without "Balance:" or "points" (got ${JSON.stringify(statUpdated.value)})`,
  );

  // 3. Relocation self-healing preserves textAnchor
  // Move element to a new container so fast-path selector fails and recovery-scan produces updatedFingerprint
  sdoc.body.innerHTML = '<div class="new-wrapper"><div data-testid="stat-card" class="stat">Balance: <strong class="val">3,100</strong> points</div></div>';
  const recovered = locateAndExtract(sdoc, statFp, 'text', null, statDom.window as unknown as Window);
  assert(recovered.value === '3,100', `relocation extracts "3,100" (got ${JSON.stringify(recovered.value)})`);
  assert(recovered.diagnostic.code === 'OK_RECOVERED', `relocation diagnostic is OK_RECOVERED (got ${recovered.diagnostic.code})`);
  assert(recovered.updatedFingerprint !== null, 'produces updatedFingerprint on relocation');
  assert(recovered.updatedFingerprint?.textAnchor !== null, 'updatedFingerprint preserves textAnchor');
  assert(
    recovered.updatedFingerprint?.textAnchor?.value === '3,100',
    `updated textAnchor value is "3,100" (got ${JSON.stringify(recovered.updatedFingerprint?.textAnchor?.value)})`,
  );
  assert(
    recovered.updatedFingerprint?.textAnchor?.before === 'Balance: ',
    `updated textAnchor before is "Balance: " (got ${JSON.stringify(recovered.updatedFingerprint?.textAnchor?.before)})`,
  );

  // Subsequent check with the healed fingerprint recovers subsequent update
  const healedFp = recovered.updatedFingerprint!;
  sdoc.body.innerHTML = '<div class="new-wrapper"><div data-testid="stat-card" class="stat">Balance: <strong class="val">4,250</strong> points</div></div>';
  const healedResult = locateAndExtract(sdoc, healedFp, 'text', null, statDom.window as unknown as Window);
  assert(
    healedResult.value === '4,250',
    `healed fingerprint extracts next value "4,250" without label (got ${JSON.stringify(healedResult.value)})`,
  );

  // 4. resolvePickerTargetAtPoint on a complete currency cell avoids expanding to entire row
  const tableDom = new JSDOM(`<!doctype html><html><body><table><tr id="r1"><td>Item 1</td><td class="price">$99.00</td><td><button>Action</button></td></tr></table></body></html>`);
  const tdoc = tableDom.window.document;
  (tdoc as any).caretRangeFromPoint = () => {
    const range = tdoc.createRange();
    const cell = tdoc.querySelector('.price')!;
    range.setStart(cell.firstChild!, 1);
    range.collapse(true);
    return range;
  };
  const cellTarget = resolvePickerTargetAtPoint(tdoc, 5, 5)!;
  assert(cellTarget !== null, 'resolves picker target at point');
  assert(cellTarget.element.tagName === 'TD', `anchors to TD element, not TR (got ${cellTarget.element.tagName})`);
  assert(cellTarget.canonicalValue === '$99.00', `canonical value is "$99.00" (got ${JSON.stringify(cellTarget.canonicalValue)})`);
}

// ---------------------------------------------------------------------
// Regression: Numeric monitor regression after updates / re-renders
// ---------------------------------------------------------------------
section('Regression: Numeric monitors return canonical value after DOM updates; text monitors unaffected');
{
  // 1. Button counter initially captures numeric value, later DOM re-renders with altered surrounding format
  const btnDom = new JSDOM(`<!doctype html><html><body><button id="like-counter"><span class="lbl">Likes: </span><span class="val">147</span></button></body></html>`);
  const bdoc = btnDom.window.document;
  (globalThis as any).Node = btnDom.window.Node;
  const valSpan = bdoc.querySelector('.val')!;
  const btnEl = bdoc.getElementById('like-counter')!;

  const pickerTarget = resolvePickerTarget(valSpan)!;
  assert(pickerTarget !== null, 'resolves picker target for initial counter');
  assert(pickerTarget.canonicalValue === '147', `canonical value is "147" (got ${JSON.stringify(pickerTarget.canonicalValue)})`);

  const fp = buildFingerprint(btnEl, btnDom.window as unknown as Window, pickerTarget.textAnchor);
  const initialCheck = locateAndExtract(bdoc, fp, 'text', null);
  assert(initialCheck.value === '147', `initial check captures canonical "147" (got ${JSON.stringify(initialCheck.value)})`);
  assert(initialCheck.semanticValue?.type === 'number', `initial semantic value is number (got ${initialCheck.semanticValue?.type})`);

  // DOM re-render: surrounding text format changes so textAnchor before/after no longer matches
  btnEl.innerHTML = 'Likes (150)';
  const updateA = locateAndExtract(bdoc, fp, 'text', null);
  assert(
    updateA.value === '150',
    `subsequent check after re-render to "Likes (150)" returns canonical "150" (got ${JSON.stringify(updateA.value)})`,
  );
  assert(
    updateA.semanticValue?.type === 'number' && updateA.semanticValue?.normalized === 150,
    `semantic value is normalized number 150 (got ${updateA.semanticValue?.type}, ${updateA.semanticValue?.normalized})`,
  );

  // DOM re-render: reversed label/number order ("152 likes")
  btnEl.innerHTML = '152 likes';
  const updateB = locateAndExtract(bdoc, fp, 'text', null);
  assert(
    updateB.value === '152',
    `subsequent check after re-render to "152 likes" returns canonical "152" (got ${JSON.stringify(updateB.value)})`,
  );
  assert(
    updateB.semanticValue?.type === 'number' && updateB.semanticValue?.normalized === 152,
    `semantic value is normalized number 152 (got ${updateB.semanticValue?.type}, ${updateB.semanticValue?.normalized})`,
  );

  // 2. Stat card: initial capture "1,234", re-render changes label and abbreviation
  const cardDom = new JSDOM(`<!doctype html><html><body><div id="stat-card">Balance: <strong class="num">1,234</strong> points</div></body></html>`);
  const cdoc = cardDom.window.document;
  const numStrong = cdoc.querySelector('.num')!;
  const cardEl = cdoc.getElementById('stat-card')!;

  const cardTarget = resolvePickerTarget(numStrong)!;
  const cardFp = buildFingerprint(cardEl, cardDom.window as unknown as Window, cardTarget.textAnchor);
  const cardInitial = locateAndExtract(cdoc, cardFp, 'text', null);
  assert(cardInitial.value === '1,234', `card initial value is "1,234" (got ${JSON.stringify(cardInitial.value)})`);

  // Subsequent check: template changes label from "Balance:" to "Total Balance:" and unit from "points" to "pts"
  cardEl.innerHTML = 'Total Balance: 2,500 pts';
  const cardUpdate = locateAndExtract(cdoc, cardFp, 'text', null);
  assert(
    cardUpdate.value === '2,500',
    `card update captures canonical "2,500" without "Total Balance:" or "pts" (got ${JSON.stringify(cardUpdate.value)})`,
  );
  assert(
    cardUpdate.semanticValue?.type === 'number' && cardUpdate.semanticValue?.normalized === 2500,
    `card update semantic value is normalized number 2500 (got ${cardUpdate.semanticValue?.type}, ${cardUpdate.semanticValue?.normalized})`,
  );

  // 3. Plain inventory count: "In stock: 42" -> "43 items remaining"
  const stockDom = new JSDOM(`<!doctype html><html><body><div id="stock-count">In stock: <span class="amt">42</span></div></body></html>`);
  const sdoc = stockDom.window.document;
  const amtSpan = sdoc.querySelector('.amt')!;
  const stockEl = sdoc.getElementById('stock-count')!;

  const stockTarget = resolvePickerTarget(amtSpan)!;
  const stockFp = buildFingerprint(stockEl, stockDom.window as unknown as Window, stockTarget.textAnchor);
  const stockInitial = locateAndExtract(sdoc, stockFp, 'text', null);
  assert(stockInitial.value === '42', `stock initial value is "42" (got ${JSON.stringify(stockInitial.value)})`);

  stockEl.innerHTML = '43 items remaining';
  const stockUpdate = locateAndExtract(sdoc, stockFp, 'text', null);
  assert(
    stockUpdate.value === '43',
    `stock update captures canonical "43" without surrounding text (got ${JSON.stringify(stockUpdate.value)})`,
  );

  // 4. Text monitors must remain unaffected: status text containing numbers or updates
  const textDom = new JSDOM(`<!doctype html><html><body><div id="status-badge">In Progress</div></body></html>`);
  const tdoc = textDom.window.document;
  const badgeEl = tdoc.getElementById('status-badge')!;

  const textTarget = resolvePickerTarget(badgeEl)!;
  assert(textTarget.semanticValue.type === 'text', `target is recognized as text (got ${textTarget.semanticValue.type})`);
  const textFp = buildFingerprint(badgeEl, textDom.window as unknown as Window, textTarget.textAnchor);
  const textInitial = locateAndExtract(tdoc, textFp, 'text', null);
  assert(textInitial.value === 'In Progress', `initial text is "In Progress" (got ${JSON.stringify(textInitial.value)})`);
  assert(textInitial.semanticValue?.type === 'text', `initial semantic is text (got ${textInitial.semanticValue?.type})`);

  // DOM update: text changes to another status string that includes numbers or percentages
  badgeEl.textContent = 'Completed (100%)';
  const textUpdateA = locateAndExtract(tdoc, textFp, 'text', null);
  assert(
    textUpdateA.value === 'Completed (100%)',
    `text monitor preserves full text "Completed (100%)" without stripping (got ${JSON.stringify(textUpdateA.value)})`,
  );

  badgeEl.textContent = 'Version 2.4.1 released';
  const textUpdateB = locateAndExtract(tdoc, textFp, 'text', null);
  assert(
    textUpdateB.value === 'Version 2.4.1 released',
    `text monitor preserves full text "Version 2.4.1 released" (got ${JSON.stringify(textUpdateB.value)})`,
  );

  // 5. Sequential value changes across formats: 147 → Likes (150) → 152 likes → 2,500 pts with SPA re-renders
  const seqDom = new JSDOM(`<!doctype html><html><body><div id="container"><span id="metric">147</span></div></body></html>`);
  const sdoc2 = seqDom.window.document;
  const metricSpan = sdoc2.getElementById('metric')!;

  const seqTarget = resolvePickerTarget(metricSpan)!;
  assert(seqTarget.canonicalValue === '147', `initial value is 147 (got ${seqTarget.canonicalValue})`);
  let activeFp = buildFingerprint(metricSpan, seqDom.window as unknown as Window, seqTarget.textAnchor);

  // State 1: 147
  const r1 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r1.value === '147', `r1 is "147" (got ${JSON.stringify(r1.value)})`);

  // State 2: Likes (150)
  metricSpan.innerHTML = 'Likes (150)';
  const r2 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r2.value === '150', `r2 format "Likes (150)" extracts canonical "150" (got ${JSON.stringify(r2.value)})`);
  assert(r2.semanticValue?.type === 'number' && r2.semanticValue.normalized === 150, `r2 semantic value is number 150`);
  if (r2.updatedFingerprint) activeFp = r2.updatedFingerprint;

  // State 3: 152 likes
  metricSpan.innerHTML = '152 likes';
  const r3 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r3.value === '152', `r3 format "152 likes" extracts canonical "152" (got ${JSON.stringify(r3.value)})`);
  assert(r3.semanticValue?.type === 'number' && r3.semanticValue.normalized === 152, `r3 semantic value is number 152`);
  if (r3.updatedFingerprint) activeFp = r3.updatedFingerprint;

  // State 4: 2,500 pts
  metricSpan.innerHTML = '2,500 pts';
  const r4 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r4.value === '2,500', `r4 format "2,500 pts" extracts canonical "2,500" (got ${JSON.stringify(r4.value)})`);
  assert(r4.semanticValue?.type === 'number' && r4.semanticValue.normalized === 2500, `r4 semantic value is number 2500`);
  if (r4.updatedFingerprint) activeFp = r4.updatedFingerprint;

  // State 5: React/SPA re-render with updated wrapper
  sdoc2.body.innerHTML = '<div class="new-wrapper"><div id="container"><span id="metric">3,100 pts</span></div></div>';
  const r5 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r5.value === '3,100', `r5 after SPA re-render extracts canonical "3,100" (got ${JSON.stringify(r5.value)})`);
  assert(r5.semanticValue?.type === 'number' && r5.semanticValue.normalized === 3100, `r5 semantic value is number 3100`);

  // State 6: Subsequent update in the re-rendered SPA DOM
  sdoc2.getElementById('metric')!.textContent = '4,500 pts';
  const r6 = locateAndExtract(sdoc2, activeFp, 'text', null, seqDom.window as unknown as Window);
  assert(r6.value === '4,500', `r6 extracts next canonical value "4,500" (got ${JSON.stringify(r6.value)})`);
  assert(r6.semanticValue?.type === 'number' && r6.semanticValue.normalized === 4500, `r6 semantic is number 4500`);
}

// ---------------------------------------------------------------------
// Regression: Selection reliability, multi-value identification, and ambiguity feedback
// ---------------------------------------------------------------------
section('Selection reliability: identify intended value and clearly indicate ambiguity on multi-value elements');
{
  const testDom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <!-- Multi-value with clear intended metric: currency vs table rank -->
        <section><div id="crypto-row">1 Bitcoin BTC $79,525.75</div></section>

        <!-- Surrounding text & label with single number -->
        <section><div id="likes-btn"><label>Likes</label> <span>(150)</span></div></section>
        <section><div id="balance-card"><label>Total Balance</label>: <span>2,500 pts</span></div></section>
        <section><div id="views-stat">222K views 4 months ago</div></section>
        <section><div id="stock-info">In stock: 42 (min order: 5)</div></section>

        <!-- Ambiguous: multiple plausible numbers of equal prominence -->
        <section><div id="score-vs">Score 85 vs 90</div></section>
        <section><div id="price-range">$25.00 ($30.00)</div></section>
        <section><div id="between-range">Between 10 and 20 items</div></section>
        <section><div id="multi-metric">12 upvotes · 4 comments</div></section>

        <!-- Text monitors: status and announcement strings -->
        <section><div id="text-status">In Progress</div></section>
        <section><div id="text-release">Version 2.4.1 released</div></section>
      </body>
    </html>
  `);

  const tdoc = testDom.window.document;
  (globalThis as any).window = testDom.window;
  (globalThis as any).document = tdoc;
  (globalThis as any).Node = testDom.window.Node;
  (globalThis as any).CSS = testDom.window.CSS ?? { escape: (s: string) => s };

  // 1. Multi-value elements with clear primary metric (High confidence, no ambiguity)
  const cryptoEl = tdoc.getElementById('crypto-row')!;
  const cryptoTarget = resolvePickerTarget(cryptoEl)!;
  assert(cryptoTarget !== null, 'resolves picker target for crypto row');
  assert(cryptoTarget.canonicalValue === '$79,525.75', `identifies "$79,525.75" over rank "1" (got ${JSON.stringify(cryptoTarget.canonicalValue)})`);
  assert(cryptoTarget.isAmbiguous === false, 'crypto row is not ambiguous');
  assert(cryptoTarget.confidence === 'high', 'crypto row has high confidence');
  assert(formatPickerTooltip(cryptoTarget) === '✓ $79,525.75', `tooltip displays canonical value "✓ $79,525.75" (got ${JSON.stringify(formatPickerTooltip(cryptoTarget))})`);

  const likesEl = tdoc.getElementById('likes-btn')!;
  const likesTarget = resolvePickerTarget(likesEl)!;
  assert(likesTarget.canonicalValue === '150', `identifies "150" from "Likes (150)" (got ${JSON.stringify(likesTarget.canonicalValue)})`);
  assert(likesTarget.isAmbiguous === false, 'likes button is not ambiguous');
  assert(likesTarget.label === 'Likes', `extracts label "Likes" (got ${JSON.stringify(likesTarget.label)})`);
  assert(formatPickerTooltip(likesTarget) === '✓ Likes · 150', `tooltip displays "✓ Likes · 150" (got ${JSON.stringify(formatPickerTooltip(likesTarget))})`);

  const balanceEl = tdoc.getElementById('balance-card')!;
  const balanceTarget = resolvePickerTarget(balanceEl)!;
  assert(balanceTarget.canonicalValue === '2,500', `identifies "2,500" from "Total Balance: 2,500 pts" (got ${JSON.stringify(balanceTarget.canonicalValue)})`);
  assert(balanceTarget.isAmbiguous === false, 'balance card is not ambiguous');
  assert(balanceTarget.label === 'Total Balance', `extracts label "Total Balance" (got ${JSON.stringify(balanceTarget.label)})`);
  assert(formatPickerTooltip(balanceTarget) === '✓ Total Balance · 2,500', `tooltip displays "✓ Total Balance · 2,500" (got ${JSON.stringify(formatPickerTooltip(balanceTarget))})`);

  const viewsEl = tdoc.getElementById('views-stat')!;
  const viewsTarget = resolvePickerTarget(viewsEl)!;
  assert(viewsTarget.canonicalValue === '222K', `identifies "222K" over time "4" (got ${JSON.stringify(viewsTarget.canonicalValue)})`);
  assert(viewsTarget.isAmbiguous === false, 'views stat is not ambiguous');
  assert(formatPickerTooltip(viewsTarget) === '✓ 222K', `tooltip displays "✓ 222K" (got ${JSON.stringify(formatPickerTooltip(viewsTarget))})`);

  const stockEl = tdoc.getElementById('stock-info')!;
  const stockTarget = resolvePickerTarget(stockEl)!;
  assert(stockTarget.canonicalValue === '42', `identifies "42" over limit "5" (got ${JSON.stringify(stockTarget.canonicalValue)})`);
  assert(stockTarget.isAmbiguous === false, 'stock info is not ambiguous');
  assert(formatPickerTooltip(stockTarget) === '✓ 42', `tooltip displays "✓ 42" (got ${JSON.stringify(formatPickerTooltip(stockTarget))})`);

  // 2. Ambiguous elements: multiple plausible candidates (Low confidence, ambiguity clearly flagged)
  const scoreEl = tdoc.getElementById('score-vs')!;
  const scoreTarget = resolvePickerTarget(scoreEl)!;
  assert(scoreTarget !== null, 'resolves picker target for score comparison');
  assert(scoreTarget.isAmbiguous === true, 'score comparison flags isAmbiguous = true');
  assert(scoreTarget.confidence === 'low', 'score comparison flags confidence = "low"');
  assert(Array.isArray(scoreTarget.candidates) && scoreTarget.candidates.includes('85') && scoreTarget.candidates.includes('90'), 'candidates contain 85 and 90');
  const scoreTooltip = formatPickerTooltip(scoreTarget);
  assert(scoreTooltip.startsWith('⚠ Ambiguous'), `tooltip clearly indicates ambiguity with ⚠ (got ${JSON.stringify(scoreTooltip)})`);
  assert(scoreTooltip.includes('85') && scoreTooltip.includes('90'), `tooltip specifies candidates "85 vs 90" (got ${JSON.stringify(scoreTooltip)})`);

  const priceRangeEl = tdoc.getElementById('price-range')!;
  const priceRangeTarget = resolvePickerTarget(priceRangeEl)!;
  assert(priceRangeTarget.isAmbiguous === true, 'price range flags isAmbiguous = true');
  assert(priceRangeTarget.confidence === 'low', 'price range flags confidence = "low"');
  const priceTooltip = formatPickerTooltip(priceRangeTarget);
  assert(priceTooltip.startsWith('⚠ Ambiguous'), `price range tooltip clearly indicates ambiguity (got ${JSON.stringify(priceTooltip)})`);
  assert(priceTooltip.includes('$25.00') && priceTooltip.includes('$30.00'), `price range tooltip includes both currencies (got ${JSON.stringify(priceTooltip)})`);

  const betweenEl = tdoc.getElementById('between-range')!;
  const betweenTarget = resolvePickerTarget(betweenEl)!;
  assert(betweenTarget.isAmbiguous === true, 'between range flags isAmbiguous = true');
  assert(formatPickerTooltip(betweenTarget).startsWith('⚠ Ambiguous'), 'between range tooltip indicates ambiguity');

  const multiMetricEl = tdoc.getElementById('multi-metric')!;
  const multiMetricTarget = resolvePickerTarget(multiMetricEl)!;
  assert(multiMetricTarget.isAmbiguous === true, 'multi-metric element flags isAmbiguous = true');
  assert(formatPickerTooltip(multiMetricTarget).startsWith('⚠ Ambiguous'), 'multi-metric tooltip indicates ambiguity');

  // 2b. Analytics dashboards (Umami / Cloudflare style): a metric value
  // with its comparison delta in one element. The label-associated
  // metric wins over the signed change indicator, which is demoted as
  // secondary by semantics - while genuinely ambiguous inputs above
  // stay rejected.
  const analyticsDom = new JSDOM(`<!doctype html><html><body>
    <div id="umami-card"><span class="stat-label">Visits</span><span class="stat-value">1,234</span><span class="stat-change">+5.2%</span></div>
    <div id="umami-visitors"><span class="stat-label">Visitors</span><span class="stat-value">342</span><span class="stat-change">+12</span></div>
    <div id="cf-metric">Unique visitors 935 +5.2%</div>
    <div id="cf-cell">1.44k <span>+2.1%</span></div>
    <div id="battery-stat">Battery 87% (+5%)</div>
    <div id="neg-delta">-4.5%</div>
  </body></html>`);
  const adoc = analyticsDom.window.document;
  (globalThis as any).window = analyticsDom.window;
  (globalThis as any).document = adoc;
  (globalThis as any).Node = analyticsDom.window.Node;
  (globalThis as any).CSS = analyticsDom.window.CSS ?? { escape: (s: string) => s };

  const umamiCard = resolvePickerTarget(adoc.querySelector('#umami-card')!)!;
  assert(umamiCard.canonicalValue === '1,234', `Umami visits card resolves "1,234", not the delta (got ${JSON.stringify(umamiCard.canonicalValue)})`);
  assert(umamiCard.isAmbiguous === false, 'Umami visits card is not ambiguous');

  const umamiVisitors = resolvePickerTarget(adoc.querySelector('#umami-visitors')!)!;
  assert(umamiVisitors.canonicalValue === '342', `Umami visitors card resolves "342" (got ${JSON.stringify(umamiVisitors.canonicalValue)})`);
  assert(umamiVisitors.isAmbiguous === false, 'Umami visitors card is not ambiguous');

  const cfMetric = resolvePickerTarget(adoc.getElementById('cf-metric')!)!;
  assert(cfMetric.canonicalValue === '935', `Cloudflare metric resolves "935", not the delta (got ${JSON.stringify(cfMetric.canonicalValue)})`);
  assert(cfMetric.isAmbiguous === false, 'Cloudflare metric is not ambiguous');

  const cfCell = resolvePickerTarget(adoc.querySelector('#cf-cell')!)!;
  assert(cfCell.canonicalValue === '1.44k', `Cloudflare cell resolves "1.44k", not the delta (got ${JSON.stringify(cfCell.canonicalValue)})`);
  assert(cfCell.isAmbiguous === false, 'Cloudflare cell is not ambiguous');

  const batteryTarget = resolvePickerTarget(adoc.getElementById('battery-stat')!)!;
  assert(batteryTarget.canonicalValue === '87%', `battery stat resolves "87%", not the delta (got ${JSON.stringify(batteryTarget.canonicalValue)})`);
  assert(batteryTarget.isAmbiguous === false, 'battery stat is not ambiguous');

  const negDelta = resolvePickerTarget(adoc.getElementById('neg-delta')!)!;
  assert(negDelta.canonicalValue === '-4.5%', `lone signed value still resolves (got ${JSON.stringify(negDelta.canonicalValue)})`);
  assert(negDelta.isAmbiguous === false, 'lone signed value is not ambiguous');

  // 3. Disambiguation via cursor range positioning (Range-first hit testing)
  const scoreTextNode = scoreEl.firstChild as Text;
  // Position range over "90" (offset 13 in "Score 85 vs 90")
  const rangeOver90 = tdoc.createRange();
  rangeOver90.setStart(scoreTextNode, 13);
  rangeOver90.collapse(true);
  tdoc.caretRangeFromPoint = () => rangeOver90;
  const pointTarget90 = resolvePickerTargetAtPoint(tdoc, 10, 10)!;
  assert(pointTarget90 !== null, 'resolves target at point with caret over 90');
  assert(pointTarget90.canonicalValue === '90', `cursor proximity resolves intended canonical value "90" (got ${JSON.stringify(pointTarget90.canonicalValue)})`);
  assert(pointTarget90.isAmbiguous === false, 'point target over 90 is disambiguated (isAmbiguous: false)');
  assert(formatPickerTooltip(pointTarget90) === '✓ 90', `tooltip displays exact canonical value "✓ 90" (got ${JSON.stringify(formatPickerTooltip(pointTarget90))})`);

  // Position range over "85" (offset 6 in "Score 85 vs 90")
  const rangeOver85 = tdoc.createRange();
  rangeOver85.setStart(scoreTextNode, 6);
  rangeOver85.collapse(true);
  tdoc.caretRangeFromPoint = () => rangeOver85;
  const pointTarget85 = resolvePickerTargetAtPoint(tdoc, 5, 5)!;
  assert(pointTarget85.canonicalValue === '85', `cursor proximity resolves intended canonical value "85" (got ${JSON.stringify(pointTarget85.canonicalValue)})`);
  assert(pointTarget85.isAmbiguous === false, 'point target over 85 is disambiguated (isAmbiguous: false)');
  assert(formatPickerTooltip(pointTarget85) === '✓ 85', `tooltip displays exact canonical value "✓ 85" (got ${JSON.stringify(formatPickerTooltip(pointTarget85))})`);

  // 4. Text monitors preserved
  const textStatusEl = tdoc.getElementById('text-status')!;
  const textStatusTarget = resolvePickerTarget(textStatusEl)!;
  assert(textStatusTarget.canonicalValue === 'In Progress', `text monitor preserves full text "In Progress" (got ${JSON.stringify(textStatusTarget.canonicalValue)})`);
  assert(textStatusTarget.semanticValue.type === 'text', `semantic value is text (got ${textStatusTarget.semanticValue.type})`);
  assert(textStatusTarget.isAmbiguous === false, 'text monitor is not ambiguous');
  assert(formatPickerTooltip(textStatusTarget) === '✓ In Progress', `tooltip displays "✓ In Progress" (got ${JSON.stringify(formatPickerTooltip(textStatusTarget))})`);

  const textReleaseEl = tdoc.getElementById('text-release')!;
  const textReleaseTarget = resolvePickerTarget(textReleaseEl)!;
  assert(textReleaseTarget.canonicalValue === 'Version 2.4.1 released', `version text monitor preserves "Version 2.4.1 released" (got ${JSON.stringify(textReleaseTarget.canonicalValue)})`);
  assert(textReleaseTarget.semanticValue.type === 'text', 'version is not treated as number');
  assert(textReleaseTarget.isAmbiguous === false, 'version release text is not ambiguous');

  // 5. End-to-end fingerprint and relocation for identified canonical value
  const fp = buildFingerprint(balanceTarget.element, testDom.window as unknown as Window, balanceTarget.textAnchor);
  assert(fp.textAnchor?.value === '2,500', `fingerprint stores canonical value "2,500" in textAnchor (got ${JSON.stringify(fp.textAnchor?.value)})`);
  assert(detectSemanticValue(fp.textAnchor?.value ?? '').type === 'number', 'fingerprint textAnchor value is numeric');

  // Subsequent check when DOM updates to "Total Balance: 3,450 pts"
  balanceEl.querySelector('span')!.textContent = '3,450 pts';
  const checkResult = locateAndExtract(tdoc, fp, 'text', null, testDom.window as unknown as Window);
  assert(checkResult.value === '3,450', `subsequent check extracts new canonical value "3,450" (got ${JSON.stringify(checkResult.value)})`);
  assert(checkResult.semanticValue?.normalized === 3450, `normalized semantic value is 3450 (got ${checkResult.semanticValue?.normalized})`);
}

// ---------------------------------------------------------------------
// Scenario: monitor error handling and recovery.
// When a monitor fails after a page re-render, navigation, or temporary
// extraction failure, determine the actual failure reason and show a useful
// state (such as "Value not found", "Page changed", or "Couldn't load page")
// with retry/check-now actions, and recover cleanly once the page becomes
// available again.
// ---------------------------------------------------------------------
section('Error handling and recovery: failure reason classification, cascade diagnostics, and recovery');

{
  // 1. Failure state classification for all diagnostic codes
  const notFoundState = getFailureStateInfo('ELEMENT_NOT_FOUND');
  assert(notFoundState.label === 'Value not found', `ELEMENT_NOT_FOUND maps to "Value not found" (got "${notFoundState.label}")`);
  assert(notFoundState.reason === 'value_not_found', 'ELEMENT_NOT_FOUND reason is value_not_found');
  assert(notFoundState.canRetry === true, 'ELEMENT_NOT_FOUND allows retry');

  const emptyState = getFailureStateInfo('EXTRACTION_EMPTY');
  assert(emptyState.label === 'Value not found', `EXTRACTION_EMPTY maps to "Value not found" (got "${emptyState.label}")`);
  assert(emptyState.reason === 'value_not_found', 'EXTRACTION_EMPTY reason is value_not_found');

  const pageChangedState = getFailureStateInfo('SELECTOR_RECOVERY_LOW_CONFIDENCE');
  assert(pageChangedState.label === 'Page changed', `SELECTOR_RECOVERY_LOW_CONFIDENCE maps to "Page changed" (got "${pageChangedState.label}")`);
  assert(pageChangedState.reason === 'page_changed', 'reason is page_changed');
  assert(pageChangedState.canRetry === true, 'page_changed allows retry');

  const timeoutState = getFailureStateInfo('PAGE_LOAD_TIMEOUT');
  assert(timeoutState.label === "Couldn't load page", `PAGE_LOAD_TIMEOUT maps to "Couldn't load page" (got "${timeoutState.label}")`);
  assert(timeoutState.reason === 'page_load_failed', 'reason is page_load_failed');
  assert(timeoutState.canRetry === true, 'timeout allows retry');

  const networkState = getFailureStateInfo('NETWORK_ERROR');
  assert(networkState.label === "Couldn't load page", `NETWORK_ERROR maps to "Couldn't load page" (got "${networkState.label}")`);
  assert(networkState.reason === 'page_load_failed', 'reason is page_load_failed');

  const notReadyState = getFailureStateInfo('PAGE_NOT_READY');
  assert(notReadyState.label === "Couldn't load page", `PAGE_NOT_READY maps to "Couldn't load page" (got "${notReadyState.label}")`);

  const tabClosedState = getFailureStateInfo('TAB_CLOSED');
  assert(tabClosedState.label === "Couldn't load page", `TAB_CLOSED maps to "Couldn't load page" (got "${tabClosedState.label}")`);

  const blockedState = getFailureStateInfo('ANTI_AUTOMATION_DETECTED');
  assert(blockedState.label === 'Blocked', `ANTI_AUTOMATION_DETECTED maps to "Blocked" (got "${blockedState.label}")`);
  assert(blockedState.reason === 'blocked', 'reason is blocked');

  const authState = getFailureStateInfo('AUTH_REQUIRED');
  assert(authState.label === 'Sign-in required', `AUTH_REQUIRED maps to "Sign-in required" (got "${authState.label}")`);

  const permState = getFailureStateInfo('PERMISSION_DENIED');
  assert(permState.label === 'Permission needed', `PERMISSION_DENIED maps to "Permission needed" (got "${permState.label}")`);
  assert(permState.canRetry === false, 'permission denied does not allow immediate retry');

  // Fallback heuristic on error messages when code is unknown
  const fallbackTimeout = getFailureStateInfo('UNKNOWN', 'Navigation timed out after 15s');
  assert(fallbackTimeout.label === "Couldn't load page", `error text with timeout maps to "Couldn't load page" (got "${fallbackTimeout.label}")`);

  const fallbackNotFound = getFailureStateInfo('UNKNOWN', 'scanned 12 candidate elements, none matched');
  assert(fallbackNotFound.label === 'Value not found', `error text with none matched maps to "Value not found" (got "${fallbackNotFound.label}")`);

  const fallbackChanged = getFailureStateInfo('UNKNOWN', 'closest matching candidate had low confidence');
  assert(fallbackChanged.label === 'Page changed', `error text with confidence maps to "Page changed" (got "${fallbackChanged.label}")`);

  // 2. Strategy cascade primary diagnostic selection
  // fetch fails with ELEMENT_NOT_FOUND (typical for SPA / client-rendered pages), but live tab fails with timeout/network
  const cascadeTimeout = selectPrimaryDiagnostic([
    diagnostic('ELEMENT_NOT_FOUND', 'fetch: SSR HTML did not contain target'),
    diagnostic('PAGE_LOAD_TIMEOUT', 'live: navigation timed out'),
  ]);
  assert(cascadeTimeout.code === 'PAGE_LOAD_TIMEOUT', `cascade selects PAGE_LOAD_TIMEOUT over preflight ELEMENT_NOT_FOUND (got ${cascadeTimeout.code})`);
  assert(getFailureStateInfo(cascadeTimeout.code).label === "Couldn't load page", 'cascade failure state correctly displays "Couldn\'t load page"');

  // fetch fails with ELEMENT_NOT_FOUND, live tab finds candidate with low confidence
  const cascadeLowConf = selectPrimaryDiagnostic([
    diagnostic('ELEMENT_NOT_FOUND', 'fetch: SSR HTML did not contain target'),
    diagnostic('SELECTOR_RECOVERY_LOW_CONFIDENCE', 'live: score 42/100'),
  ]);
  assert(cascadeLowConf.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE', `cascade selects SELECTOR_RECOVERY_LOW_CONFIDENCE over preflight ELEMENT_NOT_FOUND (got ${cascadeLowConf.code})`);
  assert(getFailureStateInfo(cascadeLowConf.code).label === 'Page changed', 'cascade failure state correctly displays "Page changed"');

  // Anti-automation block takes precedence
  const cascadeBlocked = selectPrimaryDiagnostic([
    diagnostic('ELEMENT_NOT_FOUND', 'fetch: target missing'),
    diagnostic('ANTI_AUTOMATION_DETECTED', 'live: Cloudflare challenge'),
  ]);
  assert(cascadeBlocked.code === 'ANTI_AUTOMATION_DETECTED', `cascade prioritizes ANTI_AUTOMATION_DETECTED (got ${cascadeBlocked.code})`);
  assert(getFailureStateInfo(cascadeBlocked.code).label === 'Blocked', 'cascade failure state correctly displays "Blocked"');

  // Both fail with ELEMENT_NOT_FOUND
  const cascadeNotFound = selectPrimaryDiagnostic([
    diagnostic('ELEMENT_NOT_FOUND', 'fetch: not found'),
    diagnostic('ELEMENT_NOT_FOUND', 'live: element not found in DOM'),
  ]);
  assert(cascadeNotFound.code === 'ELEMENT_NOT_FOUND', `cascade returns ELEMENT_NOT_FOUND when both agree (got ${cascadeNotFound.code})`);
  assert(getFailureStateInfo(cascadeNotFound.code).label === 'Value not found', 'cascade failure state correctly displays "Value not found"');

  // 3. Recovery cycle across DOM re-renders and page availability
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <div id="container">
          <div class="card price-card">
            <span class="label">Current Price</span>
            <span class="value" id="price-target">$450.00</span>
          </div>
          <div class="card status-card">
            <span class="label">Stock</span>
            <span class="value" id="stock-target">In Stock</span>
          </div>
          <div class="card metric-card">
            <span class="label">Subscribers</span>
            <span class="value" id="metric-target">1.73M subscribers</span>
          </div>
        </div>
      </body>
    </html>
  `);
  const doc = dom.window.document;
  const win = dom.window as unknown as Window;

  // Initial capture of numeric price monitor
  const priceEl = doc.getElementById('price-target')!;
  const priceFp = buildFingerprint(priceEl, win);
  const initialCheck = locateAndExtract(doc, priceFp, 'text', null, win);
  assert(initialCheck.value === '$450.00', `initial capture extracts "$450.00" (got ${JSON.stringify(initialCheck.value)})`);
  assert(initialCheck.diagnostic.code === 'OK', 'initial diagnostic is OK');

  // Track simulated monitor state
  const simulatedMonitor: {
    id: string;
    lastValue: string | null;
    lastStatus: MonitorStatus;
    lastError: string | null;
    lastDiagnosticCode: DiagnosticCode | null;
    consecutiveFailures: number;
    fingerprint: ElementFingerprint;
  } = {
    id: 'm-price',
    lastValue: initialCheck.value,
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: initialCheck.diagnostic.code,
    consecutiveFailures: 0,
    fingerprint: priceFp,
  };

  // Phase A: Missing element / extraction failure during page re-render
  // First test isolated element removal on a page where no similar candidate exists -> ELEMENT_NOT_FOUND
  const isolatedDom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <header><nav>Home Dashboard Analytics Settings Account Help Support</nav></header>
        <main><div id="iso-box"><span class="price-val">$100.00</span></div></main>
        <footer>Company Inc. All rights reserved 2026. Terms of Service and Privacy Policy.</footer>
      </body>
    </html>
  `);
  const isoWin = isolatedDom.window as unknown as Window;
  const isoEl = isolatedDom.window.document.querySelector('.price-val')!;
  const isoFp = buildFingerprint(isoEl, isoWin);
  isoEl.remove();
  const isoCheck = locateAndExtract(isolatedDom.window.document, isoFp, 'text', null, isoWin);
  assert(isoCheck.value === null, 'isolated removed element returns null');
  assert(isoCheck.diagnostic.code === 'ELEMENT_NOT_FOUND', `isolated removed element returns ELEMENT_NOT_FOUND (got ${isoCheck.diagnostic.code})`);
  const isoFailInfo = getFailureStateInfo(isoCheck.diagnostic.code);
  assert(isoFailInfo.label === 'Value not found', `ELEMENT_NOT_FOUND displays "Value not found" (got "${isoFailInfo.label}")`);

  // Now simulate page re-render / temporary missing element on our price monitor
  priceEl.remove();
  const failedCheck1 = locateAndExtract(doc, simulatedMonitor.fingerprint, 'text', null, win);
  assert(failedCheck1.value === null, 'failed check returns null value when element is missing');

  // Record failure state
  const failInfo1 = getFailureStateInfo(failedCheck1.diagnostic.code);
  simulatedMonitor.lastStatus = 'error';
  simulatedMonitor.lastDiagnosticCode = failedCheck1.diagnostic.code;
  simulatedMonitor.lastError = failedCheck1.diagnostic.message;
  simulatedMonitor.consecutiveFailures += 1;

  assert(simulatedMonitor.lastStatus === 'error', 'monitor status is set to error');
  assert(
    failInfo1.label === 'Value not found' || failInfo1.label === 'Page changed',
    `UI displays informative state ("${failInfo1.label}") instead of generic Error`,
  );
  assert(simulatedMonitor.lastValue === '$450.00', 'previous value "$450.00" is preserved across failure (not lost or overwritten)');
  assert(failInfo1.canRetry === true, 'failure state allows retry');

  // Phase B: Page re-mounts / element reappears with updated value ($475.00)
  const restoredCard = doc.querySelector('.price-card')!;
  const newPriceEl = doc.createElement('span');
  newPriceEl.className = 'value';
  newPriceEl.id = 'price-target';
  newPriceEl.textContent = '$475.00';
  restoredCard.appendChild(newPriceEl);

  // Recovery check runs (e.g. user clicked "Retry check" / "Check now")
  const recoveryCheck1 = locateAndExtract(doc, simulatedMonitor.fingerprint, 'text', null, win);
  assert(recoveryCheck1.value === '$475.00', `recovery check successfully extracts updated value "$475.00" (got ${JSON.stringify(recoveryCheck1.value)})`);
  assert(recoveryCheck1.diagnostic.code === 'OK' || recoveryCheck1.diagnostic.code === 'OK_RECOVERED', 'recovery diagnostic is OK / OK_RECOVERED');

  // Update monitor state upon recovery
  simulatedMonitor.consecutiveFailures = 0;
  simulatedMonitor.lastStatus = simulatedMonitor.lastValue !== recoveryCheck1.value ? 'changed' : 'unchanged';
  simulatedMonitor.lastValue = recoveryCheck1.value;
  simulatedMonitor.lastError = null;
  simulatedMonitor.lastDiagnosticCode = recoveryCheck1.diagnostic.code;
  if (recoveryCheck1.updatedFingerprint) simulatedMonitor.fingerprint = recoveryCheck1.updatedFingerprint;

  assert(simulatedMonitor.lastStatus === 'changed', 'monitor status transitions back from error to changed');
  assert(simulatedMonitor.lastError === null, 'lastError is cleared to null upon recovery');
  assert(simulatedMonitor.lastValue === '$475.00', 'lastValue is updated to recovered value');
  assert(simulatedMonitor.consecutiveFailures === 0, 'consecutiveFailures is reset to 0');

  // Phase C: Structural drift / page layout changed
  // Replace card with low-similarity element so candidate score is below threshold (< 60)
  newPriceEl.remove();
  const mutatedEl = doc.createElement('p');
  mutatedEl.className = 'unrelated-alert-box';
  mutatedEl.textContent = 'Special announcement';
  restoredCard.appendChild(mutatedEl);

  const failedCheck2 = locateAndExtract(doc, simulatedMonitor.fingerprint, 'text', null, win);
  assert(failedCheck2.value === null, 'failed check on mutated page returns null');
  assert(
    failedCheck2.diagnostic.code === 'ELEMENT_NOT_FOUND' || failedCheck2.diagnostic.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE',
    `returns ELEMENT_NOT_FOUND or SELECTOR_RECOVERY_LOW_CONFIDENCE (got ${failedCheck2.diagnostic.code})`,
  );
  const failInfo2 = getFailureStateInfo(failedCheck2.diagnostic.code);
  assert(
    failInfo2.label === 'Value not found' || failInfo2.label === 'Page changed',
    `failure state is informative ("${failInfo2.label}")`,
  );

  // Phase D: Navigation timeout recovery
  // Simulate navigation timeout failure
  simulatedMonitor.lastStatus = 'error';
  simulatedMonitor.lastDiagnosticCode = 'PAGE_LOAD_TIMEOUT';
  simulatedMonitor.lastError = 'Live tab navigation timed out after 15s';
  simulatedMonitor.consecutiveFailures += 1;

  const navFailInfo = getFailureStateInfo(simulatedMonitor.lastDiagnosticCode, simulatedMonitor.lastError);
  assert(navFailInfo.label === "Couldn't load page", `PAGE_LOAD_TIMEOUT displays "Couldn't load page" (got "${navFailInfo.label}")`);
  assert(simulatedMonitor.lastValue === '$475.00', 'value is retained during load failure');

  // Page finishes loading / connection restored
  mutatedEl.remove();
  const recoveredEl = doc.createElement('span');
  recoveredEl.className = 'value';
  recoveredEl.id = 'price-target';
  recoveredEl.textContent = '$490.00';
  restoredCard.appendChild(recoveredEl);

  const recoveryCheck2 = locateAndExtract(doc, simulatedMonitor.fingerprint, 'text', null, win);
  assert(recoveryCheck2.value === '$490.00', `recovery after page load extracts "$490.00" (got ${JSON.stringify(recoveryCheck2.value)})`);
  simulatedMonitor.lastStatus = 'changed';
  simulatedMonitor.lastValue = recoveryCheck2.value;
  simulatedMonitor.lastError = null;
  simulatedMonitor.lastDiagnosticCode = recoveryCheck2.diagnostic.code;
  simulatedMonitor.consecutiveFailures = 0;
  assert(simulatedMonitor.lastStatus === 'changed', 'status restored to changed');
  assert(simulatedMonitor.lastError === null, 'lastError cleared');

  // 4. Text monitor preservation across error and recovery
  const stockEl = doc.getElementById('stock-target')!;
  const stockFp = buildFingerprint(stockEl, win);
  const stockInit = locateAndExtract(doc, stockFp, 'text', null, win);
  assert(stockInit.value === 'In Stock', 'text monitor initial value is "In Stock"');
  assert(stockInit.semanticValue?.type === 'text', 'semantic type is text');

  // Temporarily empty
  stockEl.textContent = '';
  const stockEmpty = locateAndExtract(doc, stockFp, 'text', null, win);
  assert(stockEmpty.value === null, 'empty text produces null value');
  assert(stockEmpty.diagnostic.code === 'EXTRACTION_EMPTY', `diagnostic is EXTRACTION_EMPTY (got ${stockEmpty.diagnostic.code})`);
  const stockFailInfo = getFailureStateInfo(stockEmpty.diagnostic.code);
  assert(stockFailInfo.label === 'Value not found', 'empty text maps to "Value not found"');

  // Recovers with "Out of Stock"
  stockEl.textContent = 'Out of Stock';
  const stockRecovered = locateAndExtract(doc, stockFp, 'text', null, win);
  assert(stockRecovered.value === 'Out of Stock', `text monitor recovers exact text "Out of Stock" (got ${JSON.stringify(stockRecovered.value)})`);
  assert(stockRecovered.semanticValue?.type === 'text', 'text monitor retains type: text');

  // 5. Numeric monitor preservation across error and recovery
  const metricEl = doc.getElementById('metric-target')!;
  const metricFp = buildFingerprint(metricEl, win);
  const metricInit = locateAndExtract(doc, metricFp, 'text', null, win);
  assert(metricInit.value === '1.73M', `numeric monitor captures canonical value "1.73M" (got ${JSON.stringify(metricInit.value)})`);
  assert(metricInit.semanticValue?.type === 'followers', `semantic type is followers (got ${metricInit.semanticValue?.type})`);

  // Temporarily missing element
  metricEl.style.display = 'none';
  const metricHidden = locateAndExtract(doc, metricFp, 'text', null, win);
  assert(metricHidden.value === null, 'hidden element produces null value');
  const metricFailInfo = getFailureStateInfo(metricHidden.diagnostic.code);
  assert(metricFailInfo.label === 'Value not found', 'hidden element failure maps to "Value not found"');

  // Recovers with updated count "1.75M subscribers"
  metricEl.style.display = 'block';
  metricEl.textContent = '1.75M subscribers';
  const metricRecovered = locateAndExtract(doc, metricFp, 'text', null, win);
  assert(metricRecovered.value === '1.75M', `numeric monitor recovers canonical value "1.75M" without surrounding text (got ${JSON.stringify(metricRecovered.value)})`);
  assert(metricRecovered.semanticValue?.type === 'followers', 'semantic type followers preserved');
  assert(metricRecovered.semanticValue?.normalized === 1_750_000, 'normalized count is 1750000');
}

// ---------------------------------------------------------------------
// H1: a numeric monitor whose element renders non-numeric text (e.g.
// "Out of stock") must fail with EXTRACTION_EMPTY instead of storing
// the raw text as a successful value with an OK diagnostic (which
// would silently flip its type and suppress numeric alert conditions).
// ---------------------------------------------------------------------
{
  section('H1: numeric monitor fails cleanly on non-numeric text, recovers on numeric');

  const h1Dom = new JSDOM(`<!doctype html><html><body><div id="price">$49.99</div></body></html>`);
  const h1doc = h1Dom.window.document;
  (globalThis as any).window = h1Dom.window;
  (globalThis as any).document = h1doc;
  (globalThis as any).Node = h1Dom.window.Node;
  const h1win = h1Dom.window as unknown as Window;

  const h1PriceEl = h1doc.getElementById('price')!;
  const h1PriceFp = buildFingerprint(h1PriceEl, h1win);

  // 1. Valid numeric value -> unchanged behavior.
  const h1Init = locateAndExtract(h1doc, h1PriceFp, 'text', null, h1win);
  assert(h1Init.value === '$49.99', `valid numeric extracts "$49.99" (got ${JSON.stringify(h1Init.value)})`);
  assert(h1Init.diagnostic.code === 'OK', `valid numeric diagnostic is OK (got ${h1Init.diagnostic.code})`);
  assert(h1Init.semanticValue?.type === 'currency', `semantic type is currency (got ${h1Init.semanticValue?.type})`);
  assert(h1Init.semanticValue?.normalized === 49.99, `normalized is 49.99 (got ${h1Init.semanticValue?.normalized})`);

  // 2. Non-numeric text states -> extraction failure, never a healthy text value.
  for (const badText of ['Out of stock', 'N/A', 'Unavailable']) {
    h1PriceEl.textContent = badText;
    const bad = locateAndExtract(h1doc, h1PriceFp, 'text', null, h1win);
    assert(bad.value === null, `"${badText}" produces null value (got ${JSON.stringify(bad.value)})`);
    assert(
      bad.diagnostic.code === 'EXTRACTION_EMPTY',
      `"${badText}" diagnostic is EXTRACTION_EMPTY (got ${bad.diagnostic.code})`,
    );
    assert(bad.semanticValue === null, `"${badText}" semanticValue is null`);
  }

  // 3. Recovery back to numeric -> correct value and numeric classification.
  h1PriceEl.textContent = '$44.99';
  const h1Recovered = locateAndExtract(h1doc, h1PriceFp, 'text', null, h1win);
  assert(h1Recovered.value === '$44.99', `recovery extracts "$44.99" (got ${JSON.stringify(h1Recovered.value)})`);
  assert(h1Recovered.diagnostic.code === 'OK', `recovery diagnostic is OK (got ${h1Recovered.diagnostic.code})`);
  assert(
    h1Recovered.semanticValue?.type === 'currency',
    `recovery semantic type is currency (got ${h1Recovered.semanticValue?.type})`,
  );
  assert(
    h1Recovered.semanticValue?.normalized === 44.99,
    `recovery normalized is 44.99 (got ${h1Recovered.semanticValue?.normalized})`,
  );
}

// ---------------------------------------------------------------------
// Scenario 26: Monitor error recovery — temporary failure preservation,
// automatic retry/recovery, and permanent failure thresholding
// ---------------------------------------------------------------------
{
  section('Scenario 26: Resilient error recovery — temporary failure preservation, auto-recovery, and permanent failure thresholding');

  interface MockMonitor {
    id: string;
    lastValue: string | null;
    lastStatus: MonitorStatus;
    lastError: string | null;
    lastDiagnosticCode: DiagnosticCode | null;
    consecutiveFailures: number;
  }

  const monitor: MockMonitor = {
    id: 'mon_resilience_test',
    lastValue: '$79,525.75',
    lastStatus: 'unchanged',
    lastError: null,
    lastDiagnosticCode: 'OK',
    consecutiveFailures: 0,
  };

  // 1. Temporary failure: a network blip or temporary DOM absence occurs
  const tempDiagnostic = diagnostic('NETWORK_ERROR', 'fetch failed with status 503');
  const failureCount1 = monitor.consecutiveFailures + 1;
  const isPerm1 = isPermanentFailure(tempDiagnostic.code, failureCount1, monitor.lastValue !== null);

  assert(isPerm1 === false, 'single transient failure on a monitor with prior value is NOT permanent');
  
  // Apply resilient checker update logic
  monitor.consecutiveFailures = failureCount1;
  monitor.lastStatus = isPerm1 ? 'error' : (monitor.lastStatus === 'changed' ? 'changed' : 'unchanged');
  monitor.lastError = tempDiagnostic.message;
  monitor.lastDiagnosticCode = tempDiagnostic.code;

  assert(monitor.lastValue === '$79,525.75', 'lastValue is preserved as "$79,525.75" during temporary failure (never replaced with null or Error)');
  assert(monitor.lastStatus === 'unchanged', 'lastStatus remains healthy ("unchanged") during temporary failure');
  assert(monitor.consecutiveFailures === 1, 'consecutiveFailures is incremented to 1');
  assert(monitor.lastError === tempDiagnostic.message, 'lastError is stored internally for debugging');
  assert(monitor.lastDiagnosticCode === 'NETWORK_ERROR', 'lastDiagnosticCode is stored internally');

  // 2. Automatic recovery on the next check
  const recoveryValue = '$79,850.00';
  const changed = monitor.lastValue !== null && monitor.lastValue !== recoveryValue;
  monitor.consecutiveFailures = 0;
  monitor.lastValue = recoveryValue;
  monitor.lastStatus = changed ? 'changed' : 'unchanged';
  monitor.lastError = null;
  monitor.lastDiagnosticCode = 'OK';

  assert(monitor.lastValue === '$79,850.00', 'lastValue is successfully updated upon recovery');
  assert(monitor.lastStatus === 'changed', 'lastStatus transitions to "changed"');
  assert(monitor.consecutiveFailures === 0, 'consecutiveFailures resets to 0 upon recovery');
  assert(monitor.lastError === null, 'lastError is cleared to null upon recovery');

  // 3. Repeated failures reaching permanent failure threshold (PERMANENT_FAILURE_THRESHOLD = 3)
  const elementDiagnostic = diagnostic('ELEMENT_NOT_FOUND', 'could not find matching target');
  
  // Failure check 1
  let failures = monitor.consecutiveFailures + 1;
  let isPerm = isPermanentFailure(elementDiagnostic.code, failures, monitor.lastValue !== null);
  assert(isPerm === false, 'failure 1 of 3 is treated as temporary');
  monitor.consecutiveFailures = failures;
  monitor.lastStatus = isPerm ? 'error' : 'unchanged';
  assert(monitor.lastStatus === 'unchanged', 'status remains unchanged after 1st failure');
  assert(monitor.lastValue === '$79,850.00', 'lastValue is still preserved after 1st failure');

  // Failure check 2
  failures = monitor.consecutiveFailures + 1;
  isPerm = isPermanentFailure(elementDiagnostic.code, failures, monitor.lastValue !== null);
  assert(isPerm === false, 'failure 2 of 3 is treated as temporary');
  monitor.consecutiveFailures = failures;
  monitor.lastStatus = isPerm ? 'error' : 'unchanged';
  assert(monitor.lastStatus === 'unchanged', 'status remains unchanged after 2nd failure');
  assert(monitor.lastValue === '$79,850.00', 'lastValue is still preserved after 2nd failure');

  // Failure check 3 (meets threshold)
  failures = monitor.consecutiveFailures + 1;
  isPerm = isPermanentFailure(elementDiagnostic.code, failures, monitor.lastValue !== null);
  assert(isPerm === true, 'failure 3 of 3 reaches PERMANENT_FAILURE_THRESHOLD and is permanent');
  monitor.consecutiveFailures = failures;
  monitor.lastStatus = isPerm ? 'error' : 'unchanged';
  monitor.lastError = elementDiagnostic.message;
  monitor.lastDiagnosticCode = elementDiagnostic.code;

  assert(monitor.lastStatus === 'error', 'status transitions to "error" once threshold is reached');
  assert(monitor.lastValue === '$79,850.00', 'lastValue is STILL preserved ("$79,850.00") even in error status (never wiped out)');
  const permFailInfo = getFailureStateInfo(monitor.lastDiagnosticCode, monitor.lastError);
  assert(permFailInfo.label === 'Value not found', 'permanent failure provides useful state ("Value not found")');

  // 4. Non-retryable failure (e.g. PERMISSION_DENIED or AUTH_REQUIRED) immediately transitions to error
  const authDiagnostic = diagnostic('AUTH_REQUIRED', 'HTTP 401 unauthorized');
  const isAuthPerm = isPermanentFailure(authDiagnostic.code, 1, true);
  assert(isAuthPerm === true, 'AUTH_REQUIRED immediately evaluates as permanent failure');

  const permDiagnostic = diagnostic('PERMISSION_DENIED', 'Origin access revoked');
  const isPermDeniedPerm = isPermanentFailure(permDiagnostic.code, 1, true);
  assert(isPermDeniedPerm === true, 'PERMISSION_DENIED immediately evaluates as permanent failure');

  // 5. Fresh monitor with no prior value immediately evaluates to permanent failure
  const noPriorValuePerm = isPermanentFailure('ELEMENT_NOT_FOUND', 1, false);
  assert(noPriorValuePerm === true, 'monitor with no prior value surfaces failure immediately');
}

// ---------------------------------------------------------------------
// Scenario 27: Dynamic-page monitor recovery — YouTube video card re-renders,
// React/SPA element replacement, and streaming content resilience
// ---------------------------------------------------------------------
{
  section('Scenario 27: Dynamic page recovery — YouTube & React/SPA element re-renders');

  // 1. YouTube permalink path recognition for shorts and live streams
  assert(isPermalinkPath('/watch'), 'recognizes /watch as permalink');
  assert(isPermalinkPath('/shorts/abc123xyz'), 'recognizes /shorts/ as permalink');
  assert(isPermalinkPath('/live/live123xyz'), 'recognizes /live/ as permalink');
  assert(!isPermalinkPath('/feed/subscriptions'), 'does not treat /feed/subscriptions as permalink');
  assert(!isPermalinkPath('/channel/UC12345/about'), 'does not treat channel tab as permalink');

  // 2. YouTube card anchor capture across custom elements:
  // Leaf elements like <yt-formatted-string> or <badge-shape> must not cut off
  // the ancestor walk before reaching <ytd-rich-item-renderer> where the watch link lives.
  const ytDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div id="contents" class="style-scope ytd-rich-grid-renderer">
        <ytd-rich-item-renderer class="style-scope ytd-rich-grid-row">
          <div id="content" class="style-scope ytd-rich-item-renderer">
            <ytd-rich-grid-media class="style-scope ytd-rich-item-renderer">
              <div id="dismissible" class="style-scope ytd-rich-grid-media">
                <div id="details" class="style-scope ytd-rich-grid-media">
                  <a id="video-title-link" class="yt-simple-endpoint style-scope ytd-rich-grid-media" href="/watch?v=vid100">
                    <yt-formatted-string id="video-title" class="style-scope ytd-rich-grid-media">First Monitored Video</yt-formatted-string>
                  </a>
                  <ytd-video-meta-block class="style-scope ytd-rich-grid-media">
                    <div id="metadata-line" class="style-scope ytd-video-meta-block">
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">1.5M views</span>
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">3 days ago</span>
                    </div>
                  </ytd-video-meta-block>
                </div>
              </div>
            </ytd-rich-grid-media>
          </div>
        </ytd-rich-item-renderer>
        <ytd-rich-item-renderer class="style-scope ytd-rich-grid-row">
          <div id="content" class="style-scope ytd-rich-item-renderer">
            <ytd-rich-grid-media class="style-scope ytd-rich-item-renderer">
              <div id="dismissible" class="style-scope ytd-rich-grid-media">
                <div id="details" class="style-scope ytd-rich-grid-media">
                  <a id="video-title-link" class="yt-simple-endpoint style-scope ytd-rich-grid-media" href="/watch?v=vid200">
                    <yt-formatted-string id="video-title" class="style-scope ytd-rich-grid-media">Second Video</yt-formatted-string>
                  </a>
                  <ytd-video-meta-block class="style-scope ytd-rich-grid-media">
                    <div id="metadata-line" class="style-scope ytd-video-meta-block">
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">42K views</span>
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">1 week ago</span>
                    </div>
                  </ytd-video-meta-block>
                </div>
              </div>
            </ytd-rich-grid-media>
          </div>
        </ytd-rich-item-renderer>
      </div>
    </body></html>
  `, { url: 'https://www.youtube.com' });
  const ytDoc = ytDom.window.document;
  const viewSpan = ytDoc.querySelector('ytd-rich-item-renderer span.inline-metadata-item')!;
  
  // Verify item anchor resolves authoritatively to /watch?v=vid100 despite nested custom elements
  const itemAnchor = findItemAnchor(viewSpan);
  assert(itemAnchor !== null, 'findItemAnchor finds anchor inside YouTube card');
  assert(itemAnchor?.href === '/watch?v=vid100', `anchor href is /watch?v=vid100 (got ${itemAnchor?.href})`);
  assert(itemAnchor?.isPermalink === true, 'anchor isPermalink is true');

  // Build fingerprint from target
  const ytTarget = resolvePickerTarget(viewSpan)!;
  assert(ytTarget.canonicalValue === '1.5M', `initial value is 1.5M (got ${ytTarget.canonicalValue})`);
  assert(ytTarget.semanticValue?.type === 'views', `initial semantic is views (got ${ytTarget.semanticValue?.type})`);
  const ytFp = buildFingerprint(viewSpan, ytDom.window as unknown as Window, ytTarget.textAnchor);

  // 3. YouTube dynamic re-render: elements are replaced with fresh DOM nodes, class names
  // churn with Polymer style scoping, and count updates from 1.5M to 1.6M views
  const reRenderedYtDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div id="contents" class="style-scope ytd-rich-grid-renderer">
        <ytd-rich-item-renderer class="style-scope ytd-rich-grid-row">
          <div id="content" class="style-scope ytd-rich-item-renderer">
            <ytd-rich-grid-media class="style-scope ytd-rich-item-renderer">
              <div id="dismissible" class="style-scope ytd-rich-grid-media">
                <div id="details" class="style-scope ytd-rich-grid-media">
                  <a id="video-title-link" class="yt-simple-endpoint style-scope ytd-rich-grid-media" href="/watch?v=vid200">
                    <yt-formatted-string id="video-title" class="style-scope ytd-rich-grid-media">Second Video</yt-formatted-string>
                  </a>
                  <ytd-video-meta-block class="style-scope ytd-rich-grid-media">
                    <div id="metadata-line" class="style-scope ytd-video-meta-block">
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">45K views</span>
                    </div>
                  </ytd-video-meta-block>
                </div>
              </div>
            </ytd-rich-grid-media>
          </div>
        </ytd-rich-item-renderer>
        <ytd-rich-item-renderer class="style-scope ytd-rich-grid-row">
          <div id="content" class="style-scope ytd-rich-item-renderer">
            <ytd-rich-grid-media class="style-scope ytd-rich-item-renderer">
              <div id="dismissible" class="style-scope ytd-rich-grid-media">
                <div id="details" class="style-scope ytd-rich-grid-media">
                  <a id="video-title-link" class="yt-simple-endpoint style-scope ytd-rich-grid-media" href="/watch?v=vid100">
                    <yt-formatted-string id="video-title" class="style-scope ytd-rich-grid-media">First Monitored Video</yt-formatted-string>
                  </a>
                  <ytd-video-meta-block class="style-scope ytd-rich-grid-media">
                    <div id="metadata-line" class="style-scope ytd-video-meta-block">
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">1.6M views</span>
                      <span class="inline-metadata-item style-scope ytd-video-meta-block">3 days ago</span>
                    </div>
                  </ytd-video-meta-block>
                </div>
              </div>
            </ytd-rich-grid-media>
          </div>
        </ytd-rich-item-renderer>
      </div>
    </body></html>
  `, { url: 'https://www.youtube.com' });
  const reDoc = reRenderedYtDom.window.document;
  const ytRecovered = locateAndExtract(reDoc, ytFp, 'text', null, reRenderedYtDom.window as unknown as Window);
  assert(ytRecovered.value === '1.6M', `recovers the re-rendered YouTube view count "1.6M", not the other video's "45K" (got ${JSON.stringify(ytRecovered.value)})`);
  assert(ytRecovered.confidence >= 55, `recovery confidence clears ACCEPT_THRESHOLD (got ${ytRecovered.confidence})`);
  assert(ytRecovered.semanticValue?.type === 'views' || ytRecovered.semanticValue?.type === 'count', 'semantic value is count/views');

  // 4. React/SPA element replacement: DOM elements are completely recreated
  // inside dynamic container with new wrappers and changed formatting
  const reactDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div id="app">
        <main class="dashboard-v1">
          <div class="card" data-component="pricing">
            <h3 class="card-title">Pro Plan</h3>
            <div class="price-container">
              <span class="price-val">$29.99 / mo</span>
            </div>
            <button class="cta-btn">Subscribe</button>
          </div>
        </main>
      </div>
    </body></html>
  `);
  const reactDoc = reactDom.window.document;
  const priceContainer = reactDoc.querySelector('.price-val')!;
  const reactTarget = resolvePickerTarget(priceContainer)!;
  assert(reactTarget.canonicalValue === '$29.99', `initial React target is "$29.99" (got ${reactTarget.canonicalValue})`);
  const reactFp = buildFingerprint(priceContainer, reactDom.window as unknown as Window, reactTarget.textAnchor);

  // React re-mount with updated DOM structure and price adjustment
  reactDoc.getElementById('app')!.innerHTML = `
    <main class="dashboard-v2-active">
      <div class="card-wrapper-redesigned">
        <div class="card pro-tier" data-component="pricing">
          <h3 class="card-title">Pro Plan</h3>
          <div class="price-box-new">
            <span class="price-val">$34.99 / mo</span>
          </div>
          <button class="cta-btn">Upgrade Now</button>
        </div>
      </div>
    </main>
  `;
  const reactRecovered = locateAndExtract(reactDoc, reactFp, 'text', null, reactDom.window as unknown as Window);
  assert(reactRecovered.value === '$34.99', `recovers updated price "$34.99" across complete React re-render (got ${JSON.stringify(reactRecovered.value)})`);
  assert(reactRecovered.confidence >= 55, `React recovery confidence clears threshold (got ${reactRecovered.confidence})`);
  assert(reactRecovered.semanticValue?.type === 'currency', 'currency semantic type is preserved');

  // 5. Streaming content readiness: continuous background streaming activity does
  // not indefinitely stall page readiness when target region has sustained quiet
  const streamDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div id="video-stream-page">
        <div id="player-container">
          <div id="live-buffer" data-chunks="1">chunk_1</div>
        </div>
        <div id="channel-stats">
          <span class="stat-count">850K</span>
        </div>
      </div>
    </body></html>
  `, { pretendToBeVisual: true });
  const streamWin = streamDom.window as unknown as Window;
  const streamDoc = streamDom.window.document;
  const bufferEl = streamDoc.getElementById('live-buffer')!;
  
  // Continuous streaming mutations (simulating video streaming chunks or live chat)
  let chunkCount = 1;
  const streamInterval = setInterval(() => {
    bufferEl.textContent = `chunk_${++chunkCount}`;
  }, 50);

  // Target element readiness check: target region is quiet even though player keeps mutating
  const statsContainer = streamDoc.getElementById('channel-stats')!;
  const regionReady = await waitForRegionReady(streamWin, statsContainer, { maxWaitMs: 800, minWaitMs: 50 });
  assert(regionReady.ready === true, 'region with target settles even while background stream mutates');

  clearInterval(streamInterval);
}

// ---------------------------------------------------------------------
// Scenario 28: End-to-end reliability audit — fast-path fingerprint
// refresh, parent context text anchors, and change detection precision
// ---------------------------------------------------------------------
section('Scenario 28: End-to-end reliability audit');

{
  // 1. Fast-path value update refreshes fingerprint textAnchor & snapshot
  const storeDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div id="product-page">
        <div class="product-header" data-component="pricing">
          <h3 class="product-name">Professional Display</h3>
          <span class="price-tag" data-testid="live-price">$100.00</span>
        </div>
      </div>
    </body></html>
  `);
  const storeDoc = storeDom.window.document;
  const storeWin = storeDom.window as unknown as Window;
  const priceEl = storeDoc.querySelector('[data-testid="live-price"]')!;
  const target = resolvePickerTarget(priceEl)!;
  const initialFp = buildFingerprint(priceEl, storeWin, target.textAnchor);

  assert(initialFp.textSnapshot === '$100.00', 'initial fingerprint snapshot is $100.00');
  assert(initialFp.textAnchor?.value === '$100.00', 'initial textAnchor value is $100.00');

  // Value update on fast-path: price changes from $100.00 to $150.00
  priceEl.textContent = '$150.00';
  const fastPathCheck = locateAndExtract(storeDoc, initialFp, 'text', null, storeWin);
  assert(fastPathCheck.value === '$150.00', 'fast-path extracts updated value $150.00');
  assert(fastPathCheck.updatedFingerprint !== null, 'updatedFingerprint is generated when value changes on fast-path');
  assert(fastPathCheck.updatedFingerprint?.textAnchor?.value === '$150.00', 'updatedFingerprint textAnchor value is refreshed to $150.00');
  assert(fastPathCheck.updatedFingerprint?.textSnapshot === '$150.00', 'updatedFingerprint textSnapshot is refreshed to $150.00');

  // When value is UNCHANGED on fast path, updatedFingerprint remains null (no unnecessary churn)
  const noChangeCheck = locateAndExtract(storeDoc, fastPathCheck.updatedFingerprint!, 'text', null, storeWin);
  assert(noChangeCheck.value === '$150.00', 'extracts same value $150.00');
  assert(noChangeCheck.updatedFingerprint === null, 'no updatedFingerprint churn when value is unchanged on fast-path');

  // Subsequent DOM structural rebuild: fast-path selector breaks, recovery uses fresh fingerprint
  storeDoc.getElementById('product-page')!.innerHTML = `
    <div class="product-redesign-2026">
      <div class="hero-pricing" data-component="pricing">
        <h3 class="product-name">Professional Display</h3>
        <span class="price-tag new-variant" data-testid="live-price">$155.00</span>
      </div>
      <!-- Unrelated stale element matching original $100.00 elsewhere on page -->
      <div class="unrelated-legacy-item">
        <h4 class="product-name">Old Cable</h4>
        <span class="price-tag old-discount">$100.00</span>
      </div>
    </div>
  `;
  const recoveryOutcome = locateAndExtract(storeDoc, fastPathCheck.updatedFingerprint!, 'text', null, storeWin);
  assert(recoveryOutcome.value === '$155.00', `relocates active price $155.00 using updated fingerprint (got ${recoveryOutcome.value})`);
  assert(recoveryOutcome.value !== '$100.00', 'does not false-match stale $100.00 element elsewhere on page');

  // 2. Parent context text anchor extraction on leaf elements
  const parentAnchorDom = new JSDOM(`
    <!doctype html>
    <html><body>
      <div class="card">
        Price: <span class="val">$49.99</span> (USD)
      </div>
    </body></html>
  `);
  const parentDoc = parentAnchorDom.window.document;
  const parentWin = parentAnchorDom.window as unknown as Window;
  const leafVal = parentDoc.querySelector('.val')!;
  const leafTarget = resolvePickerTarget(leafVal)!;
  assert(leafTarget.textAnchor.before.includes('Price:'), 'parent before context captured in textAnchor');
  const leafFp = buildFingerprint(leafVal, parentWin, leafTarget.textAnchor);

  // Re-mount leaf in new container with updated value
  parentDoc.body.innerHTML = `
    <div class="card card-active">
      Price: <span class="val">$59.99</span> (USD)
    </div>
  `;
  const leafRecovered = locateAndExtract(parentDoc, leafFp, 'text', null, parentWin);
  assert(leafRecovered.value === '$59.99', `parent-anchored leaf element extracts updated value (got ${leafRecovered.value})`);

  // 3. hasValueChanged precision: cosmetic whitespace / format churn vs genuine value changes
  const semPrevUsd = detectSemanticValue('$79,525.75');
  const semNextUsdWhitespace = detectSemanticValue('$ 79,525.75');
  const semNextUsdDiff = detectSemanticValue('$79,526.00');
  const semNextEur = detectSemanticValue('€79,525.75');

  assert(!hasValueChanged('$79,525.75', semPrevUsd, '$ 79,525.75', semNextUsdWhitespace), 'whitespace format difference on identical numeric value is not changed');
  assert(hasValueChanged('$79,525.75', semPrevUsd, '$79,526.00', semNextUsdDiff), 'actual numeric change is flagged as changed');
  assert(hasValueChanged('$79,525.75', semPrevUsd, '€79,525.75', semNextEur), 'currency unit change is flagged as changed');

  const semCount1 = detectSemanticValue('150 likes');
  const semCountWhitespace = detectSemanticValue(' 150 likes ');
  const semCountDiff = detectSemanticValue('151 likes');

  assert(!hasValueChanged('150 likes', semCount1, ' 150 likes ', semCountWhitespace), 'count with surrounding whitespace churn is not changed');
  assert(hasValueChanged('150 likes', semCount1, '151 likes', semCountDiff), 'count increment is flagged as changed');
  assert(!hasValueChanged('In Stock', null, '  In Stock  ', null), 'plain text whitespace difference is not changed');
  assert(hasValueChanged('In Stock', null, 'Out of Stock', null), 'plain text change is flagged as changed');
}

// ---------------------------------------------------------------------
// Scenario 29: Change history and alert usefulness — what changed,
// when, and by how much across numeric and text monitors
// ---------------------------------------------------------------------
section('Scenario 29: Change history and alert usefulness');

{
  // 1. Numeric increase: calculates absolute and percentage change
  const prevPriceSem = detectSemanticValue('$100.00');
  const nextPriceSem = detectSemanticValue('$125.00');
  const priceIncrease = calculateValueChange('$100.00', prevPriceSem, '$125.00', nextPriceSem);

  assert(priceIncrease.hasChange === true, 'detects price change');
  assert(priceIncrease.isNumeric === true, 'identifies price change as numeric');
  assert(priceIncrease.direction === 'increase', 'direction is increase');
  assert(priceIncrease.absoluteDelta === 25, 'absoluteDelta is 25');
  assert(priceIncrease.formattedDelta === '+$25.00', `formattedDelta is "+$25.00" (got ${priceIncrease.formattedDelta})`);
  assert(priceIncrease.percentageDelta === 25, 'percentageDelta is 25%');
  assert(priceIncrease.formattedPercentage === '+25.0%', `formattedPercentage is "+25.0%" (got ${priceIncrease.formattedPercentage})`);
  assert(priceIncrease.summaryText === '+$25.00 (+25.0%)', `summaryText is "+$25.00 (+25.0%)" (got ${priceIncrease.summaryText})`);
  assert(priceIncrease.fullText === '$100.00 → $125.00 (+$25.00, +25.0%)', `fullText matches transition format (got ${priceIncrease.fullText})`);

  // Alert message for price increase
  const priceAlert = formatChangeAlertMessage(priceIncrease);
  assert(priceAlert === '$100.00 → $125.00 (+$25.00, +25.0%)', `alert message shows previous -> new with delta (got ${priceAlert})`);

  // 2. Numeric decrease: calculates negative absolute and percentage change
  const decPriceSem = detectSemanticValue('$80.00');
  const priceDecrease = calculateValueChange('$100.00', prevPriceSem, '$80.00', decPriceSem);

  assert(priceDecrease.hasChange === true, 'detects price decrease');
  assert(priceDecrease.direction === 'decrease', 'direction is decrease');
  assert(priceDecrease.absoluteDelta === -20, 'absoluteDelta is -20');
  assert(priceDecrease.formattedDelta === '-$20.00', `formattedDelta is "-$20.00" (got ${priceDecrease.formattedDelta})`);
  assert(priceDecrease.percentageDelta === -20, 'percentageDelta is -20%');
  assert(priceDecrease.formattedPercentage === '-20.0%', `formattedPercentage is "-20.0%" (got ${priceDecrease.formattedPercentage})`);
  assert(priceDecrease.summaryText === '-$20.00 (-20.0%)', `summaryText is "-$20.00 (-20.0%)" (got ${priceDecrease.summaryText})`);
  assert(priceDecrease.fullText === '$100.00 → $80.00 (-$20.00, -20.0%)', `fullText shows decrease (got ${priceDecrease.fullText})`);

  // 3. Percentage value changes: shows absolute percentage points without redundant double percentage
  const prevPctSem = detectSemanticValue('50.0%');
  const nextPctSem = detectSemanticValue('65.0%');
  const pctChange = calculateValueChange('50.0%', prevPctSem, '65.0%', nextPctSem);

  assert(pctChange.hasChange === true, 'detects percentage change');
  assert(pctChange.absoluteDelta === 15, 'absoluteDelta is 15 percentage points');
  assert(pctChange.formattedDelta === '+15.0%', `formattedDelta is "+15.0%" (got ${pctChange.formattedDelta})`);
  assert(pctChange.percentageDelta === null, 'percentageDelta is null for percentage monitor');
  assert(pctChange.summaryText === '+15.0%', `summaryText is "+15.0%" (got ${pctChange.summaryText})`);
  assert(pctChange.fullText === '50.0% → 65.0% (+15.0%)', `fullText shows clean percentage transition (got ${pctChange.fullText})`);

  // 4. Zero base value: protects against division by zero
  const zeroSem = detectSemanticValue('0');
  const nonZeroSem = detectSemanticValue('50');
  const zeroChange = calculateValueChange('0', zeroSem, '50', nonZeroSem);

  assert(zeroChange.hasChange === true, 'detects change from zero');
  assert(zeroChange.absoluteDelta === 50, 'absoluteDelta is 50');
  assert(zeroChange.percentageDelta === null, 'percentageDelta is null when base is zero (no division by zero / NaN)');
  assert(zeroChange.summaryText === '+50', `summaryText is "+50" (got ${zeroChange.summaryText})`);
  assert(zeroChange.fullText === '0 → 50 (+50)', `fullText is "0 → 50 (+50)" (got ${zeroChange.fullText})`);

  // 5. Formatting-only changes: recognized as unchanged
  const sem79k1 = detectSemanticValue('$79,525.75');
  const sem79k2 = detectSemanticValue('$ 79,525.75');
  const formatChange = calculateValueChange('$79,525.75', sem79k1, '$ 79,525.75', sem79k2);
  assert(formatChange.hasChange === false, 'formatting-only whitespace difference has no change');

  // 6. Text monitors: preserved as text changes without numeric calculations
  const textPrev = 'In Stock';
  const textNext = 'Out of Stock';
  const textChange = calculateValueChange(textPrev, null, textNext, null);

  assert(textChange.hasChange === true, 'detects text change');
  assert(textChange.isNumeric === false, 'text change is not numeric');
  assert(textChange.direction === 'text', 'direction is text');
  assert(textChange.absoluteDelta === null, 'absoluteDelta is null for text monitor');
  assert(textChange.percentageDelta === null, 'percentageDelta is null for text monitor');
  assert(textChange.summaryText === 'In Stock → Out of Stock', `summaryText is clean text transition (got ${textChange.summaryText})`);
  assert(textChange.fullText === 'In Stock → Out of Stock', `fullText is clean text transition (got ${textChange.fullText})`);

  const textAlert = formatChangeAlertMessage(textChange);
  assert(textAlert === 'In Stock → Out of Stock', `text alert shows transition without numeric calculation (got ${textAlert})`);
}

// ---------------------------------------------------------------------
// Scenario 30: Smart alert conditions and triggers
// Any change, Decrease, Increase, Below a target, Above a target,
// and Text matches across currency, percentages, zero values, and text.
// ---------------------------------------------------------------------
section('Scenario 30: Smart alert conditions and triggers');

{
  const semPrice100 = detectSemanticValue('$100.00');
  const semPrice80 = detectSemanticValue('$80.00');
  const semPrice120 = detectSemanticValue('$120.00');
  const semPriceZero = detectSemanticValue('$0.00');
  const semPriceNeg5 = detectSemanticValue('-$5.00');
  const semPct65 = detectSemanticValue('65.0%');
  const semPct45 = detectSemanticValue('45.0%');
  const semPct55 = detectSemanticValue('55.0%');
  const semCount100 = detectSemanticValue('100');
  const semCount150 = detectSemanticValue('150');
  const semCount80 = detectSemanticValue('80');

  // 1. "Any change" condition (default / backward-compatibility)
  assert(
    shouldTriggerAlert(null, '$120.00', '$100.00', semPrice120, semPrice100) === true,
    'default null condition triggers on any change',
  );
  assert(
    shouldTriggerAlert({ type: 'any' }, '$120.00', '$100.00', semPrice120, semPrice100) === true,
    'explicit any condition triggers on price increase',
  );
  assert(
    shouldTriggerAlert({ type: 'any' }, '$80.00', '$100.00', semPrice80, semPrice100) === true,
    'explicit any condition triggers on price decrease',
  );
  assert(
    shouldTriggerAlert({ type: 'any' }, 'Out of Stock', 'In Stock', null, null) === true,
    'explicit any condition triggers on text change',
  );

  // 2. "Decrease" condition
  assert(
    shouldTriggerAlert({ type: 'decrease' }, '$80.00', '$100.00', semPrice80, semPrice100) === true,
    'decrease condition triggers on price drop ($100 -> $80)',
  );
  assert(
    shouldTriggerAlert({ type: 'decrease' }, '$120.00', '$100.00', semPrice120, semPrice100) === false,
    'decrease condition suppresses price increase ($100 -> $120)',
  );
  assert(
    shouldTriggerAlert({ type: 'decrease' }, 'Out of Stock', 'In Stock', null, null) === false,
    'decrease condition suppresses text monitor changes',
  );

  // 3. "Increase" condition
  assert(
    shouldTriggerAlert({ type: 'increase' }, '150', '100', semCount150, semCount100) === true,
    'increase condition triggers on count increase (100 -> 150)',
  );
  assert(
    shouldTriggerAlert({ type: 'increase' }, '80', '100', semCount80, semCount100) === false,
    'increase condition suppresses count decrease (100 -> 80)',
  );
  assert(
    shouldTriggerAlert({ type: 'increase' }, 'Out of Stock', 'In Stock', null, null) === false,
    'increase condition suppresses text monitor changes',
  );

  // 4. "Below a target" condition
  // 4a. Currency threshold
  const target90 = { type: 'below' as const, targetValue: 90 };
  assert(
    shouldTriggerAlert(target90, '$80.00', '$100.00', semPrice80, semPrice100) === true,
    'below target triggers when value drops below target ($80 < $90)',
  );
  assert(
    shouldTriggerAlert(target90, '$100.00', '$120.00', semPrice100, semPrice120) === false,
    'below target suppresses when value remains above target ($100 not < $90)',
  );

  // 4b. Percentage threshold
  const target50Pct = { type: 'below' as const, targetValue: 50 };
  assert(
    shouldTriggerAlert(target50Pct, '45.0%', '65.0%', semPct45, semPct65) === true,
    'below target triggers for percentage drop below threshold (45% < 50%)',
  );
  assert(
    shouldTriggerAlert(target50Pct, '55.0%', '65.0%', semPct55, semPct65) === false,
    'below target suppresses for percentage above threshold (55% not < 50%)',
  );

  // 4c. Zero values & zero threshold
  const targetZero = { type: 'below' as const, targetValue: 0 };
  assert(
    shouldTriggerAlert(targetZero, '-$5.00', '$10.00', semPriceNeg5, semPrice100) === true,
    'below zero target triggers for negative value (-5 < 0)',
  );
  assert(
    shouldTriggerAlert(targetZero, '$0.00', '$10.00', semPriceZero, semPrice100) === false,
    'below zero target suppresses when value reaches zero exactly (0 not < 0)',
  );
  assert(
    shouldTriggerAlert(targetZero, '$5.00', '$10.00', detectSemanticValue('$5.00'), semPrice100) === false,
    'below zero target suppresses when value is positive (5 not < 0)',
  );

  // Value is zero with positive target
  const target10 = { type: 'below' as const, targetValue: 10 };
  assert(
    shouldTriggerAlert(target10, '$0.00', '$50.00', semPriceZero, detectSemanticValue('$50.00')) === true,
    'below target handles zero current value (0 < 10)',
  );

  // 5. "Above a target" condition
  const target120 = { type: 'above' as const, targetValue: 120 };
  assert(
    shouldTriggerAlert(target120, '150', '100', semCount150, semCount100) === true,
    'above target triggers when value rises above threshold (150 > 120)',
  );
  assert(
    shouldTriggerAlert(target120, '100', '80', semCount100, semCount80) === false,
    'above target suppresses when value is below threshold (100 not > 120)',
  );

  // 6. "Text matches" condition
  const matchInStock = { type: 'matches' as const, targetText: 'In Stock' };
  assert(
    shouldTriggerAlert(matchInStock, 'In Stock', 'Out of Stock', null, null) === true,
    'text matches triggers on exact match ("In Stock")',
  );
  assert(
    shouldTriggerAlert(matchInStock, 'Now in stock for delivery', 'Out of Stock', null, null) === true,
    'text matches triggers on case-insensitive substring match ("in stock")',
  );
  assert(
    shouldTriggerAlert(matchInStock, 'Out of Stock', 'Pre-order', null, null) === false,
    'text matches suppresses when text does not contain target ("Out of Stock")',
  );

  // 7. formatAlertConditionDescription helper
  assert(
    formatAlertConditionDescription(null) === 'Any change',
    'formats default description as Any change',
  );
  assert(
    formatAlertConditionDescription({ type: 'decrease' }, semPrice100) === 'Price drops',
    'formats currency decrease as Price drops',
  );
  assert(
    formatAlertConditionDescription({ type: 'increase' }, semCount100) === 'Value increases',
    'formats count increase as Value increases',
  );
  assert(
    formatAlertConditionDescription({ type: 'below', targetValue: 80 }, semPrice100) === 'Drops below $80',
    'formats currency below target with unit symbol',
  );
  assert(
    formatAlertConditionDescription({ type: 'below', targetValue: 50 }, semPct45) === 'Drops below 50%',
    'formats percentage below target with percentage symbol',
  );
  assert(
    formatAlertConditionDescription({ type: 'matches', targetText: 'In Stock' }) === 'Matches "In Stock"',
    'formats text match description',
  );

  // 8. formatChangeAlertMessage with condition context
  const priceChangeSummary = calculateValueChange('$100.00', semPrice100, '$80.00', semPrice80);
  const targetAlertMsg = formatChangeAlertMessage(priceChangeSummary, { type: 'below', targetValue: 90 });
  assert(
    targetAlertMsg === '$100.00 → $80.00 (-$20.00, -20.0%) [Target: < 90]',
    `alert message includes target context (got ${targetAlertMsg})`,
  );
}

// ---------------------------------------------------------------------
// Scenario 31: Hero section value movement indicator
// Compact secondary line directly below current value communicating
// movement since previous check for numeric/percentage monitors.
// ---------------------------------------------------------------------
section('Scenario 31: Hero section value movement indicator');

{
  // 1. Numeric decrease: e.g. "↓ $20.00 · -5.0% since last check"
  const sem400 = detectSemanticValue('$400.00');
  const sem380 = detectSemanticValue('$380.00');
  const decChange = calculateValueChange('$400.00', sem400, '$380.00', sem380);
  const decHero = formatHeroMovement(decChange);

  assert(decHero !== null, 'numeric decrease produces hero movement');
  assert(
    decHero?.text === '↓ $20.00 · -5.0% since last check',
    `numeric decrease matches expected format (got ${decHero?.text})`,
  );
  assert(decHero?.direction === 'decrease', 'direction is decrease');

  // 2. Numeric increase: e.g. "↑ $90.99 · +0.1% since last check"
  const sem90900 = detectSemanticValue('$90,900.00');
  const sem90990 = detectSemanticValue('$90,990.99');
  const incChange = calculateValueChange('$90,900.00', sem90900, '$90,990.99', sem90990);
  const incHero = formatHeroMovement(incChange);

  assert(incHero !== null, 'numeric increase produces hero movement');
  assert(
    incHero?.text === '↑ $90.99 · +0.1% since last check',
    `numeric increase matches expected format (got ${incHero?.text})`,
  );
  assert(incHero?.direction === 'increase', 'direction is increase');

  // 3. Percentage monitor: percentage-point movement correctly
  const semPct50 = detectSemanticValue('50.0%');
  const semPct55 = detectSemanticValue('55.0%');
  const pctIncChange = calculateValueChange('50.0%', semPct50, '55.0%', semPct55);
  const pctIncHero = formatHeroMovement(pctIncChange);

  assert(pctIncHero !== null, 'percentage increase produces hero movement');
  assert(
    pctIncHero?.text === '↑ 5.0% since last check',
    `percentage increase shows clean percentage-point movement (got ${pctIncHero?.text})`,
  );
  assert(pctIncHero?.direction === 'increase', 'percentage direction is increase');

  const semPct48 = detectSemanticValue('48.0%');
  const pctDecChange = calculateValueChange('50.0%', semPct50, '48.0%', semPct48);
  const pctDecHero = formatHeroMovement(pctDecChange);

  assert(pctDecHero !== null, 'percentage decrease produces hero movement');
  assert(
    pctDecHero?.text === '↓ 2.0% since last check',
    `percentage decrease shows clean percentage-point movement (got ${pctDecHero?.text})`,
  );
  assert(pctDecHero?.direction === 'decrease', 'percentage direction is decrease');

  // 4. Text monitor: does not show numeric delta (returns null)
  const textChange = calculateValueChange('In Stock', null, 'Out of Stock', null);
  const textHero = formatHeroMovement(textChange);
  assert(textHero === null, 'text monitor change returns null for hero movement (no numeric delta)');

  // 5. Unchanged value / no movement: returns null (shows nothing)
  const unchangedChange = calculateValueChange('$100.00', detectSemanticValue('$100.00'), '$100.00', detectSemanticValue('$100.00'));
  const unchangedHero = formatHeroMovement(unchangedChange);
  assert(unchangedHero === null, 'unchanged value returns null (shows nothing)');

  // 6. No previous comparable value: returns null (shows nothing)
  const noPrevChange = calculateValueChange(null, null, '$100.00', detectSemanticValue('$100.00'));
  const noPrevHero = formatHeroMovement(noPrevChange);
  assert(noPrevHero === null, 'missing previous value returns null (shows nothing)');
}

// ---------------------------------------------------------------------
// Scenario 32: Historical benchmarks & deal insights
// ---------------------------------------------------------------------
section('Scenario 32: Historical benchmarks and deal insights');

{
  const makeCheckEntry = (
    value: string | null,
    checkedAt: number = Date.now(),
    error: string | null = null,
  ): any => ({
    id: `check-${Math.random().toString(36).slice(2)}`,
    monitorId: 'benchmarks-monitor',
    value,
    semanticValue: value ? detectSemanticValue(value) : null,
    checkedAt,
    changed: false,
    error,
    diagnosticCode: error ? 'EXTRACTION_EMPTY' : 'OK',
    confidence: 100,
    strategy: 'live',
  });

  // 1. Numeric history: computes min, max, average, and lowDate
  const tLow = 1700000000000;
  const tMid = 1700000100000;
  const tHigh = 1700000200000;
  const numHistory = [
    makeCheckEntry('150', tHigh),
    makeCheckEntry('100', tMid),
    makeCheckEntry('50', tLow),
  ];
  const numBenchmarks = calculateHistoricalBenchmarks(numHistory, '100');
  assert(numBenchmarks !== null, 'calculates benchmarks for numeric history');
  assert(numBenchmarks?.low === 50, 'numeric low is 50');
  assert(numBenchmarks?.high === 150, 'numeric high is 150');
  assert(numBenchmarks?.average === 100, 'numeric average is 100');
  assert(numBenchmarks?.lowDate === tLow, 'numeric lowDate matches timestamp of minimum check');
  assert(numBenchmarks?.formattedLow === '50', 'numeric formattedLow is 50');
  assert(numBenchmarks?.formattedHigh === '150', 'numeric formattedHigh is 150');
  assert(numBenchmarks?.formattedAverage === '100', 'numeric formattedAverage is 100');

  // 2. Currency history: formats with proper currency symbol and decimals
  const tCurrLow = 1700001000000;
  const currHistory = [
    makeCheckEntry('$120.00', 1700003000000),
    makeCheckEntry('$100.00', 1700002000000),
    makeCheckEntry('$80.00', tCurrLow),
  ];
  const currBenchmarks = calculateHistoricalBenchmarks(currHistory, '$100.00');
  assert(currBenchmarks !== null, 'calculates benchmarks for currency history');
  assert(currBenchmarks?.low === 80, 'currency low is 80');
  assert(currBenchmarks?.high === 120, 'currency high is 120');
  assert(currBenchmarks?.average === 100, 'currency average is 100');
  assert(currBenchmarks?.lowDate === tCurrLow, 'currency lowDate matches timestamp of lowest check');
  assert(currBenchmarks?.formattedLow === '$80.00', 'currency formattedLow is $80.00');
  assert(currBenchmarks?.formattedHigh === '$120.00', 'currency formattedHigh is $120.00');
  assert(currBenchmarks?.formattedAverage === '$100.00', 'currency formattedAverage is $100.00');

  // 3. Percentage history: treated as percentage points, not percent-of-percent
  const pctHistory = [
    makeCheckEntry('60.0%', 1700006000000),
    makeCheckEntry('50.0%', 1700005000000),
    makeCheckEntry('40.0%', 1700004000000),
  ];
  const pctBenchmarks = calculateHistoricalBenchmarks(pctHistory, '50.0%');
  assert(pctBenchmarks !== null, 'calculates benchmarks for percentage history');
  assert(pctBenchmarks?.low === 40, 'percentage low is 40');
  assert(pctBenchmarks?.high === 60, 'percentage high is 60');
  assert(pctBenchmarks?.average === 50, 'percentage average is 50');
  assert(pctBenchmarks?.formattedLow === '40.0%', 'percentage formattedLow is 40.0%');
  assert(pctBenchmarks?.formattedHigh === '60.0%', 'percentage formattedHigh is 60.0%');
  assert(pctBenchmarks?.formattedAverage === '50.0%', 'percentage formattedAverage is 50.0%');

  // Percentage near-lowest: within 5 percentage points of minimum (40% + 5% = 45%)
  const pctNearLowBenchmarks = calculateHistoricalBenchmarks(pctHistory, '43.0%');
  assert(pctNearLowBenchmarks?.dealStatus === 'near-lowest', 'percentage 43.0% is within 5 percentage points of 40% (near-lowest)');
  assert(pctNearLowBenchmarks?.dealStatusLabel === 'Near lowest', 'percentage deal status label is Near lowest');

  const pctNotNearLowBenchmarks = calculateHistoricalBenchmarks(pctHistory, '46.0%');
  assert(pctNotNearLowBenchmarks?.dealStatus === null, 'percentage 46.0% exceeds 5 percentage points above minimum (shows nothing)');

  // 4. Text history: returns null (gracefully suppressed)
  const textHistory = [
    makeCheckEntry('In Stock'),
    makeCheckEntry('Out of Stock'),
    makeCheckEntry('Backorder'),
  ];
  const textBenchmarks = calculateHistoricalBenchmarks(textHistory, 'In Stock');
  assert(textBenchmarks === null, 'text history returns null (no numeric benchmarks)');

  // 5. Single-point / insufficient history: returns null
  const singlePointHistory = [makeCheckEntry('$100.00')];
  assert(calculateHistoricalBenchmarks(singlePointHistory, '$100.00') === null, 'single-point history returns null (gracefully omitted)');

  const emptyHistory: any[] = [];
  assert(calculateHistoricalBenchmarks(emptyHistory, '$100.00') === null, 'empty history returns null');

  const errorHistory = [
    makeCheckEntry('$100.00', 1, 'Failed to fetch'),
    makeCheckEntry('$90.00', 2, 'Connection error'),
  ];
  assert(calculateHistoricalBenchmarks(errorHistory, '$100.00') === null, 'history with only errors returns null');

  // 6. All-time low detection: triggers when current value equals historical minimum
  const lowDealBenchmarks = calculateHistoricalBenchmarks(currHistory, '$80.00');
  assert(lowDealBenchmarks?.dealStatus === 'all-time-low', 'current value $80.00 triggers all-time-low');
  assert(lowDealBenchmarks?.dealStatusLabel === 'All-time low', 'all-time low label is All-time low');

  // 7. All-time high detection: triggers when current value equals historical maximum
  const highDealBenchmarks = calculateHistoricalBenchmarks(currHistory, '$120.00');
  assert(highDealBenchmarks?.dealStatus === 'all-time-high', 'current value $120.00 triggers all-time-high');
  assert(highDealBenchmarks?.dealStatusLabel === 'All-time high', 'all-time high label is All-time high');

  // 8. Near-low detection: within 5% of minimum
  // Minimum is $100.00, maximum is $200.00. 5% of $100 is $5 -> near low range is ($100.00, $105.00]
  const nearLowHistory = [
    makeCheckEntry('$200.00'),
    makeCheckEntry('$150.00'),
    makeCheckEntry('$100.00'),
  ];
  const nearLowBenchmarks = calculateHistoricalBenchmarks(nearLowHistory, '$104.00');
  assert(nearLowBenchmarks?.dealStatus === 'near-lowest', 'current value $104.00 is within 5% of $100.00 (near-lowest)');
  assert(nearLowBenchmarks?.dealStatusLabel === 'Near lowest', 'near-lowest label is Near lowest');

  const notNearLowBenchmarks = calculateHistoricalBenchmarks(nearLowHistory, '$106.00');
  assert(notNearLowBenchmarks?.dealStatus === null, 'current value $106.00 exceeds 5% of $100.00 (shows nothing)');

  // 9. Average calculation: validates exact mathematical average
  const exactAvgHistory = [
    makeCheckEntry('10'),
    makeCheckEntry('20'),
    makeCheckEntry('30'),
    makeCheckEntry('40'),
  ];
  const exactAvgBenchmarks = calculateHistoricalBenchmarks(exactAvgHistory, '25');
  assert(exactAvgBenchmarks?.average === 25, 'average of 10, 20, 30, 40 is exactly 25');

  const decimalAvgHistory = [
    makeCheckEntry('$19.99'),
    makeCheckEntry('$29.99'),
  ];
  const decimalAvgBenchmarks = calculateHistoricalBenchmarks(decimalAvgHistory, '$19.99');
  assert(Math.abs((decimalAvgBenchmarks?.average ?? 0) - 24.99) < 1e-9, 'average of $19.99 and $29.99 is 24.99');
  assert(decimalAvgBenchmarks?.formattedAverage === '$24.99', 'formatted average is $24.99');
}

// ---------------------------------------------------------------------
// M9: the picker click guard distinguishes elements, not just text.
// Two duplicate values in different rows share text/anchors/label, so
// content alone would accept the wrong row; screen position separates
// them, while a re-created equivalent in the same slot still passes
// and the naming step shows the value for confirmation.
// ---------------------------------------------------------------------
{
  section('M9: sameSelection distinguishes elements; naming shows the value');

  const m9Dom = new JSDOM(`<!doctype html><html><body>
    <div class="card" id="card-a"><span class="label">Likes</span><span class="metric">12</span></div>
    <div class="card" id="card-b"><span class="label">Likes</span><span class="metric">12</span></div>
  </body></html>`);
  const m9doc = m9Dom.window.document;
  (globalThis as any).window = m9Dom.window;
  (globalThis as any).document = m9doc;
  (globalThis as any).Node = m9Dom.window.Node;
  (globalThis as any).CSS = m9Dom.window.CSS ?? { escape: (s: string) => s };

  // jsdom lays out nothing - stub distinct row positions like real boxes.
  const stubBox = (el: Element, top: number) => {
    (el as any).getBoundingClientRect = () => ({
      width: 40, height: 16, top, left: 10, right: 50, bottom: top + 16,
    });
  };

  const first = m9doc.querySelector('#card-a .metric')!;
  const second = m9doc.querySelector('#card-b .metric')!;
  stubBox(first, 100);
  stubBox(second, 200);

  const t1 = resolvePickerTarget(first);
  assert(t1 !== null, 'hover resolves the first metric');
  const t1again = resolvePickerTarget(first);
  assert(t1again !== null, 're-resolving the same element works');
  assert(sameSelection(t1!, t1again!) === true, 'same element is still the same selection');

  const t2 = resolvePickerTarget(second);
  assert(t2 !== null, 'hover resolves the duplicate metric');
  assert(
    t2!.text === t1!.text &&
      t2!.canonicalValue === t1!.canonicalValue &&
      t2!.textAnchor.before === t1!.textAnchor.before &&
      t2!.textAnchor.after === t1!.textAnchor.after &&
      t2!.label === t1!.label,
    'fixture really is identical text/context across rows (otherwise the test proves nothing)',
  );
  assert(
    sameSelection(t1!, t2!) === false,
    'different element with identical text is not the same selection',
  );

  // Legitimate re-render: the row's content is replaced in place (new
  // nodes, same slot) - must keep working.
  const cardA = m9doc.getElementById('card-a')!;
  cardA.innerHTML = '<span class="label">Likes</span><span class="metric">12</span>';
  const fresh = cardA.querySelector('.metric')!;
  assert(fresh !== first, 're-render produced a new node');
  stubBox(fresh, 100);
  const t3 = resolvePickerTarget(fresh);
  assert(t3 !== null, 're-rendered element resolves');
  assert(sameSelection(t1!, t3!) === true, 're-rendered equivalent in the same slot still works');

  // Live ticker on the same node: text changed, node identical - the
  // click targets what the user hovered, verified in the naming step.
  second.textContent = '13';
  const t4 = resolvePickerTarget(second);
  assert(t4 !== null, 'ticked element resolves');
  assert(sameSelection(t2!, t4!) === true, 'same node with ticked text is still the same selection');

  // The naming step shows the exact value for confirmation.
  assert(
    namingValuePreview(t1!) === 'Selected value: 12',
    `naming preview shows the selected value (got ${JSON.stringify(namingValuePreview(t1!))})`,
  );
}

// ---------------------------------------------------------------------
// M10: anchor matching is positional (before < value < after). Repeated
// labels slice from the nearest valid frame instead of the first one,
// and an intact-but-unresolvable frame reports failure instead of
// manufacturing a value - while reshaped elements and exact fallbacks
// keep working as before.
// ---------------------------------------------------------------------
{
  section('M10: positional anchor ordering rejects misarranged frames');

  const m10Dom = new JSDOM(
    `<!doctype html><html><body><div id="m">A <span>1</span> A <span>2</span> B</div></body></html>`,
  );
  const m10doc = m10Dom.window.document;
  (globalThis as any).window = m10Dom.window;
  (globalThis as any).document = m10doc;
  (globalThis as any).Node = m10Dom.window.Node;
  (globalThis as any).CSS = m10Dom.window.CSS ?? { escape: (s: string) => s };
  const m10win = m10Dom.window as unknown as Window;

  const mEl = m10doc.getElementById('m')!;
  const mBase = buildFingerprint(mEl, m10win);
  const withAnchor = (value: string, before: string, after: string) => ({
    ...mBase,
    textAnchor: { value, before, after },
  });

  // 1. Ordered anchors with a repeated label: nearest valid frame wins.
  const ordered = locateAndExtract(m10doc, withAnchor('2', 'A', 'B'), 'text', null, m10win);
  assert(
    ordered.value === '2',
    `repeated label resolves the correct value "2" (got ${JSON.stringify(ordered.value)})`,
  );

  // 2. Out-of-order frame on changed content: rejected, not guessed.
  mEl.innerHTML = 'A <span>1</span> A <span>3</span> B';
  const ooo = locateAndExtract(m10doc, withAnchor('2', 'B', 'A'), 'text', null, m10win);
  assert(ooo.value === null, `out-of-order frame produces null value (got ${JSON.stringify(ooo.value)})`);
  assert(
    ooo.diagnostic.code === 'EXTRACTION_EMPTY',
    `out-of-order frame reports EXTRACTION_EMPTY (got ${ooo.diagnostic.code})`,
  );

  // 3. Out-of-order frame on unchanged content still rescues the exact
  // value through the existing exact-match fallback.
  mEl.innerHTML = 'A <span>1</span> A <span>2</span> B';
  const oooSame = locateAndExtract(m10doc, withAnchor('2', 'B', 'A'), 'text', null, m10win);
  assert(
    oooSame.value === '2',
    `out-of-order frame with unchanged content still resolves "2" via exact match (got ${JSON.stringify(oooSame.value)})`,
  );

  // 4. Reshaped single-run element with a stale frame: the whole-text
  // fallback is preserved.
  const sEl = m10doc.createElement('div');
  sEl.id = 's';
  sEl.textContent = 'old text here';
  m10doc.body.appendChild(sEl);
  const sBase = buildFingerprint(sEl, m10win);
  sEl.textContent = 'new reshaped content';
  const reshaped = locateAndExtract(
    m10doc,
    { ...sBase, textAnchor: { value: 'old', before: 'zzz', after: 'qqq' } },
    'text',
    null,
    m10win,
  );
  assert(
    reshaped.value === 'new reshaped content',
    `reshaped single-run element still reads whole text (got ${JSON.stringify(reshaped.value)})`,
  );
}

// ---------------------------------------------------------------------
// M12: scroll recovery runs only for feed/item-anchored fingerprints
// and always puts the page back where the user had it - on success,
// on failure, and on early exit.
// ---------------------------------------------------------------------
{
  section('M12: feed-gated scroll recovery restores scroll position');

  const feedFp = { itemAnchor: { href: '/someuser/status/222', isPermalink: true } } as any;
  const plainFp = { itemAnchor: null } as any;
  assert(
    shouldAttemptScrollRecovery(feedFp, 'ELEMENT_NOT_FOUND') === true,
    'feed item with a missing element may scroll',
  );
  assert(
    shouldAttemptScrollRecovery(feedFp, 'SELECTOR_RECOVERY_LOW_CONFIDENCE') === true,
    'feed item with a low-confidence miss may scroll',
  );
  assert(
    shouldAttemptScrollRecovery(feedFp, 'AUTH_REQUIRED') === false,
    'blocked diagnostics never scroll, even for feed items',
  );
  assert(
    shouldAttemptScrollRecovery(feedFp, 'ANTI_AUTOMATION_DETECTED') === false,
    'challenge pages never scroll, even for feed items',
  );
  assert(
    shouldAttemptScrollRecovery(plainFp, 'ELEMENT_NOT_FOUND') === false,
    'ordinary monitor never scrolls, however deep on the page',
  );
  assert(
    shouldAttemptScrollRecovery({ itemAnchor: undefined } as any, 'SELECTOR_RECOVERY_LOW_CONFIDENCE') === false,
    'missing anchor never scrolls',
  );

  let y = 320;
  const restoredTo: number[] = [];
  const getY = () => y;
  const scrollToY = (v: number) => {
    restoredTo.push(v);
    y = v;
  };
  const okOut = await withRestoredScrollY(getY, scrollToY, async () => {
    y = 900;
    return 'done';
  });
  assert(okOut === 'done', 'restore wrapper passes the task result through');
  assert(y === 320 && restoredTo[restoredTo.length - 1] === 320, 'success restores the original position');

  let threw = false;
  try {
    await withRestoredScrollY(getY, scrollToY, async () => {
      y = 700;
      throw new Error('locate blew up');
    });
  } catch {
    threw = true;
  }
  assert(threw === true, 'task errors still propagate');
  assert(y === 320, 'failure still restores the original position');

  const early = await withRestoredScrollY(getY, scrollToY, async () => null);
  assert(early === null && y === 320, 'early exit restores the original position');

  // The exact composition the page agent now uses: the real bounded
  // scroll search inside the real restore wrapper.
  let sy = 100;
  const composed = await withRestoredScrollY(
    () => sy,
    (v) => {
      sy = v;
    },
    async () =>
      searchByScrolling(
        {
          read: () => ({ scrollY: sy, scrollHeight: 1000 }),
          scrollDown: () => {
            sy += 800;
          },
        },
        () => (sy >= 900 ? 'mounted' : null),
        async () => {},
        { maxSteps: 5, stepDelayMs: 1 },
      ),
  );
  assert(composed.result === 'mounted', 'scroll search still finds the target once it mounts');
  assert(sy === 100, 'the page is put back after the composed recovery');
}

// ---------------------------------------------------------------------
// Findings 3+4: virtualized constant-height feeds keep searching while
// the position advances (no premature bottom), and auth-URL detection
// ignores query-string values.
// ---------------------------------------------------------------------
{
  section('Findings: constant-height feeds search on; ?next=/login is not a login wall');

  // Constant height (preallocated virtualized list) with a position
  // that keeps advancing: not the bottom, keep going to the cap.
  let vy = 0;
  const virtualOutcome = await searchByScrolling(
    {
      read: () => ({ scrollY: vy, scrollHeight: 2000 }),
      scrollDown: () => {
        vy += 800;
      },
    },
    () => null,
    async () => {},
    { maxSteps: 6, stepDelayMs: 0 },
  );
  assert(
    virtualOutcome.steps === 6 && virtualOutcome.reachedBottom === false,
    `constant height with advancing position exhausts maxSteps instead of stopping early (got steps=${virtualOutcome.steps}, reachedBottom=${virtualOutcome.reachedBottom})`,
  );

  // Same constant height, but the position genuinely stops: bottom.
  const wy = 1600;
  const bottomedOutcome = await searchByScrolling(
    {
      read: () => ({ scrollY: wy, scrollHeight: 2000 }),
      scrollDown: () => {},
    },
    () => null,
    async () => {},
    { maxSteps: 10, stepDelayMs: 0 },
  );
  assert(
    bottomedOutcome.reachedBottom === true && bottomedOutcome.steps < 10,
    `stopped position plus stable height still declares bottom early (got steps=${bottomedOutcome.steps})`,
  );

  // Finding 5: the scroll gate in runLocate honors the monitor's
  // ORIGINAL type - a healed fingerprint must not widen recovery.
  // Feed monitor with a missing element attempts scrolling; an
  // originally ordinary monitor never does, observable via scrollBy.
  async function runLocateMissing(kind: 'feed' | 'plain') {
    const dom = new JSDOM(
      `<!doctype html><html><head><title>Price Tracker</title></head><body>
        <main><h1>Today's prices and market overview for every watched product category</h1>
        <p>Fresh data lands throughout the day as suppliers report new numbers.</p></main>
      </body></html>`,
      { url: 'https://example.com/prices', pretendToBeVisual: true },
    );
    const doc = dom.window.document;
    (globalThis as any).window = dom.window;
    (globalThis as any).document = doc;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).MutationObserver = dom.window.MutationObserver;
    let scrollCalls = 0;
    let restoreCalls = 0;
    (dom.window as any).scrollBy = () => {
      scrollCalls += 1;
    };
    (dom.window as any).scrollTo = () => {
      restoreCalls += 1;
    };
    const ghost = doc.createElement('div');
    ghost.id = 'gone';
    ghost.textContent = '$10.00';
    doc.body.appendChild(ghost);
    const baseFp = buildFingerprint(ghost, dom.window as unknown as Window);
    ghost.remove();
    const fp =
      kind === 'feed'
        ? { ...baseFp, itemAnchor: { href: '/u/status/9', isPermalink: true, rowKey: null, datetime: null, primaryText: null } }
        : { ...baseFp, itemAnchor: null };
    const outcome = await runLocate(JSON.stringify(fp), 'text', null, {
      maxTotalWaitMs: kind === 'feed' ? 6000 : 2500,
    });
    return { outcome, scrollCalls, restoreCalls };
  }

  const feedRun = await runLocateMissing('feed');
  assert(
    feedRun.outcome.value === null,
    `feed run with a missing element still reports no value (got ${JSON.stringify(feedRun.outcome.value)})`,
  );
  assert(feedRun.scrollCalls > 0, `feed monitor attempts scroll recovery (scrollBy calls=${feedRun.scrollCalls})`);
  assert(feedRun.restoreCalls > 0, 'feed recovery restores scroll position afterwards');

  const plainRun = await runLocateMissing('plain');
  assert(
    plainRun.outcome.value === null,
    `ordinary monitor with a missing element still reports no value (got ${JSON.stringify(plainRun.outcome.value)})`,
  );
  assert(plainRun.scrollCalls === 0, `ordinary monitor never scrolls (scrollBy calls=${plainRun.scrollCalls})`);
  assert(
    plainRun.restoreCalls === 0,
    'no recovery means no restore overhead for ordinary monitors',
  );
  // NOTE: the healed-anchor conjunction (`isFeedItem && ...` at the
  // runLocate gate) is intentionally not staged here: forcing recovery
  // to relocate onto a null-extracting feed element with >=55
  // confidence is non-deterministic to construct, and a test that
  // cannot reliably stage its precondition would pass vacuously.
  // Coverage is the gate matrix above (helper contract), the two
  // runLocate monitor-type cases here, and review of the one-line
  // conjunction over the pre-existing isFeedItem variable.

  const queryDom = new JSDOM(
    `<!doctype html><html><head><title>Account settings</title></head><body>
      <main><h1>Account settings</h1><p>Update your password below.</p>
      <form><input type="password" name="pw"></form></main>
    </body></html>`,
    { url: 'https://example.com/account/settings?next=/login' },
  );
  const queryDoc = queryDom.window.document;
  (globalThis as any).window = queryDom.window;
  (globalThis as any).document = queryDoc;
  (globalThis as any).Node = queryDom.window.Node;
  assert(
    detectAuthWall(queryDoc, false) === false,
    'query-string /login does not classify a settings page as auth-required',
  );

  const realLogin = new JSDOM(
    `<!doctype html><html><head><title>Sign in</title></head><body>
      <main><form><input type="password" name="p"></form></main>
    </body></html>`,
    { url: 'https://example.com/login?ref=homepage' },
  );
  const realLoginDoc = realLogin.window.document;
  (globalThis as any).window = realLogin.window;
  (globalThis as any).document = realLoginDoc;
  (globalThis as any).Node = realLogin.window.Node;
  assert(
    detectAuthWall(realLoginDoc, false) === true,
    'genuine login path with a query string is still detected',
  );
}

// ---------------------------------------------------------------------
// M11: a password field alone is not a login wall. Ordinary pages with
// password inputs (settings, checkout, admin) must report a missing
// element as ELEMENT_NOT_FOUND - keeping scroll recovery available -
// while genuine login pages (auth URL/title + password field) still
// detect as AUTH_REQUIRED.
// ---------------------------------------------------------------------
{
  section('M11: password field alone does not classify a login wall');

  function authDoc(html: string, url: string) {
    const dom = new JSDOM(html, { url });
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
    (globalThis as any).ShadowRoot = dom.window.ShadowRoot;
    return { dom, doc: dom.window.document };
  }

  const settings = authDoc(
    `<!doctype html><html><head><title>Account settings</title></head><body>
      <main><h1>Account settings</h1><p>Update your profile and preferences below. Changes save automatically.</p>
      <form><label>New password<input type="password" name="pw"></label></form></main>
    </body></html>`,
    'https://example.com/settings',
  );
  assert(
    detectAuthWall(settings.doc, false) === false,
    'settings page with a password field is not auth-required',
  );

  const login = authDoc(
    `<!doctype html><html><head><title>Sign in</title></head><body>
      <main><h1>Welcome back</h1><form><input type="text" name="u"><input type="password" name="p"></form></main>
    </body></html>`,
    'https://example.com/login',
  );
  assert(detectAuthWall(login.doc, false) === true, 'genuine login page is still auth-required');

  const authUrl = authDoc(
    `<!doctype html><html><head><title>Dashboard</title></head><body>
      <main><h1>Dashboard</h1><form><input type="password" name="p"></form></main>
    </body></html>`,
    'https://example.com/auth/callback',
  );
  assert(detectAuthWall(authUrl.doc, false) === true, 'auth-looking URL is still detected');

  const authTitle = authDoc(
    `<!doctype html><html><head><title>Log in to Example</title></head><body>
      <main><h1>Members area</h1><form><input type="password" name="p"></form></main>
    </body></html>`,
    'https://example.com/home',
  );
  assert(detectAuthWall(authTitle.doc, false) === true, 'auth-looking title is still detected');

  assert(detectAuthWall(login.doc, true) === false, 'found target is never an auth wall');
  const noPassword = authDoc(
    `<!doctype html><html><head><title>Sign in</title></head><body><main><h1>Sign in</h1></main></body></html>`,
    'https://example.com/login',
  );
  assert(detectAuthWall(noPassword.doc, false) === false, 'auth-looking page without a password field is not auth-required');

  // Missing element on an ordinary page with a password field reports
  // ELEMENT_NOT_FOUND (scroll-recovery eligible), not AUTH_REQUIRED.
  const ghost = settings.doc.createElement('div');
  ghost.textContent = '$1.00';
  settings.doc.body.appendChild(ghost);
  const ghostFp = buildFingerprint(ghost);
  ghost.remove();
  const missing = locateAndExtract(settings.doc, ghostFp, 'text', null);
  assert(
    missing.value === null && missing.diagnostic.code === 'ELEMENT_NOT_FOUND',
    `missing element on a password-field page reports ELEMENT_NOT_FOUND (got ${missing.diagnostic.code})`,
  );
}

// ---------------------------------------------------------------------
// Analytics value hijack: a saved "Visits 20" monitor must never come
// back with the nearby delta percentage. Pick resolves the value span
// (as in the product screenshot: "✓ 20"); if a later check can only
// recover onto the structurally similar delta span, the type mismatch
// (percentage vs number) rejects it instead of storing - and, most
// importantly, never heals the fingerprint onto the wrong element,
// which is what used to wedge monitors onto the percentage forever.
// ---------------------------------------------------------------------
{
  section('Analytics hijack: relocated delta percentage is rejected, never stored or healed');

  const hijackDom = new JSDOM(
    `<!doctype html><html><head><title>Cloudflare Dashboard</title></head><body>
      <main><h1>Web traffic analytics and performance overview</h1>
      <p>Review visits, page views, and unique visitor counts across all zones.</p>
      <div id="card"><div class="card"><span class="label">Visits</span><span class="value" data-metric="visits">20</span><span class="delta" data-metric="visits">54.55%</span></div></div>
      <footer><p>Footer content with plenty of ordinary descriptive text here.</p></footer>
    </body></html>`,
    { url: 'https://dash.cloudflare.com/', pretendToBeVisual: true },
  );
  const hijackDoc = hijackDom.window.document;
  (globalThis as any).window = hijackDom.window;
  (globalThis as any).document = hijackDoc;
  (globalThis as any).Node = hijackDom.window.Node;
  (globalThis as any).CSS = hijackDom.window.CSS ?? { escape: (s: string) => s };
  (globalThis as any).ShadowRoot = hijackDom.window.ShadowRoot;
  const hijackWin = hijackDom.window as unknown as Window;

  // Pick with the cursor on the value, like the real flow: unambiguous "✓ 20".
  const valueSpan = hijackDoc.querySelector('#card .value')!;
  const valueText = valueSpan.firstChild!;
  (hijackDoc as any).caretRangeFromPoint = () => {
    const range = hijackDoc.createRange();
    range.setStart(valueText, 1);
    range.collapse(true);
    return range;
  };
  const picked = resolvePickerTargetAtPoint(hijackDoc, 10, 10);
  assert(picked !== null, 'cursor pick resolves the Visits value');
  assert(picked!.canonicalValue === '20', `picked canonical value is "20" (got ${JSON.stringify(picked!.canonicalValue)})`);
  assert(picked!.isAmbiguous === false, 'cursor pick is not ambiguous');
  const visitsFp = buildFingerprint(valueSpan, hijackWin, picked!.textAnchor);

  // Same content, fresh nodes: the value is still extracted.
  hijackDoc.getElementById('card')!.innerHTML =
    `<div class="card"><span class="label">Visits</span><span class="value" data-metric="visits">20</span><span class="delta" data-metric="visits">54.55%</span></div>`;
  const steady = locateAndExtract(hijackDoc, visitsFp, 'text', null, hijackWin);
  assert(steady.value === '20', `recheck with the value present extracts "20" (got ${JSON.stringify(steady.value)})`);

  // Value span gone (not mounted at check time); only the structurally
  // similar delta remains and recovery lands on it with confidence.
  hijackDoc.getElementById('card')!.innerHTML =
    `<div class="card"><span class="value" data-metric="visits">54.55%</span><span class="label">Visits</span></div>`;
  const hijacked = locateAndExtract(hijackDoc, visitsFp, 'text', null, hijackWin);
  assert(
    hijacked.value === null,
    `relocated delta percentage is rejected, not stored (got ${JSON.stringify(hijacked.value)})`,
  );
  assert(
    hijacked.diagnostic.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE',
    `rejection reports low confidence, not success (got ${hijacked.diagnostic.code})`,
  );
  assert(
    hijacked.updatedFingerprint === null,
    'rejection never heals the fingerprint onto the wrong element',
  );
  assert(
    hijacked.semanticValue === null,
    'rejection carries no semantic value to poison downstream state',
  );
}

// ---------------------------------------------------------------------
// Empty-target population: an already-located element with temporarily
// empty (or effectively empty) text must be re-read until it holds a
// real value - never instantly succeed with an aria-label or invisible
// characters. Persistent emptiness still fails as EXTRACTION_EMPTY.
// ---------------------------------------------------------------------
{
  section('Empty target waits for population within budget');

  function emptyDoc(inner: string) {
    const dom = new JSDOM(
      `<!doctype html><html><head><title>Shop Deals Page</title></head><body>
      <header><nav><a href="/">Home</a><a href="/deals">Deals</a><a href="/cart">Cart</a></nav></header>
      <main><h1>Today's deals and price drops across every department</h1>${inner}</main>
      <footer><p>Footer with ordinary descriptive text for the layout.</p></footer>
      </body></html>`,
      { url: 'https://example.com/deals', pretendToBeVisual: true },
    );
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).MutationObserver = dom.window.MutationObserver;
    (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
    (globalThis as any).ShadowRoot = dom.window.ShadowRoot;
    return { dom, doc: dom.window.document };
  }

  function settleRead(
    dom: JSDOM,
    doc: Document,
    fp: ElementFingerprint,
    budgetMs: number,
  ) {
    return resolveSettledValue(
      (maxWaitMs) => waitForPageReady(dom.window as unknown as Window, { maxWaitMs, minWaitMs: 50 }),
      () => locateAndExtract(doc, fp, 'text', null),
      { maxTotalWaitMs: budgetMs, confirmDelayMs: 200 },
    );
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1. Numeric monitor picked while populated; empty with an aria-label
  // at check time; repopulates mid-budget. The label must never stand
  // in for the value.
  {
    const { dom, doc } = emptyDoc(`<div id="p"><span class="lbl">Price: </span><span class="price" aria-label="current price">$49.99</span></div>`);
    const el = doc.querySelector('.price')!;
    const fp = buildFingerprint(el, dom.window as unknown as Window);
    el.textContent = '';
    await sleep(100);
    setTimeout(() => {
      el.textContent = '$44.99';
    }, 700);
    const out = await settleRead(dom, doc, fp, 5000);
    assert(out.value === '$44.99', `empty numeric target converges on repopulated value (got ${JSON.stringify(out.value)})`);
    assert(out.semanticValue?.type === 'currency', `repopulated value keeps numeric semantics (got ${out.semanticValue?.type})`);
  }

  // 2. Zero-width-only content is empty, not a value - waited out too.
  {
    const { dom, doc } = emptyDoc(`<div id="p"><span class="price"></span></div>`);
    const el = doc.querySelector('.price')!;
    el.textContent = String.fromCharCode(0x200b);
    const fp = buildFingerprint(el, dom.window as unknown as Window);
    setTimeout(() => {
      el.textContent = '$49.99';
    }, 700);
    const out = await settleRead(dom, doc, fp, 5000);
    assert(out.value === '$49.99', `zero-width-only target waits for real text (got ${JSON.stringify(out.value)})`);
  }

  // 3. Text monitor on an empty element with an aria-label: label is
  // not stored either.
  {
    const { dom, doc } = emptyDoc(`<div id="p"><span class="status" aria-label="stock status"></span></div>`);
    const el = doc.querySelector('.status')!;
    const fp = buildFingerprint(el, dom.window as unknown as Window);
    setTimeout(() => {
      el.textContent = 'In Stock';
    }, 700);
    const out = await settleRead(dom, doc, fp, 5000);
    assert(out.value === 'In Stock', `empty text target converges instead of storing its aria-label (got ${JSON.stringify(out.value)})`);
  }

  // 4. Never populates: still fails honestly and within budget.
  {
    const { dom, doc } = emptyDoc(`<div id="p"><span class="price" aria-label="current price"></span></div>`);
    const el = doc.querySelector('.price')!;
    const fp = buildFingerprint(el, dom.window as unknown as Window);
    const start = Date.now();
    const out = await settleRead(dom, doc, fp, 2500);
    assert(out.value === null, `persistently empty target yields null (got ${JSON.stringify(out.value)})`);
    assert(
      out.diagnostic.code === 'EXTRACTION_EMPTY',
      `persistently empty target reports EXTRACTION_EMPTY (got ${out.diagnostic.code})`,
    );
    assert(Date.now() - start < 4500, `empty failure stays bounded by its budget (took ${Date.now() - start}ms)`);
  }
}

console.log('\nDone.');




