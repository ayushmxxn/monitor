/**
 * M8: page-access messaging failures must be retryable, not permanent
 * denials. Renders the real Panel against a stubbed runtime messenger:
 * `checkOriginPermissions` is programmed per scenario (granted / denied /
 * failing), and the panel's notice, Retry action, and Add gating are
 * asserted for each.
 */
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
  });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  g.navigator = dom.window.navigator;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

// Prime the first document and select React's native input path before
// react-dom evaluates (shared registry across test files in one run).
setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Panel } = await import('../components/panel/Panel');

// --- Runtime messenger stub (restored at the end) -------------------------
// The messaging layer expects `{ res, err }` envelopes.

let nextAccess: 'granted' | 'denied' | 'fail' = 'granted';

{
  const g = globalThis as any;
  g.__m8OrigSendMessage = g.chrome.runtime.sendMessage;
  g.chrome.runtime.sendMessage = (msg: any, cb: (res: any) => void) => {
    queueMicrotask(() => {
      if (msg?.type === 'getAppInfo') {
        cb({ res: { version: '0.0', name: 'Monitor', installType: 'unknown' } });
      } else if (msg?.type === 'checkOriginPermissions') {
        // A failing transport must surface through the `{ err }` envelope
        // (throwing here would escape as uncaught instead of rejecting).
        if (nextAccess === 'fail') cb({ err: { message: 'message port closed' } });
        else {
          const urls = msg.data as string[];
          cb({ res: Object.fromEntries(urls.map((u) => [u, nextAccess === 'granted'])) });
        }
      } else {
        cb({ res: null });
      }
    });
  };
}

async function renderPanel(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Panel shadowHost={host} />);
    await sleep(50);
  });
  await act(async () => {
    await sleep(50);
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

async function click(el: Element | null) {
  assert(!!el, 'click target exists');
  await act(async () => {
    el!.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
  });
  await act(async () => {
    await sleep(50);
  });
}

function findButton(container: ParentNode, text: string): Element | null {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
}

section('M8: page-access states gate Add honestly with a retry path');

{
  setupDom();
  nextAccess = 'granted';
  const { container, root } = await renderPanel();
  const text = container.textContent ?? '';
  assert(!text.includes("doesn't have access"), 'granted shows no denial notice');
  assert(!text.includes("Couldn't confirm access"), 'granted shows no error notice');
  assert(findButton(container, 'Add')?.hasAttribute('disabled') === false, 'granted keeps Add enabled');
  await unmount(container, root);
}

{
  setupDom();
  nextAccess = 'denied';
  const { container, root } = await renderPanel();
  const text = container.textContent ?? '';
  assert(
    text.includes('Close the panel and click the toolbar icon'),
    'genuine denial shows accurate recovery copy',
  );
  assert(findButton(container, 'Add')?.hasAttribute('disabled') === true, 'denied keeps Add disabled');
  assert(findButton(container, 'Retry') === null, 'denied offers no Retry (nothing transient to retry)');
  await unmount(container, root);
}

{
  setupDom();
  nextAccess = 'fail';
  const { container, root } = await renderPanel();
  const text = container.textContent ?? '';
  assert(
    text.includes("Couldn't confirm access"),
    'messaging failure shows the retryable error, not a denial',
  );
  assert(!text.includes("doesn't have access"), 'messaging failure is not labeled a denial');
  const retry = findButton(container, 'Retry');
  assert(!!retry, 'error state exposes an in-panel Retry action');
  assert(findButton(container, 'Add')?.hasAttribute('disabled') === true, 'error keeps Add disabled');

  nextAccess = 'granted';
  await click(retry);
  const recovered = container.textContent ?? '';
  assert(!recovered.includes("Couldn't confirm access"), 'retry clears the error after recovery');
  assert(findButton(container, 'Add')?.hasAttribute('disabled') === false, 'retry re-enables Add after recovery');
  await unmount(container, root);
}

{
  setupDom();
  nextAccess = 'fail';
  const { container, root } = await renderPanel();
  await click(findButton(container, 'Retry'));
  const text = container.textContent ?? '';
  assert(text.includes("Couldn't confirm access"), 'retry keeps the error when still failing');
  assert(
    findButton(container, 'Retry') !== null,
    'retry action stays available while failing',
  );
  await unmount(container, root);
}

{
  const g = globalThis as any;
  if (g.__m8OrigSendMessage === undefined) delete g.chrome.runtime.sendMessage;
  else g.chrome.runtime.sendMessage = g.__m8OrigSendMessage;
  delete g.__m8OrigSendMessage;
}

console.log('\nAll page-access tests finished.');
