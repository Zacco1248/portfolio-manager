import { createHash } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import { rollUp } from '@portfolio/shared';
import type { AssetClass } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { analystRatings, instruments } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { mentionsCompany, stripPublisher } from '../lib/headlines.js';
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
  /** Waluta ceny docelowej; null, gdy ceny nie odczytano. */
  targetCurrency: string | null;
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
    /(?:cen[aęy]\s+docelow[aąej]|wycen[aęy]|warte?\s+|do)\s*:?\s*([0-9]+(?:[.,][0-9]+)?)\s*(zł|pln|usd|eur|\$|€)/i.exec(
      text,
    ) ??
    /([0-9]+(?:[.,][0-9]+)?)\s*(zł|pln|usd|eur|\$|€)\s*(?:cen[ay]\s+docelow)/i.exec(text) ??
    // Zapis z symbolem przed kwotą: „target price $250".
    /(?:cen[aęy]\s+docelow[aąej]|target\s+price|wycen[aęy])\s*:?\s*(\$|€)\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(text);

  const amount = priceMatch?.slice(1).find((group) => group && /^[0-9]+(?:[.,][0-9]+)?$/.test(group));
  const targetPriceE8 = amount ? Math.round(Number(amount.replace(',', '.')) * 100_000_000) : null;

  /*
   * Waluta ceny docelowej. Wcześniej regex wymagał „zł", więc dla spółek
   * notowanych w dolarach czy euro cena docelowa nigdy się nie odczytywała,
   * a interfejs i tak dopisywał do niej „zł" — czyli mylił jednostki.
   */
  const targetCurrency = targetPriceE8 === null ? null : currencyFromMatch(priceMatch!);

  /*
   * Kierunek zmiany bywa jedyną konkretną informacją w nagłówku. Polskie
   * serwisy trzymają cenę docelową za progiem kliknięcia („Jaka cena
   * docelowa?"), ale samo „podniósł rekomendację" albo „obniżył wycenę"
   * piszą wprost — i to też jest sygnał wart odnotowania.
   */
  const direction = /podwyższ|podni[oó]s|podnosi|w górę|podnieś|wyższa (?:cena|wycena)/i.test(text)
    ? 'up'
    : /obniż|w dół|ścina|niższa (?:cena|wycena)/i.test(text)
      ? 'down'
      : null;

  return { rating, broker, targetPriceE8, targetCurrency, direction };
}

/**
 * Symbol albo skrót waluty z dopasowania → kod ISO.
 *
 * Grupy nie mają stałej kolejności: raz kwota jest przed walutą („250 USD"),
 * raz po symbolu („$180"). Zamiast zgadywać numer grupy, szukamy tej, która
 * wygląda na walutę.
 */
