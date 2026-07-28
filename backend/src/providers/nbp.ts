import { PRICE_SCALE } from '@portfolio/shared';
import { addDays, today } from '../lib/dates.js';
import { config } from '../config.js';
import { getNbpGoldPrice } from '../services/fx.js';
import { perGramToUnit } from './units.js';
import { splitSymbol } from './types.js';
import type { PriceProvider, ProviderCandle, ProviderInstrument, ProviderQuote } from './types.js';

const ONE_E8 = Number(PRICE_SCALE);

/** Symbole złota, dla których NBP publikuje cenę (PLN za gram próby 1000). */
const GOLD_TICKERS = new Set(['XAU', 'GOLD', 'ZLOTO', 'ZŁOTO']);

/**
 * NBP jako dostawca ceny złota. Publikuje cenę w PLN za gram, więc dla pozycji
 * prowadzonych w gramach jest dokładniejszy niż przeliczanie kontraktu
 * terminowego w USD za uncję przez kurs walutowy.
 */
export const nbpGoldProvider: PriceProvider = {
  id: 'nbp-gold',
  name: 'NBP (cena złota)',

  supports(instrument) {
    if (instrument.assetClass !== 'metal') return false;
    if (instrument.currency.toUpperCase() !== 'PLN') return false;
    const { ticker } = splitSymbol(instrument.symbol);
    return GOLD_TICKERS.has(ticker.toUpperCase());
  },

  async getQuote(instrument): Promise<ProviderQuote | null> {
    const date = today(config.timezone);
    const priceE8 = await getNbpGoldPrice(date);
    if (priceE8 === null) return null;

    const prevE8 = await getNbpGoldPrice(addDays(date, -1));

    // NBP podaje cenę za gram próby 1000; przeliczamy na jednostkę pozycji.
    return {
      priceE8: perGramToUnit(priceE8, instrument.unit),
      currency: 'PLN',
      ts: new Date().toISOString(),
      prevCloseE8: prevE8 === null ? null : perGramToUnit(prevE8, instrument.unit),
    };
  },

  async getHistory(): Promise<ProviderCandle[]> {
    // Historia cen złota nie jest potrzebna do wyceny bieżącej, a NBP wymaga
    // odpytywania dzień po dniu. Wykres historyczny bierzemy z Yahoo (GC=F).
    return [];
  },
};

/**
 * Gotówka: cena zawsze 1 jednostka waluty. Dzięki temu salda walutowe
 * przechodzą tą samą ścieżką wyceny co reszta pozycji, a przewalutowanie
 * robi wspólna warstwa kursów.
 */
export const cashProvider: PriceProvider = {
  id: 'static',
  name: 'Gotówka (kurs stały 1:1)',

  supports(instrument) {
    return instrument.assetClass === 'cash';
  },

  async getQuote(instrument): Promise<ProviderQuote> {
    return {
      priceE8: ONE_E8,
      currency: instrument.currency.toUpperCase(),
      ts: new Date().toISOString(),
      prevCloseE8: ONE_E8,
    };
  },

  async getHistory(): Promise<ProviderCandle[]> {
    return [];
  },
};
