import { describe, expect, it } from 'vitest';
import { AI_FEATURES, AI_FEATURE_INFO, getAiSettings } from '../src/services/ai-config.js';
import { previousMonth } from '../src/services/ai-assist.js';
import { fundRegion, localClassification } from '../src/services/classify.js';

describe('funkcje AI', () => {
  it('każda funkcja deklaruje zakres wysyłanych danych', () => {
    for (const feature of AI_FEATURES) {
      const info = AI_FEATURE_INFO[feature];
      expect(info.key).toBe(feature);
      expect(info.dataSent.length).toBeGreaterThan(20);
      expect(info.description.length).toBeGreaterThan(20);
    }
  });

  it('domyślnie żadna funkcja nie jest włączona', () => {
    const { features } = getAiSettings();
    for (const feature of AI_FEATURES) {
      expect(features[feature]).toBe(false);
    }
  });
});

describe('poprzedni miesiąc', () => {
  it('cofa się o jeden miesiąc', () => {
    expect(previousMonth('2026-07-27')).toBe('2026-06');
  });

  it('przechodzi przez granicę roku', () => {
    expect(previousMonth('2026-01-15')).toBe('2025-12');
  });

  it('dopełnia numer miesiąca zerem', () => {
    expect(previousMonth('2026-11-02')).toBe('2026-10');
  });
});

describe('region ekspozycji funduszu', () => {
  it('czyta indeks z nazwy zamiast rynku notowania', () => {
    expect(fundRegion('iShares Core S&P 500 UCITS ETF')).toBe('USA');
    expect(fundRegion('iShares Core MSCI World UCITS ETF')).toBe('Świat');
    expect(fundRegion('iShares MSCI Emerging Markets UCITS ETF')).toBe('Rynki wschodzące');
  });

  it('wyjątek „ex USA" ma pierwszeństwo przed dopasowaniem do USA', () => {
    expect(fundRegion('Vanguard FTSE Developed World ex-US')).toBe('Rynki rozwinięte bez USA');
  });

  it('nie zgaduje dla nazwy bez rozpoznawalnego indeksu', () => {
    expect(fundRegion('Jakiś fundusz bez nazwy indeksu')).toBeNull();
  });

  it('ETF notowany w Londynie na spółki z USA dostaje kraj USA', () => {
    expect(
      localClassification({
        symbol: 'LON:CSPX',
        name: 'iShares Core S&P 500 UCITS ETF',
        exchange: 'LON',
        assetClass: 'etf_foreign',
      }).country,
    ).toBe('USA');
  });

  it('bez rozpoznanego indeksu ETF spada do kraju notowania', () => {
    expect(
      localClassification({ symbol: 'LON:XYZ', name: 'Fundusz nieznany', exchange: 'LON', assetClass: 'etf_foreign' }).country,
    ).toBe('Wielka Brytania');
  });
});
