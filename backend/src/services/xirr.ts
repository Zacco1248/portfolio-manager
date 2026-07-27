import type { XirrResult } from '@portfolio/shared';
import { yearFraction } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';

/**
 * Wewnętrzna stopa zwrotu dla nieregularnych przepływów (XIRR), zgodna
 * z definicją używaną przez Excela i arkusz Inwestomatu.
 *
 * Konwencja znaków z punktu widzenia inwestora:
 *   ujemny  = pieniądze zaangażowane (wpłata, zakup),
 *   dodatni = pieniądze odzyskane (wypłata, sprzedaż, dywidenda),
 *   ostatni przepływ to bieżąca wartość pozycji lub portfela.
 */

export interface Cashflow {
  date: IsoDate;
  /** Kwota w groszach — skala nie ma znaczenia dla stopy, ważne by była spójna. */
  amountMinor: number;
}

const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-9;
const MIN_RATE = -0.999_999;
const MAX_RATE = 1_000;

function npv(rate: number, flows: { t: number; amount: number }[]): number {
  let total = 0;
  for (const { t, amount } of flows) {
    total += amount / (1 + rate) ** t;
  }
  return total;
}

function npvDerivative(rate: number, flows: { t: number; amount: number }[]): number {
  let total = 0;
  for (const { t, amount } of flows) {
    if (t === 0) continue;
    total -= (t * amount) / (1 + rate) ** (t + 1);
  }
  return total;
}

export function computeXirr(cashflows: Cashflow[]): XirrResult {
  const sorted = [...cashflows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const nonZero = sorted.filter((c) => c.amountMinor !== 0);

  const empty: XirrResult = {
    rateBp: null,
    cashflowCount: nonZero.length,
    from: nonZero[0]?.date ?? null,
    to: nonZero.at(-1)?.date ?? null,
    converged: false,
  };

  if (nonZero.length < 2) return empty;

  // Bez przepływów po obu stronach równanie nie ma rozwiązania — np. same
  // wpłaty bez żadnej wyceny końcowej.
  const hasPositive = nonZero.some((c) => c.amountMinor > 0);
  const hasNegative = nonZero.some((c) => c.amountMinor < 0);
  if (!hasPositive || !hasNegative) return empty;

  const start = nonZero[0]!.date;
  const flows = nonZero.map((c) => ({
    t: yearFraction(start, c.date),
    amount: c.amountMinor,
  }));

  // Wszystkie przepływy tego samego dnia — stopa roczna byłaby nieskończona.
  if (flows.every((f) => f.t === 0)) return empty;

  const newton = solveNewton(flows);
  if (newton !== null) {
    return { ...empty, rateBp: Math.round(newton * 10_000), converged: true };
  }

  // Newton potrafi uciec przy nietypowych przepływach (np. kilka zmian znaku).
  // Bisekcja jest wolniejsza, ale zbiega zawsze, gdy pierwiastek istnieje.
  const bisect = solveBisection(flows);
  if (bisect !== null) {
    return { ...empty, rateBp: Math.round(bisect * 10_000), converged: true };
  }

  return empty;
}

function solveNewton(flows: { t: number; amount: number }[]): number | null {
  let rate = 0.1;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const value = npv(rate, flows);
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) < TOLERANCE) return rate;

    const derivative = npvDerivative(rate, flows);
    if (!Number.isFinite(derivative) || Math.abs(derivative) < TOLERANCE) return null;

    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= MIN_RATE || next > MAX_RATE) return null;
    if (Math.abs(next - rate) < TOLERANCE) return next;
    rate = next;
  }
  return null;
}

function solveBisection(flows: { t: number; amount: number }[]): number | null {
  let low = MIN_RATE;
  let high = MAX_RATE;
  let fLow = npv(low, flows);
  let fHigh = npv(high, flows);

  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) return null;
  if (fLow * fHigh > 0) return null;

  for (let i = 0; i < 300; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid, flows);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < TOLERANCE || high - low < TOLERANCE) return mid;
    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return (low + high) / 2;
}

/**
 * Prosta stopa zwrotu ważona czasem nie jest tu potrzebna, ale bywa przydatna
 * jako sanity check przy debugowaniu XIRR-a.
 */
export function simpleReturnBp(investedMinor: number, currentMinor: number): number | null {
  if (investedMinor === 0) return null;
  return Math.round(((currentMinor - investedMinor) / Math.abs(investedMinor)) * 10_000);
}
