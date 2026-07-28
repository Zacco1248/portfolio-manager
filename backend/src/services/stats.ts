import { inArray } from 'drizzle-orm';
import { shareBp } from '@portfolio/shared';
import { db } from '../db/index.js';
import { realizedGains } from '../db/schema.js';
import { readHistory } from './snapshots.js';
import { activePortfolioIds, buildPositions } from './positions.js';

/**
 * Miary ryzyka i struktury portfela.
 *
 * XIRR mówi, ile portfel zarobił, ale nie mówi nic o tym, jaką drogą — a przy
 * decyzji „dokładać czy nie" liczy się głębokość obsunięć i to, czy wynik
 * pochodzi z całego portfela, czy z jednej szczęśliwej pozycji. Wszystko
 * liczone lokalnie, z dziennych snapshotów i bieżących pozycji.
 */

export interface RiskStats {
  /** Zmienność roczna w punktach bazowych — odchylenie dziennych zwrotów × √252. */
  volatilityBp: number | null;
  /** Największe obsunięcie od szczytu, w punktach bazowych. */
  maxDrawdownBp: number | null;
  maxDrawdownFrom: string | null;
  maxDrawdownTo: string | null;
  /** Bieżące oddalenie od szczytu. */
  drawdownNowBp: number | null;
  bestMonth: { month: string; changeBp: number } | null;
  worstMonth: { month: string; changeBp: number } | null;
  positiveDays: number;
  negativeDays: number;
  observations: number;
  /**
   * Przebieg obsunięcia: dla każdego dnia dystans od dotychczasowego szczytu.
   * Zero oznacza nowy szczyt, wartości ujemne — ile portfel jest pod wodą.
   */
  drawdownSeries: { date: string; drawdownBp: number }[];
}

export interface ConcentrationStats {
  /** Indeks Herfindahla-Hirschmana udziałów pozycji (0–10000). */
  hhi: number;
  /** Łączny udział trzech największych pozycji. */
  top3ShareBp: number;
  largest: { symbol: string; name: string; shareBp: number }[];
  positionCount: number;
}

export interface ContributionEntry {
  instrumentId: number;
  symbol: string;
  name: string;
  unrealizedPlnMinor: number;
  realizedPlnMinor: number;
  totalPlnMinor: number;
  /** Udział w łącznym zysku/stracie portfela. */
  shareOfResultBp: number;
}

export interface StatsResponse {
  risk: RiskStats;
  concentration: ConcentrationStats;
  contributions: ContributionEntry[];
  note: string;
}

/**
 * Dzienne zwroty oczyszczone z wpłat.
 *
 * Ta sama korekta co w TWR: bez odjęcia przepływu dzień z dopłatą wyglądałby
 * jak kilkuprocentowy wzrost cen.
 */
export function dailyReturns(
  history: { date: string; valuePlnMinor: number; investedPlnMinor: number }[],
): { date: string; growth: number }[] {
  const out: { date: string; growth: number }[] = [];

  for (let i = 1; i < history.length; i += 1) {
    const previous = history[i - 1]!;
    const point = history[i]!;
    if (previous.valuePlnMinor <= 0) continue;

    const flow = point.investedPlnMinor - previous.investedPlnMinor;
    const growth = (point.valuePlnMinor - flow) / previous.valuePlnMinor;
    if (!Number.isFinite(growth) || growth <= 0 || growth >= 3) continue;

    out.push({ date: point.date, growth });
  }

  return out;
}

/** Liczba sesji giełdowych w roku — mnożnik przy annualizacji zmienności. */
const TRADING_DAYS = 252;

/** Minimalna liczba obserwacji, przy której zmienność cokolwiek znaczy. */
const MIN_OBSERVATIONS = 20;

