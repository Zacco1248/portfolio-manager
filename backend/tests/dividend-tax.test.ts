import { describe, expect, it } from 'vitest';
import { grossUpWithheld } from '../src/services/tax.js';

/**
 * Ubruttowienie dywidendy wypłaconej po potrąceniu podatku.
 *
 * Polski płatnik przekazuje kwotę pomniejszoną o 19% i nie raportuje osobnego
 * wiersza podatku — bez korekty brutto równałoby się netto. Ale na rachunku
 * IKE i IKZE podatku nie potrąca w ogóle, więc ta sama korekta doliczałaby
 * tam daninę, której nikt nie pobrał.
 */

const orlen = { symbol: 'WSE:PKN', country: 'Polska' };
const nvidia = { symbol: 'NVDA', country: 'USA' };

describe('ubruttowienie dywidendy krajowej', () => {
  it('dolicza potrącone 19% na rachunku zwykłym', () => {
    // 81 zł netto odpowiada 100 zł brutto po potrąceniu 19%.
    const result = grossUpWithheld(81_00, 0, orlen);

    expect(result.grossMinor).toBe(100_00);
    expect(result.taxMinor).toBe(19_00);
  });

  it('nie rusza kwoty, gdy podatek jest już zapisany', () => {
    const result = grossUpWithheld(100_00, 19_00, orlen);

    expect(result.grossMinor).toBe(100_00);
    expect(result.taxMinor).toBe(19_00);
  });

  it('nie dotyczy spółek zagranicznych — tam potrącana jest stawka traktatowa', () => {
    const result = grossUpWithheld(81_00, 0, nvidia);

    expect(result.grossMinor).toBe(81_00);
    expect(result.taxMinor).toBe(0);
  });
});

describe('rachunki zwolnione z podatku', () => {
  /*
   * Regres: na IKE i IKZE płatnik nie pobiera podatku od dywidendy, więc kwota
   * z wyciągu jest już kwotą brutto. Wcześniej ubruttowienie działało tam tak
   * samo jak na rachunku zwykłym i pokazywało 19% podatku, którego nie było —
   * zawyżając i przychód, i rzekomo zapłaconą daninę.
   */
  it('nie ubruttawia dywidendy krajowej na IKE', () => {
    const result = grossUpWithheld(81_00, 0, orlen, true);

    expect(result.grossMinor).toBe(81_00);
    expect(result.taxMinor).toBe(0);
  });

  it('zwolnienie ma pierwszeństwo przed regułą krajowości', () => {
    // Ten sam papier, ta sama kwota — różni tylko rachunek.
    const zwykly = grossUpWithheld(81_00, 0, orlen, false);
    const ike = grossUpWithheld(81_00, 0, orlen, true);

    expect(zwykly.taxMinor).toBeGreaterThan(0);
    expect(ike.taxMinor).toBe(0);
    expect(ike.grossMinor).toBeLessThan(zwykly.grossMinor);
  });

  it('domyślnie zachowuje się jak rachunek zwykły', () => {
    // Pominięty parametr nie może po cichu włączyć zwolnienia — wołający,
    // który go nie poda, ma dostać wariant opodatkowany.
    expect(grossUpWithheld(81_00, 0, orlen)).toEqual(grossUpWithheld(81_00, 0, orlen, false));
  });
});
