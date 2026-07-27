import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Odczyty inflacji są w bazie, ale sam silnik odsetkowy ma być testowalny bez
 * niej — podmieniamy dostęp do CPI, żeby test opisywał regułę naliczania,
 * a nie zawartość tabeli.
 */
const cpiByPeriod = new Map<string, number>();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ all: () => [...cpiByPeriod.entries()].map(([key, cpiYoyBp]) => {
      const [year, month] = key.split('-').map(Number);
      return { year, month, cpiYoyBp };
    }) }) }),
  },
}));

const { computePeriods, valueBond } = await import('../src/services/bonds.js');

function setCpi(entries: Record<string, number>): void {
  cpiByPeriod.clear();
  for (const [key, value] of Object.entries(entries)) cpiByPeriod.set(key, value);
}

/** EDO: 10 lat, pierwszy rok stały, kolejne inflacja + marża, kapitalizacja roczna. */
const edo = {
  kind: 'EDO' as const,
  purchaseDate: '2023-01-15',
  count: 10,
  nominalMinor: 10_000, // 100 zł za obligację
  firstYearRateBp: 700, // 7,00%
  marginBp: 150, // 1,50%
  termMonths: 120,
  capitalization: 'annual' as const,
};

beforeEach(() => {
  cpiByPeriod.clear();
});

describe('EDO — pierwszy okres odsetkowy', () => {
  it('nalicza stałą stawkę z dnia zakupu', () => {
    const periods = computePeriods(edo, '2024-01-15');
    // 1000 zł × 7% = 70 zł
    expect(periods[0]?.rateBp).toBe(700);
    expect(periods[0]?.interestMinor).toBe(7_000);
    expect(periods[0]?.openingCapitalMinor).toBe(100_000);
  });

  it('nalicza odsetki proporcjonalnie w trakcie okresu', () => {
    // Pół roku od zakupu: mniej więcej połowa rocznych odsetek.
    const periods = computePeriods(edo, '2023-07-15');
    expect(periods).toHaveLength(1);
    expect(periods[0]!.interestMinor).toBeGreaterThan(3_300);
    expect(periods[0]!.interestMinor).toBeLessThan(3_600);
  });

  it('nie nalicza nic w dniu zakupu', () => {
    const periods = computePeriods(edo, '2023-01-15');
    expect(periods[0]?.interestMinor).toBe(0);
  });
});

describe('EDO — indeksacja inflacją', () => {
  it('drugi rok liczy jako inflacja plus marża', () => {
    // Odczyt sprzed dwóch miesięcy względem startu okresu (2024-01-15 → 2023-11).
    setCpi({ '2023-11': 650 });
    const periods = computePeriods(edo, '2025-01-15');

    expect(periods).toHaveLength(2);
    expect(periods[1]?.rateBp).toBe(650 + 150);
    expect(periods[1]?.projected).toBe(false);
  });

  it('kapitalizuje odsetki rocznie', () => {
    setCpi({ '2023-11': 650 });
    const periods = computePeriods(edo, '2025-01-15');

    // Rok 1: 1000 zł + 70 zł = 1070 zł kapitału na start roku 2.
    expect(periods[1]?.openingCapitalMinor).toBe(107_000);
    // Rok 2: 1070 zł × 8% = 85,60 zł
    expect(periods[1]?.interestMinor).toBe(8_560);
  });

  it('nie pozwala zejść poniżej marży przy deflacji', () => {
    setCpi({ '2023-11': -200 });
    const periods = computePeriods(edo, '2025-01-15');
    expect(periods[1]?.rateBp).toBe(150);
  });

  it('oznacza okres jako prognozowany, gdy brak odczytu inflacji', () => {
    const periods = computePeriods(edo, '2025-01-15');
    expect(periods[1]?.projected).toBe(true);
  });

  it('używa ostatniej znanej inflacji do prognozy', () => {
    setCpi({ '2023-11': 650 });
    const periods = computePeriods(edo, '2026-01-15');

    expect(periods).toHaveLength(3);
    expect(periods[2]?.projected).toBe(true);
    expect(periods[2]?.rateBp).toBe(650 + 150);
  });
});

describe('EDO — wycena', () => {
  it('podaje wartość wykupu i odsetki narosłe', () => {
    setCpi({ '2023-11': 650 });
    const valuation = valueBond(edo, '2025-01-15');

    // Po dwóch pełnych latach: 1000 → 1070 → 1155,60 zł
    expect(valuation.currentValueMinor).toBe(115_560);
    expect(valuation.accruedInterestMinor).toBe(15_560);
    expect(valuation.currentPeriodRateBp).toBe(800);
  });

  it('zwraca nominał, gdy wyceniamy przed zakupem', () => {
    const valuation = valueBond(edo, '2022-01-01');
    expect(valuation.currentValueMinor).toBe(100_000);
    expect(valuation.periods).toHaveLength(0);
  });

  it('nie nalicza odsetek po terminie wykupu', () => {
    setCpi({ '2023-11': 0 });
    const periods = computePeriods(edo, '2040-01-01');
    // 10 lat trwania emisji = 10 okresów, ani jednego więcej.
    expect(periods).toHaveLength(10);
    expect(periods.at(-1)?.to).toBe('2033-01-15');
  });
});

describe('obligacje bez kapitalizacji', () => {
  const coi = { ...edo, kind: 'COI' as const, termMonths: 48, capitalization: 'none' as const };

  it('wypłaca odsetki, więc kapitał zostaje nominalny', () => {
    setCpi({ '2023-11': 650 });
    const periods = computePeriods(coi, '2025-01-15');

    expect(periods[0]?.closingCapitalMinor).toBe(100_000);
    expect(periods[1]?.openingCapitalMinor).toBe(100_000);
    // Rok 2: 1000 zł × 8% — bez powiększenia kapitału.
    expect(periods[1]?.interestMinor).toBe(8_000);
  });
});

describe('obligacje o stałym oprocentowaniu', () => {
  const tos = { ...edo, kind: 'TOS' as const, termMonths: 36, marginBp: 0 };

  it('trzyma tę samą stawkę przez cały okres i nie sięga po inflację', () => {
    setCpi({ '2023-11': 1500 });
    const periods = computePeriods(tos, '2026-01-15');

    expect(periods).toHaveLength(3);
    expect(periods.every((p) => p.rateBp === 700)).toBe(true);
  });
});