export function riskStats(portfolioIds: number[]): RiskStats {
  const history = readHistory(portfolioIds);
  const returns = dailyReturns(history);

  const empty: RiskStats = {
    volatilityBp: null,
    maxDrawdownBp: null,
    maxDrawdownFrom: null,
    maxDrawdownTo: null,
    drawdownNowBp: null,
    bestMonth: null,
    worstMonth: null,
    positiveDays: 0,
    negativeDays: 0,
    observations: returns.length,
    drawdownSeries: [],
  };

  if (returns.length < 2) return empty;

  // Zmienność liczymy z logarytmicznych zwrotów — składają się addytywnie,
  // więc annualizacja przez √252 jest poprawna.
  const logs = returns.map((r) => Math.log(r.growth));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (logs.length - 1);
  const volatility = Math.sqrt(variance * TRADING_DAYS);

  // Obsunięcie liczymy na indeksie TWR, nie na wartości portfela — inaczej
  // wypłata z konta wyglądałaby jak krach.
  let index = 1;
  let peak = 1;
  let peakDate = returns[0]!.date;
  let worst = { depth: 0, from: '', to: '' };
  let positive = 0;
  let negative = 0;
  const monthly = new Map<string, number>();
  const drawdownSeries: { date: string; drawdownBp: number }[] = [];

  for (const point of returns) {
    index *= point.growth;
    if (point.growth > 1) positive += 1;
    else if (point.growth < 1) negative += 1;

    if (index > peak) {
      peak = index;
      peakDate = point.date;
    }

    const depth = 1 - index / peak;
    if (depth > worst.depth) worst = { depth, from: peakDate, to: point.date };
    // Bez zaokrąglenia w drugą stronę szczyt dawałby -0, co myli przy porównaniach.
    drawdownSeries.push({ date: point.date, drawdownBp: Math.round(-depth * 10_000) || 0 });

    const month = point.date.slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 1) * point.growth);
  }

  const months = [...monthly.entries()]
    .map(([month, growth]) => ({ month, changeBp: Math.round((growth - 1) * 10_000) }))
    .sort((a, b) => b.changeBp - a.changeBp);

  return {
    volatilityBp: returns.length >= MIN_OBSERVATIONS ? Math.round(volatility * 10_000) : null,
    maxDrawdownBp: worst.depth > 0 ? Math.round(worst.depth * 10_000) : 0,
    maxDrawdownFrom: worst.from || null,
    maxDrawdownTo: worst.to || null,
    drawdownNowBp: Math.round((1 - index / peak) * 10_000),
    bestMonth: months[0] ?? null,
    worstMonth: months.length > 1 ? months[months.length - 1]! : null,
    positiveDays: positive,
    negativeDays: negative,
    observations: returns.length,
    drawdownSeries,
  };
}

export function concentrationStats(portfolioIds: number[]): ConcentrationStats {
  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const total = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) + cash;

  if (total <= 0) {
    return { hhi: 0, top3ShareBp: 0, largest: [], positionCount: positions.length };
  }

  const shares = positions
    .map((p) => ({
      symbol: p.instrument.symbol,
      name: p.instrument.name,
      shareBp: Math.round(shareBp(p.valuePlnMinor, total)),
    }))
    .sort((a, b) => b.shareBp - a.shareBp);

  // HHI w skali punktów bazowych: suma kwadratów udziałów. 10000 = jedna
  // pozycja, poniżej ~1500 struktura jest uznawana za rozproszoną.
  const hhi = Math.round(shares.reduce((sum, s) => sum + (s.shareBp / 100) ** 2, 0));

  return {
    hhi,
    top3ShareBp: shares.slice(0, 3).reduce((sum, s) => sum + s.shareBp, 0),
    largest: shares.slice(0, 5),
    positionCount: positions.length,
  };
}

export function contributions(portfolioIds: number[]): ContributionEntry[] {
  const { positions } = buildPositions(portfolioIds);

  const realized = new Map<number, number>();
  for (const row of db.select().from(realizedGains).where(inArray(realizedGains.portfolioId, portfolioIds)).all()) {
    realized.set(row.instrumentId, (realized.get(row.instrumentId) ?? 0) + (row.proceedsPlnMinor - row.costPlnMinor));
  }

  const entries = positions.map((position) => {
    const unrealized = position.valuePlnMinor - position.costPlnMinor;
    const closed = realized.get(position.instrument.id) ?? 0;
    return {
      instrumentId: position.instrument.id,
      symbol: position.instrument.symbol,
      name: position.instrument.name,
      unrealizedPlnMinor: unrealized,
      realizedPlnMinor: closed,
      totalPlnMinor: unrealized + closed,
      shareOfResultBp: 0,
    };
  });

  // Pozycje już zamknięte też uczestniczyły w wyniku — bez nich obraz
  // pokazywałby tylko to, co akurat zostało w portfelu.
  const open = new Set(entries.map((e) => e.instrumentId));
  for (const [instrumentId, gain] of realized) {
    if (open.has(instrumentId)) continue;
    entries.push({
      instrumentId,
      symbol: '',
      name: 'pozycja zamknięta',
      unrealizedPlnMinor: 0,
      realizedPlnMinor: gain,
      totalPlnMinor: gain,
      shareOfResultBp: 0,
    });
  }

  // Mianownikiem jest suma wartości bezwzględnych, nie wynik netto — inaczej
  // przy wyniku bliskim zera udziały wystrzeliłyby w tysiące procent.
  const magnitude = entries.reduce((sum, e) => sum + Math.abs(e.totalPlnMinor), 0);
  for (const entry of entries) {
    entry.shareOfResultBp = magnitude > 0 ? Math.round(shareBp(Math.abs(entry.totalPlnMinor), magnitude)) : 0;
  }

  return entries.sort((a, b) => b.totalPlnMinor - a.totalPlnMinor);
}

export function buildStats(portfolioId?: number): StatsResponse {
  const ids = activePortfolioIds(portfolioId);

  return {
    risk: riskStats(ids),
    concentration: concentrationStats(ids),
    contributions: contributions(ids),
    note:
      'Miary liczone lokalnie z dziennych snapshotów wartości portfela. Zmienność i obsunięcia ' +
      'wymagają historii — przy krótkiej serii danych są niemiarodajne albo w ogóle się nie pojawią.',
  };
}
