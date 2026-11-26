/**
 * Extraction hardening regression tests: continental numeric syntax
 * and hidden-subtree reads.
 *
 * Demonstrated wrong-value class 1 (both strategies, committed OK,
 * sometimes with a fingerprint heal): continental decimal commas
 * ("9,99 €" read as 999), dot-thousands groups ("1.234,56 €"
 * truncated to the "234,56 €" span), and space/apostrophe grouping
 * ("1 234" truncated to the "1" span). Root cause was US-ASCII-only
 * tokenizers plus comma-stripping parses. Fixed generically:
 * strict-shape EU fragments match whole and parse to the right
 * magnitude, while US-valid text matches byte-identically to before
 * (a bare single "1.234" stays a US decimal — genuinely ambiguous,
 * deliberately preserved).
 *
 * Demonstrated wrong-value class 2: an exact selector resolving
 * inside a `display: none` subtree returned its stale text as current
 * on both strategies (computed styles describe only the element
 * itself, never its ancestors). Fixed by refusing extraction from
 * hidden subtrees — ranked fallbacks then move on to visible
 * candidates, or the read fails safe with no heal.
 *
 * No new confirmation/retry/settling gate was added (pure parsing +
 * an extraction filter, no extra reads), so gate-interaction coverage
 * is: the zero-confirm and zero-cliff suites run unchanged in the
 * full suite, plus composition asserts below (hidden + prior value
 * neither heals nor converts, single-commit semantics hold).
 */
import { JSDOM } from 'jsdom';

const CHROME =
  `<nav><a href="/">Home</a><a href="/stats">Statistics</a><a href="/about">About this dashboard</a></nav>` +
  `<p>Realtime analytics refresh every few minutes from the tracking snippet installed on each monitored page.</p>`;

function rDoc(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).ShadowRoot = dom.window.ShadowRoot;
  (globalThis as any).CSS = dom.window.CSS ?? { escape: (s: string) => s };
  return { dom, doc: dom.window.document as Document };
}

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

const { buildFingerprint } = await import('../lib/monitors/fingerprint');
const { locateAndExtract, locateAndExtractWithReanchor } = await import('../lib/monitors/locate');
const { detectSemanticValue, parseLocalizedNumberFragment } = await import('../lib/monitors/semanticValue');

function capture(html: string, selector: string, anchor: { value: string; before: string; after: string }) {
  const { doc } = rDoc(html);
  return buildFingerprint(doc.querySelector(selector)!, undefined, anchor);
}

section('1. localized magnitudes parse correctly (US behavior preserved)');
{
  const cases: Array<[string, number | null]> = [
    // Continental forms now read correctly.
    ['9,99', 9.99], ['54,55', 54.55], ['1.234,56', 1234.56], ['1 234', 1234],
    ["1'234", 1234], ['1.234.567', 1234567], ['12,5', 12.5], ['0,5', 0.5],
    ['1.234,5', 1234.5], ['-9,99', -9.99], ['12,34,567', 1234567],
    ['79,525.75', 79525.75], ['68,412.10', 68412.1], ['1,234.56', 1234.56],
    ['2,501.76', 2501.76], ['1,234,567.89', 1234567.89],
    // US forms parse exactly as before (comma-stripping equivalent).
    ['1,234', 1234], ['1,234,567', 1234567], ['3.14159', 3.14159],
    ['1.234', 1.234], ['42', 42], ['0', 0], ['0.00', 0], ['1,651', 1651],
    ['-5', -5], ['+12', 12], ['2,500,000,000', 2500000000],
    // Malformed input fails closed instead of guessing.
    ['abc', null], ['', null], ['12,34,56', null], ['--5', null],
  ];
  for (const [input, expected] of cases) {
    const got = parseLocalizedNumberFragment(input);
    assert(got === expected, `parse ${JSON.stringify(input)} -> ${JSON.stringify(got)} (want ${JSON.stringify(expected)})`);
  }

  const semCases: Array<[string, string, number | null]> = [
    ['9,99 €', 'currency', 9.99],
    ['1.234,56 €', 'currency', 1234.56],
    ['€1.234,56', 'currency', 1234.56],
    ['54,55%', 'percentage', 54.55],
    ['1.234,56 views', 'views', 1234.56],
    ['2,5 GB', 'storage', 2.5 * 1024 ** 3],
    ['4,8/5', 'stars', 4.8],
    ['1,5 hours', 'duration', 5400],
    ['1 234', 'number', 1234],
    ["1'234", 'number', 1234],
    ['$49.99', 'currency', 49.99],
    ['12.4K followers', 'followers', 12400],
    ['12,34,567', 'number', 1234567],
  ];
  for (const [input, type, normalized] of semCases) {
    const sem = detectSemanticValue(input);
    assert(
      sem.type === type && sem.normalized === normalized,
      `classify ${JSON.stringify(input)} -> ${sem.type}/${sem.normalized} (want ${type}/${normalized})`,
    );
  }
}

