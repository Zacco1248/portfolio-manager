import { toPrice } from '@portfolio/shared';
import { config } from '../config.js';
import { fromDate } from '../lib/dates.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { splitSymbol } from './types.js';
import type { PriceProvider, ProviderCandle, ProviderInstrument, ProviderQuote } from './types.js';

const log = createLogger('provider:coingecko');

const BASE = 'https://api.coingecko.com/api/v3';

/**
 * Mapowanie popularnych tickerów na identyfikatory CoinGecko. Dla monet spoza
 * listy użytkownik podaje id wprost w polu `providerSymbol` instrumentu.
 */
const COIN_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  SOL: 'solana',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LTC: 'litecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  ATOM: 'cosmos',
  XMR: 'monero',
  TRX: 'tron',
};

export function toCoinId(instrument: ProviderInstrument): string | null {
  if (instrument.provider === 'coingecko' && instrument.providerSymbol) return instrument.providerSymbol;
  const { ticker } = splitSymbol(instrument.symbol);
  return COIN_IDS[ticker.toUpperCase()] ?? null;
}

/**
 * CoinGecko wycenia bezpośrednio w PLN, więc dla krypto pomijamy przeliczanie
 * przez USD i unikamy podwójnego zaokrąglenia.
 */
export const coingeckoProvider: PriceProvider = {
  id: 'coingecko',
  name: 'CoinGecko',

  supports(instrument) {
    return instrument.assetClass === 'crypto' && toCoinId(instrument) !== null;
  },

  async getQuote(instrument): Promise<ProviderQuote | null> {
    const id = toCoinId(instrument);
    if (!id) return null;

    const vs = instrument.currency.toLowerCase();
    const url = `${BASE}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${vs}&include_24hr_change=true&precision=full`;
    const data = await fetchJson<Record<string, Record<string, number>>>(url, { minIntervalMs: 1500 });

    const entry = data[id];
    const price = entry?.[vs];
    if (price === undefined) {
      log.debug(`CoinGecko nie zna pary ${id}/${vs}`);
      return null;
    }

    // Zmianę 24h dostajemy w procentach — przeliczamy ją z powrotem na
    // poprzednią cenę, żeby reszta aplikacji miała jednolity `prevClose`.
    const change24h = entry?.[`${vs}_24h_change`];
    const prevClose =
      change24h === undefined || change24h <= -100 ? null : price / (1 + change24h / 100);

    return {
      priceE8: toPrice(price),
      currency: instrument.currency.toUpperCase(),
      ts: new Date().toISOString(),
      prevCloseE8: prevClose === null ? null : toPrice(prevClose),
    };
  },

  async getHistory(instrument, from, to): Promise<ProviderCandle[]> {
    const id = toCoinId(instrument);
    if (!id) return [];

    const vs = instrument.currency.toLowerCase();
    const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
    const url = `${BASE}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=${vs}&from=${fromTs}&to=${toTs}`;

    const data = await fetchJson<{ prices: [number, number][] }>(url, { minIntervalMs: 2000 });

    // Krypto handluje się non stop; bierzemy ostatni punkt z każdego dnia
    // jako odpowiednik kursu zamknięcia.
    const byDate = new Map<string, number>();
    for (const [ms, price] of data.prices ?? []) {
      byDate.set(fromDate(new Date(ms)), price);
    }

    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, price]) => ({
        date,
        openE8: null,
        highE8: null,
        lowE8: null,
        closeE8: toPrice(price),
        volume: null,
      }));
  },
};

/** Klasa krypto wyceniana jest w walucie bazowej portfela, nie w USD. */
export const cryptoQuoteCurrency = config.baseCurrency;
