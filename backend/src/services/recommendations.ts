import { and, desc, eq, gte } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { analystRatings, instruments } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { stripPublisher } from '../lib/headlines.js';
import { fetchText } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { parseFeed } from '../lib/rss.js';

const log = createLogger('recommendations');

/**
 * Rekomendacje analityków odczytywane z nagłówków prasy giełdowej.
 *
 * Nie ma darmowego API z rekomendacjami dla GPW, a serwisy branżowe nie
 * udostępniają ich inaczej niż w treści. Okazuje się to jednak wystarczające:
 * redakcje piszą o nich wedle sztywnej konwencji, w której mieści się dom
 * maklerski, zalecenie i cena docelowa — „Noble Securities: »kupuj« dla XTB,
 * cena docelowa 95,7 zł". Czytamy więc to, co i tak jest w kanale RSS, zamiast
 * scrapować strony.
 *
 * Wynik jest zapisem tego, co napisała prasa, a nie rekomendacją aplikacji.
 */

export const RATINGS = ['kupuj', 'akumuluj', 'trzymaj', 'neutralnie', 'redukuj', 'sprzedaj'] as const;
export type Rating = (typeof RATINGS)[number];

/** Kierunek zalecenia — do policzenia konsensusu bez gubienia niuansów nazw. */
const RATING_SCORE: Record<Rating, number> = {
  kupuj: 2,
  akumuluj: 1,
  trzymaj: 0,
  neutralnie: 0,
  redukuj: -1,
  sprzedaj: -2,
};

/**
 * Domy maklerskie występujące w polskich nagłówkach.
 *
 * Lista zamknięta, bo wyciąganie nazwy firmy z dowolnego tytułu daje więcej
 * pomyłek niż trafień — a nierozpoznany dom nie unieważnia samej rekomendacji.
 */
const BROKERS = [
  'Trigon',
  'Noble Securities',
  'Erste',
  'Santander',
  'mBank',
  'BM mBanku',
  'Pekao',
  'PKO BP',
  'BOŚ',
  'DM BOŚ',
  'Ipopema',
  'Haitong',
  'Wood & Company',
  'Wood',
  'JP Morgan',
  'JPMorgan',
  'Goldman Sachs',
  'Morgan Stanley',
  'Citi',
  'UBS',
  'Barclays',
  'Deutsche Bank',
  'Raiffeisen',
  'Erste Group',
  'BNP Paribas',
  'Millennium DM',
  'Vestor',
  'Michael/Ström',
];

export interface ParsedRating {
  rating: Rating | null;
  broker: string | null;
  targetPriceE8: number | null;
  /** Czy nagłówek mówi o podwyższeniu albo obniżeniu wyceny. */
  direction: 'up' | 'down' | null;
}

/**
 * Odczyt zalecenia, domu maklerskiego i ceny docelowej z nagłówka.
 *
 * Zwraca to, co udało się rozpoznać — nagłówek bez ceny, ale z zaleceniem,
 * nadal niesie informację i nie ma powodu go odrzucać.
 */
export function parseRecommendation(title: string, summary?: string | null): ParsedRating {
  const text = `${title} ${summary ?? ''}`;
  const lower = text.toLowerCase();

  const rating = RATINGS.find((value) => new RegExp(`(^|[^a-ząćęłńóśźż])${value}`, 'i').test(lower)) ?? null;

  const broker = BROKERS.find((name) => lower.includes(name.toLowerCase())) ?? null;

  /*
   * Cena docelowa bywa zapisana na kilka sposobów: „cena docelowa 95,7 zł",
   * „do 250 zł", „wartość 155,00 zł". Kotwiczymy o słowo, żeby nie złapać
   * pierwszej lepszej liczby z tytułu — kursu, procentu albo roku.
   */
  const priceMatch =
    /(?:cen[aęy]\s+docelow[aąej]|wycen[aęy]|warte?\s+|do)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:zł|pln)/i.exec(text) ??
    /([0-9]+(?:[.,][0-9]+)?)\s*(?:zł|pln)\s*(?:cen[ay]\s+docelow)/i.exec(text);

  const targetPriceE8 = priceMatch
    ? Math.round(Number(priceMatch[1]!.replace(',', '.')) * 100_000_000)
    : null;

  const direction = /podwyższ|podnios|w górę|podnieś/i.test(text)
    ? 'up'
    : /obniż|w dół|ścią|scina/i.test(text)
      ? 'down'
      : null;

  return { rating, broker, targetPriceE8, direction };
}

/** Czy nagłówek w ogóle dotyczy rekomendacji — bez tego lista zapełnia się szumem. */
export function looksLikeRecommendation(title: string, summary?: string | null): boolean {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  return /rekomendacj|rekomenduje|cena docelowa|cenę docelową|wycen[aęy]|analityk|analitycy/.test(text);
}

const idHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * Pobranie i zapis rekomendacji dla jednej spółki.
 *
 * Zapis jest idempotentny po adresie artykułu, więc powtórne wywołanie nie
 * mnoży wpisów.
 */
export async function fetchRecommendations(instrument: InstrumentRow): Promise<number> {
  const subject = instrument.name.replace(/\s+(S\.?A\.?|PLC|Inc\.?|Corp\.?)$/i, '').trim() || instrument.symbol;
  const query = `${subject} rekomendacja OR "cena docelowa" OR wycena analitycy`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pl&gl=PL&ceid=PL:pl`;

  let saved = 0;

  try {
    for (const entry of parseFeed(await fetchText(url, { retries: 1, minIntervalMs: 800 })).slice(0, 25)) {
      const title = stripPublisher(entry.title);
      if (!looksLikeRecommendation(title, entry.summary)) continue;

      const parsed = parseRecommendation(title, entry.summary);
      // Sam fakt, że tekst wspomina analityków, to za mało — bez zalecenia
      // albo ceny docelowej nie ma czego zapisywać.
      if (parsed.rating === null && parsed.targetPriceE8 === null) continue;

      const result = db
        .insert(analystRatings)
        .values({
          instrumentId: instrument.id,
          urlHash: idHash(entry.url),
          url: entry.url,
          title,
          publishedAt: entry.publishedAt,
          broker: parsed.broker,
          rating: parsed.rating,
          targetPriceE8: parsed.targetPriceE8,
          direction: parsed.direction,
          source: 'google-news',
        })
        .onConflictDoNothing()
        .run();

      saved += result.changes;
    }
  } catch (err) {
    log.warn(`Rekomendacje ${instrument.symbol} nieudane: ${errorMessage(err)}`);
  }

  return saved;
}

export interface RatingEntry {
  date: string;
  broker: string | null;
  rating: Rating | null;
  targetPriceE8: number | null;
  direction: 'up' | 'down' | null;
  title: string;
  url: string;
}

export interface RatingConsensus {
  entries: RatingEntry[];
  /** Rozkład zaleceń w oknie. */
  counts: Record<string, number>;
  /** Uśredniony kierunek: dodatni = przewaga zaleceń kupna. */
  scoreAvg: number | null;
  /** Mediana ceny docelowej — odporniejsza na pojedynczą skrajną wycenę niż średnia. */
  medianTargetE8: number | null;
  /** Potencjał wobec bieżącej ceny, w punktach bazowych. */
  upsideBp: number | null;
  monthsCovered: number;
}

/** Okno, z którego bierzemy rekomendacje. Starsze zdążyły się zdezaktualizować. */
const CONSENSUS_MONTHS = 12;

export function ratingConsensus(instrumentId: number, currentPriceE8: number | null): RatingConsensus {
  const from = addDays(today(config.timezone), -CONSENSUS_MONTHS * 30);

  const rows = db
    .select()
    .from(analystRatings)
    .where(and(eq(analystRatings.instrumentId, instrumentId), gte(analystRatings.publishedAt, from)))
    .orderBy(desc(analystRatings.publishedAt))
    .all();

  const entries: RatingEntry[] = rows.map((row) => ({
    date: row.publishedAt.slice(0, 10),
    broker: row.broker,
    rating: row.rating as Rating | null,
    targetPriceE8: row.targetPriceE8,
    direction: row.direction as 'up' | 'down' | null,
    title: row.title,
    url: row.url,
  }));

  const counts: Record<string, number> = {};
  const scores: number[] = [];
  for (const entry of entries) {
    if (!entry.rating) continue;
    counts[entry.rating] = (counts[entry.rating] ?? 0) + 1;
    scores.push(RATING_SCORE[entry.rating]);
  }

  const targets = entries
    .map((entry) => entry.targetPriceE8)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const median =
    targets.length === 0
      ? null
      : targets.length % 2 === 1
        ? targets[(targets.length - 1) / 2]!
        : Math.round((targets[targets.length / 2 - 1]! + targets[targets.length / 2]!) / 2);

  return {
    entries,
    counts,
    scoreAvg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    medianTargetE8: median,
    upsideBp:
      median !== null && currentPriceE8 !== null && currentPriceE8 > 0
        ? Math.round((median / currentPriceE8 - 1) * 10_000)
        : null,
    monthsCovered: CONSENSUS_MONTHS,
  };
}

/** Rekomendacje dla wszystkich posiadanych spółek — zadanie cykliczne. */
export async function refreshAllRecommendations(): Promise<string> {
  const rows = db
    .select()
    .from(instruments)
    .all()
    .filter((row) => row.assetClass === 'stock' || row.assetClass === 'etf');

  let total = 0;
  for (const row of rows) {
    total += await fetchRecommendations(row);
  }

  return `zapisano ${total} rekomendacji dla ${rows.length} instrumentów`;
}
