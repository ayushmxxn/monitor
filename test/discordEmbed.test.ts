/**
 * Discord embed formatting: every alert is exactly one native embed -
 * bold value transition, plain-text change line, and a metadata row
 * with a clickable domain link plus relative time. Never any code
 * fences, inline code, or preformatted blocks (they render as tinted
 * boxes and copy-paste as code). Covers numeric, percentage, text,
 * analytics, and YouTube shapes plus edge cases.
 */
import { buildDiscordPayload } from '../lib/monitors/discord';
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

const CHECKED_AT = 1788988186422;
const TIME_TAG = '<t:1788988186:R>';

function monitorOf(name: string, url: string): Monitor {
  return { id: 'm1', name, url } as Monitor;
}

function changeOf(previousValue: string | null, currentValue: string): ValueChangeSummary {
  const prevSem = previousValue === null ? null : detectSemanticValue(previousValue);
  return calculateValueChange(previousValue, prevSem, currentValue, detectSemanticValue(currentValue));
}

function build(name: string, url: string, prev: string | null, curr: string, at = CHECKED_AT) {
  return buildDiscordPayload(monitorOf(name, url), prev, curr, changeOf(prev, curr), at);
}

/** Every http(s) URL must sit inside a markdown link target, never bare. */
function assertNoBareUrl(payload: unknown, message: string) {
  assert(/(?<!\()https?:\/\//.test(JSON.stringify(payload)) === false, message);
}

/** No code formatting anywhere: no fences, inline code, or pre blocks. */
function assertNoCodeFormatting(payload: unknown, message: string) {
  const json = JSON.stringify(payload);
  assert(!/```/.test(json), `${message} (no code fences)`);
  assert(!/<\/?pre/i.test(json), `${message} (no pre tags)`);
}

section('Discord single-embed structure');

{
  const payload = build('BTC price', 'https://example.com/item', '$90.00', '$100.00');
  assert(Array.isArray(payload.embeds) && payload.embeds.length === 1, 'exactly one embed');
  assert(!('content' in payload), 'no content field at all');
  const [embed] = payload.embeds;
  assert(
    JSON.stringify(Object.keys(embed).sort()) === JSON.stringify(['color', 'description', 'title']),
    `embed has only title/description/color (got ${JSON.stringify(Object.keys(embed).sort())})`,
  );
  assert(embed.title === 'BTC price changed', `title names the monitor (got ${JSON.stringify(embed.title)})`);
  assert(
    embed.description ===
      `**$90.00 → $100.00**\n\n↑ +$10.00 · +11.1%\n\n[example.com](https://example.com/item) · ${TIME_TAG}`,
    `description hierarchy matches (got ${JSON.stringify(embed.description)})`,
  );
  assert(embed.color === 0x57f287, 'increase is green');
  assert(payload.allowed_mentions.parse.length === 0, 'mentions suppressed');
  assertNoBareUrl(payload, 'linked URL only, so no preview');
  assertNoCodeFormatting(payload, 'plain change text');
}

section('Discord embeds across monitor types');

{
  const pct = build('Uptime', 'https://example.com/status', '87%', '82%');
  assert(
    pct.embeds[0].description ===
      `**87% → 82%**\n\n↓ -5.0%\n\n[example.com](https://example.com/status) · ${TIME_TAG}`,
    `percentage decrease formatted (got ${JSON.stringify(pct.embeds[0].description)})`,
  );
  assert(pct.embeds[0].color === 0xed4245, 'decrease is red');
  assertNoBareUrl(pct, 'linked URL only on percentage alerts');
  assertNoCodeFormatting(pct, 'plain change text on percentage alerts');
}

{
  const text = build('Stock status', 'https://example.com/item', 'In Stock', 'Out of Stock');
  assert(
    text.embeds[0].description === `**In Stock → Out of Stock**\n\n[example.com](https://example.com/item) · ${TIME_TAG}`,
    `text transition without a change line (got ${JSON.stringify(text.embeds[0].description)})`,
  );
  assert(text.embeds[0].color === 0x95a5a6, 'text change is neutral');
  assertNoBareUrl(text, 'linked URL only on text alerts');
}

{
  const analytics = build('Followers', 'https://example.com/channel', '12.4K followers', '13.1K followers');
  assert(
    analytics.embeds[0].description ===
      `**12.4K followers → 13.1K followers**\n\n↑ +700 · +5.6%\n\n[example.com](https://example.com/channel) · ${TIME_TAG}`,
    `analytics delta formatted (got ${JSON.stringify(analytics.embeds[0].description)})`,
  );
  assert(analytics.embeds[0].color === 0x57f287, 'analytics increase is green');
  assertNoBareUrl(analytics, 'linked URL only on analytics alerts');
}

{
  const yt = build('Subs', 'https://www.youtube.com/@channel', '1.2M subscribers', '1.5M subscribers');
  assert(
    yt.embeds[0].description ===
      `**1.2M subscribers → 1.5M subscribers**\n\n↑ +300.0K · +25.0%\n\n[www.youtube.com](https://www.youtube.com/@channel) · ${TIME_TAG}`,
    `YouTube delta formatted (got ${JSON.stringify(yt.embeds[0].description)})`,
  );
  assertNoBareUrl(yt, 'linked URL only on YouTube alerts');
}

section('Discord embed edge cases');

{
  const missing = build('BTC price', 'https://example.com/item', null, '$100.00');
  assert(
    missing.embeds[0].description === `**$100.00**\n\n[example.com](https://example.com/item) · ${TIME_TAG}`,
    `missing previous shows current only (got ${JSON.stringify(missing.embeds[0].description)})`,
  );
  assertNoBareUrl(missing, 'linked URL only when previous is missing');
}

{
  const same = build('BTC price', 'https://example.com/item', '$100.00', '$100.00');
  assert(same.embeds[0].color === 0x95a5a6, 'zero change is neutral, not a crash');
  assert(
    same.embeds[0].description === `**$100.00 → $100.00**\n\n+$0.00 · +0.0%\n\n[example.com](https://example.com/item) · ${TIME_TAG}`,
    `zero change stays plain text (got ${JSON.stringify(same.embeds[0].description)})`,
  );
  assertNoBareUrl(same, 'linked URL only on zero change');
}

{
  const neg = build('Volume', 'https://example.com/stats', '27.0K', '26.0K');
  assert(
    neg.embeds[0].description ===
      `**27.0K → 26.0K**\n\n↓ -1.0K · -3.7%\n\n[example.com](https://example.com/stats) · ${TIME_TAG}`,
    `negative compact delta formatted (got ${JSON.stringify(neg.embeds[0].description)})`,
  );
  assertNoBareUrl(neg, 'linked URL only on negative change');
}

{
  const bad = build('BTC price', 'not a url', '$90.00', '$100.00');
  assert(
    bad.embeds[0].description === `**$90.00 → $100.00**\n\n↑ +$10.00 · +11.1%\n\nLink unavailable · ${TIME_TAG}`,
    `invalid URL degrades gracefully (got ${JSON.stringify(bad.embeds[0].description)})`,
  );
  assertNoBareUrl(bad, 'no linkable URL when invalid');
}

{
  const long = build('n'.repeat(500), 'https://example.com/item', 'p'.repeat(3000), 'c'.repeat(3000));
  assert(!('content' in long), 'long alert still has no content field');
  assert(JSON.stringify(long).length <= 2000, `long alert stays within budget (got ${JSON.stringify(long).length})`);
  assertNoBareUrl(long, 'linked URL only on long alerts');
  assertNoCodeFormatting(long, 'plain text on long alerts');
}

console.log('\nAll Discord embed tests finished.');
