/**
 * Real-browser regression test for typography, font isolation, and CSP immunity.
 *
 * Launches headless Chromium and verifies:
 * - Real computed styles (computed font-family)
 * - Actual platform rendered fonts via Chrome DevTools Protocol (CSS.getPlatformFontsForNode)
 * - Zero host-page layout disruption / document flow leakage
 * - Immunity against strict host Content-Security-Policy (font-src 'self' https:)
 * across YouTube (Roboto, 10px root), ChatGPT (-apple-system-body),
 * strict CSP pages, and a static landing page.
 */
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import postcss from 'postcss';
// @ts-expect-error - untyped config
import config from '../postcss.config.js';

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

// Compile production styles
const rawCompiled = (
  await postcss(config.plugins).process(readFileSync('./styles/globals.css', 'utf8'), {
    from: './styles/globals.css',
  })
).css;
const panelCss = rawCompiled.replaceAll(':root', ':host');

// Official InterVariable.woff2 font as base64 for passing to headless Chromium test harness
const fontBinaryBase64 = readFileSync('./public/fonts/InterVariable.woff2').toString('base64');

const PORT = 9350;
const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let chromeProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;

try {
  chromeProcess = spawn(chromeExecutable, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-networking',
    'about:blank',
  ]);

  // Wait for Chrome to bind port
  let connected = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((p) => p.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => {
          ws!.onopen = resolve;
        });
        connected = true;
        break;
      }
    } catch {
      // retry
    }
  }

  if (!connected || !ws) {
    throw new Error('Failed to connect to headless Chrome via CDP');
  }

  let nextMsgId = 1;
  function sendCdp<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const msgId = nextMsgId++;
      const handler = (e: MessageEvent) => {
        try {
          const data = JSON.parse(String(e.data));
          if (data.id === msgId) {
            ws!.removeEventListener('message', handler);
            if (data.error) reject(data.error);
            else resolve(data.result);
          }
        } catch (err) {
          reject(err);
        }
      };
      ws!.addEventListener('message', handler);
      ws!.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await sendCdp('Page.enable');
  await sendCdp('DOM.enable');
  await sendCdp('CSS.enable');

  async function evaluateInBrowser<T>(fnString: string): Promise<T> {
    const res = await sendCdp<{ result: { value: T } }>('Runtime.evaluate', {
      expression: `(${fnString})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result.value;
  }

  const HOST_ENVIRONMENTS = [
    {
      name: 'YouTube',
      bodyStyle: 'font-family: Roboto, Arial, sans-serif; font-size: 10px;',
      htmlStyle: 'font-size: 10px;',
      forbiddenFontSnippet: 'roboto',
      strictCsp: false,
    },
    {
      name: 'ChatGPT',
      bodyStyle:
        'font-family: -apple-system-body, ui-sans-serif, -apple-system, "system-ui", "Segoe UI", Helvetica, Arial, sans-serif; font-size: 16px;',
      htmlStyle: 'font-size: 16px;',
      forbiddenFontSnippet: '-apple-system-body',
      strictCsp: false,
    },
    {
      name: 'Strict CSP page',
      bodyStyle: 'font-family: Arial, sans-serif; font-size: 16px;',
      htmlStyle: 'font-size: 16px;',
      forbiddenFontSnippet: 'arial',
      strictCsp: true,
    },
    {
      name: 'Static landing page',
      bodyStyle: 'font-family: system-ui, sans-serif; font-size: 16px;',
      htmlStyle: 'font-size: 16px;',
      forbiddenFontSnippet: 'times new roman',
      strictCsp: false,
    },
  ];

  section('Real-browser typography isolation & platform rendered font verification');

  for (const env of HOST_ENVIRONMENTS) {
    await sendCdp('Page.navigate', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 100));

    const testResults = await evaluateInBrowser<{
      occupiesSpaceInFlow: boolean;
      panelFont: string;
      headerFont: string;
      textFont: string;
      buttonFont: string;
      dialogFont: string;
      documentFontsReady: boolean;
      interCheck16: boolean;
    }>(`async () => {
      // Apply strict font-src CSP meta tag if specified
      if (${env.strictCsp}) {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'Content-Security-Policy';
        meta.content = "font-src 'self' https:;";
        document.head.appendChild(meta);
      }

      document.documentElement.style.cssText = ${JSON.stringify(env.htmlStyle)};
      document.body.style.cssText = ${JSON.stringify(env.bodyStyle)};

      // Measure document flow height before injecting panel
      const bodyHeightBefore = document.body.offsetHeight;

      // Clean up any existing test elements
      document.querySelectorAll('monitor-panel').forEach(el => el.remove());

      // Register Inter variable font using FontFace(ArrayBuffer) matching lib/ui/font.ts
      const b64 = ${JSON.stringify(fontBinaryBase64)};
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      const font = new FontFace('Inter', bytes.buffer, {
        style: 'normal',
        weight: '100 900',
        display: 'swap',
      });
      await font.load();
      document.fonts.add(font);

      // Create host with applyShadowHostIsolation
      const host = document.createElement('monitor-panel');
      host.id = 'monitor-panel-host';
      const hostStyle = host.style;
      hostStyle.setProperty('all', 'initial', 'important');
      hostStyle.setProperty('display', 'block', 'important');
      hostStyle.setProperty('position', 'static', 'important');
      hostStyle.setProperty('width', '0', 'important');
      hostStyle.setProperty('height', '0', 'important');
      hostStyle.setProperty('margin', '0', 'important');
      hostStyle.setProperty('padding', '0', 'important');
      hostStyle.setProperty('overflow', 'visible', 'important');

      // Promote to top layer via Popover API matching production panel.content.tsx
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
      }

      const shadow = host.attachShadow({ mode: 'open' });
      const isolatedElement = document.createElement('html');
      const head = document.createElement('head');
      const shadowBody = document.createElement('body');

      const style = document.createElement('style');
      style.textContent = \`/* WXT Shadow Root Reset */ :host{all:initial !important;}\\n\` + ${JSON.stringify(panelCss)};
      head.appendChild(style);

      // Panel root container (matches components/panel/Panel.tsx)
      const panel = document.createElement('div');
      panel.className = 'monitor-panel fixed top-5 bottom-5 right-5 z-[2147483647] flex overflow-hidden rounded-xl font-sans border-y border-r bg-background text-foreground';
      panel.style.fontSize = '16px';

      const header = document.createElement('h1');
      header.id = 'target-header';
      header.className = 'text-[13px] font-semibold tracking-tight';
      header.textContent = 'Monitor';
      panel.appendChild(header);

      const text = document.createElement('p');
      text.id = 'target-text';
      text.className = 'text-[11px] text-muted-foreground';
      text.textContent = 'Track any element on this page.';
      panel.appendChild(text);

      const button = document.createElement('button');
      button.id = 'target-button';
      button.className = 'inline-flex items-center justify-center rounded-md text-xs font-medium bg-primary text-primary-foreground h-8 px-3';
      button.textContent = 'New monitor';
      panel.appendChild(button);

      // Portaled Dialog content inside the shadow DOM container
      const dialogPortal = document.createElement('div');
      dialogPortal.className = 'fixed inset-0 z-50 font-sans';
      const dialogCard = document.createElement('div');
      dialogCard.className = 'left-1/2 top-1/2 z-50 w-[calc(100%-2.5rem)] max-w-sm rounded-lg border bg-popover p-4 text-popover-foreground shadow-2xl font-sans';
      const dialogTitle = document.createElement('h2');
      dialogTitle.id = 'target-dialog';
      dialogTitle.className = 'text-[13px] font-semibold';
      dialogTitle.textContent = 'Delete monitor?';
      dialogCard.appendChild(dialogTitle);
      dialogPortal.appendChild(dialogCard);
      panel.appendChild(dialogPortal);

      shadowBody.appendChild(panel);
      isolatedElement.appendChild(head);
      isolatedElement.appendChild(shadowBody);
      shadow.appendChild(isolatedElement);
      document.body.appendChild(host);
      if (typeof host.showPopover === 'function') {
        try { host.showPopover(); } catch(e) {}
      }

      await document.fonts.ready;

      const bodyHeightAfter = document.body.offsetHeight;

      return {
        occupiesSpaceInFlow: bodyHeightBefore !== bodyHeightAfter,
        panelFont: getComputedStyle(panel).fontFamily,
        headerFont: getComputedStyle(header).fontFamily,
        textFont: getComputedStyle(text).fontFamily,
        buttonFont: getComputedStyle(button).fontFamily,
        dialogFont: getComputedStyle(dialogTitle).fontFamily,
        documentFontsReady: document.fonts.status === 'loaded',
        interCheck16: document.fonts.check('16px Inter'),
      };
    }`);

    // Assert host layout isolation (zero page footprint)
    assert(
      !testResults.occupiesSpaceInFlow,
      `${env.name}: shadow host has zero page footprint in document flow`,
    );

    // Assert panel computed typography
    assert(
      testResults.panelFont.toLowerCase().includes('inter'),
      `${env.name}: panel container computes to Inter design stack (got "${testResults.panelFont}")`,
    );
    assert(
      testResults.headerFont.toLowerCase().includes('inter'),
      `${env.name}: header computes to Inter design stack (got "${testResults.headerFont}")`,
    );
    assert(
      testResults.textFont.toLowerCase().includes('inter'),
      `${env.name}: text computes to Inter design stack (got "${testResults.textFont}")`,
    );
    assert(
      testResults.buttonFont.toLowerCase().includes('inter'),
      `${env.name}: button computes to Inter design stack (got "${testResults.buttonFont}")`,
    );
    assert(
      testResults.dialogFont.toLowerCase().includes('inter'),
      `${env.name}: dialog computes to Inter design stack (got "${testResults.dialogFont}")`,
    );

    // Assert no leakage of host font into panel
    assert(
      !testResults.panelFont.toLowerCase().includes(env.forbiddenFontSnippet),
      `${env.name}: panel does not leak host font ("${env.forbiddenFontSnippet}")`,
    );
    assert(
      !testResults.dialogFont.toLowerCase().includes(env.forbiddenFontSnippet),
      `${env.name}: dialog does not leak host font ("${env.forbiddenFontSnippet}")`,
    );

    // Assert actual Rendered Platform Fonts via Chrome DevTools Protocol
    const doc = await sendCdp<{ root: { nodeId: number } }>('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });

    const hostRes = await sendCdp<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '#monitor-panel-host',
    });

    const desc = await sendCdp<{ node: any }>('DOM.describeNode', {
      nodeId: hostRes.nodeId,
      depth: -1,
      pierce: true,
    });

    function findInNode(n: any, id: string): any {
      if (n.attributes) {
        for (let i = 0; i < n.attributes.length; i += 2) {
          if (n.attributes[i] === 'id' && n.attributes[i + 1] === id) return n;
        }
      }
      if (n.children) {
        for (const c of n.children) {
          const found = findInNode(c, id);
          if (found) return found;
        }
      }
      if (n.shadowRoots) {
        for (const s of n.shadowRoots) {
          const found = findInNode(s, id);
          if (found) return found;
        }
      }
      return null;
    }

    async function getRenderedFont(elementId: string): Promise<string> {
      const target = findInNode(desc.node, elementId);
      if (!target?.backendNodeId) return '';
      const pushRes = await sendCdp<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [target.backendNodeId],
      });
      if (!pushRes.nodeIds?.[0]) return '';
      const fontRes = await sendCdp<{
        fonts: Array<{ familyName: string; isCustomFont: boolean }>;
      }>('CSS.getPlatformFontsForNode', {
        nodeId: pushRes.nodeIds[0],
      });
      return fontRes.fonts?.[0]?.familyName ?? '';
    }

    const headerPlatformFont = await getRenderedFont('target-header');
    const textPlatformFont = await getRenderedFont('target-text');
    const buttonPlatformFont = await getRenderedFont('target-button');
    const dialogPlatformFont = await getRenderedFont('target-dialog');

    assert(
      headerPlatformFont === 'Inter Variable',
      `${env.name}: header renders true Inter Variable (got "${headerPlatformFont}")`,
    );
    assert(
      textPlatformFont === 'Inter Variable',
      `${env.name}: text renders true Inter Variable (got "${textPlatformFont}")`,
    );
    assert(
      buttonPlatformFont === 'Inter Variable',
      `${env.name}: button renders true Inter Variable (got "${buttonPlatformFont}")`,
    );
    assert(
      dialogPlatformFont === 'Inter Variable',
      `${env.name}: dialog renders true Inter Variable (got "${dialogPlatformFont}")`,
    );

    // Clean up
    await evaluateInBrowser(`() => {
      document.querySelectorAll('monitor-panel').forEach(el => el.remove());
    }`);
  }

  section('Real-browser tests completed successfully');
} finally {
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  if (chromeProcess) {
    try {
      chromeProcess.kill();
    } catch {}
  }
}
