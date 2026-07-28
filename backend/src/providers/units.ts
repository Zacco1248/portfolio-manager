import { bigintToNumber, mulDiv } from '@portfolio/shared';

/**
 * Przeliczanie jednostek metali szlachetnych.
 *
 * Notowania spot są podawane za uncję trojańską (kontrakty GC=F, SI=F w USD),
 * a NBP publikuje cenę złota za gram. Pozycja użytkownika może być prowadzona
 * w gramach, uncjach albo kilogramach — bez wspólnego przelicznika wycena
 * pozycji w gramach wyceniana ceną za uncję wychodzi ponad trzydziestokrotnie
 * za wysoka.
 *
 * Konwencja: każdy dostawca zwraca cenę **za jednostkę instrumentu**, a nie
 * za jednostkę swojego źródła. Przeliczenie robi dostawca, bo tylko on wie,
 * w czym kwotuje.
 */

export const GRAMS_PER_TROY_OUNCE = 31.1034768;

/** Skalowana postać przelicznika — unikamy mnożenia przez float na cenach. */
const GRAMS_PER_TROY_OUNCE_E8 = 3_110_347_680n;
const E8 = 100_000_000n;

/** Ile gramów waży jedna jednostka pozycji. */
export function unitInGramsE8(unit: string | null | undefined): bigint {
  switch ((unit ?? 'oz').toLowerCase().trim()) {
    case 'g':
    case 'gram':
    case 'gramy':
      return E8;
    case 'kg':
    case 'kilogram':
      return 1000n * E8;
    case 'oz':
    case 'ozt':
    case 'uncja':
    case 'uncje':
      return GRAMS_PER_TROY_OUNCE_E8;
    default:
      // Nieznana jednostka: zakładamy uncję, bo w niej kwotowany jest spot —
      // wtedy brak konwersji jest operacją neutralną, a nie zniekształceniem.
      return GRAMS_PER_TROY_OUNCE_E8;
  }
}

/** Cena za uncję trojańską → cena za jednostkę instrumentu. */
export function perOunceToUnit(priceE8: number, unit: string | null | undefined): number {
  return bigintToNumber(mulDiv(BigInt(priceE8), unitInGramsE8(unit), GRAMS_PER_TROY_OUNCE_E8));
}

/** Cena za gram → cena za jednostkę instrumentu. */
export function perGramToUnit(priceE8: number, unit: string | null | undefined): number {
  return bigintToNumber(mulDiv(BigInt(priceE8), unitInGramsE8(unit), E8));
}

/** Jednostki dopuszczalne dla pozycji w metalach. */
export const METAL_UNITS = ['oz', 'g', 'kg'] as const;
export type MetalUnit = (typeof METAL_UNITS)[number];

export const METAL_UNIT_LABELS: Record<string, string> = {
  oz: 'uncja trojańska',
  g: 'gram',
  kg: 'kilogram',
};
