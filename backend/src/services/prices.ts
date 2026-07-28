import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { instruments, pricesDaily, quotes, transactions } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { config } from '../config.js';
import { addDays, nowIso, today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { fetchHistory, fetchQuote } from '../providers/registry.js';
import type { ProviderInstrument } from '../providers/types.js';

const log = createLogger('prices');

export function toProviderInstrument(row: InstrumentRow): ProviderInstrument {
  return {
    id: row.id,
    symbol: row.symbol,
    assetClass: row.assetClass as ProviderInstrument['assetClass'],
    currency: row.currency,
    exchange: row.exchange,
    provider: row.provider,
    providerSymbol: row.providerSymbol,
    unit: row.unit,
  };
}

/**
 * Instrumenty wymagające wyceny: te, na których jest niezerowa pozycja
 * w dowolnym portfelu, plus watchlist. Nie odpytujemy o papiery sprzedane
 * do zera — to marnowanie limitów API.
 */
export function instrumentsNeedingPrices(): InstrumentRow[] {
  const rows = db.all<{ instrument_id: number }>(sql`
    SELECT instrument_id FROM (
      SELECT instrument_id, SUM(
        CASE type WHEN 'buy' THEN qty_e8 WHEN 'sell' THEN -qty_e8 ELSE 0 END
      ) AS qty
      FROM transactions
      WHERE instrument_id IS NOT NULL
      GROUP BY instrument_id, portfolio_id
    ) WHERE qty > 0
    UNION
    SELECT instrument_id FROM watchlist
  `);

  const ids = [...new Set(rows.map((r) => r.instrument_id))];
  if (ids.length === 0) return [];
  return db.select().from(instruments).where(inArray(instruments.id, ids)).all();
}

export interface PriceRefreshResult {
  updated: number;
  failed: number;
  skipped: number;
}

/** Odświeżenie notowań bieżących. Awaria jednego instrumentu nie przerywa reszty. */
export async function refreshQuotes(rows?: InstrumentRow[]): Promise<PriceRefreshResult> {
  const targets = rows ?? instrumentsNeedingPrices();
  const result: PriceRefreshResult = { updated: 0, failed: 0, skipped: 0 };

  for (const row of targets) {
    try {
      const fetched = await fetchQuote(toProviderInstrument(row));
      if (!fetched) {
        result.skipped += 1;
        continue;
      }

      const { quote, providerId } = fetched;
      db.insert(quotes)
        .values({
          instrumentId: row.id,
          priceE8: quote.priceE8,
          currency: quote.currency,
          prevCloseE8: quote.prevCloseE8,
          ts: quote.ts,
          source: providerId,
        })
        .onConflictDoUpdate({
          target: quotes.instrumentId,
          set: {
            priceE8: quote.priceE8,
            currency: quote.currency,
            prevCloseE8: quote.prevCloseE8,
            ts: quote.ts,
            source: providerId,
          },
        })
        .run();

      // Notowanie bieżące trafia też do historii dziennej jako zamknięcie dnia.
      // Cron w ciągu dnia nadpisuje ten wpis kolejnymi odczytami.
      db.insert(pricesDaily)
        .values({
          instrumentId: row.id,
          date: today(config.timezone),
          closeE8: quote.priceE8,
          source: providerId,
          fetchedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: [pricesDaily.instrumentId, pricesDaily.date],
          set: { closeE8: quote.priceE8, source: providerId, fetchedAt: nowIso() },
        })
        .run();

      result.updated += 1;
    } catch (err) {
      log.warn(`Nie udało się zaktualizować ${row.symbol}: ${errorMessage(err)}`);
      result.failed += 1;
    }
  }

  return result;
}

/** Uzupełnia historię dzienną instrumentu. Wołane przy dodaniu pozycji i z crona. */
export async function backfillHistory(row: InstrumentRow, from: IsoDate, to?: IsoDate): Promise<number> {
  const end = to ?? today(config.timezone);
  const fetched = await fetchHistory(toProviderInstrument(row), from, end);
  if (!fetched) return 0;

  const values = fetched.candles.map((c) => ({
    instrumentId: row.id,
    date: c.date,
    openE8: c.openE8,
    highE8: c.highE8,
    lowE8: c.lowE8,
    closeE8: c.closeE8,
    volume: c.volume,
    source: fetched.providerId,
  }));

  if (values.length === 0) return 0;

  // Wstawiamy porcjami — SQLite ma limit liczby parametrów w jednym zapytaniu.
  for (let i = 0; i < values.length; i += 200) {
    db.insert(pricesDaily).values(values.slice(i, i + 200)).onConflictDoNothing().run();
  }

  return values.length;
}

/**
 * Historia dla wszystkich posiadanych instrumentów, od pierwszej transakcji.
 * Potrzebna do wykresu wartości portfela i analizy technicznej.
 */
export async function backfillAllHistory(): Promise<string> {
  const targets = instrumentsNeedingPrices();
  let total = 0;

  for (const row of targets) {
    const first = db
      .select({ date: transactions.tradeDate })
      .from(transactions)
      .where(eq(transactions.instrumentId, row.id))
      .orderBy(transactions.tradeDate)
      .limit(1)
      .get();

    const from = first?.date ?? addDays(today(config.timezone), -365);
    try {
      total += await backfillHistory(row, from);
    } catch (err) {
      log.warn(`Historia ${row.symbol} nieudana: ${errorMessage(err)}`);
    }
  }

  return `uzupełniono ${total} notowań dla ${targets.length} instrumentów`;
}

export interface LatestPrice {
  priceE8: number;
  currency: string;
  prevCloseE8: number | null;
  ts: string;
  source: string;
  /** true, gdy cena jest starsza niż dwa dni robocze — UI powinno to pokazać. */
  stale: boolean;
}

/** Ostatnia znana cena: najpierw notowanie bieżące, potem historia dzienna. */
export function getLatestPrice(instrumentId: number, instrumentCurrency: string): LatestPrice | null {
  const quote = db.select().from(quotes).where(eq(quotes.instrumentId, instrumentId)).get();
  if (quote) {
    return {
      priceE8: quote.priceE8,
      currency: quote.currency,
      prevCloseE8: quote.prevCloseE8,
      ts: quote.ts,
      source: quote.source,
      stale: isStale(quote.ts),
    };
  }

  const daily = db
    .select()
    .from(pricesDaily)
    .where(eq(pricesDaily.instrumentId, instrumentId))
    .orderBy(desc(pricesDaily.date))
    .limit(1)
    .get();

  if (!daily) return null;

  return {
    priceE8: daily.closeE8,
    currency: instrumentCurrency,
    prevCloseE8: null,
    ts: `${daily.date}T00:00:00.000Z`,
    source: daily.source,
    stale: isStale(`${daily.date}T00:00:00.000Z`),
  };
}

function isStale(ts: string): boolean {
  const ageHours = (Date.now() - Date.parse(ts)) / 3_600_000;
  // 80 godzin przykrywa weekend plus jeden dzień świąteczny.
  return ageHours > 80;
}

/** Kurs zamknięcia na konkretny dzień lub najbliższy wcześniejszy. */
export function getPriceOn(instrumentId: number, date: IsoDate): number | null {
  const row = db
    .select()
    .from(pricesDaily)
    .where(and(eq(pricesDaily.instrumentId, instrumentId), lte(pricesDaily.date, date)))
    .orderBy(desc(pricesDaily.date))
    .limit(1)
    .get();
  return row?.closeE8 ?? null;
}

/** Czy jesteśmy w godzinach, w których warto odpytywać o ceny. */
export function isMarketHours(): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  return hour >= config.prices.marketOpenHour && hour <= config.prices.marketCloseHour;
}


/**
 * Historia notowań jednego instrumentu, od pierwszej jego transakcji.
 *
 * Wywoływane po dodaniu pozycji i doraźnie, gdy jakaś funkcja natrafi na pustą
 * historię. Bez tego wykres i analiza techniczna czekały do ręcznego
 * uruchomienia uzupełniania, a brak danych bywał mylony z brakiem obrotu.
 */
export async function backfillInstrumentHistory(instrumentId: number): Promise<number> {
  const row = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!row) return 0;

  const first = db
    .select({ date: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(transactions.tradeDate)
    .limit(1)
    .get();

  const from = first?.date ?? addDays(today(config.timezone), -365);

  try {
    return await backfillHistory(row, from);
  } catch (err) {
    log.warn(`Historia ${row.symbol} nieudana: ${errorMessage(err)}`);
    return 0;
  }
}
