import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AI_DISCLAIMER, isDomesticInstrument } from '@portfolio/shared';
import type { AiUnavailable, Importance, NewsItem, Sentiment } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, newsItems, watchlist } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { fetchText } from '../lib/http-client.js';
import { looksMarketRelated, mentionsCompany, stripPublisher } from '../lib/headlines.js';
import { parseFeed } from '../lib/rss.js';
import type { FeedEntry } from '../lib/rss.js';
import { createLogger } from '../lib/logger.js';
import { analyzeNewsBatch } from './ai.js';
import { checkFeature, getAiSettings } from './ai-config.js';
import type { AiCallOrigin } from './ai-config.js';
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
  if (instrument.country === 'Polska') return true;
  return isDomesticInstrument(instrument);
}

/**
 * Kanały zbiorcze polskich serwisów.
 *
 * Służą dwóm rzeczom naraz: filtrowane nazwą spółki dokładają wiadomości do
 * konkretnych pozycji, a czytane bez filtra dają przegląd tego, co dzieje się
 * na rynku. Wcześniej istniało tylko to pierwsze zastosowanie, więc z Pulsu
 * Biznesu — który pisze głównie o rynku, nie o pojedynczych spółkach w tytule —
 * przechodziły pojedyncze wpisy.
 */
const MARKET_FEEDS = [
  { id: 'bankier', url: 'https://www.bankier.pl/rss/wiadomosci.xml' },
  { id: 'bankier-gielda', url: 'https://www.bankier.pl/rss/gielda.xml' },
  { id: 'bankier-firma', url: 'https://www.bankier.pl/rss/firma.xml' },
  { id: 'pb-inwestora', url: 'https://www.pb.pl/rss/puls-inwestora.xml' },
  { id: 'pb-najnowsze', url: 'https://www.pb.pl/rss/najnowsze.xml' },
  { id: 'strefa-inwestorow', url: 'https://strefainwestorow.pl/rss.xml' },
  { id: 'money-gielda', url: 'https://www.money.pl/rss/gielda.xml' },
  { id: 'interia-gieldy', url: 'https://biznes.interia.pl/gieldy/feed' },
  { id: 'business-insider', url: 'https://businessinsider.com.pl/.feed' },
] as const;

/** Ile wpisów z jednego kanału trafia do przeglądu rynku. */
const MARKET_NEWS_PER_FEED = 12;

/**
 * Kanał zbiorczy przypisany do konkretnego papieru — tylko dla krajowych.
 *
 * Gotówka i obligacje detaliczne odpadają z tego samego powodu co przy
 * wyszukiwarce: nie mają nazwy, którą dałoby się sensownie odnaleźć
 * w nagłówkach, więc pobranie kanału byłoby ruchem sieciowym bez trafień.
 */
