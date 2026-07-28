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
  {
    id: 'bankier',
    urlFor: (instrument) =>
      // Bankier ma jeden zbiorczy kanał giełdowy — filtrujemy po nazwie spółki.
      instrument.exchange === 'WSE' ? 'https://www.bankier.pl/rss/wiadomosci.xml' : null,
  },
  {
    id: 'bankier-gielda',
    urlFor: (instrument) =>
      instrument.exchange === 'WSE' ? 'https://www.bankier.pl/rss/gielda.xml' : null,
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
  const targets = watchedInstruments();
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

        // Kanały zbiorcze (Bankier, StockWatch) filtrujemy po nazwie spółki,
        // inaczej każda spółka dostałaby wszystkie wiadomości z rynku.
        const isAggregate = source.id !== 'yahoo';
        const relevant = isAggregate ? entries.filter((e) => mentionsInstrument(e, instrument)) : entries;

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
    aiSummaryPl: row.aiSummaryPl,
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
