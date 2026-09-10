/**
 * Telegram alerts: configuration validation, HTML-safe message
 * formatting, best-effort delivery (8s timeout, no retries, never
 * throws), and fan-out from the shared notifyChange path without ever
 * failing the check.
 */
import {
  buildTelegramMessage,
  isValidTelegramBotToken,
  isValidTelegramChatId,
  sendTelegramAlert,
  testTelegramDelivery,
} from '../lib/monitors/telegram';
import { deliverTestAlert } from '../lib/monitors/testDelivery';
import { notifyChange } from '../lib/monitors/notify';
import { settingsItem } from '../lib/storage/items';
import { DEFAULT_SETTINGS } from '../lib/storage/schema';
import { calculateValueChange, type ValueChangeSummary } from '../lib/monitors/changeSummary';
import { detectSemanticValue } from '../lib/monitors/semanticValue';
import type { Monitor } from '../lib/monitors/types';

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

function monitorOf(name: string, url: string): Monitor {
  return { id: 'm1', name, url } as Monitor;
}

function changeOf(previousValue: string | null, currentValue: string): ValueChangeSummary {
  const prevSem = previousValue === null ? null : detectSemanticValue(previousValue);
  return calculateValueChange(previousValue, prevSem, currentValue, detectSemanticValue(currentValue));
}

function build(name: string, url: string, prev: string | null, curr: string) {
  return buildTelegramMessage(monitorOf(name, url), prev, curr, changeOf(prev, curr));
}

section('Telegram configuration validation');

{
  assert(isValidTelegramBotToken('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11') === true, 'accepts a real-shaped token');
  assert(isValidTelegramBotToken('  123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11  ') === true, 'trims surrounding whitespace');
  assert(isValidTelegramBotToken('') === false, 'rejects empty token');
  assert(isValidTelegramBotToken('not-a-token') === false, 'rejects token without separator');
  assert(isValidTelegramBotToken('abc:short') === false, 'rejects short/non-numeric id parts');
  assert(isValidTelegramBotToken('123456:abc def') === false, 'rejects spaces inside the secret');
  assert(isValidTelegramChatId('123456789') === true, 'accepts a user chat id');
  assert(isValidTelegramChatId('-1001234567890') === true, 'accepts a negative group chat id');
  assert(isValidTelegramChatId('') === false, 'rejects empty chat id');
  assert(isValidTelegramChatId('abc') === false, 'rejects non-numeric chat id');
  assert(isValidTelegramChatId('12.5') === false, 'rejects decimal chat id');
}

section('Telegram message formatting');

{
  const text = build('BTC price', 'https://example.com/item', '$90.00', '$100.00');
  assert(text.includes('<b>BTC price changed</b>'), 'title names the monitor');
  assert(text.includes('$90.00 → $100.00'), 'transition shows previous and current');
  assert(text.includes('↑ +$10.00 · +11.1%'), `change line formatted (got ${JSON.stringify(text)})`);
  assert(
    text.includes('Source: <a href="https://example.com/item">example.com</a>'),
    'source link is clickable with the domain as text',
  );
  assert(!text.includes('```'), 'no code blocks anywhere');
}

