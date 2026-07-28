import { inArray } from 'drizzle-orm';
import { changeBp } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { portfolios, transactions } from '../db/schema.js';
import { addDays, daysBetween, today } from '../lib/dates.js';
import { buildPositions, netInvested, realizedTotal } from './positions.js';
import { readHistory } from './snapshots.js';
import { getSetting } from './settings.js';
import { portfolioXirr } from './analytics.js';

/**
 * Podsumowanie osiągnięć i projekcja.
 *
 * Wszystko liczone lokalnie z danych użytkownika — bez wysyłania czegokolwiek
 * na zewnątrz. Model językowy może to potem ubrać w zdania, ale liczby
 * powstają tutaj i są takie same niezależnie od tego, czy AI jest włączone.
 *
 * Projekcja jest ekstrapolacją dotychczasowego tempa, nie prognozą rynkową.
 * Nazywamy ją wprost i pokazujemy założenia, bo inaczej byłaby obietnicą,
 * której nikt nie może złożyć.
 */

export interface Insight {
  kind: 'achievement' | 'milestone' | 'projection' | 'habit' | 'attention';
  title: string;
  detail: string;
  /** Wartość liczbowa do wyróżnienia, w groszach; null gdy insight jest opisowy. */
  valuePlnMinor: number | null;
}

export interface EmergencyFundStatus {
  /** Czy w ogóle wskazano portfel jako poduszkę. */
  configured: boolean;
  currentPlnMinor: number;
  /** Docelowa wysokość: miesięczne wydatki × liczba miesięcy. */
  targetPlnMinor: number;
  monthlyExpensesPlnMinor: number;
  targetMonths: number;
  /** Na ile miesięcy wystarczy obecna poduszka. */
  coveredMonths: number | null;
  completionBp: number | null;
  portfolioNames: string[];
  /** Pojedyncze pozycje wskazane ręcznie jako poduszka. */
  instrumentSymbols: string[];
}

export interface ProjectionPoint {
  year: number;
  /** Wartość przy założeniu dotychczasowego tempa dopłat i zwrotu. */
  valuePlnMinor: number;
  /** Sam wpłacony kapitał, bez zwrotu — do pokazania udziału procentu składanego. */
  contributedPlnMinor: number;
}

export interface InsightsResponse {
  insights: Insight[];
  emergencyFund: EmergencyFundStatus;
  projection: {
    points: ProjectionPoint[];
    monthlyContributionPlnMinor: number;
    assumedAnnualReturnBp: number;
    /** Skąd wzięliśmy założoną stopę zwrotu. */
    returnSource: 'xirr' | 'default';
    note: string;
  };
  /** Treść wygenerowana przez model; null gdy AI jest wyłączone. */
  narrative: string | null;
}

const DEFAULT_ANNUAL_RETURN_BP = 500; // 5% — ostrożne założenie, gdy brak własnej historii
const PROJECTION_YEARS = 5;

/** Średnia miesięczna wpłata z ostatniego roku. */
function monthlyContribution(portfolioIds: number[]): number {
  if (portfolioIds.length === 0) return 0;

  const cutoff = addDays(today(config.timezone), -365);
  const rows = db
    .select()
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIds))
    .all()
    .filter((r) => (r.type === 'deposit' || r.type === 'withdrawal') && r.tradeDate >= cutoff);

  if (rows.length === 0) return 0;

  const total = rows.reduce((sum, r) => sum + r.amountPlnMinor, 0);
  const first = rows.reduce((min, r) => (r.tradeDate < min ? r.tradeDate : min), rows[0]!.tradeDate);
  const months = Math.max(daysBetween(first, today(config.timezone)) / 30.44, 1);

  return Math.round(total / months);
}

/**
 * Stan poduszki finansowej.
 *
 * Poduszkę można wskazać na dwa sposoby i oba liczą się jednocześnie:
 * całym portfelem (konto oszczędnościowe prowadzone osobno) albo pojedynczymi
 * pozycjami w portfelu inwestycyjnym (obligacje skarbowe obok akcji).
 * Pozycje z portfela już oznaczonego jako poduszka nie są liczone drugi raz.
 */
