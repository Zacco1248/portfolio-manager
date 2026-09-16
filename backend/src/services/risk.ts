import { rollUp, shareBp } from '@portfolio/shared';
import type { Position, RiskWarning } from '@portfolio/shared';
import { getSetting } from './settings.js';

/**
 * Kontrola koncentracji i nakładania się ekspozycji.
 *
 * Progi są konfigurowalne — domyślne wartości to punkt wyjścia, a nie
 * rekomendacja. Ostrzeżenia opisują stan portfela, nie sugerują transakcji.
 */

export interface RiskThresholds {
  instrumentBp: number;
  sectorBp: number;
  overlapBp: number;
}

export function loadThresholds(): RiskThresholds {
  return {
    instrumentBp: getSetting<number>('concentrationInstrumentBp', 1500),
    sectorBp: getSetting<number>('concentrationSectorBp', 3500),
    overlapBp: getSetting<number>('etfOverlapBp', 3000),
  };
}

export function detectConcentration(positions: Position[], thresholds: RiskThresholds): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  const total = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);
  if (total <= 0) return warnings;

  // Pojedyncze spółki — ETF-y pomijamy, bo z definicji są koszykiem.
  const byInstrument = new Map<string, { value: number; name: string }>();
  for (const position of positions) {
    if (rollUp(position.instrument.assetClass) !== 'stock') continue;
    const key = position.instrument.symbol;
    const entry = byInstrument.get(key) ?? { value: 0, name: position.instrument.name };
    entry.value += position.valuePlnMinor;
    byInstrument.set(key, entry);
  }

  for (const [symbol, entry] of byInstrument) {
    const share = shareBp(entry.value, total);
    if (share > thresholds.instrumentBp) {
      warnings.push({
        kind: 'concentration_instrument',
        severity: share > thresholds.instrumentBp * 1.5 ? 'critical' : 'warning',
        message: `${entry.name} (${symbol}) to ${fmtPct(share)} portfela.`,
        detail: `Próg ostrzegawczy: ${fmtPct(thresholds.instrumentBp)}.`,
      });
    }
  }

  // Sektory — liczone łącznie dla akcji i ETF-ów, bo ekspozycja jest ta sama.
  const bySector = new Map<string, number>();
  for (const position of positions) {
    const sector = position.instrument.sector;
    if (!sector) continue;
    bySector.set(sector, (bySector.get(sector) ?? 0) + position.valuePlnMinor);
  }

  for (const [sector, value] of bySector) {
    const share = shareBp(value, total);
    if (share > thresholds.sectorBp) {
      warnings.push({
        kind: 'concentration_sector',
        severity: 'warning',
        message: `Sektor ${sector} to ${fmtPct(share)} portfela.`,
        detail: `Próg ostrzegawczy: ${fmtPct(thresholds.sectorBp)}.`,
      });
    }
  }

  return warnings;
}

/**
 * Nakładanie się ETF-ów: jeśli dwa fundusze trzymają te same spółki, realna
 * dywersyfikacja jest mniejsza niż sugeruje liczba pozycji.
 *
 * Wymaga wypełnionego pola `holdings` na instrumencie. Bez niego funkcja
 * milczy — nie zgadujemy składu funduszu na podstawie nazwy.
 */
