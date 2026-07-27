import { describe, expect, it } from 'vitest';
import { computeXirr } from '../src/services/xirr.js';

/** Stopa w procentach z dokładnością do dwóch miejsc. */
const pct = (bp: number | null): number | null => (bp === null ? null : Math.round(bp) / 100);

describe('XIRR', () => {
  it('liczy 10% dla rocznej inwestycji ze wzrostem o 10%', () => {
    const result = computeXirr([
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2026-01-01', amountMinor: 110_000 },
    ]);

    expect(result.converged).toBe(true);
    // Rok kalendarzowy 2025 ma 365 dni, więc ACT/365 daje dokładnie 10%.
    expect(pct(result.rateBp)).toBeCloseTo(10, 1);
  });

  it('zgadza się z wynikiem Excela dla nieregularnych przepływów', () => {
    // Przykład z dokumentacji funkcji XIRR: -10000, 2750, 4250, 3250, 2750.
    const result = computeXirr([
      { date: '2008-01-01', amountMinor: -1_000_000 },
      { date: '2008-03-01', amountMinor: 275_000 },
      { date: '2008-10-30', amountMinor: 425_000 },
      { date: '2009-02-15', amountMinor: 325_000 },
      { date: '2009-04-01', amountMinor: 275_000 },
    ]);

    expect(result.converged).toBe(true);
    expect(pct(result.rateBp)).toBeCloseTo(37.34, 0);
  });

  it('zwraca ujemną stopę przy stracie', () => {
    const result = computeXirr([
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2026-01-01', amountMinor: 80_000 },
    ]);

    expect(result.converged).toBe(true);
    expect(pct(result.rateBp)).toBeCloseTo(-20, 1);
  });

  it('radzi sobie z regularnymi dopłatami miesięcznymi', () => {
    // Odwzorowanie realnego wzorca: 100 zł co miesiąc przez 10 miesięcy,
    // na koniec wartość 1100 zł.
    const flows = [];
    for (let m = 0; m < 10; m += 1) {
      const month = String(m + 1).padStart(2, '0');
      flows.push({ date: `2025-${month}-09`, amountMinor: -10_000 });
    }
    flows.push({ date: '2025-11-09', amountMinor: 110_000 });

    const result = computeXirr(flows);
    expect(result.converged).toBe(true);
    // Zysk 10 000 gr na średnio zaangażowanym kapitale przez ~pół roku
    // to wyraźnie więcej niż 10% w skali roku.
    expect(result.rateBp).not.toBeNull();
    expect(result.rateBp!).toBeGreaterThan(1500);
  });

  it('nie zwraca stopy, gdy brak przepływów o przeciwnych znakach', () => {
    const result = computeXirr([
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2025-06-01', amountMinor: -50_000 },
    ]);

    expect(result.converged).toBe(false);
    expect(result.rateBp).toBeNull();
  });

  it('nie zwraca stopy dla pojedynczego przepływu', () => {
    const result = computeXirr([{ date: '2025-01-01', amountMinor: -100_000 }]);
    expect(result.rateBp).toBeNull();
    expect(result.cashflowCount).toBe(1);
  });

  it('nie zwraca stopy, gdy wszystko dzieje się jednego dnia', () => {
    // Zerowy czas trwania oznaczałby nieskończoną stopę roczną.
    const result = computeXirr([
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2025-01-01', amountMinor: 110_000 },
    ]);
    expect(result.rateBp).toBeNull();
  });

  it('pomija zerowe przepływy przy ustalaniu zakresu dat', () => {
    const result = computeXirr([
      { date: '2024-01-01', amountMinor: 0 },
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2026-01-01', amountMinor: 110_000 },
    ]);

    expect(result.from).toBe('2025-01-01');
    expect(result.to).toBe('2026-01-01');
    expect(result.cashflowCount).toBe(2);
  });

  it('działa dla przepływów niezależnie od kolejności podania', () => {
    const ordered = computeXirr([
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2025-07-01', amountMinor: -50_000 },
      { date: '2026-01-01', amountMinor: 165_000 },
    ]);
    const shuffled = computeXirr([
      { date: '2026-01-01', amountMinor: 165_000 },
      { date: '2025-01-01', amountMinor: -100_000 },
      { date: '2025-07-01', amountMinor: -50_000 },
    ]);

    expect(shuffled.rateBp).toBe(ordered.rateBp);
  });
});
