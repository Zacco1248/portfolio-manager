import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { FX_SCALE, toFx, toPrice } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { fxRates } from '../db/schema.js';
import { addDays, previousBusinessDay, today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('fx');

const NBP_API = 'https://api.nbp.pl/api';
export const ONE_E6 = Number(FX_SCALE);

interface NbpRatesResponse {
  table: string;
  code: string;
  rates: { no: string; effectiveDate: string; mid: number }[];
}

interface NbpGoldResponse {
  data: string;
  cena: number;
}

/**
 * Kurs waluty na dany dzień. Kolejność: cache w bazie → NBP → ostatni znany
 * kurs wcześniejszy. Waluta bazowa zawsze 1:1.
 *
 * NBP nie publikuje tabel w weekendy i święta, więc zapytanie idzie o zakres
 * kilku dni wstecz i bierzemy ostatni opublikowany kurs nie późniejszy niż
 * żądana data — dokładnie tak, jak robi to rozliczenie podatkowe.
 */
export async function getFxRate(currency: string, date: IsoDate): Promise<number> {
  const code = currency.toUpperCase();
  if (code === config.baseCurrency) return ONE_E6;

  const cached = findCachedRate(code, date);
  if (cached !== null) return cached;

  try {
    await fetchNbpRange(code, addDays(date, -14), date);
  } catch (err) {
    log.warn(`NBP nie oddał kursu ${code} na ${date}: ${errorMessage(err)}`);
  }

  const afterFetch = findCachedRate(code, date);
  if (afterFetch !== null) return afterFetch;

  // Ostatnia deska ratunku: jakikolwiek znany kurs. Lepiej wycenić pozycję
  // nieaktualnym kursem i oznaczyć ją jako nieświeżą, niż pokazać zero.
  const anyRate = db
    .select()
    .from(fxRates)
    .where(eq(fxRates.currency, code))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();

  if (anyRate) {
    log.warn(`Używam kursu ${code} z ${anyRate.date} zamiast z ${date} — brak nowszych danych`);
    return anyRate.rateE6;
  }

  throw new Error(`Brak kursu ${code} na ${date} i żadnego kursu historycznego w bazie`);
}

/**
 * Kurs do celów podatkowych: tabela A z ostatniego dnia roboczego
 * poprzedzającego dzień transakcji (D-1).
 */
export async function getTaxFxRate(
  currency: string,
  tradeDate: IsoDate,
): Promise<{ rateE6: number; fxDate: IsoDate }> {
  const code = currency.toUpperCase();
  if (code === config.baseCurrency) return { rateE6: ONE_E6, fxDate: tradeDate };

  const target = previousBusinessDay(tradeDate);
  const rateE6 = await getFxRate(code, target);
  const actual = findCachedRateDate(code, target) ?? target;
  return { rateE6, fxDate: actual };
}

function findCachedRate(currency: string, date: IsoDate): number | null {
  const row = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();
  if (!row) return null;
  // Kurs starszy niż 10 dni traktujemy jako brak — wymusza odświeżenie z NBP.
  if (row.date < addDays(date, -10)) return null;
  return row.rateE6;
}

function findCachedRateDate(currency: string, date: IsoDate): IsoDate | null {
  const row = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();
  return row?.date ?? null;
}

/** Pobiera i zapisuje zakres kursów z tabeli A. Zakres NBP to maks. 367 dni. */
export async function fetchNbpRange(currency: string, from: IsoDate, to: IsoDate): Promise<number> {
  const code = currency.toLowerCase();
  const url = `${NBP_API}/exchangerates/rates/a/${code}/${from}/${to}/?format=json`;

  let data: NbpRatesResponse;
  try {
    data = await fetchJson<NbpRatesResponse>(url);
  } catch (err) {
    // 404 znaczy "brak tabel w tym zakresie" — normalna sytuacja dla świąt,
    // nie błąd wymagający propagacji.
    if (errorMessage(err).includes('404')) return 0;
    throw err;
  }

  const rows = data.rates.map((r) => ({
    currency: currency.toUpperCase(),
    date: r.effectiveDate,
    rateE6: toFx(r.mid),
    tableName: 'A',
    source: 'NBP',
  }));

  if (rows.length === 0) return 0;

  db.insert(fxRates).values(rows).onConflictDoNothing().run();
  return rows.length;
}

/** Waluty, dla których trzymamy kursy — wyliczane z faktycznie posiadanych aktywów. */
export function currenciesInUse(): string[] {
  const rows = db.all<{ currency: string }>(
    sql`SELECT currency FROM transactions UNION SELECT currency FROM instruments`,
  );
  return rows
    .map((r) => r.currency?.toUpperCase())
    .filter((c): c is string => Boolean(c) && c !== config.baseCurrency);
}

/** Odświeżenie kursów bieżących — wołane przez crona po publikacji tabeli NBP. */
export async function refreshFxRates(): Promise<string> {
  const currencies = currenciesInUse();
  if (currencies.length === 0) return 'brak walut obcych w portfelu';

  const to = today(config.timezone);
  const from = addDays(to, -14);
  let total = 0;

  for (const currency of currencies) {
    try {
      total += await fetchNbpRange(currency, from, to);
    } catch (err) {
      log.warn(`Nie udało się odświeżyć ${currency}: ${errorMessage(err)}`);
    }
  }

  return `zaktualizowano ${total} notowań dla ${currencies.length} walut`;
}

/**
 * Cena złota z NBP: PLN za gram próby 1000, zwracana w skali price_e8.
 * Niezależne źródło obok Stooq XAUUSD — dla polskiego użytkownika bywa
 * bliższe realnym cenom skupu.
 */
export async function getNbpGoldPrice(date: IsoDate): Promise<number | null> {
  try {
    const data = await fetchJson<NbpGoldResponse[]>(
      `${NBP_API}/cenyzlota/${addDays(date, -14)}/${date}/?format=json`,
    );
    const last = data.at(-1);
    return last ? toPrice(last.cena) : null;
  } catch (err) {
    log.warn(`Brak ceny złota NBP na ${date}: ${errorMessage(err)}`);
    return null;
  }
}
