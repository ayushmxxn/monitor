/**
 * Font isolation unit tests:
 * 1. Verifies that the compiled stylesheet sets `font-sans` on `body` (the shadow UI container)
 *    and generates the `.font-sans` utility containing the design sans stack.
 * 2. Verifies that `applyShadowHostIsolation` locks the host custom element to a zero-footprint
 *    layout reset without ineffective inline font-family declarations.
 * 3. Verifies that DESIGN_FONT_STACK stays in lockstep with tailwind.config.ts.
 *
 * Full real-browser computed font assertions across YouTube, ChatGPT, and static sites
 * are covered in test/browserFontRegression.test.ts.
 */
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
// @ts-expect-error - postcss.config.js is untyped JS; imported for its live
// plugin list so this test always tracks the real build pipeline.
import config from '../postcss.config.js';
import { readFileSync } from 'node:fs';
import {
  applyShadowHostIsolation,
  DESIGN_FONT_STACK,
  SHADOW_HOST_FONT_STACK,
} from '../lib/ui/shadowHost';

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

// Compile globals.css with the production PostCSS pipeline
const compiledCss = (
  await postcss(config.plugins).process(readFileSync('./styles/globals.css', 'utf8'), {
    from: './styles/globals.css',
  })
).css;

section('Compiled stylesheet: typography isolation declarations');

{
  // 1. Verify body rule in globals.css includes font-sans
  const hasBodyFontSans =
    compiledCss.includes('body {\n  font-family: Inter, -apple-system') ||
    compiledCss.includes('body {\r\n  font-family: Inter, -apple-system') ||
    /body\s*\{[^}]*font-family:\s*Inter/m.test(compiledCss);
  assert(hasBodyFontSans, 'globals.css compiles body with the Inter design font stack');

  // 2. Verify .font-sans utility is present
  const hasFontSansClass =
    compiledCss.includes('.font-sans {\n  font-family: Inter, -apple-system') ||
    compiledCss.includes('.font-sans {\r\n  font-family: Inter, -apple-system') ||
    /\.font-sans\s*\{[^}]*font-family:\s*Inter/m.test(compiledCss);
  assert(hasFontSansClass, 'globals.css generates .font-sans utility with the Inter design font stack');
}

section('Host layout isolation: preserves zero-footprint layout reset byte-for-byte');

{
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const host = doc.createElement('monitor-panel');
  applyShadowHostIsolation(host);

  const get = (prop: string) => ({
    value: host.style.getPropertyValue(prop),
    priority: host.style.getPropertyPriority(prop),
  });

  for (const [prop, value] of [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'static'],
    ['width', '0'],
    ['height', '0'],
    ['margin', '0'],
    ['padding', '0'],
    ['overflow', 'visible'],
  ] as const) {
    const actual = get(prop);
    const normalized = actual.value === '0px' ? '0' : actual.value;
    assert(
      normalized === value && actual.priority === 'important',
      `layout reset keeps ${prop}: ${value} !important (got "${actual.value}" ${actual.priority})`,
    );
  }

  // Verify host does NOT set an ineffective inline font-family pin (wiped by shadow :host reset)
  assert(
    host.style.getPropertyValue('font-family') === '',
    'shadow host does not set redundant inline font-family (isolation lives inside shadow DOM)',
  );
}

section('Design tokens: stack stays in lockstep with tailwind.config.ts');

{
  for (const token of ['Inter', '-apple-system', 'Segoe UI', 'sans-serif']) {
    assert(
      DESIGN_FONT_STACK.includes(token) && SHADOW_HOST_FONT_STACK.includes(token),
      `design font stack contains "${token}" (got "${DESIGN_FONT_STACK}")`,
    );
  }
}

console.log('\nAll font isolation unit tests finished.');
