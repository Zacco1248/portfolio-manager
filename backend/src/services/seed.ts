import { db } from '../db/index.js';
import { instruments, portfolios, settings } from '../db/schema.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('seed');

/**
 * Minimalny zestaw danych startowych. Wołane przy każdym starcie, ale
 * wstawia tylko brakujące rekordy — nigdy nie nadpisuje niczego, co
 * użytkownik zdążył zmienić.
 */
export function seedDefaults(): void {
  seedPortfolio();
  seedCashInstruments();
  seedSettings();
}

function seedPortfolio(): void {
  const count = db.select().from(portfolios).all().length;
  if (count > 0) return;
  db.insert(portfolios)
    .values({ name: 'Główny', kind: 'Główny', taxRegime: 'taxable', baseCurrency: 'PLN', sortOrder: 1 })
    .run();
  log.info('Utworzono domyślny portfel "Główny"');
}

/**
 * Gotówka w każdej walucie jest zwykłym instrumentem klasy `cash` o cenie 1.
 * Dzięki temu wpłaty i salda walutowe przechodzą przez tę samą ścieżkę wyceny
 * co reszta pozycji, zamiast być osobnym przypadkiem w każdej kalkulacji.
 */
const CASH_CURRENCIES = ['PLN', 'USD', 'EUR', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK', 'CZK'] as const;

function seedCashInstruments(): void {
  const existing = new Set(db.select().from(instruments).all().map((i) => i.symbol));
  const missing = CASH_CURRENCIES.filter((c) => !existing.has(`CASH:${c}`));
  if (missing.length === 0) return;

  db.insert(instruments)
    .values(
      missing.map((currency) => ({
        symbol: `CASH:${currency}`,
        name: `Gotówka ${currency}`,
        assetClass: 'cash',
        currency,
        provider: 'static',
        providerSymbol: currency,
      })),
    )
    .run();
  log.info(`Dodano instrumenty gotówkowe: ${missing.join(', ')}`);
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  theme: 'dark',
  concentrationInstrumentBp: 1500, // ostrzeżenie gdy pojedyncza pozycja > 15%
  concentrationSectorBp: 3500, // ostrzeżenie gdy sektor > 35%
  etfOverlapBp: 3000, // ostrzeżenie gdy dwa ETF-y pokrywają się > 30%
  dailyMoveThresholdBp: 500, // alert przy zmianie dziennej > 5%
  defaultRebalanceMode: 'buy_only',
  benchmarks: ['WIG', 'SP500'],
  notifications: {
    news: true,
    allocation_drift: true,
    price: true,
    technical: false,
    daily_move: true,
    report_date: true,
    concentration: true,
  },
};

function seedSettings(): void {
  const existing = new Set(db.select().from(settings).all().map((s) => s.key));
  const missing = Object.entries(DEFAULT_SETTINGS).filter(([key]) => !existing.has(key));
  if (missing.length === 0) return;
  db.insert(settings)
    .values(missing.map(([key, value]) => ({ key, value })))
    .run();
  log.info(`Uzupełniono ustawienia domyślne: ${missing.map(([k]) => k).join(', ')}`);
}
