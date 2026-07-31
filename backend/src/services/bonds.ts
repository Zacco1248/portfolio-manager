import { eq } from 'drizzle-orm';
import { applyBp, bigintToNumber, mulDiv, parseDecimal } from '@portfolio/shared';
import type { BondHolding, BondKind, BondPeriod } from '@portfolio/shared';
import { INFLATION_INDEXED_BONDS, bondTermsFor } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { bondHoldings, cpiRates, instruments, transactions } from '../db/schema.js';
import { addMonths, addYears, daysBetween, minDate, today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';

/**
 * Naliczanie odsetek od detalicznych obligacji skarbowych.
 *
 * Reguły, których pilnuje ten moduł:
 *  - pierwszy okres odsetkowy ma stałe oprocentowanie z dnia zakupu,
 *  - kolejne okresy obligacji indeksowanych (EDO, COI, ROS, ROD) to
 *    inflacja z ogłoszonego odczytu plus marża emisji,
 *  - EDO kapitalizuje odsetki rocznie (odsetki powiększają kapitał),
 *    COI wypłaca je co roku i kapitał zostaje bez zmian,
 *  - parametry emisji są zapisane per zakup, bo każda transza ma inne stawki.
 */

/** Miesiąc odczytu inflacji używany do ustalenia stopy na kolejny okres. */
const CPI_LOOKBACK_MONTHS = 2;

export interface BondParams {
  kind: BondKind;
  purchaseDate: IsoDate;
  count: number;
  nominalMinor: number;
  firstYearRateBp: number;
  marginBp: number;
  termMonths: number;
  capitalization: 'annual' | 'none';
}

/** Inflacja rok do roku obowiązująca dla okresu zaczynającego się danego dnia. */
export function cpiForPeriodStart(periodStart: IsoDate): number | null {
  // Emitent bierze odczyt sprzed dwóch miesięcy — świeższy nie jest jeszcze ogłoszony.
  const reference = addMonths(periodStart, -CPI_LOOKBACK_MONTHS);
  const year = Number(reference.slice(0, 4));
  const month = Number(reference.slice(5, 7));

  const row = db
    .select()
    .from(cpiRates)
    .all()
    .find((r) => r.year === year && r.month === month);

  return row?.cpiYoyBp ?? null;
}

/**
 * Rozpisuje okresy odsetkowe od zakupu do wskazanego dnia.
 *
 * Okresy, dla których nie ma jeszcze odczytu inflacji, są oznaczone jako
 * prognozowane i używają ostatniej znanej inflacji. Bez tego oznaczenia
 * wartość obligacji wyglądałaby na pewną, a nie jest.
 */
export function computePeriods(params: BondParams, asOf: IsoDate): BondPeriod[] {
  const periods: BondPeriod[] = [];
  const maturity = addMonths(params.purchaseDate, params.termMonths);
  const isIndexed = INFLATION_INDEXED_BONDS.includes(params.kind);

  let capital = params.nominalMinor * params.count;
  let periodStart = params.purchaseDate;
  let index = 0;
  let lastKnownCpi: number | null = null;

  while (periodStart < maturity && periodStart <= asOf) {
    // Wycena dokładnie w rocznicę zakupu zaczyna nowy okres, który nie ma
    // jeszcze ani jednego dnia. Nie pokazujemy go — poza sytuacją, gdy
    // wyceniamy w dniu zakupu i jest to jedyny okres do pokazania.
    if (index > 0 && periodStart >= asOf) break;

    const periodEnd = minDate(addYears(periodStart, 1), maturity);

    let rateBp: number;
    let projected = false;

    if (index === 0) {
      // Pierwszy rok zawsze po stałej stawce z dnia zakupu.
      rateBp = params.firstYearRateBp;
    } else if (!isIndexed) {
      // TOS i podobne mają stałą stopę przez cały okres.
      rateBp = params.firstYearRateBp;
    } else {
      const cpi = cpiForPeriodStart(periodStart);
      if (cpi !== null) {
        lastKnownCpi = cpi;
        rateBp = cpi + params.marginBp;
      } else {
        rateBp = (lastKnownCpi ?? 0) + params.marginBp;
        projected = true;
      }
      // Emitent gwarantuje, że oprocentowanie nie spadnie poniżej marży.
      rateBp = Math.max(rateBp, params.marginBp);
    }

    const fullPeriodInterest = applyBp(capital, rateBp);

    // Okres bieżący naliczamy proporcjonalnie do liczby dni, które upłynęły.
    const isCurrent = asOf < periodEnd;
    const elapsedDays = daysBetween(periodStart, minDate(asOf, periodEnd));
    const totalDays = daysBetween(periodStart, periodEnd);
    const interest = isCurrent
      ? bigintToNumber(mulDiv(BigInt(fullPeriodInterest), BigInt(Math.max(elapsedDays, 0)), BigInt(totalDays)))
      : fullPeriodInterest;

    const closing = params.capitalization === 'annual' && !isCurrent ? capital + interest : capital;

    periods.push({
      index: index + 1,
      from: periodStart,
      to: periodEnd,
      rateBp,
      projected,
      openingCapitalMinor: capital,
      interestMinor: interest,
      closingCapitalMinor: closing,
    });

    capital = closing;
    periodStart = periodEnd;
    index += 1;
  }

  return periods;
}

export interface BondValuation {
  currentValueMinor: number;
  accruedInterestMinor: number;
  currentPeriodRateBp: number;
  periods: BondPeriod[];
}

export function valueBond(params: BondParams, asOf?: IsoDate): BondValuation {
  const day = asOf ?? today(config.timezone);
  const periods = computePeriods(params, day);
  const last = periods.at(-1);

  if (!last) {
    return {
      currentValueMinor: params.nominalMinor * params.count,
      accruedInterestMinor: 0,
      currentPeriodRateBp: params.firstYearRateBp,
      periods: [],
    };
  }

  // Przy kapitalizacji rocznej wartość wykupu to kapitał okresu bieżącego
  // powiększony o odsetki naliczone od jego początku. Przy braku
  // kapitalizacji odsetki są wypłacane, więc kapitał zostaje nominalny.
  const accrued =
    params.capitalization === 'annual'
      ? last.openingCapitalMinor - params.nominalMinor * params.count + last.interestMinor
      : last.interestMinor;

  return {
    currentValueMinor: last.openingCapitalMinor + last.interestMinor,
    accruedInterestMinor: accrued,
    currentPeriodRateBp: last.rateBp,
    periods,
  };
}

/**
 * Obligacje zaimportowane jako transakcje.
 *
 * Import nie tworzy dla nich osobnej pozycji obligacyjnej — zakup jest już
 * w transakcjach, a druga reprezentacja podwoiłaby wartość portfela. Warunki
 * emisji siedzą na instrumencie, więc na potrzeby tego widoku odtwarzamy
 * z nich wpisy obligacyjne.
 */
function importedBonds(portfolioId?: number): BondHolding[] {
  const rows = db
    .select()
    .from(instruments)
    .all()
    .filter((i) => i.assetClass === 'bond' && i.meta && typeof (i.meta as Record<string, unknown>).bondKind === 'string');

  const out: BondHolding[] = [];

  for (const instrument of rows) {
    const meta = instrument.meta as Record<string, unknown>;
    const kind = String(meta.bondKind).toUpperCase() as BondKind;
    const purchaseDate = String(meta.purchaseDate ?? '');
    const rate = Number(meta.firstYearRatePercent ?? 0);
    if (!purchaseDate || !Number.isFinite(rate) || rate <= 0) continue;

    // Liczba sztuk wynika z transakcji kupna tego instrumentu.
    const buys = db
      .select()
      .from(transactions)
      .where(eq(transactions.instrumentId, instrument.id))
      .all()
      .filter((t) => portfolioId === undefined || t.portfolioId === portfolioId);

    const count = Math.round(
      buys.reduce((sum, t) => sum + (t.type === 'buy' ? t.qtyE8 : t.type === 'sell' ? -t.qtyE8 : 0), 0) / 100_000_000,
    );
    if (count <= 0) continue;

    const params: BondParams = {
      kind,
      purchaseDate,
      count,
      nominalMinor: 10_000,
      firstYearRateBp: Math.round(rate * 100),
      marginBp: Math.round(Number(meta.marginPercent ?? 0) * 100),
      termMonths: bondTermsFor(kind).termMonths,
      capitalization: bondTermsFor(kind).capitalization,
    };
    const valuation = valueBond(params);

    out.push({
      id: -instrument.id,
      portfolioId: buys[0]?.portfolioId ?? 0,
      series: instrument.symbol,
      kind,
      purchaseDate,
      count,
      nominalMinor: params.nominalMinor,
      firstYearRateBp: params.firstYearRateBp,
      marginBp: params.marginBp,
      termMonths: params.termMonths,
      maturityDate: addMonths(purchaseDate, params.termMonths),
      capitalization: params.capitalization,
      currentValueMinor: valuation.currentValueMinor,
      accruedInterestMinor: valuation.accruedInterestMinor,
      currentPeriodRateBp: valuation.currentPeriodRateBp,
      periods: valuation.periods,
    });
  }

  return out;
}

export function listBonds(portfolioId?: number): BondHolding[] {
  const rows = db.select().from(bondHoldings).all();

  const manual = rows
    .filter((r) => portfolioId === undefined || r.portfolioId === portfolioId)
    .map((row) => {
      const params: BondParams = {
        kind: row.kind as BondKind,
        purchaseDate: row.purchaseDate,
        count: row.count,
        nominalMinor: row.nominalMinor,
        firstYearRateBp: row.firstYearRateBp,
        marginBp: row.marginBp,
        termMonths: row.termMonths,
        capitalization: row.capitalization as 'annual' | 'none',
      };
      const valuation = valueBond(params);

      return {
        id: row.id,
        portfolioId: row.portfolioId,
        series: row.series,
        kind: row.kind as BondKind,
        purchaseDate: row.purchaseDate,
        count: row.count,
        nominalMinor: row.nominalMinor,
        firstYearRateBp: row.firstYearRateBp,
        marginBp: row.marginBp,
        termMonths: row.termMonths,
        maturityDate: row.maturityDate,
        capitalization: row.capitalization as 'annual' | 'none',
        currentValueMinor: valuation.currentValueMinor,
        accruedInterestMinor: valuation.accruedInterestMinor,
        currentPeriodRateBp: valuation.currentPeriodRateBp,
        periods: valuation.periods,
      };
    });

  return [...manual, ...importedBonds(portfolioId)];
}

export function createBond(input: {
  portfolioId: number;
  series: string;
  kind: BondKind;
  purchaseDate: IsoDate;
  count: number;
  nominalAmount: string | number;
  firstYearRatePercent: string | number;
  marginPercent: string | number;
  termMonths: number;
  capitalization: 'annual' | 'none';
  earlyRedemptionFee: string | number;
}) {
  return db
    .insert(bondHoldings)
    .values({
      portfolioId: input.portfolioId,
      series: input.series,
      kind: input.kind,
      purchaseDate: input.purchaseDate,
      count: input.count,
      nominalMinor: parseDecimal(input.nominalAmount, 2),
      firstYearRateBp: parseDecimal(input.firstYearRatePercent, 2),
      marginBp: parseDecimal(input.marginPercent, 2),
      termMonths: input.termMonths,
      maturityDate: addMonths(input.purchaseDate, input.termMonths),
      capitalization: input.capitalization,
      earlyRedemptionFeeMinor: parseDecimal(input.earlyRedemptionFee, 2),
    })
    .returning()
    .get();
}

export function deleteBond(id: number): void {
  db.delete(bondHoldings).where(eq(bondHoldings.id, id)).run();
}

/** Zapis odczytów inflacji — ręcznie albo z importu. */
export function upsertCpi(entries: { year: number; month: number; cpiYoyPercent: string | number }[]): number {
  let count = 0;
  for (const entry of entries) {
    db.insert(cpiRates)
      .values({ year: entry.year, month: entry.month, cpiYoyBp: parseDecimal(entry.cpiYoyPercent, 2) })
      .onConflictDoUpdate({
        target: [cpiRates.year, cpiRates.month],
        set: { cpiYoyBp: parseDecimal(entry.cpiYoyPercent, 2) },
      })
      .run();
    count += 1;
  }
  return count;
}

export function listCpi() {
  return db.select().from(cpiRates).all().sort((a, b) => b.year - a.year || b.month - a.month);
}
