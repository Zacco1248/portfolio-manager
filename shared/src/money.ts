/**
 * Arytmetyka pieniężna i ilościowa.
 *
 * Zasada nienaruszalna: żadna wartość pieniężna nie jest reprezentowana jako
 * liczba zmiennoprzecinkowa. Wszystko to liczby całkowite w ustalonej skali,
 * a mnożenie/dzielenie idzie przez BigInt, żeby nie zgubić precyzji na
 * iloczynach (qty × price potrafi przekroczyć zakres bezpiecznych liczb).
 *
 * Skale:
 *   - kwoty      → minor units waluty (grosze/centy), zwykle 10^2
 *   - ilości     → 10^8  (krypto ma 8 miejsc, metale w gramach też się mieszczą)
 *   - ceny       → 10^8  (w walucie instrumentu)
 *   - kursy FX   → 10^6  (NBP publikuje 4 miejsca, zapas na przeliczenia krzyżowe)
 *   - procenty   → punkty bazowe, 10^4 = 100%
 */

export const QTY_SCALE = 100_000_000n; // 1e8
export const PRICE_SCALE = 100_000_000n; // 1e8
export const FX_SCALE = 1_000_000n; // 1e6
export const BP_SCALE = 10_000n; // 100.00% = 10000 bp

export const QTY_DECIMALS = 8;
export const PRICE_DECIMALS = 8;
export const FX_DECIMALS = 6;

/** Waluty o innej niż 2 liczbie miejsc po przecinku. */
const MINOR_UNIT_OVERRIDES: Record<string, number> = {
  JPY: 0,
  HUF: 0,
  KRW: 0,
  CLP: 0,
  ISK: 0,
};

/** Liczba miejsc po przecinku dla waluty (domyślnie 2). */
export function minorDecimals(currency: string): number {
  return MINOR_UNIT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

/** 10^n jako BigInt. */
export function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`pow10: ujemny wykładnik ${n}`);
  return 10n ** BigInt(n);
}

/** Skala minor units dla waluty, np. PLN → 100n. */
export function minorScale(currency: string): bigint {
  return pow10(minorDecimals(currency));
}

/**
 * Dzielenie całkowite z zaokrągleniem połówek w górę co do wartości
 * bezwzględnej (half-up away from zero). Taka konwencja jest zgodna z tym,
 * jak zaokrągla polska skarbówka i większość biur maklerskich.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('divRound: dzielenie przez zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** (a × b) / d z jednym zaokrągleniem na końcu — bez pośredniej utraty precyzji. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return divRound(a * b, d);
}

/**
 * Parsuje liczbę dziesiętną do postaci całkowitej w zadanej skali,
 * bez przechodzenia przez `Number` — "0.2301" przy skali 1e8 daje dokładnie
 * 23010000, a nie 23009999.99999.
 *
 * Akceptuje formaty spotykane w importach: "1 234,56", "1,234.56", "-12.5", "1e3".
 */
export function parseDecimal(input: string | number | null | undefined, decimals: number): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError(`parseDecimal: ${input} nie jest liczbą skończoną`);
    // Przez string, żeby uniknąć błędu reprezentacji zmiennoprzecinkowej.
    return parseDecimal(input.toFixed(Math.min(decimals, 15)), decimals);
  }

  let s = input.trim();
  if (s === '') return 0;

  // Usuń spacje (także niełamliwe i wąskie) używane jako separator tysięcy.
  s = s.replace(/[\s   ]/g, '');
  // Notacja naukowa — bezpieczna tylko przez Number, ale to nie są kwoty z importu.
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new RangeError(`parseDecimal: nie umiem sparsować "${input}"`);
    return parseDecimal(n.toFixed(Math.min(decimals, 15)), decimals);
  }

  // Ujednolicenie separatora dziesiętnego: ostatni separator to część ułamkowa.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // Jeden przecinek: separator dziesiętny, chyba że wygląda na tysiące ("1,234").
    const frac = s.length - lastComma - 1;
    s = frac === 3 && /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const m = /^(-|\+)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new RangeError(`parseDecimal: nie umiem sparsować "${input}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] || '0';
  const fracRaw = m[3] || '';
  // Ucinamy nadmiarowe miejsca zamiast zaokrąglać — dane źródłowe nie mają
  // większej precyzji niż nasza skala, a zaokrąglenie tutaj maskowałoby błąd.
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const value = sign * (BigInt(intPart) * pow10(decimals) + BigInt(frac || '0'));
  return bigintToNumber(value);
}

/** Bezpieczna konwersja BigInt → number z kontrolą zakresu. */
export function bigintToNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Wartość ${v} wykracza poza bezpieczny zakres liczb JS`);
  }
  return Number(v);
}

