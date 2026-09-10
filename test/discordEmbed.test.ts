/**
 * Discord embed formatting: every alert is exactly one native embed:
 * 1. Embed title linked to monitored URL
 * 2. Bold value transition ("previous → new")
 * 3. Direction-colored delta & percentage in ANSI (green for increase, red for decrease)
 * 4. Website favicon placed directly in front of source domain in footer
 * 5. Localized embed timestamp
 */
import { buildDiscordPayload, resolveFaviconUrl } from '../lib/monitors/discord';
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
const EXPECTED_ISO_TIMESTAMP = new Date(CHECKED_AT).toISOString();

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

section('Discord single-embed structure');

{
  const payload = build('x.com', 'https://x.com', '971', '975');
  assert(Array.isArray(payload.embeds) && payload.embeds.length === 1, 'exactly one embed');
  assert(!('content' in payload), 'no content field at all');
  const [embed] = payload.embeds;

  assert(embed.url === 'https://x.com/', 'embed URL links to source');
  assert(embed.title === 'x.com changed', `title names the monitor (got ${JSON.stringify(embed.title)})`);
  assert(
    embed.description === '**971 → 975**\n```ansi\n\u001b[32m↑ +4 · +0.4%\u001b[0m\n```',
    `description contains ANSI green delta and percentage (got ${JSON.stringify(embed.description)})`,
  );
  assert(embed.color === 0x57f287, 'increase is green');
  assert(embed.footer?.text === 'x.com', `footer text carries source domain (got ${JSON.stringify(embed.footer?.text)})`);
  assert(
    embed.footer?.icon_url === 'https://www.google.com/s2/favicons?domain=x.com&sz=64',
    `footer carries domain favicon in front of domain (got ${JSON.stringify(embed.footer?.icon_url)})`,
  );
  assert(embed.timestamp === EXPECTED_ISO_TIMESTAMP, 'timestamp present on embed');
  assert(payload.allowed_mentions.parse.length === 0, 'mentions suppressed');
}

section('Discord embeds across monitor types');

{
  const pct = build('Uptime', 'https://example.com/status', '87%', '82%');
  assert(
    pct.embeds[0].description === '**87% → 82%**\n```ansi\n\u001b[31m↓ -5.0%\u001b[0m\n```',
    `percentage decrease formatted with ANSI red (got ${JSON.stringify(pct.embeds[0].description)})`,
  );
  assert(pct.embeds[0].color === 0xed4245, 'decrease is red');
  assert(pct.embeds[0].footer?.text === 'example.com', 'percentage footer carries domain');
  assert(pct.embeds[0].footer?.icon_url?.includes('example.com') === true, 'percentage footer carries favicon');
}

{
  const text = build('Stock status', 'https://example.com/item', 'In Stock', 'Out of Stock');
  assert(
    text.embeds[0].description === '**In Stock → Out of Stock**',
    `text transition without change line (got ${JSON.stringify(text.embeds[0].description)})`,
  );
  assert(text.embeds[0].color === 0x95a5a6, 'text change is neutral');
  assert(text.embeds[0].footer?.text === 'example.com', 'text alert footer domain');
}

{
  const analytics = build('Followers', 'https://example.com/channel', '12.4K followers', '13.1K followers');
  assert(
    analytics.embeds[0].description === '**12.4K followers → 13.1K followers**\n```ansi\n\u001b[32m↑ +700 · +5.6%\u001b[0m\n```',
    `analytics delta formatted with ANSI green (got ${JSON.stringify(analytics.embeds[0].description)})`,
  );
  assert(analytics.embeds[0].color === 0x57f287, 'analytics increase is green');
}

{
  const yt = build('Subs', 'https://www.youtube.com/@channel', '1.2M subscribers', '1.5M subscribers');
  assert(
    yt.embeds[0].description === '**1.2M subscribers → 1.5M subscribers**\n```ansi\n\u001b[32m↑ +300.0K · +25.0%\u001b[0m\n```',
    `YouTube delta formatted with ANSI green (got ${JSON.stringify(yt.embeds[0].description)})`,
  );
  assert(yt.embeds[0].footer?.icon_url?.includes('www.youtube.com') === true, 'YouTube favicon attached');
  assert(yt.embeds[0].footer?.text === 'www.youtube.com', 'YouTube footer text');
}

section('Discord embed edge cases');

{
  const missing = build('BTC price', 'https://example.com/item', null, '$100.00');
  assert(
    missing.embeds[0].description === '**$100.00**',
    `missing previous shows current only (got ${JSON.stringify(missing.embeds[0].description)})`,
  );
  assert(missing.embeds[0].footer?.text === 'example.com', 'missing previous footer text');
}

{
  const same = build('BTC price', 'https://example.com/item', '$100.00', '$100.00');
  assert(same.embeds[0].color === 0x95a5a6, 'zero change is neutral, not a crash');
  assert(
    same.embeds[0].description === '**$100.00 → $100.00**\n+$0.00 · +0.0%',
    `zero change stays plain text (got ${JSON.stringify(same.embeds[0].description)})`,
  );
}

{
  const neg = build('Volume', 'https://example.com/stats', '27.0K', '26.0K');
  assert(
    neg.embeds[0].description === '**27.0K → 26.0K**\n```ansi\n\u001b[31m↓ -1.0K · -3.7%\u001b[0m\n```',
    `negative compact delta formatted with ANSI red (got ${JSON.stringify(neg.embeds[0].description)})`,
  );
}

{
  const schemeLess = build('Bitcoin', 'coinmarketcap.com/currencies/bitcoin', '$90.00', '$100.00');
  assert(
    schemeLess.embeds[0].url === 'https://coinmarketcap.com/currencies/bitcoin',
    `scheme-less URL resolves embed.url (got ${JSON.stringify(schemeLess.embeds[0].url)})`,
  );
  assert(
    schemeLess.embeds[0].footer?.icon_url === 'https://www.google.com/s2/favicons?domain=coinmarketcap.com&sz=64',
    `scheme-less URL resolves favicon (got ${JSON.stringify(schemeLess.embeds[0].footer?.icon_url)})`,
  );
  assert(
    schemeLess.embeds[0].footer?.text === 'coinmarketcap.com',
    `scheme-less URL resolves footer domain (got ${JSON.stringify(schemeLess.embeds[0].footer?.text)})`,
  );
}

{
  const bad = build('BTC price', 'not a url', '$90.00', '$100.00');
  assert(
    bad.embeds[0].description === '**$90.00 → $100.00**\n```ansi\n\u001b[32m↑ +$10.00 · +11.1%\u001b[0m\n```',
    `invalid URL degrades gracefully (got ${JSON.stringify(bad.embeds[0].description)})`,
  );
  assert(bad.embeds[0].footer?.text === 'Link unavailable', 'invalid URL reports unavailable');
  assert(!('icon_url' in (bad.embeds[0].footer ?? {})), 'invalid URL does not set broken icon_url');
  assert(!('url' in bad.embeds[0]), 'invalid URL does not set invalid embed.url');
}

{
  const long = build('n'.repeat(500), 'https://example.com/item', 'p'.repeat(3000), 'c'.repeat(3000));
  assert(!('content' in long), 'long alert still has no content field');
  assert(JSON.stringify(long).length <= 2000, `long alert stays within budget (got ${JSON.stringify(long).length})`);
}

console.log('\nAll Discord embed tests finished.');
