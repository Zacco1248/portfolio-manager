import { ASSET_CLASS_GROUP_LABELS, rollUp, shareBp } from '@portfolio/shared';
import type { AssetClass, AssetClassGroup } from '@portfolio/shared';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { checkFeature } from './ai-config.js';
import { complete } from './ai.js';
import { activePortfolioIds, buildPositions } from './positions.js';
import { buildPlan } from './rebalance.js';
import { loadTargets } from './targets.js';

const log = createLogger('suggestions');

/**
 * Propozycje uzupełnienia portfela.
 *
 * Warstwa deterministyczna liczy, czego brakuje względem alokacji docelowej,
 * jakie sektory i regiony są już obecne i gdzie robi się zbyt gęsto. Model
 * językowy dostaje wyłącznie te wnioski — udziały procentowe i luki — bez
 * kwot, nazwisk i historii transakcji.
 *
 * Wynik jest materiałem informacyjnym: mówi, czego w portfelu brakuje, a nie
 * co kupić.
 */

export interface AllocationGap {
  key: string;
  label: string;
  currentSharePercent: number;
  targetSharePercent: number;
  gapPercent: number;
}

export interface SuggestionContext {
  gaps: AllocationGap[];
  overweight: AllocationGap[];
  sectors: { name: string; sharePercent: number }[];
  regions: { name: string; sharePercent: number }[];
  missingAssetClasses: string[];
  concentrated: { symbol: string; sharePercent: number }[];
}

/**
 * Klasy aktywów, których brak w portfelu wypada odnotować.
 *
 * Na poziomie grup: „brak akcji" jest sensowną obserwacją, „brak akcji
 * polskich" przy pełnym portfelu zagranicznym byłaby już podpowiadaniem
 * konkretnej ekspozycji.
 */
const EXPECTED_CLASSES: AssetClassGroup[] = ['stock', 'etf', 'bond', 'metal', 'crypto'];

/** Próg, od którego pojedyncza pozycja jest uznawana za skoncentrowaną. */
const CONCENTRATION_PERCENT = 15;

export function buildContext(portfolioId?: number): SuggestionContext {
  const ids = activePortfolioIds(portfolioId);
  const { positions, cashByPortfolio } = buildPositions(ids);
  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const total = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) + cash;

  const targets = loadTargets(portfolioId ?? null, 'asset_class');
  const plan = buildPlan(
    { positions, cashPlnMinor: cash, targets, dimension: 'asset_class', contributionPlnMinor: 0 },
    'buy_only',
  );

  const toGap = (action: (typeof plan.actions)[number]): AllocationGap => ({
    key: action.key,
    label: action.label,
    currentSharePercent: Math.round(action.currentShareBp) / 100,
    targetSharePercent: Math.round(action.targetShareBp) / 100,
    gapPercent: Math.round(action.targetShareBp - action.currentShareBp) / 100,
  });

  const groupShares = (pick: (p: (typeof positions)[number]) => string | null) => {
    const buckets = new Map<string, number>();
    for (const position of positions) {
      const key = pick(position);
      if (!key || key === 'unknown') continue;
      buckets.set(key, (buckets.get(key) ?? 0) + position.valuePlnMinor);
    }
    return [...buckets.entries()]
      .map(([name, value]) => ({ name, sharePercent: Math.round(shareBp(value, total)) / 100 }))
      .sort((a, b) => b.sharePercent - a.sharePercent);
  };

  const presentGroups = new Set(positions.map((p) => rollUp(p.instrument.assetClass)));

  return {
    gaps: plan.actions.filter((a) => a.driftBp < 0).map(toGap),
    overweight: plan.actions.filter((a) => a.driftBp > 0).map(toGap),
    sectors: groupShares((p) => p.instrument.sector),
    regions: groupShares((p) => p.instrument.country),
    missingAssetClasses: EXPECTED_CLASSES.filter((c) => !presentGroups.has(c)).map((c) => ASSET_CLASS_GROUP_LABELS[c]),
    concentrated: positions
      .map((p) => ({
        symbol: p.instrument.symbol,
        sharePercent: Math.round(shareBp(p.valuePlnMinor, total)) / 100,
      }))
      .filter((p) => p.sharePercent >= CONCENTRATION_PERCENT)
      .sort((a, b) => b.sharePercent - a.sharePercent),
  };
}

export interface Suggestion {
  /** category | instrument | timing */
  kind: string;
  title: string;
  rationale: string;
}

