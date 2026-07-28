import { parseFeed } from '../src/lib/rss.js';
import { fetchText } from '../src/lib/http-client.js';

async function main() {
  for (const [name, url] of [
    ['yahoo XTB.WA', 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=XTB.WA&region=US&lang=en-US'],
    ['bankier', 'https://www.bankier.pl/rss/wiadomosci.xml'],
    ['bankier-gielda', 'https://www.bankier.pl/rss/gielda.xml'],
  ] as const) {
    try {
      const xml = await fetchText(url, { retries: 1 });
      const entries = parseFeed(xml);
      console.log(`${name}: ${entries.length} wpisów`);
      if (entries[0]) console.log(`   ${entries[0].publishedAt.slice(0, 10)} | ${entries[0].title.slice(0, 60)}`);
    } catch (e) {
      console.log(`${name}: BŁĄD ${String(e).slice(0, 80)}`);
    }
  }
}
main();
