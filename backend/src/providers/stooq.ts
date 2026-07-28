import { toPrice } from '@portfolio/shared';
import { fromDate, normalizeDate } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { fetchText } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import type { PriceProvider, ProviderCandle, ProviderInstrument, ProviderQuote } from './types.js';
import { splitSymbol } from './types.js';

const log = createLogger('provider:stooq');

/**
 * Stooq jako źródło zapasowe dla GPW.
 *
 * Endpointy `/q/l/` i `/q/d/l/` są dziś za mechanizmem antybotowym z zadaniem
 * proof-of-work w JavaScripcie i świadomie ich nie obchodzimy. Pozostaje
 * jednak publiczny endpoint `stooq.pl/q/l/?f=sd2t2ohlcv&e=csv` na innej
 * domenie, który bywa dostępny — a gdy nie jest, dostawca po prostu milczy
 * i rejestr sięga po kolejne źródło.
 *
 * Traktujemy go wyłącznie jako fallback po Yahoo: przy pustej odpowiedzi albo
 * treści HTML zamiast CSV zwracamy `null`, zamiast udawać, że mamy cenę.
 */

const BASE = 'https://stooq.com/q/l/';

/** Nasz prefiks rynku → sufiks Stooq. */
const MARKET_SUFFIX: Record<string, string> = {
  WSE: '',
  GPW: '',
  US: '.us',
  NASDAQ: '.us',
  NYSE: '.us',
  LON: '.uk',
  FRA: '.de',
};

export function toStooqSymbol(instrument: ProviderInstrument): string | null {
  if (instrument.provider === 'stooq' && instrument.providerSymbol) return instrument.providerSymbol;

  const { market, ticker } = splitSymbol(instrument.symbol);
  if (market === null) return null;

  const suffix = MARKET_SUFFIX[market];
  if (suffix === undefined) return null;

  return `${ticker.toLowerCase()}${suffix}`;
}

/** Wiersz CSV Stooq: symbol,data,czas,otwarcie,max,min,zamkniecie,wolumen. */
function parseQuoteCsv(csv: string): { date: IsoDate; close: number; open: number | null } | null {
  // Odpowiedź HTML oznacza stronę błędu albo challenge — nie jest to cena.
  if (csv.trimStart().startsWith('<')) return null;

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const cells = lines[1]!.split(',');
  if (cells.length < 7) return null;

  const date = normalizeDate(cells[1]);
  const close = Number(cells[6]);
  const open = Number(cells[3]);

  if (!date || !Number.isFinite(close) || close <= 0) return null;

  return { date, close, open: Number.isFinite(open) && open > 0 ? open : null };
}

export const stooqProvider: PriceProvider = {
  id: 'stooq',
  name: 'Stooq (zapasowe źródło)',

  supports(instrument) {
    if (instrument.assetClass === 'cash' || instrument.assetClass === 'crypto') return false;
    if (instrument.assetClass === 'metal') return false;
    return toStooqSymbol(instrument) !== null;
  },

  async getQuote(instrument): Promise<ProviderQuote | null> {
    const symbol = toStooqSymbol(instrument);
    if (!symbol) return null;

    const csv = await fetchText(`${BASE}?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`, {
      retries: 1,
      minIntervalMs: 800,
    });

    const parsed = parseQuoteCsv(csv);
    if (!parsed) {
      log.debug(`Stooq nie oddał notowania dla ${symbol}`);
      return null;
    }

    return {
      priceE8: toPrice(parsed.close),
      currency: instrument.currency.toUpperCase(),
      ts: `${parsed.date}T00:00:00.000Z`,
      // Stooq w tym endpoincie nie podaje poprzedniego zamknięcia.
      prevCloseE8: null,
    };
  },

  async getHistory(): Promise<ProviderCandle[]> {
    // Endpoint historyczny wymaga rozwiązania zadania antybotowego, więc
    // historię pobieramy wyłącznie z Yahoo. Fallback dotyczy ceny bieżącej.
    return [];
  },
};

/** Data ostatniej sesji — pomocnicze przy diagnozie świeżości danych. */
export const lastSessionDate = (): IsoDate => fromDate(new Date());
