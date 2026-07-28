import { describe, expect, it } from 'vitest';
import {
  CARRY_FORWARD_YEARS,
  computeCryptoCarryForward,
  computeSecuritiesCarryForward,
} from '../src/services/loss-carry.js';

/** Skrót: kwoty podajemy w złotych, moduł liczy w groszach. */
const zl = (amount: number): number => Math.round(amount * 100);

describe('papiery wartościowe — limit 50% rocznie', () => {
  it('nie odlicza nic, gdy nie było strat', () => {
    const result = computeSecuritiesCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(1000) },
        { year: 2025, gainPlnMinor: zl(2000) },
      ],
      2025,
    );

    expect(result.appliedPlnMinor).toBe(0);
    expect(result.taxableGainPlnMinor).toBe(zl(2000));
  });

  it('odlicza najwyżej połowę straty w jednym roku', () => {
    // Strata 10 000 zł w 2024, dochód 8 000 zł w 2025.
    const result = computeSecuritiesCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(-10_000) },
        { year: 2025, gainPlnMinor: zl(8_000) },
      ],
      2025,
    );

    // Limit to 50% z 10 000, czyli 5 000 — mimo że dochód pozwoliłby na więcej.
    expect(result.availablePlnMinor).toBe(zl(5_000));
    expect(result.appliedPlnMinor).toBe(zl(5_000));
    expect(result.taxableGainPlnMinor).toBe(zl(3_000));
  });

  it('zostawia resztę straty na kolejne lata', () => {
    const result = computeSecuritiesCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(-10_000) },
        { year: 2025, gainPlnMinor: zl(8_000) },
      ],
      2025,
    );

    expect(result.remaining.reduce((s, r) => s + r.remainingPlnMinor, 0)).toBe(zl(5_000));
  });

  it('ogranicza odliczenie dochodem, gdy jest niższy niż limit', () => {
    const result = computeSecuritiesCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(-10_000) },
        { year: 2025, gainPlnMinor: zl(2_000) },
      ],
      2025,
    );

    // Odliczyć można najwyżej tyle, ile wynosi dochód — do zera, nie poniżej.
    expect(result.appliedPlnMinor).toBe(zl(2_000));
    expect(result.taxableGainPlnMinor).toBe(0);
  });

  it('rozlicza stratę w dwóch kolejnych latach po połowie', () => {
    const history = [
      { year: 2023, gainPlnMinor: zl(-10_000) },
      { year: 2024, gainPlnMinor: zl(6_000) },
      { year: 2025, gainPlnMinor: zl(6_000) },
    ];

    expect(computeSecuritiesCarryForward(history, 2024).appliedPlnMinor).toBe(zl(5_000));
    // W drugim roku zostaje druga połowa.
    const second = computeSecuritiesCarryForward(history, 2025);
    expect(second.appliedPlnMinor).toBe(zl(5_000));
    expect(second.taxableGainPlnMinor).toBe(zl(1_000));
    expect(second.remaining).toHaveLength(0);
  });

  it('nie odlicza straty od roku, w którym powstała', () => {
    const result = computeSecuritiesCarryForward([{ year: 2025, gainPlnMinor: zl(-5_000) }], 2025);
    expect(result.appliedPlnMinor).toBe(0);
    expect(result.taxableGainPlnMinor).toBe(zl(-5_000));
  });

  it('kasuje stratę nierozliczoną po pięciu latach', () => {
    const history = [
      { year: 2018, gainPlnMinor: zl(-10_000) },
      // Kolejne lata bez dochodu — nie ma od czego odliczać.
      { year: 2024, gainPlnMinor: zl(20_000) },
    ];

    const result = computeSecuritiesCarryForward(history, 2024);
    expect(result.appliedPlnMinor).toBe(0);
    expect(result.expiredPlnMinor).toBe(zl(10_000));
    expect(result.taxableGainPlnMinor).toBe(zl(20_000));
  });

  it('odlicza od najstarszej straty jako pierwszej', () => {
    // Starsza strata przepadnie wcześniej, więc ma pierwszeństwo.
    const result = computeSecuritiesCarryForward(
      [
        { year: 2022, gainPlnMinor: zl(-4_000) },
        { year: 2023, gainPlnMinor: zl(-4_000) },
        { year: 2024, gainPlnMinor: zl(10_000) },
      ],
      2024,
    );

    // Limity: 2 000 z każdej straty → łącznie 4 000.
    expect(result.appliedPlnMinor).toBe(zl(4_000));
    expect(result.taxableGainPlnMinor).toBe(zl(6_000));
    // Z każdej straty zostaje po 2 000.
    expect(result.remaining.reduce((s, r) => s + r.remainingPlnMinor, 0)).toBe(zl(4_000));
  });

  it('okno rozliczenia obejmuje pięć lat', () => {
    expect(CARRY_FORWARD_YEARS).toBe(5);
  });
});

describe('kryptowaluty — pełne przeniesienie kosztów', () => {
  it('przenosi nadwyżkę kosztów na rok następny w całości', () => {
    // Bez limitu 50% — inaczej niż przy papierach wartościowych.
    const result = computeCryptoCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(-10_000) },
        { year: 2025, gainPlnMinor: zl(8_000) },
      ],
      2025,
    );

    expect(result.carriedCostPlnMinor).toBe(zl(10_000));
    expect(result.taxableGainPlnMinor).toBe(0);
    // Niewykorzystane 2 000 idzie dalej.
    expect(result.carryToNextYearPlnMinor).toBe(zl(2_000));
  });

  it('opodatkowuje nadwyżkę dochodu po pokryciu przeniesionych kosztów', () => {
    const result = computeCryptoCarryForward(
      [
        { year: 2024, gainPlnMinor: zl(-3_000) },
        { year: 2025, gainPlnMinor: zl(10_000) },
      ],
      2025,
    );

    expect(result.taxableGainPlnMinor).toBe(zl(7_000));
    expect(result.carryToNextYearPlnMinor).toBe(0);
  });

  it('przenosi koszty przez lata bez transakcji', () => {
    // Przerwa w handlu nie kasuje przeniesienia — inaczej niż pięcioletnie
    // okno przy papierach wartościowych.
    const result = computeCryptoCarryForward(
      [
        { year: 2018, gainPlnMinor: zl(-5_000) },
        { year: 2025, gainPlnMinor: zl(12_000) },
      ],
      2025,
    );

    expect(result.carriedCostPlnMinor).toBe(zl(5_000));
    expect(result.taxableGainPlnMinor).toBe(zl(7_000));
  });

  it('kumuluje nadwyżki z kilku stratnych lat', () => {
    const result = computeCryptoCarryForward(
      [
        { year: 2023, gainPlnMinor: zl(-2_000) },
        { year: 2024, gainPlnMinor: zl(-3_000) },
        { year: 2025, gainPlnMinor: zl(4_000) },
      ],
      2025,
    );

    expect(result.carriedCostPlnMinor).toBe(zl(5_000));
    expect(result.taxableGainPlnMinor).toBe(0);
    expect(result.carryToNextYearPlnMinor).toBe(zl(1_000));
  });

  it('nie liczy nic dla pustej historii', () => {
    expect(computeCryptoCarryForward([], 2025)).toMatchObject({
      carriedCostPlnMinor: 0,
      taxableGainPlnMinor: 0,
      carryToNextYearPlnMinor: 0,
    });
  });
});
