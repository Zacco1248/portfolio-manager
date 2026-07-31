import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASSES,
  ASSET_CLASS_CHILDREN,
  ASSET_CLASS_GROUPS,
  ASSET_CLASS_GROUP_LABELS,
  ASSET_CLASS_LABELS,
  ASSET_CLASS_PARENT,
  assetClassLabel,
  equityClassFor,
  isDomesticInstrument,
  rollUp,
  taxCategoryFor,
  toGroupKey,
} from '@portfolio/shared';
import { valueForKey } from '../src/services/rebalance.js';

/**
 * Hierarchia klas aktywów: liście zapisywalne na instrumencie i grupy
 * nadrzędne służące do zwijania raportów.
 *
 * Testy idą pętlą po `ASSET_CLASSES`, a nie po wyliczonej liście — dzięki temu
 * dodanie nowej klasy bez uzupełnienia map albo bez przemyślenia skutków
 * podatkowych wywali test, zamiast po cichu przejść.
 */

describe('hierarchia klas aktywów', () => {
  it('każdy liść ma rodzica i etykietę', () => {
    for (const leaf of ASSET_CLASSES) {
      expect(ASSET_CLASS_PARENT[leaf], `brak rodzica dla ${leaf}`).toBeDefined();
      expect(ASSET_CLASS_LABELS[leaf], `brak etykiety dla ${leaf}`).toBeTruthy();
      expect(ASSET_CLASS_GROUPS).toContain(rollUp(leaf));
    }
  });

  it('każda grupa ma etykietę i co najmniej jedno dziecko', () => {
    for (const group of ASSET_CLASS_GROUPS) {
      expect(ASSET_CLASS_GROUP_LABELS[group], `brak etykiety grupy ${group}`).toBeTruthy();
      expect(ASSET_CLASS_CHILDREN[group].length).toBeGreaterThan(0);
    }
  });

  it('mapa dzieci jest dokładną odwrotnością mapy rodziców', () => {
    for (const group of ASSET_CLASS_GROUPS) {
      for (const child of ASSET_CLASS_CHILDREN[group]) {
        expect(ASSET_CLASS_PARENT[child]).toBe(group);
      }
    }
    for (const leaf of ASSET_CLASSES) {
      expect(ASSET_CLASS_CHILDREN[rollUp(leaf)]).toContain(leaf);
    }
  });

  it('akcje i ETF-y rozbijają się na krajowe i zagraniczne', () => {
    expect(ASSET_CLASS_CHILDREN.stock).toEqual(['stock_pl', 'stock_foreign']);
    expect(ASSET_CLASS_CHILDREN.etf).toEqual(['etf_pl', 'etf_foreign']);
  });
});

describe('kategoria podatkowa', () => {
  /*
   * Strażnik PIT-38: krypto rozlicza się osobno od papierów wartościowych.
   * Gdyby doszedł kiedyś drugi liść krypto, ten test wymusi zmianę
   * `taxCategoryFor` razem z nim.
   */
  it('wszystkie klasy poza krypto są papierami wartościowymi', () => {
    for (const leaf of ASSET_CLASSES) {
      expect(taxCategoryFor(leaf), `zła kategoria dla ${leaf}`).toBe(
        leaf === 'crypto' ? 'crypto' : 'securities',
      );
    }
  });

  it('rozbicie akcji nie zmieniło kategorii podatkowej', () => {
    expect(taxCategoryFor('stock_pl')).toBe('securities');
    expect(taxCategoryFor('stock_foreign')).toBe('securities');
    expect(taxCategoryFor('etf_foreign')).toBe('securities');
  });
});

