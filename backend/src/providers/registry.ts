import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { providerHealth } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { coingeckoProvider } from './coingecko.js';
import { cashProvider, nbpGoldProvider } from './nbp.js';
import type { PriceProvider, ProviderCandle, ProviderInstrument, ProviderQuote } from './types.js';
import { yahooProvider } from './yahoo.js';

const log = createLogger('providers');

/**
 * Kolejność ma znaczenie — pierwszy dostawca, który deklaruje obsługę
 * instrumentu, jest pytany jako pierwszy; reszta służy za fallback.
 *
 * Uwaga: Stooq, wskazany pierwotnie jako źródło dla GPW, wypadł z zestawu.
 * Jego endpointy CSV są dziś za mechanizmem antybotowym (proof-of-work
 * w JavaScripcie), więc nie da się z nich korzystać programowo bez obchodzenia
 * zabezpieczenia. GPW pokrywa Yahoo przez sufiks `.WA`.
 */
const PROVIDERS: PriceProvider[] = [cashProvider, nbpGoldProvider, coingeckoProvider, yahooProvider];

/** Po tylu porażkach z rzędu dostawca jest wyłączany na `COOLDOWN_MINUTES`. */
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MINUTES = 30;

export function allProviders(): PriceProvider[] {
  return [...PROVIDERS];
}

export function providersFor(instrument: ProviderInstrument): PriceProvider[] {
  const supporting = PROVIDERS.filter((p) => p.supports(instrument));
  // Jawny wybór dostawcy na instrumencie ma pierwszeństwo przed kolejnością domyślną.
  if (instrument.provider) {
    const preferred = supporting.filter((p) => p.id === instrument.provider);
    const rest = supporting.filter((p) => p.id !== instrument.provider);
    return [...preferred, ...rest];
  }
  return supporting;
}

function isDisabled(providerId: string): boolean {
  const row = db.select().from(providerHealth).where(eq(providerHealth.id, providerId)).get();
  if (!row?.disabledUntil) return false;
  if (row.disabledUntil > nowIso()) return true;
  // Okres karencji minął — zerujemy licznik i próbujemy ponownie.
  db.update(providerHealth)
    .set({ disabledUntil: null, consecutiveFailures: 0 })
    .where(eq(providerHealth.id, providerId))
    .run();
  return false;
}

function recordSuccess(providerId: string): void {
  db.insert(providerHealth)
    .values({ id: providerId, lastSuccessAt: nowIso(), consecutiveFailures: 0 })
    .onConflictDoUpdate({
      target: providerHealth.id,
      set: { lastSuccessAt: nowIso(), consecutiveFailures: 0, disabledUntil: null, lastError: null },
    })
    .run();
}

function recordFailure(providerId: string, message: string): void {
  const current = db.select().from(providerHealth).where(eq(providerHealth.id, providerId)).get();
  const failures = (current?.consecutiveFailures ?? 0) + 1;
  const disabledUntil =
    failures >= FAILURE_THRESHOLD ? new Date(Date.now() + COOLDOWN_MINUTES * 60_000).toISOString() : null;

  db.insert(providerHealth)
    .values({
      id: providerId,
      lastErrorAt: nowIso(),
      lastError: message.slice(0, 500),
      consecutiveFailures: failures,
      disabledUntil,
    })
    .onConflictDoUpdate({
      target: providerHealth.id,
      set: {
        lastErrorAt: nowIso(),
        lastError: message.slice(0, 500),
        consecutiveFailures: failures,
        disabledUntil,
      },
    })
    .run();

  if (disabledUntil) {
    log.warn(`Dostawca ${providerId} wyłączony na ${COOLDOWN_MINUTES} min po ${failures} błędach z rzędu`);
  }
}

export interface QuoteResult {
  quote: ProviderQuote;
  providerId: string;
}

/**
 * Pobiera notowanie, przechodząc po dostawcach aż do pierwszego sukcesu.
 * Zwraca null, gdy żaden nie ma danych — to nie jest błąd, tylko informacja,
 * że pozycję trzeba wycenić ostatnią znaną ceną i oznaczyć jako nieświeżą.
 */
export async function fetchQuote(instrument: ProviderInstrument): Promise<QuoteResult | null> {
  const candidates = providersFor(instrument);
  if (candidates.length === 0) {
    log.debug(`Brak dostawcy dla ${instrument.symbol} (${instrument.assetClass})`);
    return null;
  }

  for (const provider of candidates) {
    if (isDisabled(provider.id)) continue;
    try {
      const quote = await provider.getQuote(instrument);
      if (quote) {
        recordSuccess(provider.id);
        return { quote, providerId: provider.id };
      }
      // Brak danych to nie awaria dostawcy — nie karzemy go licznikiem błędów.
      recordSuccess(provider.id);
    } catch (err) {
      const message = errorMessage(err);
      log.warn(`${provider.id} nie oddał ceny ${instrument.symbol}: ${message}`);
      recordFailure(provider.id, message);
    }
  }

  return null;
}

export async function fetchHistory(
  instrument: ProviderInstrument,
  from: IsoDate,
  to: IsoDate,
): Promise<{ candles: ProviderCandle[]; providerId: string } | null> {
  for (const provider of providersFor(instrument)) {
    if (isDisabled(provider.id)) continue;
    try {
      const candles = await provider.getHistory(instrument, from, to);
      if (candles.length > 0) {
        recordSuccess(provider.id);
        return { candles, providerId: provider.id };
      }
    } catch (err) {
      const message = errorMessage(err);
      log.warn(`${provider.id} nie oddał historii ${instrument.symbol}: ${message}`);
      recordFailure(provider.id, message);
    }
  }
  return null;
}
