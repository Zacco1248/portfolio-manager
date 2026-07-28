import { minorToDisplay, qtyToDisplay, priceToDisplay } from '@portfolio/shared';

/**
 * Formatowanie do prezentacji. Wszystkie wejścia to liczby całkowite w skali
 * zdefiniowanej w `shared/money.ts` — konwersja na liczby zmiennoprzecinkowe
 * następuje dopiero tutaj i nigdy nie wraca do obliczeń.
 */

const plnFormatter = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  maximumFractionDigits: 0,
});

export function formatPln(minor: number, options: { compact?: boolean; sign?: boolean } = {}): string {
  const value = minorToDisplay(minor);
  const formatted = options.compact && Math.abs(value) >= 100_000
    ? compactFormatter.format(value)
    : plnFormatter.format(value);
  return options.sign && value > 0 ? `+${formatted}` : formatted;
}

export function formatCurrency(minor: number, currency: string, options: { sign?: boolean } = {}): string {
  const value = minorToDisplay(minor, currency);
  const formatted = new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return options.sign && value > 0 ? `+${formatted}` : formatted;
}

/** Punkty bazowe → procent. Zwraca kreskę dla braku danych, nie „0%”. */
export function formatPercent(bp: number | null | undefined, options: { sign?: boolean; digits?: number } = {}): string {
  if (bp === null || bp === undefined) return '—';
  const value = bp / 100;
  const formatted = new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: options.digits ?? 2,
    maximumFractionDigits: options.digits ?? 2,
  }).format(value);
  return `${options.sign && value > 0 ? '+' : ''}${formatted}%`;
}

export function formatQuantity(qtyE8: number): string {
  const value = qtyToDisplay(qtyE8);
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 8 }).format(value);
}

export function formatPrice(priceE8: number | null, currency: string): string {
  if (priceE8 === null) return '—';
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: currency === 'PLN' ? 2 : 4,
  }).format(priceToDisplay(priceE8));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10).split('-').reverse().join('.');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/** Klasa koloru dla wartości zysk/strata. Zero jest neutralne, nie zielone. */
export function toneClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-content-secondary';
  return value > 0 ? 'text-gain' : 'text-loss';
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs)) return '—';

  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'przed chwilą';
  if (minutes < 60) return `${minutes} min temu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} godz. temu`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} dni temu`;
  return formatDate(iso);
}


/**
 * Szacunkowy koszt wywołania modelu.
 *
 * Pojedyncze wywołanie kosztuje ułamek centa, więc zaokrąglenie do centów
 * pokazywałoby wszędzie zero. Poniżej centa schodzimy więc na cztery miejsca.
 */
export function formatCost(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return 'koszt nieznany';
  if (microUsd === 0) return '< 0,0001 $';

  const usd = microUsd / 1_000_000;
  return usd < 0.01 ? `${usd.toFixed(4)} $` : `${usd.toFixed(2)} $`;
}
