import { describe, expect, it } from 'vitest';
import { looksLikeRecommendation, parseRecommendation } from '../src/services/recommendations.js';

describe('odczyt rekomendacji z nagłówka', () => {
  it('czyta dom maklerski, zalecenie i cenę docelową', () => {
    const parsed = parseRecommendation('Noble Securities: "kupuj" dla XTB, cena docelowa 95,7 zł');
    expect(parsed.broker).toBe('Noble Securities');
    expect(parsed.rating).toBe('kupuj');
    expect(parsed.targetPriceE8).toBe(9_570_000_000);
  });

  it('czyta zalecenie bez ceny docelowej', () => {
    const parsed = parseRecommendation('Trigon DM rekomenduje "trzymaj" akcje Orlenu. Jaka cena docelowa?');
    expect(parsed.broker).toBe('Trigon');
    expect(parsed.rating).toBe('trzymaj');
    expect(parsed.targetPriceE8).toBeNull();
  });

  it('rozpoznaje obniżenie wyceny i kwotę po słowie „do"', () => {
    const parsed = parseRecommendation('Noble Securities obniżył cenę docelową akcji CD Projektu do 250 zł');
    expect(parsed.direction).toBe('down');
    expect(parsed.targetPriceE8).toBe(25_000_000_000);
  });

  it('rozpoznaje podwyższenie wyceny', () => {
    expect(parseRecommendation('Analityk Noble Securities podwyższył cenę docelową dla akcji XTB').direction).toBe('up');
  });

  it('nie bierze pierwszej lepszej liczby za cenę docelową', () => {
    // 155 zł to bieżący kurs, nie wycena — brak słowa kotwiczącego.
    const parsed = parseRecommendation('Kurs akcji Orlen przebił 155 zł, a eksperci wskazują kolejne opory');
    expect(parsed.targetPriceE8).toBeNull();
  });

  it('odsiewa nagłówki niebędące rekomendacją', () => {
    expect(looksLikeRecommendation('Orlen otworzył nową stację w Poznaniu')).toBe(false);
    expect(looksLikeRecommendation('Dwaj analitycy podnieśli wycenę XTB')).toBe(true);
  });
});
