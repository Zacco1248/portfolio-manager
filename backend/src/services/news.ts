import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AI_DISCLAIMER } from '@portfolio/shared';
import type { Importance, NewsItem, Sentiment } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, newsItems, watchlist } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { fetchText } from '../lib/http-client.js';
import { looksMarketRelated, stripPublisher } from '../lib/headlines.js';
import { parseFeed } from '../lib/rss.js';
import type { FeedEntry } from '../lib/rss.js';
import { createLogger } from '../lib/logger.js';
import { analyzeNewsBatch, isAiEnabled } from './ai.js';
import { instrumentsNeedingPrices } from './prices.js';

const log = createLogger('news');

/**
 * Pobieranie newsów o obserwowanych spółkach.
 *
 * Źródła to publiczne kanały RSS. Bez klucza Anthropic zapisujemy same
 * nagłówki z linkami — analiza AI jest warstwą opcjonalną, a nie warunkiem
 * działania modułu.
 */

interface FeedSource {
  id: string;
  /** Buduje adres kanału dla instrumentu; null = źródło nie obsługuje papieru. */
  urlFor(instrument: InstrumentRow): string | null;
}

/**
 * Czy instrument jest notowany w Polsce.
 *
 * Decyduje o pobraniu zbiorczych kanałów polskich serwisów. Samo pole `exchange`
 * nie wystarcza: wyciąg brokera nie zawsze podaje giełdę, więc instrument
 * zaimportowany z historii transakcji miał je puste i wypadał ze wszystkich
 * krajowych źródeł — zostawał mu tylko anglojęzyczny kanał Yahoo, który dla
 * spółek z GPW bywa pusty.
 */
function isPolish(instrument: InstrumentRow): boolean {
  if (instrument.exchange === 'WSE' || instrument.exchange === 'GPW') return true;
  if (instrument.country === 'Polska') return true;
  if (instrument.symbol.toUpperCase().startsWith('WSE:')) return true;
  if (instrument.symbol.toUpperCase().endsWith('.WA')) return true;
  return instrument.currency === 'PLN' && instrument.assetClass === 'stock';
}