export interface SuggestionsResponse {
  context: SuggestionContext;
  suggestions: Suggestion[];
  /** Powód pustej listy — najczęściej wyłączona funkcja AI. */
  unavailableReason: string | null;
  disclaimer: string;
}

const PROMPT = `Jesteś asystentem inwestora indywidualnego z Polski, który buduje długoterminowy portfel.

Dostajesz opis struktury portfela: udziały procentowe klas aktywów wobec celu, sektory, regiony,
brakujące klasy aktywów i pozycje o dużej koncentracji. Nie znasz kwot ani nazwisk.

Zaproponuj 3-6 kierunków uzupełnienia portfela. Dla każdego podaj:
- "kind": "category" (klasa aktywów albo sektor), "instrument" (typ funduszu lub spółki)
  albo "timing" (na co zwrócić uwagę przy wyborze momentu zakupu),
- "title": zwięzła propozycja,
- "rationale": dlaczego pasuje do TEGO portfela, odwołując się do podanych liczb.

Zasady:
- Przy instrumentach opisuj TYP (np. „szeroki ETF na rynki rozwinięte", „ETF na krótkoterminowe
  obligacje skarbowe"), a nie konkretne tickery — nie znasz kosztów, dostępności ani sytuacji podatkowej.
- Nie obiecuj wyników i nie prognozuj cen. Przy "timing" pisz o zasadach: regularność wpłat,
  rozłożenie zakupu w czasie, unikanie jednorazowych dużych wejść — nie o przewidywaniu dołków.
- Nie sugeruj sprzedaży. Ten portfel jest budowany dopłatami.
- Jeśli struktura jest zdrowa, napisz to wprost zamiast wymyślać braki.
- Nie wyliczaj czynników, których nie znasz (horyzont, tolerancja ryzyka, koszty transakcyjne,
  sytuacja podatkowa). Zdanie bez konkretnej liczby albo nazwy wytnij zamiast je pisać.
- Żadnych zwrotów „warto sprawdzić", „należy rozważyć", „dobrze zweryfikować".

Odpowiadasz wyłącznie tablicą JSON: [{"kind":"...","title":"...","rationale":"..."}]`;

export async function buildSuggestions(portfolioId?: number): Promise<SuggestionsResponse> {
  const context = buildContext(portfolioId);
  const disclaimer =
    'Materiał informacyjny wygenerowany automatycznie na podstawie struktury portfela. ' +
    'Nie stanowi rekomendacji ani doradztwa inwestycyjnego.';

  const availability = checkFeature('rebalanceHints');
  if (!availability.enabled) {
    return { context, suggestions: [], unavailableReason: availability.reason, disclaimer };
  }

  const payload = [
    `Luki wobec celu: ${context.gaps.map((g) => `${g.label} ${g.currentSharePercent}% wobec ${g.targetSharePercent}%`).join('; ') || 'brak'}`,
    `Powyżej celu: ${context.overweight.map((g) => `${g.label} ${g.currentSharePercent}%`).join('; ') || 'brak'}`,
    `Sektory: ${context.sectors.map((s) => `${s.name} ${s.sharePercent}%`).join('; ') || 'nieprzypisane'}`,
    `Regiony: ${context.regions.map((r) => `${r.name} ${r.sharePercent}%`).join('; ') || 'nieprzypisane'}`,
    `Brakujące klasy aktywów: ${context.missingAssetClasses.join(', ') || 'żadne'}`,
    `Duża koncentracja: ${context.concentrated.map((c) => `${c.symbol} ${c.sharePercent}%`).join('; ') || 'brak'}`,
  ].join('\n');

  try {
    const text = await complete(PROMPT, payload, 1500);
    return { context, suggestions: parseSuggestions(text), unavailableReason: null, disclaimer };
  } catch (err) {
    log.warn(`Propozycje AI nieudane: ${errorMessage(err)}`);
    return { context, suggestions: [], unavailableReason: 'Model nie odpowiedział.', disclaimer };
  }
}

export function parseSuggestions(text: string | null): Suggestion[] {
  if (!text) return [];

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        kind: typeof entry.kind === 'string' ? entry.kind : 'category',
        title: typeof entry.title === 'string' ? entry.title.trim() : '',
        rationale: typeof entry.rationale === 'string' ? entry.rationale.trim() : '',
      }))
      .filter((s) => s.title.length > 0);
  } catch {
    return [];
  }
}