section('2. continental end-to-end commits carry whole display + right magnitude');
{
  async function euCommit(html: string, anchorValue: string, wantValue: string, wantType: string, wantNormalized: number) {
    const { doc: cap } = rDoc(html);
    const fp = buildFingerprint(cap.querySelector('.v')!, undefined, { value: anchorValue, before: '', after: '' });
    const { doc } = rDoc(html);
    const out = locateAndExtract(doc, fp, 'text', null);
    assert(out.value === wantValue, `${wantValue}: value whole (got ${JSON.stringify(out.value)})`);
    assert(
      out.semanticValue?.type === wantType && out.semanticValue?.normalized === wantNormalized,
      `${wantValue}: magnitude ${out.semanticValue?.type}/${out.semanticValue?.normalized} (want ${wantType}/${wantNormalized})`,
    );
    assert(out.diagnostic.code === 'OK', `${wantValue}: success, not failure (got ${out.diagnostic.code})`);
  }

  await euCommit(
    CHROME + `<main><h1>Shop</h1><div class="s"><span class="v">9,99 €</span></div></main>`,
    '9,99 €', '9,99 €', 'currency', 9.99,
  );
  await euCommit(
    CHROME + `<main><h1>Shop</h1><div class="s"><span class="v">1.234,56 €</span></div></main>`,
    '1.234,56 €', '1.234,56 €', 'currency', 1234.56,
  );
  await euCommit(
    CHROME + `<main><h1>Stats</h1><div class="s"><span class="v">54,55%</span></div></main>`,
    '54,55%', '54,55%', 'percentage', 54.55,
  );
  await euCommit(
    CHROME + `<main><h1>Stats</h1><div class="s"><span class="v">1 234</span></div></main>`,
    '1 234', '1 234', 'number', 1234,
  );
}

section('3. continental re-renders against numeric anchors (no truncation, valid heals)');
{
  const { doc: capA } = rDoc(CHROME + `<main><h1>Z</h1><div class="s"><span class="v">1234</span></div></main>`);
  const fpA = buildFingerprint(capA.querySelector('.v')!, undefined, { value: '1234', before: '', after: '' });
  const { doc: docA } = rDoc(CHROME + `<main><h1>Z</h1><div class="s"><span class="v">1'234</span></div></main>`);
  const outA = locateAndExtract(docA, fpA, 'text', null);
  assert(outA.value === "1'234", `apostrophe re-render keeps whole span (got ${JSON.stringify(outA.value)})`);
  assert(outA.semanticValue?.normalized === 1234, 'apostrophe re-render magnitude is 1234, not 1');

  const { doc: capB } = rDoc(CHROME + `<main><h1>Shop</h1><div class="s"><span class="v">€1,100.00</span></div></main>`);
  const fpB = buildFingerprint(capB.querySelector('.v')!, undefined, { value: '€1,100.00', before: '', after: '' });
  const { doc: docB } = rDoc(CHROME + `<main><h1>Shop</h1><div class="s"><span class="v">€1.234,56</span></div></main>`);
  const outB = locateAndExtract(docB, fpB, 'text', null);
  assert(outB.value === '€1.234,56', `euro re-render keeps whole span (got ${JSON.stringify(outB.value)})`);
  assert(outB.semanticValue?.normalized === 1234.56, 'euro re-render magnitude is 1234.56, not 1.234');
}