const SOURCES: FeedSource[] = [
  {
    id: 'yahoo',
    urlFor: (instrument) => {
      // Yahoo publikuje kanał RSS per ticker, także dla papierów spoza USA.
      const symbol = yahooSymbol(instrument);
      return symbol
        ? `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`
        : null;
    },
  },
  /*
   * Wyszukiwarka wiadomości per spółka.
   *
   * Kanały zbiorcze rzadko wymieniają konkretną spółkę w tytule — dla większości
   * pozycji dawały zero trafień, przez co „brak wiadomości" oznaczał w praktyce
   * brak źródła, a nie brak wydarzeń. To zapytanie jest kierowane nazwą spółki,
   * więc wraca z materiałem faktycznie jej dotyczącym.
   */
  {
    id: 'google-news',
    urlFor: (instrument) => {
      if (instrument.assetClass === 'cash' || instrument.assetClass === 'bond') return null;

      const ticker = instrument.symbol.split(':').pop()?.split('.')[0] ?? '';
      const name = instrument.name.replace(/\s+(S\.?A\.?|PLC|Inc\.?|Corp\.?)$/i, '').trim();
      const subject = name.length > 2 ? name : ticker;
      if (!subject) return null;

      const polish = isPolish(instrument);
      // Zawężenie zapytania odsiewa artykuły o firmie o tej samej nazwie
      // spoza rynku kapitałowego.
      const query = polish ? `${subject} akcje OR giełda OR wyniki` : `${subject} stock OR shares OR earnings`;
      const locale = polish ? 'hl=pl&gl=PL&ceid=PL:pl' : 'hl=en-US&gl=US&ceid=US:en';

      return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`;
    },
  },
  // Kanały zbiorcze polskich serwisów. Filtrujemy je po nazwie spółki, więc
  // jeden pobrany kanał obsługuje wszystkie krajowe pozycje naraz.
  {
    id: 'bankier',
    urlFor: (instrument) =>
      isPolish(instrument) ? 'https://www.bankier.pl/rss/wiadomosci.xml' : null,
  },
  {
    id: 'bankier-gielda',
    urlFor: (instrument) => (isPolish(instrument) ? 'https://www.bankier.pl/rss/gielda.xml' : null),
  },
  {
    id: 'pb-inwestora',
    urlFor: (instrument) => (isPolish(instrument) ? 'https://www.pb.pl/rss/puls-inwestora.xml' : null),
  },
  {
    id: 'pb-najnowsze',
    urlFor: (instrument) => (isPolish(instrument) ? 'https://www.pb.pl/rss/najnowsze.xml' : null),
  },
];

function yahooSymbol(instrument: InstrumentRow): string | null {
  const idx = instrument.symbol.indexOf(':');
  const ticker = idx === -1 ? instrument.symbol : instrument.symbol.slice(idx + 1);
  const market = idx === -1 ? null : instrument.symbol.slice(0, idx);
  const suffix: Record<string, string> = { WSE: '.WA', LON: '.L', FRA: '.DE', CPH: '.CO', US: '', NASDAQ: '', NYSE: '' };
  const mapped = market === null ? '' : suffix[market];
  return mapped === undefined ? null : `${ticker}${mapped}`;
}

const urlHash = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 32);

/** Instrumenty objęte monitoringiem: posiadane pozycje plus ręczna watchlista. */
export function watchedInstruments(): InstrumentRow[] {
  const held = instrumentsNeedingPrices();
  const watched = db
    .select()
    .from(instruments)
    .innerJoin(watchlist, eq(watchlist.instrumentId, instruments.id))
    .all()
    .map((r) => r.instruments);

  const byId = new Map<number, InstrumentRow>();
  for (const row of [...held, ...watched]) {
    if (row.assetClass === 'cash') continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

export async function fetchNews(): Promise<string> {
  return fetchNewsFor(watchedInstruments());
}

/**
 * Pobranie wiadomości dla wskazanych instrumentów.
 *
 * Wydzielone z `fetchNews`, żeby dało się odświeżyć jedną spółkę na żądanie —
 * czekanie do najbliższego przebiegu co godzinę jest bez sensu, gdy użytkownik
 * właśnie patrzy na pustą listę.
 */
export async function fetchNewsFor(targets: InstrumentRow[]): Promise<string> {
  if (targets.length === 0) return 'brak obserwowanych instrumentów';

  let inserted = 0;
  const feedCache = new Map<string, FeedEntry[]>();

  for (const instrument of targets) {
    for (const source of SOURCES) {
      const url = source.urlFor(instrument);
      if (!url) continue;

      try {
        let entries = feedCache.get(url);
        if (!entries) {
          entries = parseFeed(await fetchText(url, { retries: 1, minIntervalMs: 800 }));
          feedCache.set(url, entries);
        }

        /*
         * Kanały zbiorcze (Bankier, Puls Biznesu) filtrujemy po nazwie spółki,
         * inaczej każda spółka dostałaby wszystkie wiadomości z rynku.
         *
         * Kanał kierowany też wymaga sprawdzenia, choć zapytanie zawiera nazwę:
         * dopasowanie potrafi wpaść w nazwę wydawcy zamiast w treść. Tam badamy
         * sam tytuł bez wydawcy — zajawka niosłaby tę samą pułapkę.
         */
        const relevant =
          source.id === 'yahoo'
            ? entries
            : entries.filter((e) =>
                source.id === 'google-news'
                  ? mentionsInstrument({ ...e, title: stripPublisher(e.title), summary: null }, instrument) &&
                    looksMarketRelated(stripPublisher(e.title))
                  : mentionsInstrument(e, instrument),
              );

        for (const entry of relevant.slice(0, 15)) {
          const result = db
            .insert(newsItems)
            .values({
              instrumentId: instrument.id,
              source: source.id,
              url: entry.url,
              urlHash: urlHash(entry.url),
              title: entry.title,
              publishedAt: entry.publishedAt,
              rawSummary: entry.summary,
            })
            .onConflictDoNothing()
            .run();
          inserted += result.changes;
        }
      } catch (err) {
        log.debug(`Kanał ${source.id} dla ${instrument.symbol} nieosiągalny: ${errorMessage(err)}`);
      }
    }
  }

  return `pobrano ${inserted} nowych wiadomości dla ${targets.length} instrumentów`;
}

function mentionsInstrument(entry: FeedEntry, instrument: InstrumentRow): boolean {
  const haystack = `${entry.title} ${entry.summary ?? ''}`.toLowerCase();
  // Pierwszy człon nazwy zwykle wystarcza ("CD Projekt SA" → "cd projekt").
  const name = instrument.name.toLowerCase().replace(/\s+(sa|s\.a\.|spółka akcyjna|plc|inc|corp)\.?$/i, '');
  const ticker = instrument.symbol.split(':').pop()?.toLowerCase() ?? '';
  return (name.length > 3 && haystack.includes(name)) || (ticker.length > 2 && haystack.includes(ticker));
}

/**
 * Analiza AI dla wiadomości, które jej jeszcze nie mają.
 * Bez klucza API nic nie robi — to nie jest błąd, tylko tryb okrojony.
 */
export async function analyzePendingNews(): Promise<string> {
  if (!isAiEnabled()) return 'analiza AI wyłączona (brak ANTHROPIC_API_KEY)';

  const pending = db
    .select()
    .from(newsItems)
    .where(isNull(newsItems.aiAnalyzedAt))
    .orderBy(desc(newsItems.publishedAt))
    .limit(config.ai.batchLimit)
    .all();

  if (pending.length === 0) return 'brak wiadomości do analizy';

  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));

  const results = await analyzeNewsBatch(
    pending.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.rawSummary,
      instrumentName: item.instrumentId ? (instrumentMap.get(item.instrumentId)?.name ?? null) : null,
    })),
  );

  let analyzed = 0;
  for (const result of results) {
    db.update(newsItems)
      .set({
        aiSummaryPl: result.summaryPl,
        sentiment: result.sentiment,
        importance: result.importance,
        aiSignal: result.signal,
        aiModel: config.ai.model,
        aiAnalyzedAt: nowIso(),
      })
      .where(eq(newsItems.id, result.id))
      .run();
    analyzed += 1;
  }

  return `przeanalizowano ${analyzed} wiadomości`;
}

export interface NewsQuery {
  instrumentId?: number;
  sentiment?: Sentiment;
  importance?: Importance;
  limit: number;
}

export function listNews(query: NewsQuery): NewsItem[] {
  const conditions = [];
  if (query.instrumentId) conditions.push(eq(newsItems.instrumentId, query.instrumentId));
  if (query.sentiment) conditions.push(eq(newsItems.sentiment, query.sentiment));
  if (query.importance) conditions.push(eq(newsItems.importance, query.importance));

  const rows = db
    .select()
    .from(newsItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(newsItems.publishedAt))
    .limit(query.limit)
    .all();

  const instrumentIds = [...new Set(rows.map((r) => r.instrumentId).filter((id): id is number => id !== null))];
  const instrumentMap = new Map(
    instrumentIds.length > 0
      ? db.select().from(instruments).where(inArray(instruments.id, instrumentIds)).all().map((i) => [i.id, i])
      : [],
  );

  return rows.map((row) => ({
    id: row.id,
    instrumentId: row.instrumentId,
    instrumentSymbol: row.instrumentId ? (instrumentMap.get(row.instrumentId)?.symbol ?? null) : null,
    source: row.source,
    url: row.url,
    title: row.title,
    publishedAt: row.publishedAt,
    // Bez włączonej analizy AI pokazujemy zajawkę prosto ze źródła — dla
    // polskich serwisów jest po polsku, więc spełnia tę samą rolę.
    aiSummaryPl: row.aiSummaryPl ?? shortSummary(row.rawSummary),
    /*
     * Streszczenie pochodzi albo od modelu, albo z przyciętej zajawki kanału.
     * Bez tego rozróżnienia interfejs podpisywałby cudzy tekst jako wytworzony
     * przez AI — albo odwrotnie, ukrywał że coś przeszło przez model.
     */
    aiGenerated: row.aiSummaryPl !== null,
    sentiment: row.sentiment as Sentiment | null,
    importance: row.importance as Importance | null,
    aiSignal: row.aiSignal,
    aiModel: row.aiModel,
    // Każda treść pochodząca z modelu jest materiałem informacyjnym.
    informationalOnly: true,
  }));
}

export const newsDisclaimer = AI_DISCLAIMER;

/** Ręczne dodanie spółki do obserwowanych. */
export function addToWatchlist(instrumentId: number, note?: string): void {
  db.insert(watchlist).values({ instrumentId, note: note ?? null }).onConflictDoNothing().run();
}

export function removeFromWatchlist(instrumentId: number): void {
  db.delete(watchlist).where(eq(watchlist.instrumentId, instrumentId)).run();
}

export function listWatchlist(): InstrumentRow[] {
  return db
    .select()
    .from(instruments)
    .innerJoin(watchlist, eq(watchlist.instrumentId, instruments.id))
    .all()
    .map((r) => r.instruments);
}

/** Skraca zajawkę ze źródła do długości, która mieści się pod tytułem. */
function shortSummary(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  if (text.length <= 240) return text;

  // Ucinamy na granicy zdania, żeby nie zostawiać urwanego słowa.
  const cut = text.slice(0, 240);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return lastStop > 120 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}


/** Wiadomości dla jednego instrumentu, na żądanie z interfejsu. */
export async function fetchNewsForInstrument(instrumentId: number): Promise<string> {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return 'nie ma takiego instrumentu';
  return fetchNewsFor([instrument]);
}
