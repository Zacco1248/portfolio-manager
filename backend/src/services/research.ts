import { and, desc, eq, gte } from 'drizzle-orm';
import { shareBp } from '@portfolio/shared';
import type { Candle } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, newsItems, pricesDaily } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { fetchAnalystSummary } from '../providers/yahoo-summary.js';
import { toYahooSymbol } from '../providers/yahoo.js';
import { checkFeature } from './ai-config.js';
import { toProviderInstrument } from './prices.js';
import { createLogger } from '../lib/logger.js';
import { completeWithMeta, estimateCostMicroUsd } from './ai.js';
import { activePortfolioIds, buildPositions, toInstrumentDto } from './positions.js';
import { ratingConsensus, fetchRecommendations } from './recommendations.js';
import type { RatingConsensus } from './recommendations.js';
import { backfillInstrumentHistory, historyNeedsRefresh } from './prices.js';
import { computeIndicators, currentState, detectSignals } from './technical.js';
import type { TechnicalState } from './technical.js';

const log = createLogger('research');

/**
 * Przegląd spółki w jednym miejscu.
 *
 * Dotąd, żeby wyrobić sobie zdanie o walorze, trzeba było obejść kilka
 * zakładek i samemu zestawić notowania z wiadomościami i strukturą portfela.
 * Ten moduł składa to w jedną odpowiedź: cena, technika, rekomendacje prasy,
 * wiadomości i wpływ ewentualnego zakupu na portfel.
 *
 * Wszystko poza komentarzem modelu powstaje lokalnie.
 */

export interface ResearchSnapshot {
  instrument: ReturnType<typeof toInstrumentDto>;
  priceE8: number | null;
  changes: { days: number; changeBp: number | null }[];
  technical: TechnicalState;
  signals: { date: string; label: string; detail: string }[];
  ratings: RatingConsensus;
  news: { title: string; publishedAt: string; source: string; url: string }[];
  /** Czy i w jakiej skali walor już jest w portfelu. */
  holding: { held: boolean; shareBp: number; valuePlnMinor: number } | null;
  candles: Candle[];
}

/** Okna, dla których liczymy zmianę kursu w przeglądzie. */
const CHANGE_WINDOWS = [1, 7, 30, 90, 365];

/**
 * Wyszukiwanie spółki po symbolu lub nazwie.
 *
 * Instrumenty znane aplikacji idą na początek listy, ale nie zastępują
 * odpowiedzi dostawcy. Wcześniej pierwsze lokalne trafienie zwierało obwód
 * i w ogóle nie pytaliśmy Yahoo — przez co „Service now" gubiło ServiceNow,
 * jeśli w bazie było cokolwiek zawierającego „now" (choćby „Snowflake"
 * albo spółka z „Nowa" w nazwie).
 *
 * Dopasowanie lokalne trzyma się granicy słowa z tego samego powodu.
 */
export async function searchCompanies(query: string): Promise<
  {
    id: number | null;
    symbol: string;
    name: string;
    assetClass: string;
    exchange: string | null;
    currency?: string | null;
    known: boolean;
  }[]
> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const matchesLocally = (value: string): boolean => {
    const haystack = value.toLowerCase();
    if (haystack.startsWith(needle)) return true;
    // Granica słowa: „now" ma trafiać w „ServiceNow" i „NOW Inc", ale nie
    // w środek „Snowflake".
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}`, 'i').test(haystack);
  };

  const local = db
    .select()
    .from(instruments)
    .all()
    .filter((row) => matchesLocally(row.symbol) || matchesLocally(row.name))
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      assetClass: row.assetClass,
      exchange: row.exchange,
      currency: row.currency,
      known: true,
    }));

  try {
    const { suggestSymbols } = await import('./instruments.js');
    const remote = await suggestSymbols(query);

    // Wyniki lokalne mają pierwszeństwo, ale zdalne je uzupełniają — ten sam
    // porządek co w `suggestSymbols`.
    const seen = new Set(local.map((item) => item.symbol.toUpperCase()));
    const extra = remote
      .filter((item) => !seen.has(item.symbol.toUpperCase()))
      .map((item) => ({
        id: null,
        symbol: item.symbol,
        name: item.name,
        assetClass: item.assetClass,
        exchange: item.exchange ?? null,
        currency: item.currency,
        known: false,
      }));

    return [...local, ...extra].slice(0, 15);
  } catch (err) {
    log.warn(`Wyszukiwanie „${query}" u dostawcy nieudane: ${errorMessage(err)}`);
    return local;
  }
}

