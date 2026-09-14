/**
 * Real-browser regression test for font isolation.
 *
 * Launches headless Chromium and verifies real computed styles of:
 * - The root monitor panel container
 * - Headers, text, and buttons
 * - Portaled dialogs (e.g. Delete / Clear all monitors dialogs)
 * across YouTube (Roboto, 10px root), ChatGPT (-apple-system-body),
 * and a static landing page.
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

// Compile production globals.css
const rawCompiled = (
  await postcss(config.plugins).process(readFileSync('./styles/globals.css', 'utf8'), {
    from: './styles/globals.css',
  })
).css;
const panelCss = rawCompiled.replaceAll(':root', ':host');

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
  for (let i = 0; i < 20; i++) {
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
    },
    {
      name: 'ChatGPT',
      bodyStyle:
        'font-family: -apple-system-body, ui-sans-serif, -apple-system, "system-ui", "Segoe UI", Helvetica, Arial, sans-serif; font-size: 16px;',
      htmlStyle: 'font-size: 16px;',
      forbiddenFontSnippet: '-apple-system-body',
    },
    {
      name: 'Static landing page',
      bodyStyle: 'font-family: system-ui, sans-serif; font-size: 16px;',
      htmlStyle: 'font-size: 16px;',
      forbiddenFontSnippet: 'times new roman',
    },
  ];

  section('Real-browser typography isolation & computed font verification');

  for (const env of HOST_ENVIRONMENTS) {
    const testResults = await evaluateInBrowser<{
      occupiesSpaceInFlow: boolean;
      panelFont: string;
      headerFont: string;
      textFont: string;
      buttonFont: string;
      dialogFont: string;
    }>(`() => {
      document.documentElement.style.cssText = ${JSON.stringify(env.htmlStyle)};
      document.body.style.cssText = ${JSON.stringify(env.bodyStyle)};

      // Measure document flow height before injecting panel
      const bodyHeightBefore = document.body.offsetHeight;

      // Clean up any existing test elements
      const existing = document.querySelector('monitor-panel');
      if (existing) existing.remove();

      // Create host with applyShadowHostIsolation
      const host = document.createElement('monitor-panel');
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
      header.className = 'text-[13px] font-semibold tracking-tight';
      header.textContent = 'Monitor';
      panel.appendChild(header);

      const text = document.createElement('p');
      text.className = 'text-[11px] text-muted-foreground';
      text.textContent = 'Track any element on this page.';
      panel.appendChild(text);

      const button = document.createElement('button');
      button.className = 'inline-flex items-center justify-center rounded-md text-xs font-medium bg-primary text-primary-foreground h-8 px-3';
      button.textContent = 'New monitor';
      panel.appendChild(button);

      // Portaled Dialog content inside the shadow DOM container
      const dialogPortal = document.createElement('div');
      dialogPortal.className = 'fixed inset-0 z-50 font-sans';
      const dialogCard = document.createElement('div');
      dialogCard.className = 'left-1/2 top-1/2 z-50 w-[calc(100%-2.5rem)] max-w-sm rounded-lg border bg-popover p-4 text-popover-foreground shadow-2xl font-sans';
      const dialogTitle = document.createElement('h2');
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

      const bodyHeightAfter = document.body.offsetHeight;

      const result = {
        occupiesSpaceInFlow: bodyHeightBefore !== bodyHeightAfter,
        panelFont: getComputedStyle(panel).fontFamily,
        headerFont: getComputedStyle(header).fontFamily,
        textFont: getComputedStyle(text).fontFamily,
        buttonFont: getComputedStyle(button).fontFamily,
        dialogFont: getComputedStyle(dialogTitle).fontFamily,
      };

      host.remove();
      return result;
    }`);

    // Assert host layout isolation (zero page footprint)
    assert(
      !testResults.occupiesSpaceInFlow,
      `${env.name}: shadow host has zero page footprint in document flow`,
    );

    // Assert panel typography
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