export function emergencyFundStatus(): EmergencyFundStatus {
  const active = db
    .select()
    .from(portfolios)
    .all()
    .filter((p) => !p.archived);

  const funds = active.filter((p) => p.emergencyFund);
  const fundIds = new Set(funds.map((p) => p.id));
  const otherIds = active.filter((p) => !fundIds.has(p.id)).map((p) => p.id);

  // Pozycje oznaczone ręcznie, leżące poza portfelami-poduszkami.
  const flagged =
    otherIds.length > 0
      ? buildPositions(otherIds).positions.filter((p) => p.instrument.emergencyFund === true)
      : [];
  const flaggedValue = flagged.reduce((sum, p) => sum + p.valuePlnMinor, 0);

  const monthlyExpenses = getSetting<number>('monthlyExpensesPlnMinor', 0);
  const targetMonths = getSetting<number>('emergencyFundMonths', 6);
  const target = monthlyExpenses * targetMonths;

  if (funds.length === 0 && flagged.length === 0) {
    return {
      configured: false,
      currentPlnMinor: 0,
      targetPlnMinor: target,
      monthlyExpensesPlnMinor: monthlyExpenses,
      targetMonths,
      coveredMonths: null,
      completionBp: null,
      portfolioNames: [],
      instrumentSymbols: [],
    };
  }

  const ids = funds.map((p) => p.id);
  const fromPortfolios =
    ids.length > 0
      ? (() => {
          const { positions, cashByPortfolio } = buildPositions(ids);
          return (
            positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
            [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0)
          );
        })()
      : 0;

  const current = fromPortfolios + flaggedValue;

  return {
    configured: true,
    currentPlnMinor: current,
    targetPlnMinor: target,
    monthlyExpensesPlnMinor: monthlyExpenses,
    targetMonths,
    coveredMonths: monthlyExpenses > 0 ? Math.round((current / monthlyExpenses) * 10) / 10 : null,
    completionBp: target > 0 ? Math.min(Math.round((current / target) * 10_000), 20_000) : null,
    instrumentSymbols: flagged.map((p) => p.instrument.symbol),
    portfolioNames: funds.map((p) => p.name),
  };
}

/**
 * Projekcja wartości przy utrzymaniu dotychczasowego tempa.
 *
 * Kapitalizacja miesięczna, bo wpłaty też są miesięczne. Stopa zwrotu bierze
 * się z faktycznego XIRR portfela — jeśli jest zbyt krótka historia, spadamy
 * na ostrożne 5%, zamiast ekstrapolować przypadkowy wynik z kilku tygodni.
 */
export function buildProjection(portfolioIds: number[]): InsightsResponse['projection'] {
  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const current =
    positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
    [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);

  const monthly = Math.max(monthlyContribution(portfolioIds), 0);
  const xirr = portfolioXirr(portfolioIds);

  // XIRR z krótkiej historii potrafi dać absurdalne wartości (kilkaset procent),
  // bo roczna stopa ekstrapoluje kilkutygodniowy wynik. Przyjmujemy go tylko
  // w rozsądnym przedziale.
  const usableXirr =
    xirr.converged && xirr.rateBp !== null && xirr.rateBp > -3000 && xirr.rateBp < 2500 ? xirr.rateBp : null;

  const annualBp = usableXirr ?? DEFAULT_ANNUAL_RETURN_BP;
  const monthlyRate = annualBp / 10_000 / 12;

  const points: ProjectionPoint[] = [];
  let value = current;
  let contributed = current;

  for (let year = 1; year <= PROJECTION_YEARS; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      value = value * (1 + monthlyRate) + monthly;
      contributed += monthly;
    }
    points.push({
      year,
      valuePlnMinor: Math.round(value),
      contributedPlnMinor: Math.round(contributed),
    });
  }

  return {
    points,
    monthlyContributionPlnMinor: monthly,
    assumedAnnualReturnBp: annualBp,
    returnSource: usableXirr === null ? 'default' : 'xirr',
    note:
      usableXirr === null
        ? `Projekcja przy założeniu ${(DEFAULT_ANNUAL_RETURN_BP / 100).toFixed(1)}% rocznie — Twoja historia jest ` +
          'za krótka, żeby wyliczyć wiarygodną stopę zwrotu. To ekstrapolacja tempa, nie prognoza rynku.'
        : `Projekcja przy Twoim dotychczasowym XIRR (${(annualBp / 100).toFixed(1)}% rocznie) i średniej wpłacie ` +
          'z ostatniego roku. To ekstrapolacja tempa, nie prognoza rynku — rzeczywisty wynik będzie inny.',
  };
}

