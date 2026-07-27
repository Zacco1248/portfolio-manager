import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { toPrice } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { dividendEvents, instruments, reportDates } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { addDays, fromDate, today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { toYahooSymbol } from '../providers/yahoo.js';
import { instrumentsNeedingPrices, toProviderInstrument } from './prices.js';

const log = createLogger('corporate-actions');

/**
 * Zdarzenia korporacyjne: historia wypłat dywidend i splitów.
 *
 * Yahoo udostępnia je w tym samym endpoincie co notowania, bez uwierzytelniania.
 * Moduł `quoteSummary`, który zawierałby przyszłe terminy i składy funduszy,
 * jest za mechanizmem crumb — świadomie go nie obchodzimy, więc przyszłe
 * terminy wypłat *prognozujemy* z rytmu historycznych, a skład ETF-ów
 * użytkownik wprowadza sam.
 */

interface YahooEventsResponse {
  chart: {
    result:
      | {
          meta: { currency: string | null };
          events?: {
            dividends?: Record<string, { amount: number; date: number }>;
            splits?: Record<string, { date: number; numerator: number; denominator: number }>;
          };
        }[]
      | null;
  };
}

/** Pobiera i zapisuje historię dywidend dla instrumentu. */
export async function fetchDividendHistory(instrument: InstrumentRow): Promise<number> {
  const symbol = toYahooSymbol(toProviderInstrument(instrument));
  if (!symbol) return 0;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d&events=div%2Csplit`;
  const data = await fetchJson<YahooEventsResponse>(url, {
    headers: { Accept: 'application/json' },
    minIntervalMs: 400,
    retries: 1,
  });

  const result = data.chart.result?.[0];
  const dividends = result?.events?.dividends;
  if (!dividends) return 0;

  const currency = (result?.meta.currency ?? instrument.currency).toUpperCase();
  const rows = Object.values(dividends).map((entry) => ({
    instrumentId: instrument.id,
    exDate: fromDate(new Date(entry.date * 1000)),
    amountE8: toPrice(entry.amount),
    currency,
    source: 'yahoo',
  }));

  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += 200) {
    db.insert(dividendEvents)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .run();
  }

  return rows.length;
}

export async function refreshDividendHistory(): Promise<string> {
  const targets = instrumentsNeedingPrices().filter(
    (i) => i.assetClass === 'stock' || i.assetClass === 'etf',
  );
  let total = 0;

  for (const instrument of targets) {
    try {
      total += await fetchDividendHistory(instrument);
    } catch (err) {
      log.debug(`Historia dywidend ${instrument.symbol} nieosiągalna: ${errorMessage(err)}`);
    }
  }

  return `zapisano ${total} zdarzeń dywidendowych dla ${targets.length} instrumentów`;
}

export interface UpcomingDividend {
  instrumentId: number;
  symbol: string;
  name: string;
  /** Prognozowany dzień ustalenia prawa, wyliczony z rytmu poprzednich wypłat. */
  expectedExDate: IsoDate;
  lastExDate: IsoDate;
  lastAmountE8: number;
  currency: string;
  /** annual | semiannual | quarterly | monthly | irregular */
  cadence: string;
  /** Ile wypłat posłużyło do wyznaczenia rytmu. */
  observations: number;
}

const CADENCE_BUCKETS: { maxDays: number; label: string; days: number }[] = [
  { maxDays: 45, label: 'monthly', days: 30 },
  { maxDays: 135, label: 'quarterly', days: 91 },
  { maxDays: 250, label: 'semiannual', days: 182 },
  { maxDays: 450, label: 'annual', days: 365 },
];

/**
 * Wyznacza rytm wypłat z median odstępów między kolejnymi dywidendami.
 * Mediana, a nie średnia — pojedyncza wypłata specjalna nie może przesunąć
 * całej prognozy.
 */
function detectCadence(dates: IsoDate[]): { label: string; days: number } | null {
  if (dates.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    gaps.push(Math.round((Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / 86_400_000));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;

  const bucket = CADENCE_BUCKETS.find((b) => median <= b.maxDays);
  return bucket ? { label: bucket.label, days: bucket.days } : null;
}

/**
 * Kalendarz nadchodzących dywidend.
 *
 * To są terminy *prognozowane*, nie ogłoszone przez spółkę — dostępne za darmo
 * źródła nie podają przyszłych dat. Interfejs musi to jasno komunikować.
 */
export function upcomingDividends(instrumentIds: number[]): UpcomingDividend[] {
  if (instrumentIds.length === 0) return [];

  const instrumentMap = new Map(
    db.select().from(instruments).where(inArray(instruments.id, instrumentIds)).all().map((i) => [i.id, i]),
  );

  const out: UpcomingDividend[] = [];
  const day = today(config.timezone);

  for (const instrumentId of instrumentIds) {
    const instrument = instrumentMap.get(instrumentId);
    if (!instrument) continue;

    const history = db
      .select()
      .from(dividendEvents)
      .where(eq(dividendEvents.instrumentId, instrumentId))
      .orderBy(asc(dividendEvents.exDate))
      .all();

    if (history.length === 0) continue;

    const last = history.at(-1)!;
    const cadence = detectCadence(history.map((h) => h.exDate));
    if (!cadence) continue;

    // Przesuwamy prognozę o kolejne okresy, aż wypadnie w przyszłości —
    // spółka mogła przerwać wypłaty, ale wtedy i tak pokażemy najbliższy
    // sensowny termin, a nie datę sprzed lat.
    let expected = addDays(last.exDate, cadence.days);
    let guard = 0;
    while (expected < day && guard < 20) {
      expected = addDays(expected, cadence.days);
      guard += 1;
    }

    out.push({
      instrumentId,
      symbol: instrument.symbol,
      name: instrument.name,
      expectedExDate: expected,
      lastExDate: last.exDate,
      lastAmountE8: last.amountE8,
      currency: last.currency,
      cadence: cadence.label,
      observations: history.length,
    });
  }

  return out.sort((a, b) => (a.expectedExDate < b.expectedExDate ? -1 : 1));
}

/** Historia wypłat danego instrumentu — do widoku szczegółów. */
export function dividendHistory(instrumentId: number) {
  return db
    .select()
    .from(dividendEvents)
    .where(eq(dividendEvents.instrumentId, instrumentId))
    .orderBy(desc(dividendEvents.exDate))
    .all();
}

// ─────────────────────────────────────────────────────────────
// Terminy raportów okresowych
// ─────────────────────────────────────────────────────────────

/**
 * Terminy raportów wprowadza użytkownik.
 *
 * GPW i spółki publikują harmonogramy, ale nie w formie darmowego API, którego
 * dałoby się użyć bez obchodzenia zabezpieczeń. Ręczne wprowadzenie kilku dat
 * rocznie jest uczciwsze niż scraping, który zepsuje się przy pierwszej
 * zmianie layoutu strony.
 */
export function listReportDates(from?: IsoDate) {
  const cutoff = from ?? addDays(today(config.timezone), -30);
  const rows = db
    .select()
    .from(reportDates)
    .where(gte(reportDates.date, cutoff))
    .orderBy(asc(reportDates.date))
    .all();

  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));

  return rows.map((row) => ({
    id: row.id,
    instrumentId: row.instrumentId,
    symbol: instrumentMap.get(row.instrumentId)?.symbol ?? '',
    name: instrumentMap.get(row.instrumentId)?.name ?? '',
    date: row.date,
    label: row.label,
    note: row.note,
    source: row.source,
  }));
}

export function addReportDate(input: { instrumentId: number; date: IsoDate; label: string; note?: string }) {
  return db
    .insert(reportDates)
    .values({
      instrumentId: input.instrumentId,
      date: input.date,
      label: input.label,
      note: input.note ?? null,
      source: 'manual',
    })
    .onConflictDoUpdate({
      target: [reportDates.instrumentId, reportDates.date, reportDates.label],
      set: { note: input.note ?? null },
    })
    .returning()
    .get();
}

export function deleteReportDate(id: number): void {
  db.delete(reportDates).where(eq(reportDates.id, id)).run();
}

// ─────────────────────────────────────────────────────────────
// Skład ETF-ów
// ─────────────────────────────────────────────────────────────

export interface HoldingInput {
  symbol: string;
  weightPercent: string | number;
}

/**
 * Zapisuje skład funduszu. Dane pochodzą od użytkownika — emitenci publikują
 * je jako pliki CSV na swoich stronach, ale każdy w innym formacie, a wykrywanie
 * składu po nazwie funduszu byłoby zgadywaniem.
 *
 * Wagi normalizujemy do punktów bazowych i sortujemy malejąco.
 */
export function setHoldings(instrumentId: number, holdings: HoldingInput[]): number {
  const parsed = holdings
    .map((h) => ({
      symbol: h.symbol.trim().toUpperCase(),
      weightBp: Math.round(Number(String(h.weightPercent).replace(',', '.')) * 100),
    }))
    .filter((h) => h.symbol.length > 0 && Number.isFinite(h.weightBp) && h.weightBp > 0)
    .sort((a, b) => b.weightBp - a.weightBp);

  db.update(instruments)
    .set({ holdings: parsed.length > 0 ? parsed : null })
    .where(eq(instruments.id, instrumentId))
    .run();

  return parsed.length;
}

export function getHoldings(instrumentId: number) {
  const row = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  return row?.holdings ?? [];
}

/**
 * Parsuje wklejony skład funduszu. Akceptuje format „TICKER<separator>waga",
 * czyli to, co wychodzi po skopiowaniu tabeli ze strony emitenta albo z CSV.
 */
export function parseHoldingsText(text: string): HoldingInput[] {
  const out: HoldingInput[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ostatnia liczba w wierszu to waga; pierwszy człon to ticker.
    const match = /^([A-Za-z0-9.\-:]+)[\s,;|\t]+.*?([\d]+[.,]?[\d]*)\s*%?$/.exec(trimmed);
    if (!match) continue;

    const symbol = match[1]!;
    // Pomijamy wiersz nagłówkowy.
    if (/^(ticker|symbol|nazwa|name|isin)$/i.test(symbol)) continue;

    out.push({ symbol, weightPercent: match[2]! });
  }

  return out;
}

/** Instrumenty, dla których warto uzupełnić skład — ETF-y bez danych. */
export function etfsMissingHoldings(): { id: number; symbol: string; name: string }[] {
  return db
    .select()
    .from(instruments)
    .where(and(eq(instruments.assetClass, 'etf')))
    .all()
    .filter((i) => !i.holdings || i.holdings.length === 0)
    .map((i) => ({ id: i.id, symbol: i.symbol, name: i.name }));
}
