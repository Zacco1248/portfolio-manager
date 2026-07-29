import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson, fetchText } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('yahoo-summary');

/**
 * Konsensus analityków z modułu `quoteSummary` Yahoo.
 *
 * Reszta integracji z Yahoo celowo omija ten moduł — stoi za mechanizmem
 * crumb, czyli tokenem wydawanym razem z ciasteczkiem sesji. Tutaj świadomie
 * ten mechanizm obsługujemy, bo daje jedyne źródło prawdziwych cen docelowych
 * dla spółek zagranicznych: odczyt z polskich nagłówków prasowych działa
 * wyłącznie dla GPW.
 *
 * Konsekwencje, z którymi trzeba się liczyć:
 *  - to nieudokumentowany endpoint i Yahoo może go zmienić bez ostrzeżenia,
 *  - dlatego cała ścieżka jest opcjonalna, domyślnie wyłączona, a każdy błąd
 *    kończy się zejściem do odczytu z nagłówków, nie awarią.
 */

const HOST = 'https://query2.finance.yahoo.com';
const CRUMB_URL = `${HOST}/v1/test/getcrumb`;
const COOKIE_URL = 'https://fc.yahoo.com';

const BROWSER_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
};

interface Session {
  cookie: string;
  crumb: string;
  obtainedAt: number;
}

let session: Session | null = null;

/** Sesja Yahoo bywa ważna godzinami; odnawiamy ją co godzinę z zapasem. */
const SESSION_TTL_MS = 60 * 60 * 1000;

async function getSession(): Promise<Session | null> {
  if (session && Date.now() - session.obtainedAt < SESSION_TTL_MS) return session;

  try {
    // Pierwsze żądanie służy wyłącznie zdobyciu ciasteczka; treść nas nie obchodzi.
    const response = await fetch(COOKIE_URL, { headers: BROWSER_HEADERS, redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) return null;

    const cookie = setCookie.split(';')[0] ?? '';
    const crumb = await fetchText(CRUMB_URL, {
      headers: { ...BROWSER_HEADERS, Cookie: cookie },
      retries: 1,
      minIntervalMs: 400,
    });

    // Yahoo przy odmowie zwraca stronę HTML zamiast krótkiego tokenu.
    if (!crumb || crumb.length > 32 || crumb.includes('<')) return null;

    session = { cookie, crumb, obtainedAt: Date.now() };
    return session;
  } catch (err) {
    log.debug(`Nie udało się otworzyć sesji Yahoo: ${errorMessage(err)}`);
    return null;
  }
}

interface QuoteSummaryResponse {
  quoteSummary?: {
    result?: {
      financialData?: {
        currentPrice?: { raw?: number };
        targetMeanPrice?: { raw?: number };
        targetHighPrice?: { raw?: number };
        targetLowPrice?: { raw?: number };
        numberOfAnalystOpinions?: { raw?: number };
        recommendationKey?: string;
        financialCurrency?: string;
      };
      recommendationTrend?: {
        trend?: { period?: string; strongBuy?: number; buy?: number; hold?: number; sell?: number; strongSell?: number }[];
      };
      price?: { currency?: string };
    }[];
    error?: unknown;
  };
}

export interface AnalystSummary {
  targetMeanE8: number | null;
  targetHighE8: number | null;
  targetLowE8: number | null;
  analystCount: number | null;
  /** Zalecenie zbiorcze u dostawcy: buy, hold, underperform… */
  recommendationKey: string | null;
  currency: string | null;
  /** Rozkład zaleceń w bieżącym okresie. */
  distribution: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
}

const toE8 = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100_000_000) : null;

/**
 * Konsensus analityków dla symbolu w notacji Yahoo (`NVDA`, `CDR.WA`).
 * `null` oznacza brak danych albo niedostępność mechanizmu — wołający ma wtedy
 * użyć odczytu z nagłówków.
 */
export async function fetchAnalystSummary(yahooSymbol: string): Promise<AnalystSummary | null> {
  if (config.prices.disableExternalFetch) return null;

  const current = await getSession();
  if (!current) return null;

  const url =
    `${HOST}/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}` +
    `?modules=financialData,recommendationTrend,price&crumb=${encodeURIComponent(current.crumb)}`;

  try {
    const data = await fetchJson<QuoteSummaryResponse>(url, {
      headers: { ...BROWSER_HEADERS, Cookie: current.cookie },
      retries: 1,
      minIntervalMs: 600,
    });

    const result = data.quoteSummary?.result?.[0];
    const financial = result?.financialData;
    if (!financial) return null;

    const trend = result?.recommendationTrend?.trend?.[0];

    return {
      targetMeanE8: toE8(financial.targetMeanPrice?.raw),
      targetHighE8: toE8(financial.targetHighPrice?.raw),
      targetLowE8: toE8(financial.targetLowPrice?.raw),
      analystCount: financial.numberOfAnalystOpinions?.raw ?? null,
      recommendationKey: financial.recommendationKey ?? null,
      // Cena docelowa jest w walucie notowania, nie sprawozdań finansowych.
      currency: result?.price?.currency ?? financial.financialCurrency ?? null,
      distribution: trend
        ? {
            strongBuy: trend.strongBuy ?? 0,
            buy: trend.buy ?? 0,
            hold: trend.hold ?? 0,
            sell: trend.sell ?? 0,
            strongSell: trend.strongSell ?? 0,
          }
        : null,
    };
  } catch (err) {
    // Unieważniamy sesję: najczęstszą przyczyną błędu jest wygasły crumb.
    session = null;
    log.debug(`Konsensus ${yahooSymbol} niedostępny: ${errorMessage(err)}`);
    return null;
  }
}