/** Escapowanie do budowy wyrażenia z tekstu użytkownika. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function buildResearch(instrumentId: number, portfolioId?: number): Promise<ResearchSnapshot | null> {
  let instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return null;

  /*
   * Sektor i kraj uzupełniamy tu, a nie tylko w zbiorczej klasyfikacji.
   * Instrumenty dodane przed jej wprowadzeniem zostawały nieprzypisane aż do
   * ręcznego uruchomienia, przez co karta spółki pokazywała „sektor
   * nieprzypisany" mimo że dostawca zna odpowiedź.
   */
  if (!instrument.sector || !instrument.country) {
    instrument = (await ensureClassified(instrument)) ?? instrument;
  }

  let candles = readCandles(instrument.id);

  /*
   * Bez historii nie ma ani techniki, ani zmian procentowych — uzupełniamy
   * zanim cokolwiek policzymy, zamiast oddawać pustą kartę.
   *
   * Warunek patrzy też na wiek ostatniej świecy, nie tylko na ich liczbę:
   * papier z pełną historią urwaną rok temu nigdy nie spełniał progu
   * trzydziestu świec i wskaźniki zostawały nieaktualne bez końca.
   */
  if (candles.length < 30 || historyNeedsRefresh(instrument.id)) {
    try {
      await backfillInstrumentHistory(instrument.id);
      candles = readCandles(instrument.id);
    } catch (err) {
      log.warn(`Historia ${instrument.symbol} nieosiągalna: ${errorMessage(err)}`);
    }
  }

  const indicators = computeIndicators(candles);
  const priceE8 = candles.at(-1)?.closeE8 ?? null;

  // Rekomendacje dociągamy, gdy ich brak — inaczej pierwsze wejście na kartę
  // pokazywałoby pustkę aż do najbliższego przebiegu zadania cyklicznego.
  let ratings = ratingConsensus(instrument.id, priceE8, instrument.currency);
  if (ratings.entries.length === 0) {
    try {
      await fetchRecommendations(instrument);
      ratings = ratingConsensus(instrument.id, priceE8, instrument.currency);
    } catch (err) {
      log.warn(`Rekomendacje ${instrument.symbol} nieosiągalne: ${errorMessage(err)}`);
    }
  }

  return {
    instrument: toInstrumentDto(instrument),
    priceE8,
    changes: CHANGE_WINDOWS.map((days) => ({ days, changeBp: changeOver(candles, days) })),
    technical: currentState(indicators, candles),
    signals: detectSignals(candles, indicators)
      .slice(-6)
      .reverse()
      .map((signal) => ({ date: signal.date, label: signal.label, detail: signal.detail })),
    ratings,
    news: recentNews(instrument.id),
    holding: holdingShare(instrument.id, portfolioId),
    candles: candles.slice(-260),
  };
}

function readCandles(instrumentId: number): Candle[] {
  return db
    .select()
    .from(pricesDaily)
    .where(eq(pricesDaily.instrumentId, instrumentId))
    .orderBy(pricesDaily.date)
    .all()
    .map((row) => ({
      date: row.date,
      // Część źródeł podaje wyłącznie zamknięcie; wskaźniki oparte o zakres
      // sesji potrzebują liczb, więc brakujące pola zastępujemy zamknięciem.
      openE8: row.openE8 ?? row.closeE8,
      highE8: row.highE8 ?? row.closeE8,
      lowE8: row.lowE8 ?? row.closeE8,
      closeE8: row.closeE8,
      volume: row.volume,
    }));
}

