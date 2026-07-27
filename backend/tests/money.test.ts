import { describe, expect, it } from 'vitest';
import {
  applyBp,
  changeBp,
  convertMinor,
  divRound,
  formatMinor,
  formatQty,
  parseDecimal,
  positionValueMinor,
  shareBp,
  toFx,
  toMinor,
  toPrice,
  toQty,
} from '@portfolio/shared';

describe('parseDecimal', () => {
  it('parsuje ułamki bez błędu reprezentacji zmiennoprzecinkowej', () => {
    // 2.2301 * 1e8 w arytmetyce float daje 223010000.00000003.
    expect(toQty('2.2301')).toBe(223_010_000);
    expect(toQty('0.2301')).toBe(23_010_000);
    expect(toPrice('10.485')).toBe(1_048_500_000);
    expect(toFx('3.65313')).toBe(3_653_130);
  });

  it('radzi sobie z formatami z importów', () => {
    expect(toMinor('1 234,56')).toBe(123_456); // polski zapis ze spacją
    expect(toMinor('1,234.56')).toBe(123_456); // angielski z separatorem tysięcy
    expect(toMinor('1234,56')).toBe(123_456);
    expect(toMinor('-99,99')).toBe(-9_999);
    expect(toMinor('0')).toBe(0);
    expect(toMinor('')).toBe(0);
    expect(toMinor(null)).toBe(0);
  });

  it('odróżnia separator tysięcy od dziesiętnego przy jednym przecinku', () => {
    expect(toMinor('1,234')).toBe(123_400); // 1234 zł
    expect(toMinor('1,23')).toBe(123); // 1,23 zł
  });

  it('ucina nadmiarowe miejsca zamiast zaokrąglać w górę', () => {
    // Dane źródłowe nie mają większej precyzji niż skala; zaokrąglenie tutaj
    // maskowałoby błąd wejścia.
    expect(parseDecimal('1.999999999999', 8)).toBe(199_999_999);
  });

  it('odrzuca wejście, którego nie da się zinterpretować', () => {
    expect(() => toMinor('abc')).toThrow();
  });
});

describe('divRound', () => {
  it('zaokrągla połówki w górę co do wartości bezwzględnej', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
  });

  it('nie pozwala dzielić przez zero', () => {
    expect(() => divRound(1n, 0n)).toThrow();
  });
});

describe('wycena pozycji', () => {
  it('mnoży ilość przez cenę bez przepełnienia', () => {
    // 0.7677 szt. × 48.31 USD = 37.0866... → 37.09 USD
    expect(positionValueMinor(toQty('0.7677'), toPrice('48.31'), 'USD')).toBe(3_709);
  });

  it('radzi sobie z dużymi wartościami krypto', () => {
    // 12.5 BTC × 500 000 USD = 6 250 000 USD. Iloczyn qty_e8 × price_e8 to 6.25e21,
    // czyli daleko poza Number.MAX_SAFE_INTEGER — arytmetyka musi iść przez BigInt.
    expect(positionValueMinor(toQty('12.5'), toPrice('500000'), 'USD')).toBe(6_250_000_00);
  });

  it('przewalutowuje po kursie NBP', () => {
    // 100.03 DKK po kursie 0.5774
    expect(convertMinor(10_003, toFx('0.5774'), 'DKK', 'PLN')).toBe(5_776);
  });

  it('traktuje waluty bez części ułamkowej poprawnie', () => {
    // JPY nie ma groszy — skala minor units to 1, nie 100.
    expect(toMinor('1234', 'JPY')).toBe(1234);
    expect(formatMinor(1234, 'JPY')).toBe('1234');
  });
});

describe('procenty w punktach bazowych', () => {
  it('liczy udział w portfelu', () => {
    expect(shareBp(25_00, 100_00)).toBe(2500); // 25.00%
    expect(shareBp(0, 0)).toBe(0);
  });

  it('liczy zmianę względem bazy', () => {
    expect(changeBp(150_00, 100_00)).toBe(5000); // +50.00%
    expect(changeBp(50_00, 100_00)).toBe(-5000);
    expect(changeBp(100_00, 0)).toBeNull();
  });

  it('liczy zmianę od ujemnej bazy względem jej wartości bezwzględnej', () => {
    // Bez wartości bezwzględnej wzrost z -100 do -50 wyszedłby jako -50%.
    expect(changeBp(-50_00, -100_00)).toBe(5000);
  });

  it('stosuje stopę do kwoty', () => {
    expect(applyBp(1000_00, 1900)).toBe(190_00); // podatek Belki 19%
  });
});

describe('formatowanie', () => {
  it('formatuje kwoty i ilości do prezentacji', () => {
    expect(formatMinor(123_456)).toBe('1234.56');
    expect(formatMinor(-5)).toBe('-0.05');
    expect(formatQty(toQty('2.2301'))).toBe('2.2301');
    expect(formatQty(toQty('3'))).toBe('3');
  });
});