section('4. hidden subtrees never yield values (both paths), visible twin still recovers');
{
  const { doc: cap } = rDoc(
    CHROME + `<main><h1>Metrics panel</h1><div class="m"><span class="l">Visitors</span><span class="v">150</span></div></main>`,
  );
  const fp = buildFingerprint(cap.querySelector('.v')!, undefined, { value: '150', before: 'Visitors', after: '' });

  // Hidden exact slot first, visible twin second: the hidden read must
  // not win — recovery lands on the visible instance instead.
  const { dom, doc } = rDoc(
    CHROME +
      `<main><h1>Metrics panel</h1>` +
      `<div class="m" style="display:none"><span class="l">Visitors</span><span class="v">150</span></div>` +
      `<div class="m"><span class="l">Visitors</span><span class="v">175</span></div></main>`,
  );
  const found = locateAndExtract(doc, fp, 'text', null, dom.window as unknown as Window);
  assert(found.value === '175', `visible twin wins over hidden stale slot (got ${JSON.stringify(found.value)})`);
  assert(found.updatedFingerprint !== null, 'recovery onto the visible instance heals forward');

  // Nothing visible at all: fail safe, no heal, no fabricated value.
  const { doc: hiddenOnly } = rDoc(
    CHROME + `<main><h1>Metrics panel</h1><div class="m" style="display:none"><span class="l">Visitors</span><span class="v">150</span></div></main>`,
  );
  const gone = locateAndExtract(hiddenOnly, fp, 'text', null);
  assert(gone.value === null, 'fully hidden target yields no value');
  assert(gone.updatedFingerprint === null, 'fully hidden target never heals');
  assert(
    gone.diagnostic.code === 'EXTRACTION_EMPTY' || gone.diagnostic.code === 'ELEMENT_NOT_FOUND',
    `hidden-only read fails honestly (got ${gone.diagnostic.code})`,
  );

  // Composition with the prior-value machinery: a hidden failure with
  // a lastValue neither heals nor converts — the primary verdict
  // stands exactly as before.
  const stuck = locateAndExtractWithReanchor(hiddenOnly, fp, 'text', null, undefined, '150');
  assert(stuck.value === null && stuck.updatedFingerprint === null, 're-anchor never heals from hidden content');
  assert(
    stuck.diagnostic.code === 'EXTRACTION_EMPTY' || stuck.diagnostic.code === 'ELEMENT_NOT_FOUND',
    `hidden + prior value keeps the honest primary code (got ${stuck.diagnostic.code})`,
  );
}

section('5. legitimate unusual values keep working (no false negatives)');
{
  async function jump(fromHtml: string, toHtml: string, anchorValue: string, want: string, wantNormalized?: number) {
    const { doc: cap } = rDoc(fromHtml);
    const fp = buildFingerprint(cap.querySelector('.v')!, undefined, { value: anchorValue, before: '', after: '' });
    const { doc } = rDoc(toHtml);
    const out = locateAndExtract(doc, fp, 'text', null);
    assert(out.value === want, `legit jump commits ${want} (got ${JSON.stringify(out.value)}, ${out.diagnostic.code})`);
    if (wantNormalized !== undefined) {
      assert(
        out.semanticValue?.normalized === wantNormalized,
        `legit jump magnitude is ${wantNormalized} (got ${out.semanticValue?.normalized})`,
      );
    }
  }

  const wrap = (inner: string) => CHROME + `<main><h1>Dashboard</h1><div class="s">${inner}</div></main>`;
  await jump(
    wrap(`<span class="v">314,271</span>`), wrap(`<span class="v">1,204,553</span>`),
    '314,271', '1,204,553', 1204553,
  );
  await jump(
    wrap(`<span class="v">$49.99</span>`), wrap(`<span class="v">$1,299.00</span>`),
    '$49.99', '$1,299.00', 1299,
  );
  await jump(
    wrap(`<span class="v">87%</span>`), wrap(`<span class="v">92.4%</span>`),
    '87%', '92.4%', 92.4,
  );
  await jump(
    wrap(`<span class="v">12.4K followers</span>`), wrap(`<span class="v">1.2M followers</span>`),
    '12.4K followers', '1.2M', 1200000,
  );
  await jump(
    wrap(`<span class="v">0</span>`), wrap(`<span class="v">0</span>`),
    '0', '0', 0,
  );

  // Ambiguous bare "1.234" deliberately stays a US decimal (documented
  // boundary shared with the parser: dot-thousands need pairs or a
  // comma tail to disambiguate).
  const sem = detectSemanticValue('1.234');
  assert(sem.type === 'number' && sem.normalized === 1.234, 'bare "1.234" stays US decimal by design');
  // Malformed fragments fail closed instead of guessing.
  const bad = detectSemanticValue('12,34,56');
  assert(bad.type === 'text', 'malformed grouping classifies as text, never a guessed number');
}

console.log(`\n${failures === 0 ? 'All extraction-hardening tests passed.' : `${failures} extraction-hardening assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