/** Zestaw obserwacji o tym, co się udało. */
export function buildInsights(portfolioIds: number[]): Insight[] {
  const insights: Insight[] = [];
  if (portfolioIds.length === 0) return insights;

  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const value =
    positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
    [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);

  const invested = netInvested(portfolioIds);
  const realized = realizedTotal(portfolioIds);
  const gain = value - invested;

  if (invested > 0 && gain !== 0) {
    const bp = changeBp(value, invested);
    insights.push({
      kind: gain > 0 ? 'achievement' : 'attention',
      title: gain > 0 ? 'Twoje pieniądze zarobiły na siebie' : 'Portfel jest poniżej wpłaconego kapitału',
      detail:
        gain > 0
          ? `Z wpłaconych środków wyrosło ${fmt(gain)} ponad kapitał, czyli ${pct(bp)}. ` +
            'To część, której nie musiałeś odłożyć z pensji.'
          : `Portfel jest ${fmt(Math.abs(gain))} poniżej wpłaconego kapitału (${pct(bp)}). ` +
            'Przy długim horyzoncie takie okresy są normalne — liczy się, czy plan się nie zmienił.',
      valuePlnMinor: gain,
    });
  }

  // Systematyczność bywa ważniejsza niż wybór instrumentów — warto ją pokazać.
  const monthly = monthlyContribution(portfolioIds);
  if (monthly > 0) {
    insights.push({
      kind: 'habit',
      title: 'Regularne dopłaty',
      detail:
        `Średnio dokładasz ${fmt(monthly)} miesięcznie. W skali roku to ${fmt(monthly * 12)} ` +
        'nowego kapitału, niezależnie od tego, co robi rynek.',
      valuePlnMinor: monthly,
    });
  }

  if (realized !== 0) {
    insights.push({
      kind: 'achievement',
      title: realized > 0 ? 'Zrealizowane zyski' : 'Zrealizowane straty',
      detail:
        realized > 0
          ? `Zamknięte pozycje dały ${fmt(realized)} zysku.`
          : `Zamknięte pozycje dały ${fmt(Math.abs(realized))} straty — w portfelu opodatkowanym obniża ona ` +
            'podstawę w kolejnych latach.',
      valuePlnMinor: realized,
    });
  }

  // Kamienie milowe pokazują postęp lepiej niż sama liczba na koncie.
  const milestones = [10_000_00, 25_000_00, 50_000_00, 100_000_00, 250_000_00, 500_000_00, 1_000_000_00];
  const passed = milestones.filter((m) => value >= m).at(-1);
  const next = milestones.find((m) => value < m);

  if (passed) {
    insights.push({
      kind: 'milestone',
      title: `Portfel przekroczył ${fmt(passed)}`,
      detail: next
        ? `Do kolejnego progu ${fmt(next)} brakuje ${fmt(next - value)}.`
        : 'To najwyższy próg, jaki śledzimy.',
      valuePlnMinor: passed,
    });
  } else if (next) {
    insights.push({
      kind: 'milestone',
      title: `Pierwszy próg: ${fmt(next)}`,
      detail: `Brakuje ${fmt(next - value)}.`,
      valuePlnMinor: next,
    });
  }

  const history = readHistory(portfolioIds);
  if (history.length >= 30) {
    const month = history.at(-30)!;
    const change = value - month.valuePlnMinor;
    insights.push({
      kind: change >= 0 ? 'achievement' : 'attention',
      title: 'Ostatnie 30 dni',
      detail: `Wartość portfela zmieniła się o ${fmt(change)} (${pct(changeBp(value, month.valuePlnMinor))}).`,
      valuePlnMinor: change,
    });
  }

  const best = positions.filter((p) => p.unrealizedBp !== null).sort((a, b) => (b.unrealizedBp ?? 0) - (a.unrealizedBp ?? 0))[0];
  if (best && (best.unrealizedBp ?? 0) > 0) {
    insights.push({
      kind: 'achievement',
      title: `Najlepsza pozycja: ${best.instrument.symbol}`,
      detail: `${best.instrument.name} jest ${pct(best.unrealizedBp)} nad kosztem nabycia (${fmt(best.unrealizedPlnMinor)}).`,
      valuePlnMinor: best.unrealizedPlnMinor,
    });
  }

  return insights;
}

function fmt(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  return `${sign}${(Math.abs(minor) / 100).toFixed(2).replace('.', ',')} zł`;
}

function pct(bp: number | null): string {
  if (bp === null) return '—';
  return `${bp > 0 ? '+' : ''}${(bp / 100).toFixed(2).replace('.', ',')}%`;
}
