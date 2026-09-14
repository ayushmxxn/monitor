import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { resolvePickerTarget, resolvePickerTargetAtPoint } from '../lib/monitors/pickerTarget';
import { detectSemanticValue } from '../lib/monitors/semanticValue';

const initDom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as any).window = initDom.window;
(globalThis as any).document = initDom.window.document;
(globalThis as any).Node = initDom.window.Node;

function targetFromHtml(html: string) {
  const dom = new JSDOM(html);
  const el = dom.window.document.body.firstElementChild as Element;
  return resolvePickerTarget(el);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

console.log('\n=== Numeric-Only Picker Target Resolution Tests ===');

// 1. Plain numbers
test('resolves integer numbers', () => {
  const target = targetFromHtml('<span>42</span>');
  assert(target !== null, '42 should resolve to a valid target');
  assert.strictEqual(target!.canonicalValue, '42');
  assert.strictEqual(target!.semanticValue.type, 'number');
  assert.strictEqual(target!.semanticValue.normalized, 42);
});

test('resolves comma-grouped numbers', () => {
  const target = targetFromHtml('<span>1,234.56</span>');
  assert(target !== null, '1,234.56 should resolve to a valid target');
  assert.strictEqual(target!.canonicalValue, '1,234.56');
  assert.strictEqual(target!.semanticValue.type, 'number');
  assert.strictEqual(target!.semanticValue.normalized, 1234.56);
});

test('resolves negative numbers', () => {
  const target = targetFromHtml('<span>-85</span>');
  assert(target !== null, '-85 should resolve to a valid target');
  assert.strictEqual(target!.canonicalValue, '85');
  assert.strictEqual(target!.semanticValue.type, 'number');
});

test('resolves numbers nested inside labeled containers', () => {
  const target = targetFromHtml('<div class="stat"><span class="label">Count:</span><span class="val">99</span></div>');
  assert(target !== null, 'nested number should resolve');
  assert.strictEqual(target!.canonicalValue, '99');
  assert.strictEqual(target!.semanticValue.type, 'number');
  assert.strictEqual(target!.semanticValue.normalized, 99);
});

// 2. Currency values
test('resolves USD currency with symbol and commas', () => {
  const target = targetFromHtml('<span>$77,638.73</span>');
  assert(target !== null, '$77,638.73 should resolve');
  assert.strictEqual(target!.canonicalValue, '$77,638.73');
  assert.strictEqual(target!.semanticValue.type, 'currency');
  assert.strictEqual(target!.semanticValue.normalized, 77638.73);
  assert.strictEqual(target!.semanticValue.unit, 'USD');
});

test('resolves EUR currency', () => {
  const target = targetFromHtml('<span>€49.99</span>');
  assert(target !== null, '€49.99 should resolve');
  assert.strictEqual(target!.canonicalValue, '€49.99');
  assert.strictEqual(target!.semanticValue.type, 'currency');
  assert.strictEqual(target!.semanticValue.normalized, 49.99);
  assert.strictEqual(target!.semanticValue.unit, 'EUR');
});

test('resolves ISO currency codes', () => {
  const target = targetFromHtml('<span>100 USD</span>');
  assert(target !== null, '100 USD should resolve');
  assert.strictEqual(target!.canonicalValue, '100 USD');
  assert.strictEqual(target!.semanticValue.type, 'currency');
  assert.strictEqual(target!.semanticValue.normalized, 100);
  assert.strictEqual(target!.semanticValue.unit, 'USD');
});

test('resolves scaled currency', () => {
  const target = targetFromHtml('<span>$1.2M</span>');
  assert(target !== null, '$1.2M should resolve');
  assert.strictEqual(target!.canonicalValue, '$1.2M');
  assert.strictEqual(target!.semanticValue.type, 'currency');
  assert.strictEqual(target!.semanticValue.normalized, 1200000);
});

// 3. Percentages
test('resolves standard percentages', () => {
  const target = targetFromHtml('<span>15%</span>');
  assert(target !== null, '15% should resolve');
  assert.strictEqual(target!.canonicalValue, '15%');
  assert.strictEqual(target!.semanticValue.type, 'percentage');
  assert.strictEqual(target!.semanticValue.normalized, 15);
});

test('resolves signed positive percentage delta', () => {
  const target = targetFromHtml('<span>+0.2%</span>');
  assert(target !== null, '+0.2% should resolve');
  assert.strictEqual(target!.canonicalValue, '+0.2%');
  assert.strictEqual(target!.semanticValue.type, 'percentage');
  assert.strictEqual(target!.semanticValue.normalized, 0.2);
});

test('resolves signed negative percentage delta', () => {
  const target = targetFromHtml('<span>-3.5%</span>');
  assert(target !== null, '-3.5% should resolve');
  assert.strictEqual(target!.canonicalValue, '-3.5%');
  assert.strictEqual(target!.semanticValue.type, 'percentage');
  assert.strictEqual(target!.semanticValue.normalized, -3.5);
});

// 4. Compact values
test('resolves compact K values', () => {
  const target = targetFromHtml('<span>25k</span>');
  assert(target !== null, '25k should resolve');
  assert.strictEqual(target!.canonicalValue, '25k');
  assert.strictEqual(target!.semanticValue.type, 'count');
  assert.strictEqual(target!.semanticValue.normalized, 25000);
});

test('resolves compact M values', () => {
  const target = targetFromHtml('<span>1.5M</span>');
  assert(target !== null, '1.5M should resolve');
  assert.strictEqual(target!.canonicalValue, '1.5M');
  assert.strictEqual(target!.semanticValue.type, 'count');
  assert.strictEqual(target!.semanticValue.normalized, 1500000);
});

test('resolves compact billion values', () => {
  const target = targetFromHtml('<span>2.4bn</span>');
  assert(target !== null, '2.4bn should resolve');
  assert.strictEqual(target!.canonicalValue, '2.4bn');
  assert.strictEqual(target!.semanticValue.type, 'count');
  assert.strictEqual(target!.semanticValue.normalized, 2400000000);
});

test('resolves magnitude word forms', () => {
  const target = targetFromHtml('<span>10 thousand</span>');
  assert(target !== null, '10 thousand should resolve');
  assert.strictEqual(target!.canonicalValue, '10 thousand');
  assert.strictEqual(target!.semanticValue.type, 'count');
  assert.strictEqual(target!.semanticValue.normalized, 10000);
});

// 5. Text-only elements (rejected / not selectable)
test('rejects plain conversational text', () => {
  const target = targetFromHtml('<p>Just comments about how they love Dessn</p>');
  assert.strictEqual(target, null, 'conversational text must not be selectable');
});

test('rejects navigation and action labels', () => {
  const target = targetFromHtml('<button>Account Settings</button>');
  assert.strictEqual(target, null, 'action button text must not be selectable');
});

test('rejects headings without numbers', () => {
  const target = targetFromHtml('<h1>Latest Updates</h1>');
  assert.strictEqual(target, null, 'heading without numbers must not be selectable');
});

test('rejects multi-word text sentences', () => {
  const target = targetFromHtml('<span>In Progress</span>');
  assert.strictEqual(target, null, 'status text without numeric values must not be selectable');
});

test('rejects software version strings without numeric values', () => {
  const target = targetFromHtml('<span>Version 2.4.1 released</span>');
  assert.strictEqual(target, null, 'version string must not be selectable as numeric value');
});

test('rejects date-only strings', () => {
  const target = targetFromHtml('<span>2024-05-12</span>');
  assert.strictEqual(target, null, 'pure date must not be selectable as numeric value');
});

test('rejects empty or whitespace elements', () => {
  const target = targetFromHtml('<div>   </div>');
  assert.strictEqual(target, null, 'whitespace element must not be selectable');
});

test('returns null when hit testing point over text-only element without numeric neighborhood', () => {
  const dom = new JSDOM('<div><p id="text-node">No numbers in here at all</p></div>');
  const doc = dom.window.document;
  const p = doc.getElementById('text-node')!;
  doc.elementFromPoint = () => p;
  const target = resolvePickerTargetAtPoint(doc, 10, 10);
  assert.strictEqual(target, null, 'point hit test over text-only element must return null');
});

// 6. Numeric detection pipeline consistency
test('uses existing detectSemanticValue pipeline', () => {
  const numSemantic = detectSemanticValue('1,234.56');
  assert.strictEqual(numSemantic.type, 'number');
  assert.strictEqual(numSemantic.normalized, 1234.56);

  const textSemantic = detectSemanticValue('Account Settings');
  assert.strictEqual(textSemantic.type, 'text');
  assert.strictEqual(textSemantic.normalized, null);
});

console.log('All numeric-only picker tests passed!\n');
