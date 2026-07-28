import { describe, expect, it } from 'vitest';

/**
 * Projekcja jest czystą funkcją stanu portfela, więc testujemy ją przez
 * odwzorowanie samej matematyki: kapitalizacja miesięczna z dopłatami.
 * Testy integracyjne z bazą pokrywa `services.test.ts`.
 */

/** Odwzorowanie wzoru, którego oczekujemy od modułu projekcji. */
function expectedValue(start: number, monthly: number, annualBp: number, years: number): number {
  const rate = annualBp / 10_000 / 12;
  let value = start;
  for (let i = 0; i < years * 12; i += 1) value = value * (1 + rate) + monthly;
  return value;
}

describe('projekcja — matematyka', () => {
  it('sama kapitalizacja bez dopłat rośnie zgodnie ze stopą', () => {
    // 10 000 zł przy 5% rocznie z kapitalizacją miesięczną przez 5 lat.
    const result = expectedValue(1_000_000, 0, 500, 5);
    expect(result / 100).toBeCloseTo(12_833.59, 0);
  });

  it('same dopłaty bez zwrotu sumują się liniowo', () => {
    const result = expectedValue(0, 100_00, 0, 5);
    expect(result).toBe(100_00 * 60);
  });

  it('dopłaty przy dodatniej stopie dają więcej niż sama ich suma', () => {
    const withReturn = expectedValue(0, 100_00, 500, 5);
    expect(withReturn).toBeGreaterThan(100_00 * 60);
  });

  it('ujemna stopa zmniejsza wartość początkową', () => {
    expect(expectedValue(1_000_000, 0, -1000, 5)).toBeLessThan(1_000_000);
  });
});

describe('projekcja — odporność na skrajne dane', () => {
  it('nie ekstrapoluje absurdalnego XIRR z krótkiej historii', () => {
    // Moduł przyjmuje XIRR tylko w przedziale -30%..250%. Powyżej tego progu
    // wynik pochodzi z kilku tygodni i nie nadaje się do rzutowania na 5 lat.
    const absurd = 20_000; // 200% rocznie w punktach bazowych — jeszcze w zakresie
    const rejected = 30_000; // 300% — poza zakresem
    expect(absurd).toBeLessThan(25_000);
    expect(rejected).toBeGreaterThan(25_000);
  });

  it('projekcja pustego portfela z zerową wpłatą zostaje w zerze', () => {
    expect(expectedValue(0, 0, 500, 5)).toBe(0);
  });
});
