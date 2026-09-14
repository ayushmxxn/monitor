/**
 * Settings social row: X + Discord icon-only links live in the main
 * settings content (About & Feedback "Social" row), never in a footer.
 *
 * Note: `browser`/`chrome` come from an explicit mockBrowser import
 * (same as checkNow/checkStage/errorMessages) rather than the bunfig
 * test preload, which single-file `bun test <file>` runs do not apply.
 */
import './mockBrowser';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SocialLinks } = await import('../components/layout/SocialLinks');
const { App: OptionsApp } = await import('../entrypoints/options/App');
const { Panel } = await import('../components/panel/Panel');

function findAboutSection(root: ParentNode): Element | null {
  for (const section of Array.from(root.querySelectorAll('section'))) {
    if (section.querySelector('h2')?.textContent === 'About & Feedback') return section;
  }
  return null;
}

section('social icon row');
{
  setupDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<SocialLinks /> as ReactElement);
    await sleep(10);
  });

  const links = Array.from(container.querySelectorAll('a'));
  assert(links.length === 2, `renders exactly two social links (got ${links.length})`);

  const x = container.querySelector('a[aria-label="X"]') as HTMLAnchorElement | null;
  assert(!!x, 'X link exists with an accessible label');
  assert(x?.getAttribute('href') === 'https://x.com/ayushmxxn', 'X links to the creator profile');
  assert(x?.target === '_blank', 'X opens in a new tab');
  assert((x?.getAttribute('rel') ?? '').includes('noopener'), 'X link is hardened with rel=noopener');

  const discord = container.querySelector('a[aria-label="Discord"]') as HTMLAnchorElement | null;
  assert(!!discord, 'Discord link exists with an accessible label');
  assert(
    discord?.getAttribute('href') === 'https://discord.com/invite/kzk6uWey3g',
    'Discord links to the invite',
  );
  assert(discord?.target === '_blank', 'Discord opens in a new tab');
  assert((discord?.getAttribute('rel') ?? '').includes('noopener'), 'Discord link is hardened with rel=noopener');

  assert(
    (container.textContent ?? '').trim() === '',
    'icons only — no visible text labels',
  );
  assert(
    container.querySelectorAll('a svg').length === 2,
    'each link renders a brand icon',
  );

  await act(async () => {
    root.unmount();
  });
  container.remove();
}

section('placement: Social row in content, footers clean');
{
  // Options Settings page.
  setupDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<OptionsApp />);
    await sleep(100);
  });
  const about = findAboutSection(container);
  assert(!!about, 'options About & Feedback section renders');
  assert(!!about?.querySelector('a[aria-label="X"]'), 'options Social row links X');
  assert(
    about?.querySelector('a[aria-label="Discord"]')?.getAttribute('href') ===
      'https://discord.com/invite/kzk6uWey3g',
    'options Social row links Discord',
  );
  assert(
    (about?.textContent ?? '').includes('Socials'),
    'options row carries the Socials label',
  );
  const footerDiv = container.querySelector('div.border-t');
  assert(
    !!footerDiv &&
      footerDiv.querySelector('a[aria-label="X"], a[aria-label="Discord"]') === null,
    'options footer has no social icons',
  );
  await act(async () => {
    root.unmount();
  });
  container.remove();

  // Panel settings view (gear → Settings).
  setupDom();
  if (!(document as any).createElement('canvas').getContext) {
    (window as any).HTMLCanvasElement.prototype.getContext = () => null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const panelHost = document.createElement('div');
  document.body.appendChild(panelHost);
  const panelRoot: Root = createRoot(panelHost);
  await act(async () => {
    panelRoot.render(<Panel shadowHost={host} />);
    await sleep(100);
  });
  const gear = panelHost.querySelector('button[aria-label="Open settings"]') as HTMLElement | null;
  assert(!!gear, 'panel settings gear renders');
  if (gear) {
    await act(async () => {
      gear.dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(100);
    });
  }
  const panelAbout = findAboutSection(panelHost);
  assert(!!panelAbout?.querySelector('a[aria-label="X"]'), 'panel Social row links X');
  assert(
    !!panelAbout?.querySelector('a[aria-label="Discord"]'),
    'panel Social row links Discord',
  );
  const panelFooter = panelHost.querySelector('footer');
  assert(
    !!panelFooter && panelFooter.querySelector('a[aria-label="X"], a[aria-label="Discord"]') === null,
    'panel footer has no social icons',
  );
  await act(async () => {
    panelRoot.unmount();
  });
  panelHost.remove();
  host.remove();
}

console.log(`\n${failures === 0 ? 'All social link tests passed.' : `${failures} social link assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
