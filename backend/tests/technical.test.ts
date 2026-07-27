import { describe, expect, it } from 'vitest';
import type { Candle } from '@portfolio/shared';
import { computeIndicators, currentState, detectSignals, ema, macd, rsi, sma } from '../src/services/technical.js';

function candlesFrom(closes: number[]): Candle[] {
  // Kolejne dni kalendarzowe od 2024-01-01 — daty muszą rosnąć, inaczej
  // testy porządku sygnałów sprawdzałyby nie to, co trzeba.
  const start = Date.UTC(2024, 0, 1);
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    openE8: c,
    highE8: c,
    lowE8: c,
    closeE8: c,
    volume: null,
  }));
}

describe('SMA', () => {
  it('zwraca null dopóki okno nie jest pełne', () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it('zwraca same null, gdy danych jest mniej niż okres', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('EMA', () => {
  it('startuje od średniej prostej pierwszego okna', () => {
    const result = ema([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBe(2); // (1+2+3)/3
    // k = 2/(3+1) = 0.5 → 4*0.5 + 2*0.5 = 3
    expect(result[3]).toBe(3);
    expect(result[4]).toBe(4);
  });
});

describe('RSI', () => {
  it('zwraca 100 przy nieprzerwanym wzroście', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsi(values, 14);
    expect(result[14]).toBe(100);
  });

  it('zwraca 0 przy nieprzerwanym spadku', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 - i);
    const result = rsi(values, 14);
    expect(result[14]).toBe(0);
  });

  it('utrzymuje się w zakresie 0-100 dla danych mieszanych', () => {
    const values = [44, 44.3, 44.1, 44.2, 44.6, 43.4, 44.2, 44.2, 44.6, 43.4, 44.9, 45.1, 45.4, 45.4, 45.1, 46.2, 47.1];
    const result = rsi(values, 14);
    for (const v of result) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(result[14]).not.toBeNull();
  });

  it('nie liczy nic, gdy danych jest za mało', () => {
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true);
  });
});

describe('MACD', () => {
  it('wyrównuje długości wszystkich trzech serii z wejściem', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const result = macd(values);
    expect(result.macd).toHaveLength(60);
    expect(result.signal).toHaveLength(60);
    expect(result.histogram).toHaveLength(60);
  });

  it('daje dodatni MACD przy trendzie wzrostowym', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const result = macd(values);
    expect(result.macd[59]).toBeGreaterThan(0);
  });

  it('histogram jest różnicą MACD i linii sygnału', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 10);
    const result = macd(values);
    const i = 59;
    expect(result.histogram[i]!).toBeCloseTo(result.macd[i]! - result.signal[i]!, 8);
  });
});

describe('sygnały', () => {
  it('wykrywa złoty krzyż', () => {
    // Długi spadek, potem mocne odbicie — SMA50 przecina SMA200 od dołu.
    const down = Array.from({ length: 220 }, (_, i) => 300 - i);
    const up = Array.from({ length: 120 }, (_, i) => 80 + i * 4);
    const candles = candlesFrom([...down, ...up]);
    const signals = detectSignals(candles, computeIndicators(candles));

    expect(signals.some((s) => s.kind === 'golden_cross')).toBe(true);
  });

  it('wykrywa krzyż śmierci', () => {
    const up = Array.from({ length: 220 }, (_, i) => 100 + i);
    const down = Array.from({ length: 150 }, (_, i) => 320 - i * 3);
    const candles = candlesFrom([...up, ...down]);
    const signals = detectSignals(candles, computeIndicators(candles));

    expect(signals.some((s) => s.kind === 'death_cross')).toBe(true);
  });

  it('zgłasza wykupienie raz — w momencie przekroczenia progu, nie codziennie', () => {
    // Spokojny start, potem wyraźne wybicie: RSI przechodzi przez 70 raz.
    const flat = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 0.4 : -0.4));
    const rally = Array.from({ length: 20 }, (_, i) => 100 + (i + 1) * 3);
    const candles = candlesFrom([...flat, ...rally]);
    const signals = detectSignals(candles, computeIndicators(candles));

    expect(signals.filter((s) => s.kind === 'rsi_overbought')).toHaveLength(1);
  });

  it('nie zgłasza przejścia, gdy RSI jest wykupiony od pierwszego odczytu', () => {
    // Sygnały opisują zaobserwowane przejścia. Nieprzerwany wzrost od początku
    // historii nie daje momentu przekroczenia progu — stan bieżący pokazuje
    // za to `currentState`.
    const candles = candlesFrom(Array.from({ length: 40 }, (_, i) => 100 + i));
    const indicators = computeIndicators(candles);

    expect(detectSignals(candles, indicators).filter((s) => s.kind === 'rsi_overbought')).toHaveLength(0);
    expect(currentState(indicators).rsiZone).toBe('overbought');
  });

  it('zwraca sygnały od najnowszego', () => {
    const values = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 10) * 40);
    const candles = candlesFrom(values);
    const signals = detectSignals(candles, computeIndicators(candles));

    expect(signals.length).toBeGreaterThan(1);
    for (let i = 1; i < signals.length; i += 1) {
      expect(signals[i - 1]!.date >= signals[i]!.date).toBe(true);
    }
  });

  it('nie wywala się na pustym wejściu', () => {
    const indicators = computeIndicators([]);
    expect(detectSignals([], indicators)).toEqual([]);
  });
});
