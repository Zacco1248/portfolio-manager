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
const { BOND_KINDS, BOND_TERMS, defaultBondSeries } = await import('@portfolio/shared');

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

/**
 * Regres wobec arkusza użytkownika (`import/portfel_wspolny.xlsx`, arkusz
 * „Obligacje").
 *
 * Arkusz liczy wartość obligacji własnymi formułami i podaje wynik w kolumnie
 * „cena". Ten test sprawdza, że nasz silnik daje te same liczby dla tych samych
 * warunków emisji i tych samych odczytów inflacji — czyli że wyliczenie jest
 * konkretne, a nie prognozowane.
 *
 * Odczyty CPI pochodzą z ukrytego arkusza „Inflacja" (wariant „analogiczny
 * miesiąc poprzedniego roku"), ten sam, który czyta parser importu.
 */
describe('EDO — zgodność z arkuszem użytkownika', () => {
  /** Dzień wyceny, dla którego arkusz podał wartości w kolumnie „cena". */
  const asOf = '2026-07-29';

  /** Emitent bierze odczyt sprzed dwóch miesięcy względem początku okresu. */
  const REAL_CPI = {
    '2025-12': 240,
    '2026-01': 210,
    '2026-02': 210,
    '2026-04': 320,
  };

  function edoBond(purchaseDate: string, firstYearRateBp: number, count = 1) {
    return {
      kind: 'EDO' as const,
      purchaseDate,
      count,
      nominalMinor: 10_000,
      firstYearRateBp,
      marginBp: 200,
      termMonths: 120,
      capitalization: 'annual' as const,
    };
  }

  it.each([
    // seria,        zakup,        1. rok,  sztuk, wartość z arkusza (zł)
    ['EDO-130235', '2025-02-13', 655, 1, 108.68],
    ['EDO-100335', '2025-03-10', 655, 1, 108.24],
    ['EDO-100435', '2025-04-10', 655, 1, 107.87],
    ['EDO-040635', '2025-06-04', 625, 1, 107.08],
    ['EDO-160436', '2026-04-16', 535, 2, 203.05],
  ])('%s wycenia się jak w arkuszu', (_series, purchaseDate, rateBp, count, expectedZl) => {
    setCpi(REAL_CPI);
    const valuation = valueBond(edoBond(purchaseDate as string, rateBp as number, count as number), asOf);

    // Arkusz zaokrągla do groszy, więc dopuszczamy różnicę jednego grosza.
    expect(Math.abs(valuation.currentValueMinor - Math.round((expectedZl as number) * 100))).toBeLessThanOrEqual(1);
  });

  it('drugi rok naliczany jest z realnego odczytu, nie z prognozy', () => {
    setCpi(REAL_CPI);
    const periods = computePeriods(edoBond('2025-02-13', 655), asOf);

    expect(periods).toHaveLength(2);
    expect(periods[0]?.rateBp).toBe(655);
    expect(periods[0]?.projected).toBe(false);
    // CPI z grudnia 2025 (2,4%) plus marża 2% — dokładnie 4,4% z arkusza.
    expect(periods[1]?.rateBp).toBe(440);
    expect(periods[1]?.projected).toBe(false);
  });

  it('bez odczytu inflacji oznacza okres jako prognozę', () => {
    // Ta sama obligacja, ale baza nie zna jeszcze odczytu za grudzień 2025.
    setCpi({});
    const periods = computePeriods(edoBond('2025-02-13', 655), asOf);

    expect(periods[1]?.projected).toBe(true);
    // Bez danych zostaje sama marża — gwarantowane minimum emitenta.
    expect(periods[1]?.rateBp).toBe(200);
  });
});

describe('warunki emisji i oznaczenie serii', () => {
  it('COI i ROR wypłacają odsetki, a nie kapitalizują', () => {
    // Import zakładał wcześniej kapitalizację roczną dla wszystkich rodzajów,
    // przez co te dwie emisje wyceniały się za wysoko.
    expect(BOND_TERMS.COI.capitalization).toBe('none');
    expect(BOND_TERMS.ROR.capitalization).toBe('none');
    expect(BOND_TERMS.DOR.capitalization).toBe('none');
    expect(BOND_TERMS.EDO.capitalization).toBe('annual');
  });

  it('każdy rodzaj obligacji ma komplet warunków', () => {
    for (const kind of BOND_KINDS) {
      expect(BOND_TERMS[kind], `brak warunków dla ${kind}`).toBeDefined();
      expect(BOND_TERMS[kind].termMonths).toBeGreaterThan(0);
    }
  });

  it('wylicza serię z rodzaju i daty zakupu wg konwencji MF', () => {
    // EDO kupione w lutym 2025 zapada w lutym 2035.
    expect(defaultBondSeries('EDO', '2025-02-13')).toBe('EDO0235');
    expect(defaultBondSeries('EDO', '2026-04-16')).toBe('EDO0436');
    // COI to cztery lata.
    expect(defaultBondSeries('COI', '2025-03-10')).toBe('COI0329');
    // TOS trzy lata.
    expect(defaultBondSeries('TOS', '2025-06-04')).toBe('TOS0628');
  });

  it('przekracza granicę roku bez pomyłki o miesiąc', () => {
    // Grudzień + 120 miesięcy to nadal grudzień, dziesięć lat później.
    expect(defaultBondSeries('EDO', '2025-12-31')).toBe('EDO1235');
    // OTS trwa trzy miesiące: październik → styczeń następnego roku.
    expect(defaultBondSeries('OTS', '2025-10-05')).toBe('OTS0126');
  });

  it('nie wywraca się na niepełnej dacie', () => {
    expect(defaultBondSeries('EDO', '')).toBe('EDO');
  });
});
