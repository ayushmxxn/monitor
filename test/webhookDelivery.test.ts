/**
 * H2: webhook/Discord delivery must complete inside the background
 * message-handler lifetime instead of being fire-and-forget.
 *
 * Covers: successful delivery, non-2xx failure, 429 rate-limit,
 * invalid URL, unreachable host, network timeout, and proof that a
 * webhook failure never changes the monitor-check result (notifyChange
 * still resolves and the system notification is still sent).
 *
 * The timing assertion (`/slow` endpoint) is the behavioral proof of
 * the fix: before it, notifyChange resolved in milliseconds while the
 * POST was still in flight (killable by SW suspension); after it, the
 * POST completes first.
 */
import { postWebhookAlert } from '../lib/monitors/webhook';
import { postDiscordAlert, buildDiscordPayload, isValidDiscordWebhookUrl } from '../lib/monitors/discord';
import { notifyChange } from '../lib/monitors/notify';
import { settingsItem } from '../lib/storage/items';
import { DEFAULT_SETTINGS } from '../lib/storage/schema';

// Untyped on purpose: this repo's tsconfig has no `bun` typings.
const BunRuntime = (globalThis as { Bun?: any }).Bun;

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
const PORT = 48751;
const base = `http://127.0.0.1:${PORT}`;
const hits: Array<{ path: string; body: string }> = [];
const releaseHang: Array<() => void> = [];

const server = BunRuntime.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    if (req.method !== 'POST') return new Response('nf', { status: 404 });
    if (url.pathname === '/hang') {
      await new Promise<void>((resolve) => {
        releaseHang.push(resolve);
      });
      return new Response('released');
    }
    if (url.pathname === '/slow') {
      await sleep(1500);
      const slowBody = await req.text();
      hits.push({ path: url.pathname, body: slowBody });
      return Response.json({});
    }
    if (url.pathname === '/fail') return new Response('boom', { status: 500 });
    if (url.pathname === '/ratelimit') return Response.json({ retry_after: 1 }, { status: 429 });
    const body = await req.text();
    hits.push({ path: url.pathname, body });
    return Response.json({});
  },
});

const payload = {
  event: 'monitor.changed',
  monitorId: 'm1',
  monitorName: 'BTC price',
  url: 'https://example.com/item',
  previousValue: '$90.00',
  currentValue: '$100.00',
  message: '$90.00 → $100.00 (+$10.00)',
  checkedAt: Date.now(),
} as Parameters<typeof postWebhookAlert>[1];

section('H2: generic webhook transport matrix');

const okHit = await postWebhookAlert(`${base}/ok`, payload);
assert(okHit === true, 'successful delivery returns true');
const logged = hits.find((h) => h.path === '/ok');
assert(!!logged && JSON.parse(logged.body).event === 'monitor.changed', 'receiver gets the alert payload');

assert((await postWebhookAlert(`${base}/fail`, payload)) === false, 'non-2xx resolves false');
assert((await postWebhookAlert(`${base}/ratelimit`, payload)) === false, '429 resolves false without retry');
assert((await postWebhookAlert('not-a-url', payload)) === false, 'invalid URL resolves false without network');
assert(
  (await postWebhookAlert(`${base}/ok`, payload).then(
    () => true,
    () => false,
  )) === true,
  'sender never rejects on success path',
);

const unreachable = await postWebhookAlert('http://127.0.0.1:9/nope', payload);
assert(unreachable === false, 'unreachable host resolves false');

const t0 = Date.now();
const timedOut = await postWebhookAlert(`${base}/hang`, payload);
const dt = Date.now() - t0;
assert(timedOut === false, 'hung request resolves false via timeout');
assert(dt >= 7000 && dt < 20000, `timeout bounds the wait (~8s, took ${dt}ms)`);

section('H2: discord poster (validator, payload, graceful failure)');

assert(
  isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123456/abcdef-token_123') === true,
  'accepts genuine discord webhook URL',
);
assert(isValidDiscordWebhookUrl('https://example.com/api/webhooks/123/tok') === false, 'rejects non-discord host');
assert(isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123/tok') === false, 'rejects plain http');
assert(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123') === false, 'rejects missing token');

const discordPayload = buildDiscordPayload(
  { id: 'm1', name: 'BTC price', url: 'https://example.com/item' } as Parameters<typeof buildDiscordPayload>[0],
  '$90.00 → $100.00 (+$10.00)',
);
assert(typeof discordPayload.content === 'string' && discordPayload.content.includes('BTC price'), 'content carries monitor details');
assert(discordPayload.allowed_mentions.parse.length === 0, 'mentions suppressed');

assert((await postDiscordAlert('not-a-url', discordPayload)) === false, 'invalid discord URL resolves false');
// Localhost can never pass discord validation, so this must fail closed without network use.
assert((await postDiscordAlert(`${base}/ok`, discordPayload)) === false, 'non-discord host rejected before POST');

section('H2: webhook failure never changes the monitor-check result');

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
try {
  const monitor = { id: 'm1', name: 'BTC price', url: 'https://example.com/item' } as Parameters<
    typeof notifyChange
  >[0];

  // Failing webhook: check still resolves, system notification still sent.
  (settingsItem as any).getValue = async () => ({
    ...DEFAULT_SETTINGS,
    notificationsEnabled: true,
    webhookEnabled: true,
    webhookUrl: 'not-a-valid-url',
  });
  const r1 = await notifyChange(monitor, '$100.00', '$90.00', null, null);
  assert(r1 === undefined, 'notifyChange resolves void with a failing webhook');
  assert(notificationsCreated.length === 1, 'system notification still sent when webhook fails');

  // Slow webhook: notifyChange must wait for the in-flight POST to finish.
  (settingsItem as any).getValue = async () => ({
    ...DEFAULT_SETTINGS,
    notificationsEnabled: false,
    webhookEnabled: true,
    webhookUrl: `${base}/slow`,
  });
  const s0 = Date.now();
  await notifyChange(monitor, '$100.00', '$90.00', null, null);
  const sdt = Date.now() - s0;
  assert(sdt >= 1200, `notifyChange awaits the in-flight POST (took ${sdt}ms)`);
  assert(hits.some((h) => h.path === '/slow'), 'slow POST completed delivery before resolve');

  // Finding 1: a failing settings read skips delivery silently and never
  // fails the check (no throw, no notification attempt).
  (settingsItem as any).getValue = async () => {
    throw new Error('storage backend unavailable');
  };
  const before = notificationsCreated.length;
  const r2 = await notifyChange(monitor, '$100.00', '$90.00', null, null);
  assert(r2 === undefined, 'notifyChange resolves void when the settings read fails');
  assert(
    notificationsCreated.length === before,
    'no notification attempted without readable settings',
  );
} finally {
  (settingsItem as any).getValue = origGetValue;
  if (realBrowser === undefined) delete (globalThis as any).browser;
  else (globalThis as any).browser = realBrowser;
}

releaseHang.forEach((release) => release());
server.stop();

console.log('\nAll webhook delivery tests finished.');