function currencyFromMatch(match: RegExpExecArray): string {
  const raw = match.slice(1).find((group) => group && /^(zł|pln|usd|eur|\$|€)$/i.test(group));
  const normalized = (raw ?? '').toLowerCase();
  if (normalized === '$' || normalized === 'usd') return 'USD';
  if (normalized === '€' || normalized === 'eur') return 'EUR';
  return 'PLN';
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

  /*
   * Dwa zapytania, bo szukamy dwóch różnych rzeczy. Pierwsze łapie samą
   * rekomendację, drugie celuje w nagłówki z kwotą: „podniósł wycenę do 144 zł"
   * ginęło w ogólnym zapytaniu wśród kilkudziesięciu tekstów bez liczb.
   */
  const queries = [
    `${subject} rekomendacja OR "cena docelowa" OR wycena analitycy`,
    `${subject} "cena docelowa" OR wycena zł podnosi OR obniża`,
  ];

  let saved = 0;
  const entries: { url: string; title: string; publishedAt: string; summary: string | null }[] = [];

  for (const query of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pl&gl=PL&ceid=PL:pl`;
    try {
      entries.push(...parseFeed(await fetchText(url, { retries: 1, minIntervalMs: 800 })));
    } catch (err) {
      log.warn(`Rekomendacje ${instrument.symbol} nieudane: ${errorMessage(err)}`);
    }
  }

  try {
    /*
     * Kolejność ma znaczenie: najpierw odsiewamy, dopiero potem ograniczamy
     * liczbę. Wcześniej brałem pierwsze 25 pozycji kanału i dopiero je
     * filtrowałem, więc jedyny nagłówek z ceną docelową bywał odcinany przez
     * recenzje innych spółek stojące wyżej w wynikach.
     *
     * Sprawdzenie nazwy jest tu konieczne mimo celowanego zapytania:
     * wyszukiwarka zwraca zbiorcze przeglądy rekomendacji dla całej giełdy,
     * przez co „DM BOŚ obniżył wycenę akcji Grupy Azoty do 15 zł" lądowało
     * jako wycena Orlenu.
     */
    const relevant = entries
      .map((entry) => ({ entry, title: stripPublisher(entry.title) }))
      .filter(({ title }) => mentionsCompany(title, instrument))
      .filter(({ entry, title }) => looksLikeRecommendation(title, entry.summary))
      .slice(0, 30);

    for (const { entry, title } of relevant) {
      const parsed = parseRecommendation(title, entry.summary);
      /*
       * Sam fakt, że tekst wspomina analityków, to za mało. Zapisujemy, gdy
       * jest zalecenie, cena docelowa albo przynajmniej kierunek zmiany —
       * „podniósł rekomendację dla Orlenu" niesie treść, choć nie podaje kwoty.
       */
      if (parsed.rating === null && parsed.targetPriceE8 === null && parsed.direction === null) continue;

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
          targetCurrency: parsed.targetCurrency,
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
  /** Waluta ceny docelowej; null dla wpisów sprzed rozróżnienia walut. */
  targetCurrency: string | null;
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
  /** Podwyższenia i obniżki rekomendacji lub wyceny w oknie. */
  upgrades: number;
  downgrades: number;
  /** Mediana ceny docelowej — odporniejsza na pojedynczą skrajną wycenę niż średnia. */
  medianTargetE8: number | null;
  /** Waluta mediany — ta sama, co waluta notowania instrumentu. */
  targetCurrency: string | null;
  /** Potencjał wobec bieżącej ceny, w punktach bazowych. */
  upsideBp: number | null;
  monthsCovered: number;
  /**
   * Konsensus prosto od dostawcy notowań. Dostępny tylko wtedy, gdy funkcja
   * jest włączona i mechanizm zadziałał — inaczej zostaje sam odczyt
   * z nagłówków prasowych.
   */
  provider?: {
    targetMeanE8: number | null;
    targetHighE8: number | null;
    targetLowE8: number | null;
    analystCount: number | null;
    recommendationKey: string | null;
    currency: string | null;
    distribution: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
    upsideBp: number | null;
  };
}

/** Okno, z którego bierzemy rekomendacje. Starsze zdążyły się zdezaktualizować. */
const CONSENSUS_MONTHS = 12;

export function ratingConsensus(
  instrumentId: number,
  currentPriceE8: number | null,
  /** Waluta notowania — ceny docelowe w innej walucie nie wchodzą do mediany. */
  priceCurrency = 'PLN',
): RatingConsensus {
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
    targetCurrency: row.targetCurrency,
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

  /*
   * Do mediany wchodzą wyłącznie wyceny w walucie notowania. Wcześniej regex
   * czytał tylko kwoty w złotych, więc problem nie istniał; po dopuszczeniu
   * dolarów i euro mieszanie ich dałoby medianę bez sensu — a na jej podstawie
   * liczy się „potencjał" wobec ceny bieżącej.
   *
   * Starsze wpisy nie mają zapisanej waluty; skoro powstały pod regexem
   * wymagającym „zł", traktujemy je jako złotowe.
   */
  const targets = entries
    .filter((entry) => (entry.targetCurrency ?? 'PLN') === priceCurrency)
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
    upgrades: entries.filter((entry) => entry.direction === 'up').length,
    downgrades: entries.filter((entry) => entry.direction === 'down').length,
    scoreAvg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    medianTargetE8: median,
    targetCurrency: median === null ? null : priceCurrency,
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
    // Porównanie po grupie: po rozbiciu klas żaden instrument nie ma już
    // wartości 'stock' ani 'etf', a dosłowne porównanie cicho wyzerowałoby
    // listę spółek do odświeżenia.
    .filter((row) => {
      const group = rollUp(row.assetClass as AssetClass);
      return group === 'stock' || group === 'etf';
    });

  let total = 0;
  for (const row of rows) {
    total += await fetchRecommendations(row);
  }

  return `zapisano ${total} rekomendacji dla ${rows.length} instrumentów`;
}
