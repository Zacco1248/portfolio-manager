import { toPrice } from '@portfolio/shared';
import { fromDate } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import type { PriceProvider, ProviderCandle, ProviderInstrument, ProviderQuote } from './types.js';
import { perOunceToUnit } from './units.js';
import { splitSymbol } from './types.js';

const log = createLogger('provider:yahoo');

/**
 * Nieoficjalne API wykresów Yahoo Finance. Jedyne darmowe źródło bez klucza,
 * które obsługuje jednocześnie GPW, giełdy zagraniczne, indeksy i kontrakty
 * na metale. Format bywa zmieniany bez zapowiedzi, dlatego każdy odczyt jest
 * defensywny, a rejestr dostawców ma fallback.
 */
/**
 * Dwa równoważne hosty tego samego API. Awarie bywają jednostronne, więc przy
 * błędzie pierwszego próbujemy drugiego, zanim uznamy brak danych.
 */
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const CHART_PATH = '/v8/finance/chart';

/** Mapowanie naszych prefiksów rynków na sufiksy Yahoo. */
const MARKET_SUFFIX: Record<string, string> = {
  WSE: '.WA',
  GPW: '.WA',
  LON: '.L',
  LSE: '.L',
  FRA: '.DE',
  XETRA: '.DE',
  GER: '.DE',
  CPH: '.CO',
  STO: '.ST',
  OSL: '.OL',
  HEL: '.HE',
  AMS: '.AS',
  PAR: '.PA',
  MIL: '.MI',
  MAD: '.MC',
  SWX: '.SW',
  VIE: '.VI',
  LIS: '.LS',
  TSE: '.TO',
  HKG: '.HK',
  TYO: '.T',
  // Rynki amerykańskie nie mają sufiksu.
  NASDAQ: '',
  NYSE: '',
  NYSEARCA: '',
  AMEX: '',
  BATS: '',
  US: '',
};

/**
 * Kontrakty terminowe używane jako proxy ceny spot metali.
 *
 * Wszystkie są kwotowane w USD za uncję trojańską, więc dla pozycji
 * prowadzonych w gramach albo kilogramach cena musi zostać przeliczona
 * na jednostkę instrumentu — inaczej wycena jest zawyżona ponad 31-krotnie.
 */
const METAL_SYMBOLS: Record<string, string> = {
  XAU: 'GC=F',
  GOLD: 'GC=F',
  ZLOTO: 'GC=F',
  XAG: 'SI=F',
  SILVER: 'SI=F',
  SREBRO: 'SI=F',
  XPT: 'PL=F',
  XPD: 'PA=F',
};

export function toYahooSymbol(instrument: ProviderInstrument): string | null {
  if (instrument.provider === 'yahoo' && instrument.providerSymbol) return instrument.providerSymbol;

  const { market, ticker } = splitSymbol(instrument.symbol);

  if (instrument.assetClass === 'metal') {
    return METAL_SYMBOLS[ticker.toUpperCase()] ?? null;
  }

  if (market === null) {
    // Bez prefiksu zakładamy rynek amerykański — tam tickery są bez sufiksu.
    return ticker;
  }

  const suffix = MARKET_SUFFIX[market];
  if (suffix === undefined) return null;
  return `${ticker}${suffix}`;
}

interface YahooMeta {
  currency: string | null;
  symbol: string;
  regularMarketPrice: number | null;
  chartPreviousClose?: number | null;
  previousClose?: number | null;
  regularMarketTime: number | null;
  instrumentType?: string;
}

interface YahooChartResponse {
  chart: {
    result:
      | {
          meta: YahooMeta;
          timestamp?: number[];
          indicators: {
            quote?: {
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }[];
          };
        }[]
      | null;
    error: { code: string; description: string } | null;
  };
}

async function fetchChart(symbol: string, range: string, interval = '1d'): Promise<YahooChartResponse> {
  const query = `${CHART_PATH}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let lastError: unknown;

  for (const host of HOSTS) {
    try {
      return await fetchJson<YahooChartResponse>(`${host}${query}`, {
        // Yahoo bywa wybredne wobec klientów bez przeglądarkowych nagłówków.
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        minIntervalMs: 400,
        retries: 1,
      });
    } catch (err) {
      lastError = err;
      log.debug(`${host} nie odpowiedział dla ${symbol}, próbuję kolejnego hosta`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Yahoo nie odpowiedział dla ${symbol}`);
}

