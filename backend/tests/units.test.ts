import { describe, expect, it } from 'vitest';
import { toPrice } from '@portfolio/shared';
import { GRAMS_PER_TROY_OUNCE, perGramToUnit, perOunceToUnit, unitInGramsE8 } from '../src/providers/units.js';

/**
 * Konwersja jednostek metali. Bez niej pozycja prowadzona w gramach,
 * wyceniana kontraktem kwotowanym za uncję trojańską, wychodzi ponad
 * trzydziestokrotnie za wysoka.
 */

describe('waga jednostki', () => {
  it('zna gram, kilogram i uncję trojańską', () => {
    expect(unitInGramsE8('g')).toBe(100_000_000n);
    expect(unitInGramsE8('kg')).toBe(100_000_000_000n);
    expect(unitInGramsE8('oz')).toBe(3_110_347_680n);
  });

  it('akceptuje polskie i alternatywne zapisy', () => {
    expect(unitInGramsE8('uncja')).toBe(unitInGramsE8('oz'));
    expect(unitInGramsE8('ozt')).toBe(unitInGramsE8('oz'));
    expect(unitInGramsE8('gram')).toBe(unitInGramsE8('g'));
    expect(unitInGramsE8('OZ')).toBe(unitInGramsE8('oz'));
  });

  it('przy braku jednostki zakłada uncję', () => {
    // Spot jest kwotowany w uncjach, więc to założenie jest operacją neutralną.
    expect(unitInGramsE8(null)).toBe(unitInGramsE8('oz'));
    expect(unitInGramsE8(undefined)).toBe(unitInGramsE8('oz'));
    expect(unitInGramsE8('nieznana')).toBe(unitInGramsE8('oz'));
  });
});

describe('cena za uncję → cena za jednostkę', () => {
  const spotPerOunce = toPrice('34.50'); // USD za uncję srebra

  it('nie zmienia ceny dla pozycji w uncjach', () => {
    // Realny przypadek: moneta uncjowa. Konwersja musi być tożsamością.
    expect(perOunceToUnit(spotPerOunce, 'oz')).toBe(spotPerOunce);
  });

  it('dzieli przez wagę uncji dla pozycji w gramach', () => {
    const perGram = perOunceToUnit(spotPerOunce, 'g');
    expect(perGram / 1e8).toBeCloseTo(34.5 / GRAMS_PER_TROY_OUNCE, 6);
    // Bez konwersji wycena byłaby ponad 31 razy za wysoka.
    expect(spotPerOunce / perGram).toBeCloseTo(GRAMS_PER_TROY_OUNCE, 4);
  });

  it('mnoży dla pozycji kilogramowych', () => {
    const perKilo = perOunceToUnit(spotPerOunce, 'kg');
    expect(perKilo / 1e8).toBeCloseTo((34.5 * 1000) / GRAMS_PER_TROY_OUNCE, 3);
  });
});

describe('cena za gram → cena za jednostkę', () => {
  const nbpGoldPerGram = toPrice('495.63'); // PLN za gram, notowanie NBP

  it('nie zmienia ceny dla pozycji gramowych', () => {
    expect(perGramToUnit(nbpGoldPerGram, 'g')).toBe(nbpGoldPerGram);
  });

  it('mnoży przez wagę uncji dla pozycji w uncjach', () => {
    const perOunce = perGramToUnit(nbpGoldPerGram, 'oz');
    expect(perOunce / 1e8).toBeCloseTo(495.63 * GRAMS_PER_TROY_OUNCE, 3);
  });

  it('mnoży przez tysiąc dla kilograma', () => {
    expect(perGramToUnit(nbpGoldPerGram, 'kg')).toBe(nbpGoldPerGram * 1000);
  });
});

describe('spójność obu kierunków', () => {
  it('przeliczenie tam i z powrotem odtwarza cenę', () => {
    const perOunce = toPrice('4068.90'); // USD za uncję złota
    const perGram = perOunceToUnit(perOunce, 'g');
    const backToOunce = perGramToUnit(perGram, 'oz');

    // Dwa zaokrąglenia w skali 1e8 zostawiają błąd rzędu 10⁻⁷ jednostki waluty.
    // Sprawdzamy błąd względny, bo bezwzględny rośnie wraz z ceną instrumentu.
    expect(Math.abs(backToOunce - perOunce) / perOunce).toBeLessThan(1e-9);
  });
});
