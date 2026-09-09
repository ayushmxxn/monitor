import { deriveSources, filterMonitorsBySource, getMonitorHostname } from '../components/panel/Panel';

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

section('1. getMonitorHostname');
{
  assert(getMonitorHostname('https://youtube.com/watch?v=123') === 'youtube.com', 'extracts youtube.com hostname');
  assert(getMonitorHostname('https://coinmarketcap.com/currencies/bitcoin/') === 'coinmarketcap.com', 'extracts coinmarketcap.com hostname');
  assert(getMonitorHostname('https://21st.dev/components') === '21st.dev', 'extracts 21st.dev hostname');
  assert(getMonitorHostname('https://umami.is/docs') === 'umami.is', 'extracts umami.is hostname');
  assert(getMonitorHostname('invalid-url') === null, 'returns null for invalid url');
  assert(getMonitorHostname('') === null, 'returns null for empty string');
}

section('2. deriveSources: hostnames derivation, deduplication, sorting');
{
  const monitors = [
    { id: '1', url: 'https://youtube.com/watch?v=1' },
    { id: '2', url: 'https://coinmarketcap.com/currencies/ethereum/' },
    { id: '3', url: 'https://youtube.com/channel/xyz' },
    { id: '4', url: 'https://21st.dev/templates' },
    { id: '5', url: 'https://umami.is/features' },
    { id: '6', url: 'https://coinmarketcap.com/currencies/solana/' },
  ];

  const sources = deriveSources(monitors);
  assert(sources.length === 4, `deduplicates hostnames to 4 unique sources (got ${sources.length})`);
  assert(sources[0] === '21st.dev', `sorted alphabetically 1st: 21st.dev (got ${sources[0]})`);
  assert(sources[1] === 'coinmarketcap.com', `sorted alphabetically 2nd: coinmarketcap.com (got ${sources[1]})`);
  assert(sources[2] === 'umami.is', `sorted alphabetically 3rd: umami.is (got ${sources[2]})`);
  assert(sources[3] === 'youtube.com', `sorted alphabetically 4th: youtube.com (got ${sources[3]})`);

  const emptySources = deriveSources([]);
  assert(emptySources.length === 0, 'empty monitors array yields empty sources');

  const invalidUrlSources = deriveSources([{ url: 'not-a-url' }]);
  assert(invalidUrlSources.length === 0, 'ignores invalid urls without crashing');
}

section('3. filterMonitorsBySource: filtering behavior and All restore');
{
  const monitors = [
    { id: '1', name: 'YT Subs', url: 'https://youtube.com/watch?v=1' },
    { id: '2', name: 'BTC Price', url: 'https://coinmarketcap.com/currencies/bitcoin/' },
    { id: '3', name: 'YT Views', url: 'https://youtube.com/watch?v=2' },
    { id: '4', name: 'Umami Visitors', url: 'https://umami.is/stats' },
  ];

  const allFiltered = filterMonitorsBySource(monitors, 'all');
  assert(allFiltered.length === 4, 'selecting All restores complete monitor list');

  const ytFiltered = filterMonitorsBySource(monitors, 'youtube.com');
  assert(ytFiltered.length === 2, 'selecting youtube.com returns only youtube monitors');
  assert(ytFiltered.every((m) => m.url.includes('youtube.com')), 'all returned monitors match youtube.com');

  const btcFiltered = filterMonitorsBySource(monitors, 'coinmarketcap.com');
  assert(btcFiltered.length === 1 && btcFiltered[0]?.name === 'BTC Price', 'selecting coinmarketcap.com returns correct single monitor');

  const nonexistentFiltered = filterMonitorsBySource(monitors, 'nonexistent.com');
  assert(nonexistentFiltered.length === 0, 'nonexistent hostname returns empty array without error');
}

console.log(`\n${failures === 0 ? 'All source filter tests passed.' : `${failures} source filter assertion(s) FAILED.`}`);
if (failures > 0) process.exit(1);
