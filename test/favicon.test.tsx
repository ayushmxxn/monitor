import './mockBrowser';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { faviconUrl } from '../lib/favicon';

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

setupDom();
(document as any).oninput = () => {};

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Favicon } = await import('../components/layout/Favicon');

async function render(el: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
}

async function unmount(container: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

section('Local favicon cache URL');
{
  const src = faviconUrl('https://example.com/pricing', 32);
  assert(
    src.startsWith('chrome-extension://mock-extension-id/_favicon/'),
    'uses Chrome local _favicon cache URL',
  );
  assert(!src.includes('google.com'), 'never builds a Google favicon URL');
}

section('Favicon component uses local cache and falls back to generic icon');
{
  const { container, root } = await render(<Favicon url="https://example.com/pricing" size={16} />);
  const img = container.querySelector('img');
  assert(!!img, 'renders an img for valid http(s) monitor URL');
  assert(
    img?.getAttribute('src')?.startsWith('chrome-extension://mock-extension-id/_favicon/') === true,
    'img src points to Chrome local _favicon cache',
  );

  await act(async () => {
    img!.dispatchEvent(new window.Event('error'));
  });

  const fallbackImg = container.querySelector('img');
  const globeSvg = container.querySelector('svg');
  assert(fallbackImg === null, 'does not retry via an external favicon URL on error');
  assert(!!globeSvg, 'falls back directly to the generic globe icon');

  await act(async () => {
    root.render(<Favicon url="https://another.example/stats" size={16} />);
  });
  const nextImg = container.querySelector('img');
  assert(!!nextImg, 'resets fallback state when URL prop changes');

  await unmount(container, root);
}

{
  const { container, root } = await render(<Favicon url="not-a-url" size={16} />);
  assert(container.querySelector('img') === null, 'invalid URL does not render an img');
  assert(!!container.querySelector('svg'), 'invalid URL renders the generic globe icon');
  await unmount(container, root);
}

console.log('\nAll favicon privacy tests passed.');
