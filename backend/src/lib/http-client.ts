import { config } from '../config.js';
import { serviceUnavailable } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('http-client');

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Minimalny odstęp między requestami do tego hosta. */
  minIntervalMs?: number;
  method?: 'GET' | 'POST';
  /** Ciało żądania; obiekt jest serializowany do JSON-a. */
  body?: unknown;
}

const DEFAULTS = { timeoutMs: 12_000, retries: 3, minIntervalMs: 250 };

/**
 * Kolejkowanie per host. Publiczne API (Stooq, CoinGecko) mają limity zapytań
 * i potrafią zwrócić 429 albo po prostu uciąć połączenie, jeśli walnąć w nie
 * kilkudziesięcioma requestami naraz przy odświeżaniu cen całego portfela.
 */
const hostQueues = new Map<string, Promise<unknown>>();

function throttleByHost<T>(url: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const host = safeHost(url);
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const result = await fn();
      await sleep(minIntervalMs);
      return result;
    });
  hostQueues.set(
    host,
    next.catch(() => undefined),
  );
  return next;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Kody, przy których ponawianie ma sens. 404 czy 400 nie naprawi się samo. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, options);
  return (await response.json()) as T;
}

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  if (config.prices.disableExternalFetch) {
    throw serviceUnavailable('Pobieranie danych zewnętrznych jest wyłączone (DISABLE_EXTERNAL_FETCH=true)');
  }

  const { timeoutMs, retries, minIntervalMs } = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // Wykładniczy backoff z losowym rozrzutem, żeby kilka instrumentów
      // odbijających się od 429 nie wracało dokładnie w tym samym momencie.
      const delay = Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.random() * 250;
      log.debug(`Ponawiam ${url} (próba ${attempt + 1}) za ${Math.round(delay)} ms`);
      await sleep(delay);
    }

    try {
      const response = await throttleByHost(url, minIntervalMs, () => doFetch(url, timeoutMs, options));

      if (response.ok) return response;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        throw new Error(`HTTP ${response.status} ${response.statusText} dla ${url}`);
      }
      lastError = new Error(`HTTP ${response.status} dla ${url}`);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Nie udało się pobrać ${url}`);
}

async function doFetch(url: string, timeoutMs: number, options: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hasBody = options.body !== undefined;

  try {
    return await fetch(url, {
      method: options.method ?? (hasBody ? 'POST' : 'GET'),
      signal: controller.signal,
      headers: {
        // Część darmowych endpointów odrzuca requesty bez User-Agenta.
        'User-Agent': 'portfolio-manager/0.1 (self-hosted)',
        Accept: '*/*',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(hasBody ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {}),
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}
