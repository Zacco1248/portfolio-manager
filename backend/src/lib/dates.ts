/**
 * Wszystkie daty kalendarzowe trzymamy jako string 'YYYY-MM-DD' w czasie
 * lokalnym strefy aplikacji. Operacje na obiektach Date robimy w UTC-południe,
 * żeby przesunięcia czasu letniego nigdy nie przesunęły dnia o jeden.
 */

export type IsoDate = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is IsoDate {
  return typeof v === 'string' && DATE_RE.test(v);
}

export function today(timeZone = 'Europe/Warsaw'): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parsowanie do UTC-południa — bezpieczne dla arytmetyki dni. */
export function toDate(date: IsoDate): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

export function fromDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDate(d);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = toDate(date);
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Zachowanie dnia miesiąca z korektą dla krótszych miesięcy (31.01 + 1m = 28/29.02).
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return fromDate(d);
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

export function monthOf(date: IsoDate): number {
  return Number(date.slice(5, 7));
}

/** Poniedziałek–piątek. Nie uwzględnia świąt — NBP i tak zwróci ostatni dostępny kurs. */
export function isWeekend(date: IsoDate): boolean {
  const day = toDate(date).getUTCDay();
  return day === 0 || day === 6;
}

/** Poprzedni dzień roboczy — podstawa kursu D-1 do celów podatkowych. */
export function previousBusinessDay(date: IsoDate): IsoDate {
  let d = addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Lista dni (włącznie) — do uzupełniania luk w seriach czasowych. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Ułamek roku wg konwencji ACT/365 — używany w XIRR.
 * Prosty i zgodny z tym, co liczy Excel dla funkcji XIRR.
 */
export function yearFraction(from: IsoDate, to: IsoDate): number {
  return daysBetween(from, to) / 365;
}

/** Normalizacja dat z importów: '29/09/2025', '2025-09-29', '29.09.2025', Date. */
export function normalizeDate(input: string | Date | number | null | undefined): IsoDate | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    // Excel oddaje daty w UTC — bierzemy komponenty UTC, żeby nie cofnąć dnia.
    return `${input.getUTCFullYear()}-${String(input.getUTCMonth() + 1).padStart(2, '0')}-${String(
      input.getUTCDate(),
    ).padStart(2, '0')}`;
  }
  if (typeof input === 'number') {
    // Numer seryjny Excela: dni od 1899-12-30.
    const ms = Math.round(input) * 86_400_000 + Date.UTC(1899, 11, 30);
    return fromDate(new Date(ms));
  }

  const s = input.trim();
  if (DATE_RE.test(s)) return s;

  // Numer seryjny Excela, który po drodze zamienił się w tekst. Zakres
  // odpowiada latom 1954-2091 — poza nim ciąg cyfr to na pewno nie data.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 20_000 && serial <= 70_000) return normalizeDate(serial);
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD/MM/YYYY lub DD.MM.YYYY, opcjonalnie z godziną (format eksportów XTB).
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
  if (m) {
    const [, dd, mm, yyyy] = m as unknown as [string, string, string, string];
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : fromDate(parsed);
}
