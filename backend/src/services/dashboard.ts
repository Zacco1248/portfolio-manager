import { inArray } from 'drizzle-orm';
import { assetClassLabel, changeBp, rollUp, shareBp } from '@portfolio/shared';
import type {
  AllocationSlice,
  AssetClass,
  DashboardResponse,
  PortfolioSummary,
  Position,
  RiskWarning,
} from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { buildPositions, netInvested, realizedTotal } from './positions.js';
import {
  detectConcentration,
  detectEtfOverlap,
  detectMissingPrices,
  detectStaleFx,
  detectStalePrices,
  loadThresholds,
} from './risk.js';
import { readHistory, valueOn } from './snapshots.js';

export function buildDashboard(portfolioIds: number[]): DashboardResponse {
  const { positions, cashByPortfolio, totalValuePlnMinor } = buildPositions(portfolioIds);
  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const day = today(config.timezone);

  const cost = positions.reduce((sum, p) => sum + p.costPlnMinor, 0);
  const positionsValue = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);
  const invested = netInvested(portfolioIds);
  const realized = realizedTotal(portfolioIds);

  const dayChange = positions.reduce<number | null>((sum, p) => {
    if (p.dayChangePlnMinor === null) return sum;
    return (sum ?? 0) + p.dayChangePlnMinor;
  }, null);

  // Zmiana tygodniowa liczona ze snapshotów — bez historii nie zgadujemy.
  const weekAgoValue = valueOn(portfolioIds, addDays(day, -7));

  const summary: PortfolioSummary = {
    portfolioIds,
    valuePlnMinor: totalValuePlnMinor,
    cashPlnMinor: cash,
    investedPlnMinor: invested,
    realizedPlnMinor: realized,
    unrealizedPlnMinor: positionsValue - cost,
    totalReturnPlnMinor: totalValuePlnMinor - invested,
    totalReturnBp: changeBp(totalValuePlnMinor, invested),
    dayChangePlnMinor: dayChange,
    dayChangeBp:
      dayChange === null || totalValuePlnMinor - dayChange === 0
        ? null
        : changeBp(totalValuePlnMinor, totalValuePlnMinor - dayChange),
    weekChangePlnMinor: weekAgoValue === null ? null : totalValuePlnMinor - weekAgoValue,
    weekChangeBp: weekAgoValue === null ? null : changeBp(totalValuePlnMinor, weekAgoValue),
    positionsCount: positions.length,
    asOf: day,
  };

  return {
    summary,
    history: readHistory(portfolioIds),
    allocation: buildAllocation(positions, cash),
    topMovers: topMovers(positions),
    warnings: buildWarnings(positions),
  };
}

function buildAllocation(positions: Position[], cashPlnMinor: number): DashboardResponse['allocation'] {
  const total = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) + cashPlnMinor;

  const group = (
    keyOf: (p: Position) => string | null,
    labelOf: (key: string) => string,
    includeCash: boolean,
    cashKey: string,
  ): AllocationSlice[] => {
    const buckets = new Map<string, number>();
    for (const position of positions) {
      const key = keyOf(position) ?? 'unknown';
      buckets.set(key, (buckets.get(key) ?? 0) + position.valuePlnMinor);
    }
    if (includeCash && cashPlnMinor !== 0) {
      buckets.set(cashKey, (buckets.get(cashKey) ?? 0) + cashPlnMinor);
    }

    return [...buckets.entries()]
      .map(([key, value]) => ({
        key,
        label: key === 'unknown' ? 'Nieprzypisane' : labelOf(key),
        valuePlnMinor: value,
        shareBp: shareBp(value, total),
      }))
      .sort((a, b) => b.valuePlnMinor - a.valuePlnMinor);
  };

  return {
    assetClass: group((p) => p.instrument.assetClass, assetClassLabel, true, 'cash'),
    // Gotówka jest w walucie bazowej, więc trafia do jej koszyka walutowego.
    currency: group((p) => p.instrument.currency, (key) => key, true, config.baseCurrency),
    sector: group((p) => p.instrument.sector, (key) => key, false, ''),
    geo: group((p) => p.instrument.country, (key) => key, false, ''),
  };
}

function topMovers(positions: Position[]): DashboardResponse['topMovers'] {
  return positions
    .filter((p) => p.dayChangeBp !== null)
    .sort((a, b) => Math.abs(b.dayChangeBp ?? 0) - Math.abs(a.dayChangeBp ?? 0))
    .slice(0, 6)
    .map((p) => ({
      instrument: p.instrument,
      dayChangeBp: p.dayChangeBp,
      dayChangePlnMinor: p.dayChangePlnMinor,
    }));
}

function buildWarnings(positions: Position[]): RiskWarning[] {
  const thresholds = loadThresholds();

  const etfIds = positions.filter((p) => rollUp(p.instrument.assetClass) === 'etf').map((p) => p.instrument.id);
  const holdingsMap = new Map<number, { symbol: string; weightBp: number }[]>();
  if (etfIds.length > 0) {
    for (const row of db.select().from(instruments).where(inArray(instruments.id, etfIds)).all()) {
      if (row.holdings) holdingsMap.set(row.id, row.holdings);
    }
  }

  return [
    // Najpierw to, co psuje same liczby, potem to, co mówi o strukturze portfela.
    ...detectStaleFx(positions),
    ...detectMissingPrices(positions),
    ...detectStalePrices(positions),
    ...detectConcentration(positions, thresholds),
    ...detectEtfOverlap(positions, holdingsMap, thresholds.overlapBp),
  ];
}