/** Zmiana wobec sesji sprzed N dni kalendarzowych. */
function changeOver(candles: Candle[], days: number): number | null {
  if (candles.length < 2) return null;

  const last = candles.at(-1)!;
  const cutoff = addDays(last.date, -days);

  // Pierwsza sesja od progu, a nie N-ta wstecz — kalendarz nie pokrywa się
  // z sesjami, a przy 365 dniach różnica sięga kilkudziesięciu notowań.
  const reference = candles.find((candle) => candle.date >= cutoff) ?? candles[0]!;
  if (reference.closeE8 <= 0 || reference.date === last.date) return null;

  return Math.round((last.closeE8 / reference.closeE8 - 1) * 10_000);
}

function recentNews(instrumentId: number): ResearchSnapshot['news'] {
  return db
    .select()
    .from(newsItems)
    .where(and(eq(newsItems.instrumentId, instrumentId), gte(newsItems.publishedAt, addDays(today(config.timezone), -60))))
    .orderBy(desc(newsItems.publishedAt))
    .limit(8)
    .all()
    .map((row) => ({
      title: row.title,
      publishedAt: row.publishedAt.slice(0, 10),
      source: row.source,
      url: row.url,
    }));
}

function holdingShare(instrumentId: number, portfolioId?: number): ResearchSnapshot['holding'] {
  const { positions, cashByPortfolio } = buildPositions(activePortfolioIds(portfolioId));
  const total =
    positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
    [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);

  const position = positions.find((p) => p.instrument.id === instrumentId);
  if (!position) return { held: false, shareBp: 0, valuePlnMinor: 0 };

  return {
    held: true,
    shareBp: Math.round(shareBp(position.valuePlnMinor, total)),
    valuePlnMinor: position.valuePlnMinor,
  };
}

// ── Ocena dopasowania do portfela ────────────────────────────

const FIT_PROMPT = `Jesteś asystentem inwestora indywidualnego z Polski, budującego portfel długoterminowo dopłatami.

Dostajesz opis jednego waloru: zmiany kursu w kilku oknach, stan wskaźników technicznych, konsensus
rekomendacji prasy giełdowej, ostatnie nagłówki oraz strukturę portfela użytkownika i to, czy walor
już w nim jest.

Napisz po polsku 5-8 zdań w tej kolejności:
1. Czym ten walor jest i jaką rolę mógłby pełnić w portfelu (dywersyfikacja, ekspozycja na sektor lub region,
   dochód z dywidendy, wzrost).
2. Co mówi obraz techniczny — bez wróżenia, wyłącznie opis położenia wobec średnich, zmienności i momentum.
3. Jak wygląda konsensus analityków i na ile jest jednomyślny. Zaznacz, że to zapis tego, co napisała prasa.
4. Czy pasuje do TEGO portfela: co poprawia, co pogarsza, gdzie zwiększa koncentrację sektorową albo regionalną.

Zasady:
- Nie mów „kup" ani „nie kupuj". Opisujesz dopasowanie do struktury, nie wydajesz zalecenia.
- Nie prognozuj kursu i nie podawaj cen docelowych innych niż te z konsensusu.
- Jeśli walor już jest w portfelu z dużym udziałem, powiedz to wprost.

Styl odpowiedzi — równie ważny, co treść:
- Pisz o tym, co widzisz w danych. Nie wyliczaj tego, czego w nich brakuje (wycena fundamentalna,
  zadłużenie, koszty funduszu, sytuacja podatkowa, horyzont) — użytkownik i tak o tym wie, a taka
  lista zajmuje miejsce, w którym powinien być konkret.
- Żadnych zdań w rodzaju „warto sprawdzić", „należy rozważyć", „dobrze zweryfikować".
- Każde zdanie ma nieść liczbę albo nazwę. Zdanie bez konkretu wytnij.
- Piszesz zwartym tekstem, bez nagłówków i list punktowanych.`;