export function detectEtfOverlap(
  positions: Position[],
  holdingsByInstrument: Map<number, { symbol: string; weightBp: number }[]>,
  thresholdBp: number,
): RiskWarning[] {
  const etfs = positions.filter(
    (p) => rollUp(p.instrument.assetClass) === 'etf' && (holdingsByInstrument.get(p.instrument.id)?.length ?? 0) > 0,
  );
  if (etfs.length < 2) return [];

  const warnings: RiskWarning[] = [];

  for (let i = 0; i < etfs.length; i += 1) {
    for (let j = i + 1; j < etfs.length; j += 1) {
      const a = etfs[i]!;
      const b = etfs[j]!;
      const holdingsA = new Map(
        (holdingsByInstrument.get(a.instrument.id) ?? []).map((h) => [h.symbol.toUpperCase(), h.weightBp]),
      );
      const holdingsB = holdingsByInstrument.get(b.instrument.id) ?? [];

      // Miara pokrycia: suma minimalnych wag wspólnych spółek. Odpowiada
      // części kapitału, która w obu funduszach kupuje to samo.
      let overlapBp = 0;
      for (const holding of holdingsB) {
        const weightA = holdingsA.get(holding.symbol.toUpperCase());
        if (weightA !== undefined) overlapBp += Math.min(weightA, holding.weightBp);
      }

      if (overlapBp > thresholdBp) {
        warnings.push({
          kind: 'etf_overlap',
          severity: 'info',
          message: `${a.instrument.symbol} i ${b.instrument.symbol} pokrywają się w ${fmtPct(overlapBp)}.`,
          detail:
            'Oba fundusze kupują w dużej części te same spółki, więc dywersyfikacja jest mniejsza, ' +
            'niż wynikałoby z liczby pozycji.',
        });
      }
    }
  }

  return warnings;
}

export function detectStalePrices(positions: Position[]): RiskWarning[] {
  const stale = positions.filter((p) => p.priceStale && p.valuePlnMinor > 0);
  if (stale.length === 0) return [];

  return [
    {
      kind: 'stale_prices',
      severity: 'warning',
      message: `${stale.length} ${stale.length === 1 ? 'pozycja ma nieaktualną cenę' : 'pozycji ma nieaktualne ceny'}.`,
      detail: `Dotyczy: ${stale.map((p) => p.instrument.symbol).join(', ')}. Wycena może być przestarzała.`,
    },
  ];
}

/**
 * Kursy walutowe użyte do wyceny są nieaktualne.
 *
 * Osobno od `detectStalePrices`, bo to inna awaria i inna naprawa: cena może
 * być z dzisiaj, a kurs sprzed dwóch miesięcy — i wtedy wycena wygląda na
 * świeżą, choć jest przeliczona po nieaktualnym kursie. W praktyce zdarza się
 * to wtedy, gdy aplikacja nie chodzi ciągle i zadanie `fx:refresh` nie ma
 * kiedy się wykonać.
 */
export function detectStaleFx(positions: Position[]): RiskWarning[] {
  const affected = positions.filter((p) => p.fxStale && p.valuePlnMinor > 0);
  if (affected.length === 0) return [];

  const value = affected.reduce((sum, p) => sum + p.valuePlnMinor, 0);
  const total = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);
  const dates = [...new Set(affected.map((p) => p.fxAsOf).filter((d): d is string => d !== null))].sort();

  return [
    {
      kind: 'stale_fx',
      severity: 'critical',
      message: `Kursy walut są nieaktualne — ostatni z ${dates[0] ?? 'nieznanej daty'}.`,
      detail:
        `Dotyczy ${affected.length} ${affected.length === 1 ? 'pozycji' : 'pozycji'} ` +
        `(${affected.map((p) => p.instrument.symbol).join(', ')}), ` +
        `czyli ${fmtPct(total > 0 ? Math.round((value / total) * 10_000) : 0)} wartości portfela. ` +
        'Odśwież kursy NBP, żeby wycena walutowa się zgadzała.',
    },
  ];
}

/**
 * Pozycje bez jakiegokolwiek notowania.
 *
 * Ich wartość podstawia koszt nabycia, więc wchodzą do sumy portfela z wynikiem
 * zero — co bez ostrzeżenia wygląda jak papier, który nie drgnął od zakupu.
 */
export function detectMissingPrices(positions: Position[]): RiskWarning[] {
  const missing = positions.filter((p) => p.priceMissing);
  if (missing.length === 0) return [];

  return [
    {
      kind: 'missing_prices',
      severity: 'warning',
      message: `${missing.length} ${missing.length === 1 ? 'pozycja nie ma notowania' : 'pozycji nie ma notowania'}.`,
      detail:
        `Dotyczy: ${missing.map((p) => p.instrument.symbol).join(', ')}. ` +
        'Wycenione po koszcie nabycia — wynik na nich jest nieznany, nie zerowy.',
    },
  ];
}

function fmtPct(bp: number): string {
  return `${(bp / 100).toFixed(1).replace('.', ',')}%`;
}