/**
 * Yahoo dla nieznanych tickerów zwraca atrapę: `currency: null`, typ MUTUALFUND
 * i znacznik czasu sprzed lat, zamiast błędu. Bez tej kontroli zapisalibyśmy
 * jako cenę bieżącą notowanie z 2019 roku.
 */
function isStaleStub(meta: YahooMeta): boolean {
  if (meta.currency === null) return true;
  if (meta.regularMarketPrice === null) return true;
  if (meta.regularMarketTime !== null) {
    const ageDays = (Date.now() / 1000 - meta.regularMarketTime) / 86_400;
    if (ageDays > 30) return true;
  }
  return false;
}

export const yahooProvider: PriceProvider = {
  id: 'yahoo',
  name: 'Yahoo Finance',

  supports(instrument) {
    if (instrument.assetClass === 'cash') return false;
    if (instrument.assetClass === 'crypto') return false;
    return toYahooSymbol(instrument) !== null;
  },

  async getQuote(instrument): Promise<ProviderQuote | null> {
    const symbol = toYahooSymbol(instrument);
    if (!symbol) return null;

    const data = await fetchChart(symbol, '5d');
    const result = data.chart.result?.[0];
    if (!result) {
      log.debug(`Brak danych dla ${symbol}: ${data.chart.error?.description ?? 'nieznany powód'}`);
      return null;
    }

    const { meta } = result;
    if (isStaleStub(meta)) {
      log.warn(`Yahoo zwrócił nieaktualny rekord dla ${symbol} — traktuję jako brak ceny`);
      return null;
    }

    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    // Dla metali kwotowanie jest za uncję trojańską niezależnie od tego,
    // w czym użytkownik prowadzi pozycję.
    const toUnit = (value: number): number =>
      instrument.assetClass === 'metal' ? perOunceToUnit(value, instrument.unit) : value;

    return {
      priceE8: toUnit(toPrice(meta.regularMarketPrice!)),
      currency: (meta.currency ?? instrument.currency).toUpperCase(),
      ts: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      prevCloseE8: prevClose === null ? null : toUnit(toPrice(prevClose)),
    };
  },

  async getHistory(instrument, from, to): Promise<ProviderCandle[]> {
    const symbol = toYahooSymbol(instrument);
    if (!symbol) return [];

    const data = await fetchChart(symbol, rangeFor(from, to));
    const result = data.chart.result?.[0];
    if (!result?.timestamp) return [];
    if (isStaleStub(result.meta)) return [];

    const quote = result.indicators.quote?.[0];
    const candles: ProviderCandle[] = [];
    const toUnit = (value: number | null): number | null =>
      value !== null && instrument.assetClass === 'metal' ? perOunceToUnit(value, instrument.unit) : value;

    for (let i = 0; i < result.timestamp.length; i += 1) {
      const close = quote?.close?.[i];
      // Dni bez obrotu Yahoo oddaje jako null — pomijamy zamiast wpisywać zero.
      if (close === null || close === undefined) continue;

      const date: IsoDate = fromDate(new Date(result.timestamp[i]! * 1000));
      if (date < from || date > to) continue;

      candles.push({
        date,
        openE8: toUnit(nullablePrice(quote?.open?.[i])),
        highE8: toUnit(nullablePrice(quote?.high?.[i])),
        lowE8: toUnit(nullablePrice(quote?.low?.[i])),
        closeE8: toUnit(toPrice(close))!,
        volume: quote?.volume?.[i] ?? null,
      });
    }

    return candles;
  },
};

function nullablePrice(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : toPrice(v);
}

/** Yahoo przyjmuje zakresy słowne; dobieramy najmniejszy pokrywający okres. */
function rangeFor(from: IsoDate, to: IsoDate): string {
  const days = Math.ceil((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
  if (days <= 5) return '5d';
  if (days <= 31) return '1mo';
  if (days <= 93) return '3mo';
  if (days <= 186) return '6mo';
  if (days <= 370) return '1y';
  if (days <= 740) return '2y';
  if (days <= 1850) return '5y';
  if (days <= 3700) return '10y';
  return 'max';
}