function polishFeed(url: string): (instrument: InstrumentRow) => string | null {
  return (instrument) => {
    if (instrument.assetClass === 'cash' || instrument.assetClass === 'bond') return null;
    return isPolish(instrument) ? url : null;
  };
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
  ...MARKET_FEEDS.map((feed) => ({ id: feed.id, urlFor: polishFeed(feed.url) })),
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
                  ? mentionsCompany(e.title, instrument) && looksMarketRelated(stripPublisher(e.title))
                  : mentionsCompany(e.title, instrument),
              );

        // Limit tnie po dacie, nie po kolejności w kanale. Kanały zbiorcze
        // bywają posortowane działowo, więc bez tego „15 pierwszych" potrafiło
        // oznaczać najstarsze wpisy dnia.
        const newest = [...relevant].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

        for (const entry of newest.slice(0, 15)) {
          const result = db
            .insert(newsItems)
            .values({
              instrumentId: instrument.id,
              source: source.id,
              url: entry.url,
              urlHash: urlHash(entry.url),
              // Nazwę wydawcy odcinamy przy zapisie, nie przy wyświetlaniu:
              // „… - XTB.com" w tytule sugerowałoby, że to wiadomość o XTB.
              title: stripPublisher(entry.title),
              publishedAt: entry.publishedAt,
              rawSummary: cleanSummary(entry.summary),
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

/**
 * Analiza AI dla wiadomości, które jej jeszcze nie mają.
 * Bez klucza API nic nie robi — to nie jest błąd, tylko tryb okrojony.
 */
/**
 * Ile partii przetwarza jeden przebieg.
 *
 * Model dostaje wiadomości paczkami po `AI_NEWS_BATCH_LIMIT` (domyślnie 25).
 * Pojedyncza paczka wystarcza zadaniu cyklicznemu, które chodzi co godzinę,
 * ale przy ręcznym odświeżeniu zostawiała zaległości: przy stu kilkudziesięciu
 * wiadomościach część miała streszczenie, a część nie, i wyglądało to na
 * losowe działanie funkcji. Górny limit jest po to, żeby jedno kliknięcie nie
 * przepuściło przez model całej historii naraz.
 */
export const MAX_BATCHES_ON_DEMAND = 8;

/**
 * Ile razy wiadomość może wrócić do kolejki, zanim ją odpuścimy.
 *
 * Dotyczy wyłącznie sytuacji, w której model odpowiedział, ale tej konkretnej
 * pozycji nie objął — zwykle dlatego, że nie potrafi jej streścić. Awaria
 * dostawcy prób nie zużywa, bo nie mówi nic o samej wiadomości.
 */
const MAX_ANALYSIS_ATTEMPTS = 3;

export interface AnalyzeNewsOutcome {
  analyzed: number;
  pending: number;
  failure: AiUnavailable | null;
  message: string;
}

export async function analyzePendingNews(options: { maxBatches?: number; origin?: AiCallOrigin } = {}): Promise<AnalyzeNewsOutcome> {
  const countPending = (): number =>
    db.select().from(newsItems).where(isNull(newsItems.aiAnalyzedAt)).all().length;

  // Powód bierzemy z konfiguracji, zamiast zgadywać: funkcja bywa wyłączona
  // mimo obecnego klucza, a poprzedni komunikat obwiniał zawsze brak klucza.
  const availability = checkFeature('news');
  if (!availability.enabled) {
    return {
      analyzed: 0,
      pending: countPending(),
      failure: availability.unavailable,
      message: `analiza AI pominięta — ${availability.reason ?? 'funkcja niedostępna'}`,
    };
  }

  const maxBatches = Math.max(options.maxBatches ?? 1, 1);
  const origin = options.origin ?? 'user';
  let analyzed = 0;
  let failure: AiUnavailable | null = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await analyzeOneBatch(origin);
    analyzed += result.analyzed;

    /*
     * Awaria dostawcy przerywa pętlę. Kolejne siedem paczek poleciałoby z tym
     * samym błędnym kluczem albo w ten sam przekroczony limit, więc jedyne, co
     * by to dało, to siedem kolejnych nieudanych zapytań.
     */
    if (result.failure) {
      failure = result.failure;
      break;
    }

    // Mniej niż pełna paczka znaczy, że kolejka się skończyła.
    if (result.size < config.ai.batchLimit) break;
  }

  const left = countPending();

  if (failure) {
    return {
      analyzed,
      pending: left,
      failure,
      message: `analiza przerwana — ${failure.message}${analyzed > 0 ? ` (zdążyło przejść ${analyzed})` : ''}`,
    };
  }

  if (analyzed === 0) {
    return {
      analyzed: 0,
      pending: left,
      failure: null,
      message: left === 0 ? 'brak wiadomości do analizy' : 'model nie zwrócił analiz',
    };
  }

  return {
    analyzed,
    pending: left,
    failure: null,
    message:
      left > 0
        ? `przeanalizowano ${analyzed} wiadomości, w kolejce zostaje ${left}`
        : `przeanalizowano ${analyzed} wiadomości`,
  };
}

interface BatchOutcome {
  /** Ile wiadomości poszło do modelu w tej paczce. */
  size: number;
  analyzed: number;
  failure: AiUnavailable | null;
}

/** Jedna paczka wysłana do modelu. */
async function analyzeOneBatch(origin: AiCallOrigin): Promise<BatchOutcome> {
  const pending = db
    .select()
    .from(newsItems)
    .where(isNull(newsItems.aiAnalyzedAt))
    .orderBy(desc(newsItems.publishedAt))
    .limit(config.ai.batchLimit)
    .all();

  if (pending.length === 0) return { size: 0, analyzed: 0, failure: null };

  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));

  const { analyses: results, failure } = await analyzeNewsBatch(
    pending.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.rawSummary,
      instrumentName: item.instrumentId ? (instrumentMap.get(item.instrumentId)?.name ?? null) : null,
    })),
    origin,
  );

  /*
   * Przy awarii dostawcy nie ruszamy kolejki. Wcześniej wszystkie
   * dwadzieścia pięć wiadomości dostawało stempel „przeanalizowane" mimo
   * braku odpowiedzi, więc pojedynczy błąd 429 trwale pozbawiał je
   * streszczenia i nie było jak tego cofnąć.
   */
  if (failure) return { size: pending.length, analyzed: 0, failure };

  let analyzed = 0;
  for (const result of results) {
    db.update(newsItems)
      .set({
        aiSummaryPl: result.summaryPl,
        sentiment: result.sentiment,
        importance: result.importance,
        aiSignal: result.signal,
        // Model faktycznie użyty, nie domyślny z `.env` — po zmianie dostawcy
        // w ustawieniach historia pokazywałaby inaczej nieprawdziwy identyfikator.
        aiModel: getAiSettings().model,
        aiAnalyzedAt: nowIso(),
      })
      .where(eq(newsItems.id, result.id))
      .run();
    analyzed += 1;
  }

  /*
   * Wiadomości, których model nie objął odpowiedzią mimo sprawnego połączenia,
   * dostają kolejną próbę — a po `MAX_ANALYSIS_ATTEMPTS` odpuszczamy je
   * z zapisanym powodem, żeby nie blokowały kolejki w nieskończoność.
   */
  const missing = pending.filter((item) => !results.some((r) => r.id === item.id));
  for (const item of missing) {
    const attempts = item.aiAttempts + 1;
    const exhausted = attempts >= MAX_ANALYSIS_ATTEMPTS;
    db.update(newsItems)
      .set({
        aiAttempts: attempts,
        aiAnalyzedAt: exhausted ? nowIso() : null,
        aiError: exhausted ? `Model pominął tę wiadomość w ${attempts} podejściach.` : null,
      })
      .where(eq(newsItems.id, item.id))
      .run();
  }

  return { size: pending.length, analyzed, failure: null };
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
/**
 * Oczyszczenie zajawki z kanału.
 *
 * Wyszukiwarka wiadomości podaje w opisie surowy fragment HTML — zwykle sam
 * odnośnik do artykułu. Wyświetlony dosłownie wyglądał jak wklejony kod,
 * a modelowi zabierał tokeny na znaczniki zamiast na treść.
 */
