import { describe, expect, it } from 'vitest';
import { localClassification } from '../src/services/classify.js';
import { dailyReturns } from '../src/services/stats.js';

describe('klasyfikacja lokalna', () => {
  it('rozpoznaje kraj po prefiksie rynku w symbolu', () => {
    expect(localClassification({ symbol: 'WSE:PKO', exchange: null, assetClass: 'stock' }).country).toBe('Polska');
    expect(localClassification({ symbol: 'LON:IUIT', exchange: null, assetClass: 'etf' }).country).toBe(
      'Wielka Brytania',
    );
  });

  it('rozpoznaje kraj po sufiksie symbolu dostawcy', () => {
    expect(localClassification({ symbol: 'PKO.WA', exchange: null, assetClass: 'stock' }).country).toBe('Polska');
  });

  it('pole exchange ma pierwszeństwo przed zgadywaniem z symbolu', () => {
    expect(localClassification({ symbol: 'IUIT', exchange: 'NYSE', assetClass: 'etf' }).country).toBe('USA');
  });

  it('obligacjom i metalom nadaje sektor bez odpytywania dostawcy', () => {
    expect(localClassification({ symbol: 'EDO1035', exchange: null, assetClass: 'bond' })).toEqual({
      sector: 'Obligacje skarbowe',
      country: 'Polska',
    });
    expect(localClassification({ symbol: 'SIW00', exchange: null, assetClass: 'metal' }).sector).toBe(
      'Metale szlachetne',
    );
    expect(localClassification({ symbol: 'BTC', exchange: null, assetClass: 'crypto' }).sector).toBe('Kryptowaluty');
  });

  it('dla nieznanego rynku nie zmyśla kraju', () => {
    expect(localClassification({ symbol: 'FOO', exchange: 'ZZZ', assetClass: 'stock' }).country).toBeNull();
  });
});

describe('dzienne zwroty portfela', () => {
  it('nie liczy dopłaty jako wzrostu', () => {
    const [first] = dailyReturns([
      { date: '2026-01-01', valuePlnMinor: 100_000, investedPlnMinor: 100_000 },
      { date: '2026-01-02', valuePlnMinor: 200_000, investedPlnMinor: 200_000 },
    ]);
    // Wartość podwojona wyłącznie wpłatą — zwrot ma wyjść zerowy.
    expect(first?.growth).toBeCloseTo(1, 10);
  });

  it('liczy zwrot ze zmiany cen przy jednoczesnej dopłacie', () => {
    const [first] = dailyReturns([
      { date: '2026-01-01', valuePlnMinor: 100_000, investedPlnMinor: 100_000 },
      { date: '2026-01-02', valuePlnMinor: 155_000, investedPlnMinor: 150_000 },
    ]);
    // 100 000 urosło do 105 000, reszta to wpłata 50 000.
    expect(first?.growth).toBeCloseTo(1.05, 10);
  });

  it('pomija dni startujące od pustego portfela', () => {
    expect(
      dailyReturns([
        { date: '2026-01-01', valuePlnMinor: 0, investedPlnMinor: 0 },
        { date: '2026-01-02', valuePlnMinor: 100_000, investedPlnMinor: 100_000 },
      ]),
    ).toHaveLength(0);
  });
});
