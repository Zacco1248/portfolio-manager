import type { Candle, TechnicalIndicators, TechnicalSignal } from '@portfolio/shared';

/**
 * Wskaźniki analizy technicznej liczone na cenach zamknięcia.
 *
 * Wszystkie funkcje zwracają tablicę tej samej długości co wejście, z `null`
 * na pozycjach, dla których nie ma jeszcze pełnego okna. Dzięki temu indeksy
 * zgadzają się ze świecami i wykres nie wymaga przesuwania serii.
 *
 * Wartości wskaźników są zwykłymi liczbami zmiennoprzecinkowymi w skali ceny
 * ×1e8 — to nie są kwoty pieniężne, tylko dane wykresu, więc precyzja float
 * jest tu w zupełności wystarczająca.
 */

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  // Pierwsza wartość EMA to zwykła średnia z pierwszego pełnego okna.
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * RSI metodą Wildera (wygładzanie średnią kroczącą, nie prostą) — tak liczy
 * większość platform, w tym te używane przez brokerów.
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }

  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  // Brak strat w oknie oznacza RSI 100 — dzielenie przez zero jest tu
  // poprawnym przypadkiem brzegowym, nie błędem.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);

  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f === null || f === undefined || s === null || s === undefined ? null : f - s;
  });

  // Linia sygnału to EMA z linii MACD, liczona dopiero od miejsca, w którym
  // MACD w ogóle istnieje.
  const firstIndex = macdLine.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(values.length).fill(null);

  if (firstIndex !== -1) {
    const compact = macdLine.slice(firstIndex).map((v) => v ?? 0);
    const signalCompact = ema(compact, signalPeriod);
    for (let i = 0; i < signalCompact.length; i += 1) {
      signal[firstIndex + i] = signalCompact[i] ?? null;
    }
  }

  const histogram = macdLine.map((v, i) => {
    const s = signal[i];
    return v === null || s === null || s === undefined ? null : v - s;
  });

  return { macd: macdLine, signal, histogram };
}

export function computeIndicators(candles: Candle[]): TechnicalIndicators {
  const closes = candles.map((c) => c.closeE8);
  const macdResult = macd(closes);

  return {
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    rsi14: rsi(closes, 14),
    macd: macdResult,
  };
}

const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

/**
 * Wykrywa zdarzenia techniczne jako listę z datami. Sygnały są materiałem
 * informacyjnym — aplikacja nigdy nie sugeruje na ich podstawie decyzji.
 */
export function detectSignals(candles: Candle[], indicators: TechnicalIndicators): TechnicalSignal[] {
  const signals: TechnicalSignal[] = [];

  for (let i = 1; i < candles.length; i += 1) {
    const date = candles[i]!.date;

    const sma50Prev = indicators.sma50[i - 1];
    const sma50Now = indicators.sma50[i];
    const sma200Prev = indicators.sma200[i - 1];
    const sma200Now = indicators.sma200[i];

    if (
      sma50Prev != null &&
      sma50Now != null &&
      sma200Prev != null &&
      sma200Now != null
    ) {
      if (sma50Prev <= sma200Prev && sma50Now > sma200Now) {
        signals.push({
          date,
          kind: 'golden_cross',
          label: 'Złoty krzyż',
          detail: 'SMA 50 przecięła SMA 200 od dołu.',
        });
      } else if (sma50Prev >= sma200Prev && sma50Now < sma200Now) {
        signals.push({
          date,
          kind: 'death_cross',
          label: 'Krzyż śmierci',
          detail: 'SMA 50 przecięła SMA 200 od góry.',
        });
      }
    }

    const rsiPrev = indicators.rsi14[i - 1];
    const rsiNow = indicators.rsi14[i];
    if (rsiPrev != null && rsiNow != null) {
      // Zgłaszamy tylko moment przekroczenia progu, nie każdy dzień powyżej.
      if (rsiPrev < RSI_OVERBOUGHT && rsiNow >= RSI_OVERBOUGHT) {
        signals.push({
          date,
          kind: 'rsi_overbought',
          label: 'RSI w strefie wykupienia',
          detail: `RSI(14) = ${rsiNow.toFixed(1)}, próg ${RSI_OVERBOUGHT}.`,
        });
      } else if (rsiPrev > RSI_OVERSOLD && rsiNow <= RSI_OVERSOLD) {
        signals.push({
          date,
          kind: 'rsi_oversold',
          label: 'RSI w strefie wyprzedania',
          detail: `RSI(14) = ${rsiNow.toFixed(1)}, próg ${RSI_OVERSOLD}.`,
        });
      }
    }

    const histPrev = indicators.macd.histogram[i - 1];
    const histNow = indicators.macd.histogram[i];
    if (histPrev != null && histNow != null) {
      if (histPrev <= 0 && histNow > 0) {
        signals.push({
          date,
          kind: 'macd_bullish',
          label: 'MACD przeciął linię sygnału w górę',
          detail: 'Histogram MACD zmienił znak na dodatni.',
        });
      } else if (histPrev >= 0 && histNow < 0) {
        signals.push({
          date,
          kind: 'macd_bearish',
          label: 'MACD przeciął linię sygnału w dół',
          detail: 'Histogram MACD zmienił znak na ujemny.',
        });
      }
    }
  }

  return signals.reverse();
}

export interface TechnicalState {
  rsi: number | null;
  rsiZone: 'overbought' | 'oversold' | 'neutral' | null;
  /** Układ średnich: 'bullish' gdy SMA50 nad SMA200. */
  trend: 'bullish' | 'bearish' | null;
  macdHistogram: number | null;
}

/**
 * Stan bieżący wskaźników, niezależny od listy sygnałów.
 *
 * Sygnały opisują zaobserwowane *przejścia* — instrument, który był wykupiony
 * już w pierwszym policzalnym punkcie, nigdy nie wygeneruje zdarzenia
 * przekroczenia progu. Bez tego odczytu użytkownik nie zobaczyłby, że RSI
 * właśnie stoi na 85.
 */
export function currentState(indicators: TechnicalIndicators): TechnicalState {
  const lastDefined = <T>(arr: (T | null)[]): T | null => {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const v = arr[i];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };

  const rsiNow = lastDefined(indicators.rsi14);
  const sma50 = lastDefined(indicators.sma50);
  const sma200 = lastDefined(indicators.sma200);

  return {
    rsi: rsiNow,
    rsiZone:
      rsiNow === null
        ? null
        : rsiNow >= RSI_OVERBOUGHT
          ? 'overbought'
          : rsiNow <= RSI_OVERSOLD
            ? 'oversold'
            : 'neutral',
    trend: sma50 === null || sma200 === null ? null : sma50 > sma200 ? 'bullish' : 'bearish',
    macdHistogram: lastDefined(indicators.macd.histogram),
  };
}