export interface FitResult {
  snapshot: ResearchSnapshot;
  text: string | null;
  unavailableReason: string | null;
  disclaimer: string;
  usage?: { provider: string; model: string; costMicroUsd: number | null };
}

const pct = (bp: number | null): string => (bp === null ? 'brak danych' : `${bp >= 0 ? '+' : ''}${(bp / 100).toFixed(1)}%`);

export async function assessFit(instrumentId: number, portfolioId?: number): Promise<FitResult | null> {
  const snapshot = await buildResearch(instrumentId, portfolioId);
  if (!snapshot) return null;

  const disclaimer =
    'Materiał informacyjny wygenerowany automatycznie na podstawie danych rynkowych i struktury portfela. ' +
    'Nie stanowi rekomendacji ani doradztwa inwestycyjnego.';

  const availability = checkFeature('portfolioFit');
  if (!availability.enabled) {
    return { snapshot, text: null, unavailableReason: availability.reason, disclaimer };
  }

  const { buildContext } = await import('./suggestions.js');
  const context = buildContext(portfolioId);

  const payload = [
    `Walor: ${snapshot.instrument.symbol} — ${snapshot.instrument.name}`,
    `Klasa: ${snapshot.instrument.assetClass}, sektor: ${snapshot.instrument.sector ?? 'nieprzypisany'}, region: ${snapshot.instrument.country ?? 'nieprzypisany'}`,
    `Zmiany kursu: ${snapshot.changes.map((c) => `${c.days}d ${pct(c.changeBp)}`).join(', ')}`,
    `Technika: RSI ${snapshot.technical.rsi?.toFixed(1) ?? 'brak'} (${snapshot.technical.rsiZone ?? '—'}), ` +
      `układ średnich ${snapshot.technical.trend ?? 'nieokreślony'}, ` +
      `pozycja we wstęgach ${snapshot.technical.bollingerPercent?.toFixed(0) ?? 'brak'}%, ` +
      `zmienność ATR ${snapshot.technical.atrPercent?.toFixed(2) ?? 'brak'}% dziennie, ` +
      `momentum 20 sesji ${snapshot.technical.momentum20?.toFixed(1) ?? 'brak'}%, ` +
      `od rocznego maksimum ${snapshot.technical.fromYearHighPercent?.toFixed(1) ?? 'brak'}%`,
    `Rekomendacje prasy (${snapshot.ratings.monthsCovered} mies.): ${
      Object.entries(snapshot.ratings.counts)
        .map(([rating, count]) => `${rating} ×${count}`)
        .join(', ') || 'brak'
    }; mediana ceny docelowej ${
      snapshot.ratings.medianTargetE8 ? `${(snapshot.ratings.medianTargetE8 / 1e8).toFixed(2)} zł` : 'brak'
    }, potencjał ${pct(snapshot.ratings.upsideBp)}`,
    `Ostatnie nagłówki: ${snapshot.news.slice(0, 5).map((n) => n.title).join(' | ') || 'brak'}`,
    '',
    `W portfelu: ${snapshot.holding?.held ? `tak, udział ${pct(snapshot.holding.shareBp)}` : 'nie'}`,
    `Sektory portfela: ${context.sectors.map((s) => `${s.name} ${s.sharePercent}%`).join('; ') || 'nieprzypisane'}`,
    `Regiony portfela: ${context.regions.map((r) => `${r.name} ${r.sharePercent}%`).join('; ') || 'nieprzypisane'}`,
    `Luki wobec celu: ${context.gaps.map((g) => `${g.label} ${g.currentSharePercent}% z ${g.targetSharePercent}%`).join('; ') || 'brak'}`,
    `Duża koncentracja: ${context.concentrated.map((c) => `${c.symbol} ${c.sharePercent}%`).join('; ') || 'brak'}`,
  ].join('\n');

  try {
    const meta = await completeWithMeta(FIT_PROMPT, payload, 1500);
    return {
      snapshot,
      text: meta.text,
      unavailableReason: meta.text ? null : 'Model nie zwrócił treści.',
      disclaimer,
      usage: { provider: meta.provider, model: meta.model, costMicroUsd: estimateCostMicroUsd(meta) },
    };
  } catch (err) {
    log.warn(`Ocena dopasowania nieudana: ${errorMessage(err)}`);
    return { snapshot, text: null, unavailableReason: 'Model nie odpowiedział.', disclaimer };
  }
}


