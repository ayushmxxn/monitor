/**
 * Test-button delivery goes through the background worker (the same
 * context real alerts post from), never via a panel content-script
 * fetch that the page's CSP can block. Covers the background handler
 * logic plus the UI-facing senders' failure contract.
 */
import { deliverTestAlert } from '../lib/monitors/testDelivery';
import { testWebhookDelivery as testGenericWebhook } from '../lib/monitors/webhook';
import { testWebhookDelivery as testDiscordWebhook } from '../lib/monitors/discord';

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

section('Background test delivery never throws and validates first');

{
  assert(
    (await deliverTestAlert({ kind: 'discord', url: 'not-a-url', payload: {} as any })) === false,
    'invalid discord URL resolves false without network use',
  );
  assert(
    (await deliverTestAlert({ kind: 'generic', url: '', payload: {} as any })) === false,
    'empty generic URL resolves false',
  );
  assert(
    (await deliverTestAlert(null as any)) === false,
    'malformed input resolves false instead of throwing',
  );
  assert(
    (await deliverTestAlert({
      kind: 'generic',
      url: 'https://discord.com/api/webhooks/123456/abcdef-token_123',
      payload: {} as any,
    })) === false,
    'discord URL under the generic kind is rejected',
  );
  assert(
    (await deliverTestAlert({
      kind: 'discord',
      url: 'https://discord.com/api/webhooks/0/invalid-token-probe',
      payload: { embeds: [], allowed_mentions: { parse: [] } } as any,
    })) === false,
    'unreachable discord webhook resolves false gracefully',
  );
  assert(
    (await deliverTestAlert({
      kind: 'generic',
      url: 'http://127.0.0.1:9/nope',
      payload: { event: 'monitor.changed' } as any,
    })) === false,
    'unreachable generic webhook resolves false gracefully',
  );
}

section('UI test senders use the background message path');

{
  // No messaging runtime here: the senders must fail closed, fast.
  assert(
    (await testGenericWebhook('https://example.com/hook', {} as any)) === false,
    'generic test sender resolves false without a background worker',
  );
  assert(
    (await testDiscordWebhook('https://discord.com/api/webhooks/123456/abcdef-token_123', {} as any)) === false,
    'discord test sender resolves false without a background worker',
  );
}

{
  // With a messaging runtime present, the senders forward the
  // testWebhookDelivery message and honor its boolean result.
  const g = globalThis as any;
  const hadSendMessage = 'sendMessage' in g.chrome.runtime;
  const origSendMessage = g.chrome.runtime.sendMessage;
  let seen: Array<{ type: string; data: unknown }> = [];
  g.chrome.runtime.sendMessage = (msg: any, cb: (res: any) => void) => {
    seen.push({ type: msg?.type, data: msg?.data });
    queueMicrotask(() => cb({ res: true }));
  };
  try {
    const ok = await testDiscordWebhook('https://discord.com/api/webhooks/123456/abcdef-token_123', {} as any);
    assert(ok === true, 'discord test sender returns the background result');
    assert(
      seen.length === 1 && seen[0].type === 'testWebhookDelivery',
      `discord test sender uses the testWebhookDelivery message (got ${JSON.stringify(seen.map((s) => s.type))})`,
    );
    assert(
      (seen[0].data as any)?.kind === 'discord',
      'discord test sender tags the kind for the background handler',
    );
  } finally {
    if (!hadSendMessage) delete g.chrome.runtime.sendMessage;
    else g.chrome.runtime.sendMessage = origSendMessage;
  }
}

console.log('\nAll test-delivery tests finished.');