export function cleanSummary(raw: string | null): string | null {
  if (!raw) return null;

  const text = raw
    // Najpierw całe elementy z treścią, potem osierocone znaczniki.
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > 0 ? text : null;
}

function shortSummary(raw: string | null): string | null {
  if (!raw) return null;
  const text = cleanSummary(raw) ?? '';
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


/**
 * Przegląd rynku prosto z kanałów serwisów, bez wiązania z konkretną spółką.
 *
 * Kanały zbiorcze filtrowane nazwą spółki oddawały pojedyncze wpisy: Puls
 * Biznesu pisze o rynku, a nie o tickerach w tytule, więc prawie wszystko
 * odpadało. Tutaj bierzemy je bez filtra — wpis bez `instrumentId` jest
 * materiałem ogólnym i nie zaśmieca listy wiadomości żadnej pozycji.
 *
 * Adresy pochodzą wprost od wydawcy, nie z pośrednika, więc podgląd treści
 * w aplikacji działa — w przeciwieństwie do linków z Google News.
 */
export async function fetchMarketNews(): Promise<string> {
  let inserted = 0;
  let failed = 0;

  for (const feed of MARKET_FEEDS) {
    try {
      const entries = parseFeed(await fetchText(feed.url, { retries: 1, minIntervalMs: 800 }));

      for (const entry of entries.slice(0, MARKET_NEWS_PER_FEED)) {
        // Ten sam filtr co przy kanale kierowanym — odsiewa materiały
        // niezwiązane z rynkiem, których w kanałach ogólnych bywa sporo.
        if (!looksMarketRelated(stripPublisher(entry.title))) continue;

        const result = db
          .insert(newsItems)
          .values({
            instrumentId: null,
            source: feed.id,
            url: entry.url,
            urlHash: urlHash(entry.url),
            title: stripPublisher(entry.title),
            publishedAt: entry.publishedAt,
            rawSummary: cleanSummary(entry.summary),
          })
          .onConflictDoNothing()
          .run();
        inserted += result.changes;
      }
    } catch (err) {
      failed += 1;
      log.debug(`Kanał rynkowy ${feed.id} nieosiągalny: ${errorMessage(err)}`);
    }
  }

  return failed > 0
    ? `przegląd rynku: ${inserted} nowych, ${failed} kanałów nieosiągalnych`
    : `przegląd rynku: ${inserted} nowych`;
}

/**
 * Wiadomości z otoczenia rynkowego, niezwiązane z konkretną spółką.
 *
 * Zapisujemy je bez `instrumentId` — decyzja rządu o cenach paliw nie należy
 * do Orlenu, choć go dotyczy. Przypisanie jej do jednej spółki zafałszowałoby
 * listę jej wiadomości, a nie przypisanie do niczego pozwala korzystać z niej
 * każdemu, kogo dotyczy.
 */
export async function fetchContextNews(query: string): Promise<number> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pl&gl=PL&ceid=PL:pl`;

  let inserted = 0;

  try {
    for (const entry of parseFeed(await fetchText(url, { retries: 1, minIntervalMs: 800 })).slice(0, 20)) {
      const result = db
        .insert(newsItems)
        .values({
          instrumentId: null,
          source: 'otoczenie',
          url: entry.url,
          urlHash: urlHash(entry.url),
          title: stripPublisher(entry.title),
          publishedAt: entry.publishedAt,
          rawSummary: cleanSummary(entry.summary),
        })
        .onConflictDoNothing()
        .run();
      inserted += result.changes;
    }
  } catch (err) {
    log.warn(`Wiadomości otoczenia („${query}") nieudane: ${errorMessage(err)}`);
  }

  return inserted;
}
