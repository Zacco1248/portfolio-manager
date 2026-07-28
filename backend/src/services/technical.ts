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
    bollinger: bollinger(closes),
    atr14: atr(candles),
    stochastic: stochastic(candles),
    roc20: rateOfChange(closes, 20),
    obv: onBalanceVolume(candles),
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
  /** Położenie ceny we wstęgach Bollingera: 0 = dolna, 100 = górna. */
  bollingerPercent: number | null;
  /** ATR wyrażony jako procent ceny — zmienność porównywalna między walorami. */
  atrPercent: number | null;
  stochasticK: number | null;
  stochasticZone: 'overbought' | 'oversold' | 'neutral' | null;
  /** Zmiana procentowa przez ostatnie 20 sesji. */
  momentum20: number | null;
  /** Odległość od maksimum i minimum z roku, w procentach. */
  fromYearHighPercent: number | null;
  fromYearLowPercent: number | null;
}

/**
 * Stan bieżący wskaźników, niezależny od listy sygnałów.
 *
 * Sygnały opisują zaobserwowane *przejścia* — instrument, który był wykupiony
 * już w pierwszym policzalnym punkcie, nigdy nie wygeneruje zdarzenia
 * przekroczenia progu. Bez tego odczytu użytkownik nie zobaczyłby, że RSI
 * właśnie stoi na 85.
 */
export function currentState(indicators: TechnicalIndicators, candles: Candle[] = []): TechnicalState {
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

  const close = candles.length > 0 ? candles[candles.length - 1]!.closeE8 : null;
  const atrNow = lastDefined(indicators.atr14);
  const stochK = lastDefined(indicators.stochastic.k);

  const yearWindow = candles.slice(-YEAR_SESSIONS);
  const yearHigh = yearWindow.length > 0 ? Math.max(...yearWindow.map((c) => c.highE8)) : null;
  const yearLow = yearWindow.length > 0 ? Math.min(...yearWindow.map((c) => c.lowE8)) : null;

  /** Położenie ceny między wstęgami, w procentach szerokości kanału. */
  const percentB = (): number | null => {
    const upper = lastDefined(indicators.bollinger.upper);
    const lower = lastDefined(indicators.bollinger.lower);
    if (close === null || upper === null || lower === null || upper === lower) return null;
    return ((close - lower) / (upper - lower)) * 100;
  };

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
    bollingerPercent: percentB(),
    // ATR w jednostkach ceny nic nie mówi bez odniesienia — 2 zł to dużo dla
    // spółki po 20 zł i nic dla spółki po 500 zł.
    atrPercent: close !== null && atrNow !== null && close > 0 ? (atrNow / close) * 100 : null,
    stochasticK: stochK,
    stochasticZone:
      stochK === null ? null : stochK >= STOCH_OVERBOUGHT ? 'overbought' : stochK <= STOCH_OVERSOLD ? 'oversold' : 'neutral',
    momentum20: lastDefined(indicators.roc20),
    fromYearHighPercent: yearHigh !== null && close !== null && yearHigh > 0 ? ((close - yearHigh) / yearHigh) * 100 : null,
    fromYearLowPercent: yearLow !== null && close !== null && yearLow > 0 ? ((close - yearLow) / yearLow) * 100 : null,
  };
}

const STOCH_OVERBOUGHT = 80;
const STOCH_OVERSOLD = 20;

/** Liczba sesji przyjmowana za rok giełdowy. */
const YEAR_SESSIONS = 252;

/**
 * Wstęgi Bollingera: średnia krocząca z odchyleniem standardowym po obu stronach.
 *
 * Mówią coś, czego nie mówi sama średnia — czy bieżąca cena jest daleko od niej
 * jak na własną zmienność tego waloru. Ten sam ruch o 3% jest czymś innym dla
 * spółki chodzącej po 1% dziennie i czymś innym dla krypto.
 */
export function bollinger(
  values: number[],
  period = 20,
  deviations = 2,
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const middle = sma(values, period);

  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null || mean === undefined || i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }

    const window = values.slice(i - period + 1, i + 1);
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);

    upper.push(mean + deviations * sd);
    lower.push(mean - deviations * sd);
  }

  return { upper, middle, lower };
}

/**
 * Średni rzeczywisty zakres (ATR) — miara zmienności w jednostkach ceny.
 *
 * Uwzględnia luki między sesjami, więc opisuje faktyczne ryzyko dzienne lepiej
 * niż rozstęp od otwarcia do zamknięcia.
 */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const trueRanges: number[] = candles.map((candle, i) => {
    if (i === 0) return candle.highE8 - candle.lowE8;
    const previousClose = candles[i - 1]!.closeE8;
    return Math.max(
      candle.highE8 - candle.lowE8,
      Math.abs(candle.highE8 - previousClose),
      Math.abs(candle.lowE8 - previousClose),
    );
  });

  // Wygładzanie Wildera, nie zwykła średnia — tak zdefiniował to autor wskaźnika.
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return out;

  let running = trueRanges.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  out[period - 1] = running;

  for (let i = period; i < candles.length; i += 1) {
    running = (running * (period - 1) + trueRanges[i]!) / period;
    out[i] = running;
  }

  return out;
}

/**
 * Oscylator stochastyczny: położenie zamknięcia w zakresie ostatnich sesji.
 *
 * W odróżnieniu od RSI pyta nie o siłę zmian, lecz o to, w której części
 * ostatniego przedziału wahań kończy się dzień.
 */
export function stochastic(
  candles: Candle[],
  period = 14,
  smoothing = 3,
): { k: (number | null)[]; d: (number | null)[] } {
  const k: (number | null)[] = candles.map((_, i) => {
    if (i < period - 1) return null;

    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map((c) => c.highE8));
    const low = Math.min(...window.map((c) => c.lowE8));
    if (high === low) return 50;

    return ((candles[i]!.closeE8 - low) / (high - low)) * 100;
  });

  // %D to wygładzone %K — sam %K jest zbyt nerwowy, żeby cokolwiek z niego czytać.
  const defined = k.map((v) => v ?? 0);
  const smoothed = sma(defined, smoothing);
  const d = k.map((v, i) => (v === null ? null : (smoothed[i] ?? null)));

  return { k, d };
}

/**
 * Zmiana procentowa wobec sesji sprzed N dni (momentum).
 *
 * Prosta rzecz, której brakowało: „ile urosło przez miesiąc" jest pytaniem
 * zadawanym częściej niż o którykolwiek oscylator.
 */
export function rateOfChange(values: number[], period: number): (number | null)[] {
  return values.map((value, i) => {
    if (i < period) return null;
    const past = values[i - period]!;
    return past === 0 ? null : ((value - past) / past) * 100;
  });
}

/**
 * Bilans wolumenu (OBV): wolumen dodawany w dni wzrostowe, odejmowany w spadkowe.
 *
 * Rozbieżność między OBV a ceną bywa pierwszą wskazówką, że ruch nie ma
 * pokrycia w obrocie.
 */
export function onBalanceVolume(candles: Candle[]): (number | null)[] {
  let running = 0;

  return candles.map((candle, i) => {
    if (i === 0) return 0;
    const previous = candles[i - 1]!.closeE8;
    if (candle.closeE8 > previous) running += candle.volume ?? 0;
    else if (candle.closeE8 < previous) running -= candle.volume ?? 0;
    return running;
  });
}