export const toQty = (v: string | number | null | undefined): number => parseDecimal(v, QTY_DECIMALS);
export const toPrice = (v: string | number | null | undefined): number => parseDecimal(v, PRICE_DECIMALS);
export const toFx = (v: string | number | null | undefined): number => parseDecimal(v, FX_DECIMALS);
export const toMinor = (v: string | number | null | undefined, currency = 'PLN'): number =>
  parseDecimal(v, minorDecimals(currency));

/**
 * Wartość pozycji: ilość × cena → kwota w minor units waluty instrumentu.
 * qtyE8 × priceE8 daje 1e16, więc dzielimy przez 1e16 i mnożymy przez skalę waluty.
 */
export function positionValueMinor(qtyE8: number, priceE8: number, currency = 'PLN'): number {
  return bigintToNumber(mulDiv(BigInt(qtyE8) * BigInt(priceE8), minorScale(currency), QTY_SCALE * PRICE_SCALE));
}

/** Przewalutowanie kwoty: minor units waluty źródłowej × kurs → minor units PLN. */
export function convertMinor(
  amountMinor: number,
  fxRateE6: number,
  fromCurrency = 'PLN',
  toCurrency = 'PLN',
): number {
  const fromScale = minorScale(fromCurrency);
  const toScale = minorScale(toCurrency);
  return bigintToNumber(mulDiv(BigInt(amountMinor) * BigInt(fxRateE6), toScale, FX_SCALE * fromScale));
}

/** Udział procentowy w punktach bazowych: part / total. */
export function shareBp(partMinor: number, totalMinor: number): number {
  if (totalMinor === 0) return 0;
  return bigintToNumber(mulDiv(BigInt(partMinor), BP_SCALE, BigInt(totalMinor)));
}

/** Zmiana procentowa w punktach bazowych: (now - base) / base. */
export function changeBp(nowMinor: number, baseMinor: number): number | null {
  if (baseMinor === 0) return null;
  const base = BigInt(baseMinor);
  const abs = base < 0n ? -base : base;
  return bigintToNumber(mulDiv(BigInt(nowMinor) - base, BP_SCALE, abs));
}

/** Zastosowanie stopy w punktach bazowych do kwoty. */
export function applyBp(amountMinor: number, bp: number): number {
  return bigintToNumber(mulDiv(BigInt(amountMinor), BigInt(bp), BP_SCALE));
}

/** Formatowanie wartości skalowanej do stringa dziesiętnego (bez separatorów). */
export function formatScaled(value: number, decimals: number): string {
  const negative = value < 0;
  const v = BigInt(Math.abs(value));
  const scale = pow10(decimals);
  const int = v / scale;
  const frac = v % scale;
  const fracStr = decimals > 0 ? `.${frac.toString().padStart(decimals, '0')}` : '';
  return `${negative ? '-' : ''}${int}${fracStr}`;
}

export const formatMinor = (v: number, currency = 'PLN'): string => formatScaled(v, minorDecimals(currency));
export const formatQty = (v: number): string => trimZeros(formatScaled(v, QTY_DECIMALS));
export const formatPrice = (v: number): string => trimZeros(formatScaled(v, PRICE_DECIMALS));

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Kwota skalowana → number w jednostkach głównych. Wyłącznie do prezentacji. */
export function toDisplayNumber(value: number, decimals: number): number {
  return Number(formatScaled(value, decimals));
}

export const minorToDisplay = (v: number, currency = 'PLN'): number => toDisplayNumber(v, minorDecimals(currency));
export const qtyToDisplay = (v: number): number => toDisplayNumber(v, QTY_DECIMALS);
export const priceToDisplay = (v: number): number => toDisplayNumber(v, PRICE_DECIMALS);
export const bpToPercent = (bp: number): number => toDisplayNumber(bp, 2);
