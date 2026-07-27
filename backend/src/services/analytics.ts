import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { changeBp } from '@portfolio/shared';
import type { AnalyticsResponse, BenchmarkSeries, XirrResult } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { benchmarkSeries, instruments, transactions } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { yahooProvider } from '../providers/yahoo.js';
import { buildPositions } from './positions.js';
import { readHistory } from './snapshots.js';
import { computeXirr } from './xirr.js';
import type { Cashflow } from './xirr.js';

const log = createLogger('analytics');

/**
 * Benchmarki. WIG nie jest dostępny w API Yahoo — używamy WIG20, który jest
 * jedynym indeksem GPW, jaki to źródło publikuje. Nazwę pokazujemy wprost,
 * żeby porównanie nie sugerowało czegoś innego niż jest.
 */
export const BENCHMARKS: Record<string, { symbol: string; label: string; currency: string }> = {
  WIG20: { symbol: 'WIG20.WA', label: 'WIG20', currency: 'PLN' },
  SP500: { symbol: '^GSPC', label: 'S&P 500', currency: 'USD' },
  MWIG40: { symbol: 'MWIG40.WA', label: 'mWIG40', currency: 'PLN' },
  NASDAQ: { symbol: '^IXIC', label: 'NASDAQ Composite', currency: 'USD' },
  MSCI_WORLD: { symbol: 'URTH', label: 'MSCI World (ETF URTH)', currency: 'USD' },
};

/**
 * XIRR całego portfela. Przepływami są wpłaty i wypłaty gotówki, a domykającym
 * przepływem bieżąca wartość portfela.
 *
 * Świadomie nie bierzemy tu zakupów i sprzedaży — one przesuwają pieniądze
 * wewnątrz portfela i nie są przepływem między inwestorem a portfelem.
 */
export function portfolioXirr(portfolioIds: number[]): XirrResult {
  if (portfolioIds.length === 0) {
    return { rateBp: null, cashflowCount: 0, from: null, to: null, converged: false };
  }

  const rows = db
    .select()
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIds))
    .orderBy(asc(transactions.tradeDate))
    .all();

  const flows: Cashflow[] = rows
    .filter((r) => r.type === 'deposit' || r.type === 'withdrawal')
    // Wpłata do portfela to z punktu widzenia inwestora wydatek, stąd minus.
    .map((r) => ({ date: r.tradeDate, amountMinor: -r.amountPlnMinor }));

  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const currentValue =
    positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
    [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);

  flows.push({ date: today(config.timezone), amountMinor: currentValue });
  return computeXirr(flows);
}

/**
 * XIRR pojedynczej pozycji. Tu przepływami są zakupy, sprzedaże i dywidendy,
 * domknięte bieżącą wartością pozostałej ilości.
 */
export function positionXirr(portfolioIds: number[]): AnalyticsResponse['positionXirr'] {
  if (portfolioIds.length === 0) return [];

  const rows = db
    .select()
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIds))
    .orderBy(asc(transactions.tradeDate))
    .all()
    .filter((r) => r.instrumentId !== null);

  const instrumentMap = new Map(
    db
      .select()
      .from(instruments)
      .all()
      .map((i) => [i.id, i]),
  );

  const { positions } = buildPositions(portfolioIds);
  const valueByInstrument = new Map<number, number>();
  for (const position of positions) {
    valueByInstrument.set(
      position.instrument.id,
      (valueByInstrument.get(position.instrument.id) ?? 0) + position.valuePlnMinor,
    );
  }

  const byInstrument = new Map<number, Cashflow[]>();
  for (const row of rows) {
    const id = row.instrumentId!;
    const flows = byInstrument.get(id) ?? [];
    // Zakup to zaangażowanie kapitału (ujemny), sprzedaż i dywidenda to zwrot.
    flows.push({ date: row.tradeDate, amountMinor: row.amountPlnMinor });
    byInstrument.set(id, flows);
  }

  const result: AnalyticsResponse['positionXirr'] = [];
  for (const [instrumentId, flows] of byInstrument) {
    const instrument = instrumentMap.get(instrumentId);
    if (!instrument) continue;

    const currentValue = valueByInstrument.get(instrumentId) ?? 0;
    const closing = currentValue > 0 ? [{ date: today(config.timezone), amountMinor: currentValue }] : [];
    const xirr = computeXirr([...flows, ...closing]);

    result.push({ instrumentId, symbol: instrument.symbol, name: instrument.name, xirr });
  }

  return result.sort((a, b) => (b.xirr.rateBp ?? -1e9) - (a.xirr.rateBp ?? -1e9));
}

