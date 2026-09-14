/**
 * Account/session-scope-change regression tests.
 *
 * A monitor must not go terminal `NEEDS_REPICK` when the user switches
 * accounts (or workspaces): the app shell — even the element's
 * selector — can be unchanged while the page shows a different
 * account's data. That reads as an access problem (`ACCESS_CHANGED`,
 * Retry kept, fingerprint untouched so going back recovers), never as
 * selector drift. Genuine drift keeps the NEEDS_REPICK path.
 *
 * Pure DOM-level tests (jsdom + the real locate pipeline, no
 * chrome/storage): the simulated dashboard below is deliberately
 * generic — no brand names, no per-site selectors — mirroring only the
 * shape of the report (same app shell, swapped workspace dataset).
 */
import { JSDOM } from 'jsdom';
import { buildFingerprint } from '../lib/monitors/fingerprint';
import { locateAndExtract, locateAndExtractWithReanchor } from '../lib/monitors/locate';
import {
  detectAccessChange,
  fingerprintContextStrings,
} from '../lib/monitors/accessChange';
import {
  FORCE_REPROBE_CODES,
  NON_RETRYABLE_CODES,
  STALE_IDENTITY_CODES,
  getFailureStateInfo,
  shouldMarkNeedsRepick,
} from '../lib/monitors/diagnostics';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${message}`);
  }
}

function rDoc(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).MutationObserver = dom.window.MutationObserver;
  (globalThis as any).ShadowRoot = dom.window.ShadowRoot;
  (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
  return { dom, doc: dom.window.document as Document };
}

const CHROME = `<nav><a href="/dashboard">Dashboard</a><a href="/sites">Websites</a><a href="/settings">Settings</a></nav>`;
const GENERIC_COPY = `<p>Realtime analytics for all of your websites. Data refreshes every few minutes once the tracking snippet installed on each site reports its first visit.</p>`;

// Original account: workspace "Acme Corp" with a reporting stat.
const ORIGINAL_HTML =
  CHROME +
  `<main><h1>Acme Corp overview</h1>${GENERIC_COPY}` +
  `<section><h2>Website statistics</h2>` +
  `<div class="stat-card"><span class="stat-label">Unique visitors</span><span class="stat-value">1,024</span></div>` +
  `<div class="stat-card"><span class="stat-label">Pageviews</span><span class="stat-value">3,318</span></div>` +
  `</section></main>`;

// Same app shell and selectors, different workspace: the stat slot the
// selector resolves to is emptied and the section carries an empty
// state instead of data. None of the original workspace's context
// (site name, stat labels) is present anywhere in this document.
const SWITCHED_EMPTY_SLOT_HTML =
  CHROME +
  `<main><h1>Welcome to your new workspace</h1>${GENERIC_COPY}` +
  `<section><h2>Getting started</h2>` +
  `<div class="stat-card"><span class="stat-label">Visitors this period</span><span class="stat-value"></span></div>` +
  `<p>No data has been collected for this workspace yet. Add a website and install the tracking snippet to begin.</p>` +
  `</section></main>`;

// Same, but the stat element is gone entirely rather than emptied.
const SWITCHED_MISSING_HTML =
  CHROME +
  `<main><h1>Welcome to your new workspace</h1>${GENERIC_COPY}` +
  `<section><h2>Getting started</h2>` +
  `<p>No data has been collected for this workspace yet. Add a website and install the tracking snippet to begin.</p>` +
  `</section></main>`;

// Genuine drift on the ORIGINAL account: the watched stat element is
// gone and its slot restructured into non-numeric content, but every
// surrounding label and heading is intact. (Note: merely deleting the
// first of two identically-structured cards is NOT used here — the
// shared positional selector would honestly resolve the sibling card,
// which is existing recovery semantics, not drift.)
const DRIFT_HTML =
  CHROME +
  `<main><h1>Acme Corp overview</h1>${GENERIC_COPY}` +
  `<section><h2>Website statistics</h2>` +
  `<p>Unique visitors reporting has moved to the new reports page.</p>` +
  `<div class="note"><span>Pageviews are now tracked separately.</span></div>` +
  `</section></main>`;

const { doc: originalDoc } = rDoc(ORIGINAL_HTML);
const fp = buildFingerprint(originalDoc.querySelector('.stat-value')!, undefined, {
  value: '1,024',
  before: 'Unique visitors',
  after: '',
});
const fpSnapshot = JSON.stringify(fp);

section('0. test premise: capture works and context is meaningful');
{
  const sanity = locateAndExtract(originalDoc, fp, 'text', null);
  assert(sanity.value === '1,024', `capture reads the value on the original account (got ${JSON.stringify(sanity.value)})`);

  const contexts = fingerprintContextStrings(fp);
  assert(contexts.length > 0, `fingerprint carries substantive context strings (got ${JSON.stringify(contexts)})`);

  const haystack = SWITCHED_EMPTY_SLOT_HTML.toLowerCase();
  assert(
    !contexts.some((c) => haystack.includes(c.toLowerCase())),
    'switched-workspace page truly contains none of the captured context',
  );
  const driftHaystack = DRIFT_HTML.toLowerCase();
  assert(
    contexts.some((c) => driftHaystack.includes(c.toLowerCase())),
    'drifted page keeps surrounding context (labels/headings intact)',
  );
}

section('1. same monitor + account/session changed → ACCESS_CHANGED');
{
  // Variant A: the selector still resolves (same app shell) but the
  // slot is emptied — the "selector may still be valid" case.
  const { doc: switchedDoc } = rDoc(SWITCHED_EMPTY_SLOT_HTML);
  const emptied = locateAndExtractWithReanchor(switchedDoc, fp, 'text', null, undefined, '1,024');
  assert(emptied.value === null, 'no value is fabricated from the other workspace');
  assert(
    emptied.diagnostic.code === 'ACCESS_CHANGED',
    `emptied slot under a new workspace diagnoses ACCESS_CHANGED (got ${emptied.diagnostic.code})`,
  );
  assert(emptied.updatedFingerprint === null, 'access failure never heals or replaces the fingerprint');
  assert(emptied.semanticValue === null, 'access failure carries no semantic value');
  assert(
    JSON.stringify(fp) === fpSnapshot,
    'the stored fingerprint object is untouched by the access failure',
  );

  // Variant B: the stat element is gone entirely on the new workspace.
  const { doc: missingDoc } = rDoc(SWITCHED_MISSING_HTML);
  const missing = locateAndExtractWithReanchor(missingDoc, fp, 'text', null, undefined, '1,024');
  assert(missing.value === null, 'no value is fabricated when the element is absent');
  assert(
    missing.diagnostic.code === 'ACCESS_CHANGED',
    `missing element under a new workspace diagnoses ACCESS_CHANGED (got ${missing.diagnostic.code})`,
  );
  assert(missing.updatedFingerprint === null, 'missing-element access failure never heals either');

  // Variant C: explicit access messaging on an otherwise rendered page.
  const { doc: deniedDoc } = rDoc(
    CHROME +
      `<main><h1>Acme Corp overview</h1>${GENERIC_COPY}` +
      `<section><h2>Website statistics</h2>` +
      `<p>You do not have access to this workspace. Ask an administrator to invite you.</p>` +
      `</section></main>`,
  );
  const denied = locateAndExtractWithReanchor(deniedDoc, fp, 'text', null, undefined, '1,024');
  assert(
    denied.diagnostic.code === 'ACCESS_CHANGED',
    `explicit access messaging diagnoses ACCESS_CHANGED (got ${denied.diagnostic.code})`,
  );
  assert(denied.updatedFingerprint === null, 'explicit-message access failure never heals');
}

section('2. returning to the original account recovers the existing monitor');
{
  // The fingerprint survived section 1 byte-for-byte (asserted there);
  // back on the original workspace the very same fingerprint reads
  // again with no re-pick and no migration.
  const { doc: backDoc } = rDoc(ORIGINAL_HTML);
  const recovered = locateAndExtractWithReanchor(backDoc, fp, 'text', null, undefined, '1,024');
  assert(
    recovered.value === '1,024',
    `original account recovers the existing monitor automatically (got ${JSON.stringify(recovered.value)})`,
  );
  assert(
    recovered.diagnostic.code === 'OK' || recovered.diagnostic.code === 'OK_RECOVERED',
    `recovery reports success, not a lingering failure (got ${recovered.diagnostic.code})`,
  );
}

section('3. genuine element removal/layout drift → still NEEDS_REPICK');
{
  const { doc: driftDoc } = rDoc(DRIFT_HTML);
  const drifted = locateAndExtractWithReanchor(driftDoc, fp, 'text', null, undefined, '1,024');
  assert(drifted.value === null, 'no value is fabricated from the drifted page');
  assert(
    drifted.diagnostic.code !== 'ACCESS_CHANGED',
    `genuine drift never diagnoses ACCESS_CHANGED (got ${drifted.diagnostic.code})`,
  );
  assert(
    drifted.diagnostic.code === 'ELEMENT_NOT_FOUND' ||
      drifted.diagnostic.code === 'SELECTOR_RECOVERY_LOW_CONFIDENCE' ||
      drifted.diagnostic.code === 'EXTRACTION_EMPTY',
    `genuine drift keeps a stale-identity diagnosis (got ${drifted.diagnostic.code})`,
  );
  // …which is exactly what still routes to the terminal re-pick state
  // after the permanent threshold — while ACCESS_CHANGED never does.
  assert(
    shouldMarkNeedsRepick(drifted.diagnostic.code, 3, true) === true,
    'repeated drift still reaches NEEDS_REPICK',
  );
  assert(
    shouldMarkNeedsRepick('ACCESS_CHANGED', 9, true) === false,
    'ACCESS_CHANGED never converts to NEEDS_REPICK, however long it persists',
  );
}

section('4. initial monitor creation failure → no access error');
{
  // A fresh monitor has no prior value: even on an account-changed
  // page the failure must stay an ordinary identity miss, never an
  // "account changed" claim about a monitor that never worked.
  const { doc: switchedDoc } = rDoc(SWITCHED_MISSING_HTML);
  const fresh = locateAndExtractWithReanchor(switchedDoc, fp, 'text', null, undefined, null);
  assert(fresh.value === null, 'fresh monitor still finds no value');
  assert(
    fresh.diagnostic.code !== 'ACCESS_CHANGED',
    `fresh-monitor failure is not an access error (got ${fresh.diagnostic.code})`,
  );

  const placeholder = locateAndExtractWithReanchor(switchedDoc, fp, 'text', null, undefined, '--');
  assert(
    placeholder.diagnostic.code !== 'ACCESS_CHANGED',
    `placeholder lastValue is not an access error either (got ${placeholder.diagnostic.code})`,
  );
}

section('5. checker semantics + UI copy for ACCESS_CHANGED');
{
  assert(!STALE_IDENTITY_CODES.has('ACCESS_CHANGED'), 'no value-anchored re-anchor attempts on access failures');
  assert(!NON_RETRYABLE_CODES.has('ACCESS_CHANGED'), 'access failures keep threshold-based error timing, not instant-error');
  assert(FORCE_REPROBE_CODES.has('ACCESS_CHANGED'), 'next check re-cascades strategies so returning accounts recover');

  const info = getFailureStateInfo('ACCESS_CHANGED');
  assert(info.label === 'Access changed', `card/badge label is "Access changed" (got ${JSON.stringify(info.label)})`);
  assert(
    info.description === 'This monitor was created under a different account or workspace. Switch back to the original account and try again.',
    `description explains the account cause briefly (got ${JSON.stringify(info.description)})`,
  );
  assert(info.reason === 'access_changed', `distinct failure reason (got ${JSON.stringify(info.reason)})`);
  assert(info.canRetry === true, 'Retry stays available');
  assert(info.actionLabel === 'Check now', 'existing retry affordance is reused');

  const direct = detectAccessChange(rDoc(SWITCHED_MISSING_HTML).doc, fp);
  assert(direct.detected === true, 'detector fires on the switched workspace page');
  const calm = detectAccessChange(rDoc(DRIFT_HTML).doc, fp);
  assert(calm.detected === false, 'detector stays quiet on genuine drift');
}

console.log(`\n${failures === 0 ? 'All access-change tests passed.' : `${failures} access-change assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
