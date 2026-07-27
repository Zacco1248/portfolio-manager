import { eq, inArray, sql } from 'drizzle-orm';
import {
  bigintToNumber,
  changeBp,
  convertMinor,
  mulDiv,
  positionValueMinor,
  QTY_SCALE,
  shareBp,
} from '@portfolio/shared';
import type { AssetClass, Instrument, Position, TransactionType } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, portfolios, realizedGains, transactions } from '../db/schema.js';
import type { InstrumentRow, PortfolioRow } from '../db/schema.js';
import { computeFifo, groupForFifo, parseGroupKey } from './fifo.js';
import { getLatestPrice } from './prices.js';
import type { LatestPrice } from './prices.js';

export function toInstrumentDto(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetClass: row.assetClass as AssetClass,
    currency: row.currency,
    isin: row.isin,
    exchange: row.exchange,
    sector: row.sector,
    country: row.country,
    provider: row.provider,
    providerSymbol: row.providerSymbol,
  };
}

/**
 * Kursy walut do wyceny bieżącej — najświeższy opublikowany kurs każdej waluty.
 * To nie są kursy transakcyjne: te zostają zapisane przy transakcji i służą
 * wyłącznie do rozliczenia podatkowego.
 */
function currentFxRates(): Map<string, number> {
  const rows = db.all<{ currency: string; rate_e6: number }>(sql`
    SELECT f.currency, f.rate_e6
    FROM fx_rates f
    JOIN (SELECT currency, MAX(date) AS max_date FROM fx_rates GROUP BY currency) latest
      ON latest.currency = f.currency AND latest.max_date = f.date
  `);
  const map = new Map<string, number>([[config.baseCurrency, 1_000_000]]);
  for (const row of rows) map.set(row.currency, row.rate_e6);
  return map;
}

export interface PositionsResult {
  positions: Position[];
  /** Saldo gotówki per portfel, wyliczone z podpisanych przepływów. */
  cashByPortfolio: Map<number, number>;
  totalValuePlnMinor: number;
}

/**
 * Buduje aktualne pozycje z transakcji. Ilości i koszt biorą się z tego samego
 * silnika FIFO, który liczy podatek — dzięki temu średnia cena nabycia
 * pokazywana w tabeli zgadza się z kosztem użytym w rozliczeniu.
 */