describe('etykiety i klucze historyczne', () => {
  it('rozpoznaje klucz grupowy zapisany przed rozbiciem klas', () => {
    expect(assetClassLabel('stock')).toBe('Akcje');
    expect(assetClassLabel('etf')).toBe('ETF-y');
  });

  it('rozpoznaje klucz liściasty', () => {
    expect(assetClassLabel('stock_pl')).toBe('Akcje polskie');
    expect(assetClassLabel('etf_foreign')).toBe('ETF-y zagraniczne');
  });

  it('nierozpoznany klucz wraca jako własna nazwa, zamiast rzucać', () => {
    expect(assetClassLabel('nieznane')).toBe('nieznane');
  });

  it('zwija liście do grup, a klucze historyczne zostawia bez zmian', () => {
    expect(toGroupKey('stock_pl')).toBe('stock');
    expect(toGroupKey('etf_foreign')).toBe('etf');
    // Klucz ze starego snapshotu jest już grupą — na tym opiera się ciągłość
    // wykresu historii przez moment migracji.
    expect(toGroupKey('stock')).toBe('stock');
    expect(toGroupKey('cash')).toBe('cash');
  });
});

describe('oś krajowa', () => {
  const foreign = { symbol: 'NVDA', exchange: 'NASDAQ', currency: 'USD' };

  it('uznaje za krajowe papiery z GPW, niezależnie od zapisu', () => {
    expect(isDomesticInstrument({ symbol: 'PKO', exchange: 'WSE', currency: 'PLN' })).toBe(true);
    expect(isDomesticInstrument({ symbol: 'WSE:BIO', exchange: null, currency: 'PLN' })).toBe(true);
    expect(isDomesticInstrument({ symbol: 'CDR.WA', exchange: null, currency: 'USD' })).toBe(true);
    // Wyciąg brokera bywa bez giełdy — wtedy rozstrzyga waluta.
    expect(isDomesticInstrument({ symbol: 'ALE', exchange: null, currency: 'PLN' })).toBe(true);
  });

  it('nie uznaje za krajowy papieru notowanego za granicą', () => {
    expect(isDomesticInstrument(foreign)).toBe(false);
    expect(isDomesticInstrument({ symbol: 'LON:VUAA', exchange: null, currency: 'USD' })).toBe(false);
  });

  it('domyka grupę dostawcy do konkretnego liścia', () => {
    expect(equityClassFor('etf', { symbol: 'LON:VUAA', exchange: null, currency: 'USD' })).toBe('etf_foreign');
    expect(equityClassFor('etf', { symbol: 'BETA.WA', exchange: null, currency: 'PLN' })).toBe('etf_pl');
    expect(equityClassFor('stock', foreign)).toBe('stock_foreign');
    expect(equityClassFor('stock', { symbol: 'WSE:PKO', exchange: null, currency: 'PLN' })).toBe('stock_pl');
  });
});

describe('valueForKey — cele na grupie i na liściu', () => {
  const values = new Map([
    ['stock_pl', 3000_00],
    ['stock_foreign', 2000_00],
    ['bond', 1000_00],
    ['cash', 500_00],
  ]);

  it('cel na grupie sumuje oba liście', () => {
    expect(valueForKey(values, 'stock')).toBe(5000_00);
  });

  it('cel na liściu bierze wyłącznie ten liść', () => {
    expect(valueForKey(values, 'stock_pl')).toBe(3000_00);
  });

  it('nie podwaja grup jednoelementowych', () => {
    // `bond` i `cash` są jednocześnie liśćmi i grupami — naiwne sumowanie
    // „własny wpis plus dzieci" policzyłoby je dwa razy.
    expect(valueForKey(values, 'bond')).toBe(1000_00);
    expect(valueForKey(values, 'cash')).toBe(500_00);
  });

  it('uwzględnia wartość zapisaną pod kluczem grupowym sprzed migracji', () => {
    const legacy = new Map([
      ['stock', 4000_00],
      ['stock_pl', 1000_00],
    ]);
    expect(valueForKey(legacy, 'stock')).toBe(5000_00);
  });

  it('nieznany klucz daje zero, a nie wyjątek', () => {
    expect(valueForKey(values, 'nieznane')).toBe(0);
  });
});
