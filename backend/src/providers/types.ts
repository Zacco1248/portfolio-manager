import type { AssetClass } from '@portfolio/shared';
import type { IsoDate } from '../lib/dates.js';

/** Instrument w postaci, jakiej potrzebuje dostawca — bez zależności od schematu bazy. */
export interface ProviderInstrument {
  id: number;
  symbol: string;
  assetClass: AssetClass;
  currency: string;
  exchange: string | null;
  provider: string | null;
  providerSymbol: string | null;
  unit: string | null;
}

export interface ProviderQuote {
  priceE8: number;
  currency: string;
  ts: string;
  /** Poprzednie zamknięcie, jeśli dostawca je podaje — inaczej liczymy z historii. */
  prevCloseE8: number | null;
}

export interface ProviderCandle {
  date: IsoDate;
  openE8: number | null;
  highE8: number | null;
  lowE8: number | null;
  closeE8: number;
  volume: number | null;
}

/**
 * Wspólny kontrakt dostawcy cen. Dodanie nowego źródła sprowadza się do
 * implementacji tego interfejsu i dopisania go do rejestru — żaden istniejący
 * kod nie wymaga zmian.
 */
export interface PriceProvider {
  readonly id: string;
  readonly name: string;
  /** Czy dostawca potrafi obsłużyć dany instrument. */
  supports(instrument: ProviderInstrument): boolean;
  getQuote(instrument: ProviderInstrument): Promise<ProviderQuote | null>;
  getHistory(instrument: ProviderInstrument, from: IsoDate, to: IsoDate): Promise<ProviderCandle[]>;
}

/** Symbol używany przez dostawcę; jeśli instrument ma alias, ma on pierwszeństwo. */
export function resolveSymbol(instrument: ProviderInstrument, fallback: (symbol: string) => string): string {
  if (instrument.provider && instrument.providerSymbol) return instrument.providerSymbol;
  return fallback(instrument.symbol);
}

/**
 * Symbol wewnętrzny ma postać `GIEŁDA:TICKER` (np. `WSE:XTB`, `LON:IUIT`).
 * Ta funkcja rozbija go na części, tolerując zapis bez prefiksu.
 */
export function splitSymbol(symbol: string): { market: string | null; ticker: string } {
  const idx = symbol.indexOf(':');
  if (idx === -1) return { market: null, ticker: symbol };
  return { market: symbol.slice(0, idx).toUpperCase(), ticker: symbol.slice(idx + 1) };
}
