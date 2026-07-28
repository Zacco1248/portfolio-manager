/**
 * Rozliczanie strat z lat ubiegłych.
 *
 * Dwa reżimy, bo ustawa traktuje te dochody osobno:
 *
 *  - **Papiery wartościowe** (PIT-38 część C): stratę odlicza się w najbliższych
 *    kolejno po sobie następujących **pięciu** latach podatkowych, przy czym
 *    kwota obniżenia w którymkolwiek z tych lat nie może przekroczyć **50%**
 *    wysokości tej straty. Nieodliczona reszta po pięciu latach przepada.
 *
 *  - **Kryptowaluty** (PIT-38 część E): nadwyżka kosztów nad przychodami nie
 *    jest „stratą" w tym rozumieniu, tylko powiększa koszty uzyskania przychodu
 *    w roku następnym — bez limitu procentowego i bez ograniczenia czasowego.
 *
 * Moduł jest czysty: dostaje wyniki roczne, oddaje rozliczenie. Dzięki temu
 * da się go przetestować na tabelce lat bez dotykania bazy.
 */

/** Dochód (dodatni) albo strata (ujemny) za dany rok, w groszach. */
export interface YearResult {
  year: number;
  gainPlnMinor: number;
}

export interface LossSource {
  /** Rok, w którym powstała strata. */
  year: number;
  lossPlnMinor: number;
  /** Limit odliczenia w jednym roku: 50% straty. */
  annualLimitPlnMinor: number;
  /** Ile z tej straty zostało jeszcze do wykorzystania. */
  remainingPlnMinor: number;
  /** Ostatni rok, w którym można ją odliczyć. */
  expiresAfterYear: number;
}

export interface CarryForwardResult {
  /** Strata dostępna do odliczenia w rozliczanym roku. */
  availablePlnMinor: number;
  /** Ile faktycznie odliczono, ograniczone dochodem i limitami. */
  appliedPlnMinor: number;
  /** Dochód po odliczeniu — podstawa opodatkowania. */
  taxableGainPlnMinor: number;
  /** Straty, które zostają na kolejne lata. */
  remaining: LossSource[];
  /** Straty, które przepadły z upływem pięciu lat. */
  expiredPlnMinor: number;
}

export const CARRY_FORWARD_YEARS = 5;
const ANNUAL_SHARE_BP = 5000; // 50%

/**
 * Symuluje odliczenia rok po roku od najstarszej straty.
 *
 * Nie da się policzyć samego roku docelowego w oderwaniu od poprzednich —
 * to, ile straty zostało, zależy od tego, ile odliczono wcześniej. Dlatego
 * przechodzimy przez całą historię od pierwszego roku ze stratą.
 */
export function computeSecuritiesCarryForward(history: YearResult[], targetYear: number): CarryForwardResult {
  const sorted = [...history].filter((y) => y.year <= targetYear).sort((a, b) => a.year - b.year);
  if (sorted.length === 0) {
    return { availablePlnMinor: 0, appliedPlnMinor: 0, taxableGainPlnMinor: 0, remaining: [], expiredPlnMinor: 0 };
  }

  const pool: LossSource[] = [];
  let expired = 0;
  let lastApplied = 0;
  let lastAvailable = 0;
  let lastTaxable = 0;

  const firstYear = sorted[0]!.year;
  const resultByYear = new Map(sorted.map((y) => [y.year, y.gainPlnMinor]));

  for (let year = firstYear; year <= targetYear; year += 1) {
    // Straty starsze niż pięć lat przepadają, zanim spróbujemy je odliczyć.
    for (const source of pool) {
      if (source.expiresAfterYear < year && source.remainingPlnMinor > 0) {
        expired += source.remainingPlnMinor;
        source.remainingPlnMinor = 0;
      }
    }

    const gain = resultByYear.get(year) ?? 0;
    const available = pool.reduce(
      (sum, source) => sum + Math.min(source.remainingPlnMinor, source.annualLimitPlnMinor),
      0,
    );

    let applied = 0;
    if (gain > 0) {
      let budget = gain;
      // Odliczamy od najstarszej straty — ta przepadnie najwcześniej.
      for (const source of pool) {
        if (budget <= 0) break;
        if (source.remainingPlnMinor <= 0) continue;
        const usable = Math.min(source.remainingPlnMinor, source.annualLimitPlnMinor, budget);
        source.remainingPlnMinor -= usable;
        budget -= usable;
        applied += usable;
      }
    } else if (gain < 0) {
      const loss = -gain;
      pool.push({
        year,
        lossPlnMinor: loss,
        annualLimitPlnMinor: Math.floor((loss * ANNUAL_SHARE_BP) / 10_000),
        remainingPlnMinor: loss,
        expiresAfterYear: year + CARRY_FORWARD_YEARS,
      });
    }

    if (year === targetYear) {
      lastApplied = applied;
      lastAvailable = available;
      // Rok stratny ma ujemną podstawę i zerowy podatek; rok dochodowy
      // pomniejszamy o faktycznie odliczoną stratę.
      lastTaxable = gain > 0 ? gain - applied : gain;
    }
  }

  return {
    availablePlnMinor: lastAvailable,
    appliedPlnMinor: lastApplied,
    taxableGainPlnMinor: lastTaxable,
    remaining: pool.filter((source) => source.remainingPlnMinor > 0),
    expiredPlnMinor: expired,
  };
}

export interface CryptoCarryResult {
  /** Koszty przeniesione z lat poprzednich, powiększające koszty tego roku. */
  carriedCostPlnMinor: number;
  /** Dochód po uwzględnieniu przeniesionych kosztów. */
  taxableGainPlnMinor: number;
  /** Nadwyżka kosztów, która przejdzie na rok następny. */
  carryToNextYearPlnMinor: number;
}

/**
 * Krypto: nadwyżka kosztów przechodzi na rok następny w całości.
 *
 * `history` to pary rok → (przychód − koszt). Rok bez transakcji nie zeruje
 * przeniesienia; nadwyżka wędruje dalej.
 */
export function computeCryptoCarryForward(history: YearResult[], targetYear: number): CryptoCarryResult {
  const empty: CryptoCarryResult = {
    carriedCostPlnMinor: 0,
    taxableGainPlnMinor: 0,
    carryToNextYearPlnMinor: 0,
  };

  const sorted = [...history].filter((y) => y.year <= targetYear).sort((a, b) => a.year - b.year);
  if (sorted.length === 0) return empty;

  let carried = 0;
  let result = empty;

  for (let year = sorted[0]!.year; year <= targetYear; year += 1) {
    const gain = sorted.find((y) => y.year === year)?.gainPlnMinor ?? 0;
    const carriedIn = carried;
    const afterCarry = gain - carriedIn;

    carried = afterCarry < 0 ? -afterCarry : 0;

    if (year === targetYear) {
      result = {
        carriedCostPlnMinor: carriedIn,
        taxableGainPlnMinor: Math.max(afterCarry, 0),
        carryToNextYearPlnMinor: carried,
      };
    }
  }

  return result;
}