export function buildPositions(portfolioIds?: number[]): PositionsResult {
  const portfolioRows = db.select().from(portfolios).all();
  const portfolioMap = new Map<number, PortfolioRow>(portfolioRows.map((p) => [p.id, p]));

  const selected =
    portfolioIds && portfolioIds.length > 0
      ? portfolioRows.filter((p) => portfolioIds.includes(p.id))
      : portfolioRows.filter((p) => !p.archived);
  const selectedIds = selected.map((p) => p.id);
  if (selectedIds.length === 0) {
    return { positions: [], cashByPortfolio: new Map(), totalValuePlnMinor: 0 };
  }

  const txRows = db.select().from(transactions).where(inArray(transactions.portfolioId, selectedIds)).all();

  const instrumentRows = db.select().from(instruments).all();
  const instrumentMap = new Map<number, InstrumentRow>(instrumentRows.map((i) => [i.id, i]));

  const fxRates = currentFxRates();
  const priceCache = new Map<number, LatestPrice | null>();

  const cashByPortfolio = new Map<number, number>();
  for (const id of selectedIds) cashByPortfolio.set(id, 0);
  for (const tx of txRows) {
    cashByPortfolio.set(tx.portfolioId, (cashByPortfolio.get(tx.portfolioId) ?? 0) + tx.amountPlnMinor);
  }

  const groups = groupForFifo(txRows);
  const positions: Position[] = [];

  for (const [key, rows] of groups) {
    const { portfolioId, instrumentId } = parseGroupKey(key);
    const portfolio = portfolioMap.get(portfolioId);
    const instrument = instrumentMap.get(instrumentId);
    if (!portfolio || !instrument) continue;

    const fifo = computeFifo(
      rows.map((r) => ({
        id: r.id,
        portfolioId: r.portfolioId,
        instrumentId: r.instrumentId!,
        type: r.type as TransactionType,
        tradeDate: r.tradeDate,
        qtyE8: r.qtyE8,
        amountPlnMinor: r.amountPlnMinor,
        taxAmountPlnMinor: r.taxAmountPlnMinor,
      })),
      {
        assetClass: instrument.assetClass as AssetClass,
        taxExempt: portfolio.taxRegime === 'ike' || portfolio.taxRegime === 'ikze',
      },
    );

    if (fifo.remainingQtyE8 <= 0) continue;

    if (!priceCache.has(instrumentId)) {
      priceCache.set(instrumentId, getLatestPrice(instrumentId, instrument.currency));
    }
    const price = priceCache.get(instrumentId) ?? null;

    const quoteCurrency = price?.currency ?? instrument.currency;
    const fxRateE6 = fxRates.get(quoteCurrency.toUpperCase()) ?? 1_000_000;

    const valueInQuoteCurrency = price
      ? positionValueMinor(fifo.remainingQtyE8, price.priceE8, quoteCurrency)
      : 0;
    const valuePlnMinor = price
      ? convertMinor(valueInQuoteCurrency, fxRateE6, quoteCurrency, config.baseCurrency)
      : fifo.remainingCostPlnMinor;

    const prevValuePln =
      price?.prevCloseE8 != null
        ? convertMinor(
            positionValueMinor(fifo.remainingQtyE8, price.prevCloseE8, quoteCurrency),
            fxRateE6,
            quoteCurrency,
            config.baseCurrency,
          )
        : null;

    positions.push({
      portfolioId,
      portfolioName: portfolio.name,
      instrument: toInstrumentDto(instrument),
      qtyE8: fifo.remainingQtyE8,
      avgPriceE8: averagePriceE8(fifo.remainingCostPlnMinor, fifo.remainingQtyE8),
      costPlnMinor: fifo.remainingCostPlnMinor,
      priceE8: price?.priceE8 ?? null,
      valuePlnMinor,
      unrealizedPlnMinor: valuePlnMinor - fifo.remainingCostPlnMinor,
      unrealizedBp: changeBp(valuePlnMinor, fifo.remainingCostPlnMinor),
      dayChangePlnMinor: prevValuePln === null ? null : valuePlnMinor - prevValuePln,
      dayChangeBp: prevValuePln === null ? null : changeBp(valuePlnMinor, prevValuePln),
      sharePortfolioBp: 0, // uzupełniane niżej, gdy znamy sumę
      priceStale: price?.stale ?? true,
      fxRateE6,
    });
  }

  const positionsValue = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);
  const cashTotal = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const totalValuePlnMinor = positionsValue + cashTotal;

  for (const position of positions) {
    position.sharePortfolioBp = shareBp(position.valuePlnMinor, totalValuePlnMinor);
  }

  positions.sort((a, b) => b.valuePlnMinor - a.valuePlnMinor);

  return { positions, cashByPortfolio, totalValuePlnMinor };
}

/**
 * Średnia cena nabycia w PLN za sztukę. Świadomie w walucie bazowej, a nie
 * w walucie instrumentu — inaczej pozycja kupowana przy różnych kursach
 * pokazywałaby cenę, której nigdy nie zapłacono.
 */
function averagePriceE8(costPlnMinor: number, qtyE8: number): number {
  if (qtyE8 === 0) return 0;
  // koszt w groszach → cena w skali e8: (cost / 100) / (qty / 1e8) × 1e8
  return bigintToNumber(mulDiv(BigInt(costPlnMinor) * QTY_SCALE, 1_000_000n, BigInt(qtyE8) * 100n));
}

/** Suma zysków zrealizowanych dla wskazanych portfeli. */
export function realizedTotal(portfolioIds: number[]): number {
  if (portfolioIds.length === 0) return 0;
  const rows = db
    .select({ gain: realizedGains.gainPlnMinor })
    .from(realizedGains)
    .where(inArray(realizedGains.portfolioId, portfolioIds))
    .all();
  return rows.reduce((sum, r) => sum + r.gain, 0);
}

/** Kapitał wpłacony netto: wpłaty minus wypłaty. */
export function netInvested(portfolioIds: number[]): number {
  if (portfolioIds.length === 0) return 0;
  const rows = db
    .select({ type: transactions.type, amount: transactions.amountPlnMinor })
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIds))
    .all();

  return rows
    .filter((r) => r.type === 'deposit' || r.type === 'withdrawal')
    .reduce((sum, r) => sum + r.amount, 0);
}

export function activePortfolioIds(portfolioId?: number): number[] {
  if (portfolioId) {
    const row = db.select().from(portfolios).where(eq(portfolios.id, portfolioId)).get();
    return row ? [row.id] : [];
  }
  return db
    .select()
    .from(portfolios)
    .all()
    .filter((p) => !p.archived)
    .map((p) => p.id);
}