/** Pobiera i cache'uje serię benchmarku. */
export async function refreshBenchmark(key: string, from: IsoDate): Promise<number> {
  const meta = BENCHMARKS[key];
  if (!meta) return 0;

  const candles = await yahooProvider.getHistory(
    {
      id: -1,
      symbol: meta.symbol,
      assetClass: 'etf',
      currency: meta.currency,
      exchange: null,
      provider: 'yahoo',
      providerSymbol: meta.symbol,
      unit: null,
    },
    from,
    today(config.timezone),
  );

  if (candles.length === 0) return 0;

  const rows = candles.map((c) => ({
    symbol: key,
    date: c.date,
    closeE8: c.closeE8,
    currency: meta.currency,
    source: 'yahoo',
  }));

  for (let i = 0; i < rows.length; i += 200) {
    db.insert(benchmarkSeries).values(rows.slice(i, i + 200)).onConflictDoNothing().run();
  }

  return rows.length;
}

export async function refreshAllBenchmarks(keys: string[], from: IsoDate): Promise<string> {
  let total = 0;
  for (const key of keys) {
    try {
      total += await refreshBenchmark(key, from);
    } catch (err) {
      log.warn(`Benchmark ${key} nieudany: ${errorMessage(err)}`);
    }
  }
  return `pobrano ${total} notowań benchmarków`;
}

/** Seria znormalizowana do 100 na starcie okresu (×100, czyli 10000 = 100,00). */
function normalize(points: { date: string; value: number }[]): { date: string; indexed: number }[] {
  const base = points.find((p) => p.value !== 0)?.value;
  if (!base) return [];
  return points.map((p) => ({ date: p.date, indexed: Math.round((p.value / base) * 10_000) }));
}

export function benchmarkSeriesFor(keys: string[], from: IsoDate, to: IsoDate): BenchmarkSeries[] {
  const out: BenchmarkSeries[] = [];

  for (const key of keys) {
    const meta = BENCHMARKS[key];
    if (!meta) continue;

    const rows = db
      .select()
      .from(benchmarkSeries)
      .where(and(eq(benchmarkSeries.symbol, key), gte(benchmarkSeries.date, from), lte(benchmarkSeries.date, to)))
      .orderBy(asc(benchmarkSeries.date))
      .all();

    if (rows.length === 0) continue;

    const points = normalize(rows.map((r) => ({ date: r.date, value: r.closeE8 })));
    out.push({
      symbol: key,
      label: meta.label,
      points,
      totalReturnBp: changeBp(rows.at(-1)!.closeE8, rows[0]!.closeE8),
    });
  }

  return out;
}

export function buildAnalytics(portfolioIds: number[], from?: IsoDate, to?: IsoDate, benchmarks?: string[]): AnalyticsResponse {
  const end = to ?? today(config.timezone);
  const history = readHistory(portfolioIds, from, end);
  const start = from ?? history[0]?.date ?? addDays(end, -365);

  return {
    portfolioXirr: portfolioXirr(portfolioIds),
    positionXirr: positionXirr(portfolioIds),
    benchmarks: benchmarkSeriesFor(benchmarks ?? ['WIG20', 'SP500'], start, end),
    portfolioIndexed: normalize(history.map((h) => ({ date: h.date, value: h.valuePlnMinor }))),
  };
}

/** Najstarsza data transakcji — punkt startowy dla pobierania benchmarków. */
export function earliestTransactionDate(): IsoDate {
  const row = db.select().from(transactions).orderBy(asc(transactions.tradeDate)).limit(1).get();
  return row?.tradeDate ?? addDays(today(config.timezone), -365);
}

export function latestTransactionDate(): IsoDate {
  const row = db.select().from(transactions).orderBy(desc(transactions.tradeDate)).limit(1).get();
  return row?.tradeDate ?? today(config.timezone);
}