/**
 * Konsensus rekomendacji dla jednego instrumentu.
 *
 * Wydzielone z przeglądu, bo karta instrumentu potrzebuje wyłącznie tego —
 * uzupełnianie historii notowań i liczenie wskaźników trwałoby tam bez powodu.
 */
export async function instrumentRatings(instrumentId: number): Promise<RatingConsensus | null> {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return null;

  const latest = db
    .select()
    .from(pricesDaily)
    .where(eq(pricesDaily.instrumentId, instrumentId))
    .orderBy(desc(pricesDaily.date))
    .limit(1)
    .get();

  let consensus = ratingConsensus(instrumentId, latest?.closeE8 ?? null, instrument.currency);

  if (consensus.entries.length === 0) {
    try {
      await fetchRecommendations(instrument);
      consensus = ratingConsensus(instrumentId, latest?.closeE8 ?? null, instrument.currency);
    } catch (err) {
      log.warn(`Rekomendacje ${instrument.symbol} nieosiągalne: ${errorMessage(err)}`);
    }
  }

  /*
   * Konsensus od dostawcy dokładamy obok odczytu z nagłówków, a nie zamiast
   * niego: polska prasa opisuje decyzje krajowych domów maklerskich, których
   * Yahoo nie zna, więc oba źródła się uzupełniają.
   *
   * Funkcja jest opcjonalna i domyślnie wyłączona — korzysta z
   * nieudokumentowanego mechanizmu, który może przestać działać.
   */
  if (checkFeature('analystConsensus').enabled) {
    const symbol = toYahooSymbol(toProviderInstrument(instrument));
    if (symbol) {
      const summary = await fetchAnalystSummary(symbol);
      if (summary?.targetMeanE8) {
        consensus = {
          ...consensus,
          provider: {
            targetMeanE8: summary.targetMeanE8,
            targetHighE8: summary.targetHighE8,
            targetLowE8: summary.targetLowE8,
            analystCount: summary.analystCount,
            recommendationKey: summary.recommendationKey,
            currency: summary.currency,
            distribution: summary.distribution,
            upsideBp:
              latest?.closeE8 && latest.closeE8 > 0 && summary.currency === instrument.currency
                ? Math.round((summary.targetMeanE8 / latest.closeE8 - 1) * 10_000)
                : null,
          },
        };
      }
    }
  }

  return consensus;
}


/**
 * Uzupełnienie sektora i kraju pojedynczego instrumentu.
 *
 * Najpierw to, co wynika z samych danych, potem dopiero pytanie do dostawcy.
 * Błąd sieci nie może wywrócić karty spółki, więc przy niepowodzeniu wracamy
 * z niezmienionym wierszem.
 */
async function ensureClassified(instrument: InstrumentRow): Promise<InstrumentRow | null> {
  const patch: Partial<InstrumentRow> = {};

  const { classifyInstrument, localClassification } = await import('./classify.js');
  const local = localClassification(instrument);
  if (!instrument.sector && local.sector) patch.sector = local.sector;
  if (!instrument.country && local.country) patch.country = local.country;

  if (!patch.sector && !instrument.sector && instrument.assetClass !== 'bond' && instrument.assetClass !== 'cash') {
    try {
      const classification = await classifyInstrument(instrument);
      if (classification.sector) patch.sector = classification.sector;
    } catch (err) {
      log.warn(`Klasyfikacja ${instrument.symbol} nieudana: ${errorMessage(err)}`);
    }
  }

  if (Object.keys(patch).length === 0) return instrument;

  return db.update(instruments).set(patch).where(eq(instruments.id, instrument.id)).returning().get();
}