{
  const evil = build('<Price> & "deal"', 'https://example.com/item', 'a<b', 'c&d');
  assert(!evil.includes('<Price>') && evil.includes('&lt;Price&gt;'), 'monitor name escaped');
  assert(evil.includes('a&lt;b') && evil.includes('c&amp;d'), 'values escaped so markup cannot break');
  assert(!/<(?!\/?(b|a)\b)/.test(evil.replace(/<a href="[^"]*">|<\/a>|<\/?b>/g, '')), 'no stray tags from page content');
}

{
  const textOnly = build('Stock status', 'https://example.com/item', 'In Stock', 'Out of Stock');
  assert(textOnly.includes('In Stock → Out of Stock'), 'text transition shown');
  assert(!textOnly.includes('↑') && !textOnly.includes('↓'), 'text alerts carry no delta arrow');
}

{
  const missing = build('BTC price', 'https://example.com/item', null, '$100.00');
  assert(!missing.startsWith('→') && missing.includes('$100.00'), 'missing previous shows current only');
}

{
  const bad = build('BTC price', 'not a url', '$90.00', '$100.00');
  assert(bad.includes('Link unavailable'), 'invalid URL degrades to plain text');
  assert(!bad.includes('<a href'), 'no link emitted for invalid URLs');
}

{
  const long = build('n'.repeat(500), 'https://example.com/item', 'p'.repeat(3000), 'c'.repeat(3000));
  assert(long.length <= 2001, `long alert stays within budget (got ${long.length})`);
}

section('Telegram delivery: success, failure, timeout, no retries');

const realFetch = globalThis.fetch;

async function withFetchStub(
  stub: (url: unknown, init: any) => Promise<{ ok: boolean; status?: number }>,
  fn: (calls: Array<{ url: string; body: any }>) => Promise<void>,
) {
  const calls: Array<{ url: string; body: any }> = [];
  (globalThis as any).fetch = async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return stub(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  await withFetchStub(async () => ({ ok: true }), async (calls) => {
    const ok = await sendTelegramAlert('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi');
    assert(ok === true, 'successful delivery returns true');
    assert(calls.length === 1, 'exactly one POST, no retry machinery');
    assert(
      calls[0].url === 'https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage',
      'posts to the official Bot API sendMessage endpoint',
    );
    assert(calls[0].body.chat_id === '123456789', 'chat id sent in the body');
    assert(calls[0].body.parse_mode === 'HTML', 'HTML parse mode used');
    assert(calls[0].body.disable_web_page_preview === true, 'link previews disabled');
    assert(!JSON.stringify(calls[0].body).includes('ABC-DEF'), 'body carries no token material');
  });
}

{
  await withFetchStub(async () => ({ ok: false, status: 429 }), async (calls) => {
    const ok = await sendTelegramAlert('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi');
    assert(ok === false, '429 resolves false');
    assert(calls.length === 1, 'rate limit triggers no retry');
  });
}

{
  await withFetchStub(async () => ({ ok: false, status: 401 }), async () => {
    assert(
      (await sendTelegramAlert('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi')) === false,
      'invalid credentials (401) resolve false',
    );
  });
}

{
  await withFetchStub(async () => {
    throw new Error('network unreachable');
  }, async () => {
    assert(
      (await sendTelegramAlert('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi')) === false,
      'unreachable API resolves false',
    );
  });
  assert(
    (await sendTelegramAlert('bad-token', '123', 'hi')) === false,
    'invalid credentials never touch the network path as valid',
  );
  assert((await sendTelegramAlert('', '', 'hi')) === false, 'empty credentials resolve false');
}

{
  await withFetchStub(
    (url, init) =>
      new Promise<{ ok: boolean }>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('already aborted'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    async () => {
      const t0 = Date.now();
      const ok = await sendTelegramAlert('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi');
      const dt = Date.now() - t0;
      assert(ok === false, 'hung request resolves false via timeout');
      assert(dt >= 7500 && dt < 20000, `timeout bounds the wait (~8s, took ${dt}ms)`);
    },
  );
}

section('Telegram background test path and notify fan-out');

{
  assert(
    (await deliverTestAlert({ kind: 'telegram', url: '', payload: 'hi', botToken: 'bad', chatId: '1' })) === false,
    'background test rejects invalid credentials without network use',
  );
  assert(
    (await deliverTestAlert({ kind: 'telegram', url: '', payload: 123 as any, botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', chatId: '123456789' })) === false,
    'background test rejects malformed payloads',
  );
  assert(
    (await testTelegramDelivery('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', '123456789', 'hi')) === false,
    'test sender resolves false without a background worker',
  );
}

{
  const notificationsCreated: Array<string> = [];
  const realBrowser = (globalThis as any).browser;
  (globalThis as any).browser = {
    notifications: {
      create: async (id: string) => {
        notificationsCreated.push(id);
        return id;
      },
    },
    runtime: { getURL: (p: string) => p },
  };
  const origGetValue = settingsItem.getValue;
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    throw new Error('telegram unreachable');
  };
  try {
    (settingsItem as any).getValue = async () => ({
      ...DEFAULT_SETTINGS,
      notificationsEnabled: true,
      webhookEnabled: true,
      webhookUrl: 'not-a-valid-url',
      discordEnabled: true,
      discordWebhookUrl: 'not-a-valid-url',
      telegramEnabled: true,
      telegramBotToken: 'not-a-valid-token',
      telegramChatId: 'not-a-chat-id',
    });
    const monitor = { id: 'm1', name: 'BTC price', url: 'https://example.com/item' } as Monitor;
    const result = await notifyChange(monitor, '$100.00', '$90.00', null, null);
    assert(result === undefined, 'notifyChange resolves with all three channels failing');
    assert(notificationsCreated.length === 1, 'system notification still sent when every integration fails');
  } finally {
    (settingsItem as any).getValue = origGetValue;
    globalThis.fetch = origFetch;
    if (realBrowser === undefined) delete (globalThis as any).browser;
    else (globalThis as any).browser = realBrowser;
  }
}

console.log('\nAll Telegram tests finished.');
