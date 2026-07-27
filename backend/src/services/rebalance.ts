import { ASSET_CLASS_LABELS, shareBp } from '@portfolio/shared';
import type {
  AllocationDimension,
  AssetClass,
  Position,
  RebalanceAction,
  RebalanceMode,
  RebalancePlan,
} from '@portfolio/shared';

/**
 * Propozycja rebalansu portfela.
 *
 * Dwa tryby:
 *   - `full`     — dopuszcza sprzedaż nadmiarowych pozycji,
 *   - `buy_only` — wyłącznie dokupowanie, rozdzielone w ramach zadanej wpłaty.
 *
 * Tryb `buy_only` odpowiada realnemu sposobowi prowadzenia portfela przy
 * comiesięcznych dopłatach: nie generuje zdarzeń podatkowych i nie wymusza
 * sprzedaży czegokolwiek, tylko kieruje nowe pieniądze tam, gdzie brakuje
 * najwięcej do celu.
 */

export interface TargetEntry {
  key: string;
  targetBp: number;
  toleranceBp: number;
}

export interface RebalanceInput {
  positions: Position[];
  cashPlnMinor: number;
  targets: TargetEntry[];
  dimension: AllocationDimension;
  /** Kwota planowanej dopłaty w groszach; 0 = sam rebalans istniejącego kapitału. */
  contributionPlnMinor: number;
}

/** Klucz wymiaru dla pozycji — po czym grupujemy alokację. */
export function dimensionKey(position: Position, dimension: AllocationDimension): string {
  switch (dimension) {
    case 'asset_class':
      return position.instrument.assetClass;
    case 'instrument':
      return position.instrument.symbol;
    case 'sector':
      return position.instrument.sector ?? 'unknown';
    case 'geo':
      return position.instrument.country ?? 'unknown';
    case 'currency':
      return position.instrument.currency;
    default:
      return 'unknown';
  }
}

function labelFor(key: string, dimension: AllocationDimension): string {
  if (dimension === 'asset_class') return ASSET_CLASS_LABELS[key as AssetClass] ?? key;
  return key === 'unknown' ? 'Nieprzypisane' : key;
}

/** Bieżące wartości per klucz wymiaru, z gotówką doliczoną do klasy `cash`. */
export function currentValues(
  positions: Position[],
  cashPlnMinor: number,
  dimension: AllocationDimension,
): Map<string, number> {
  const values = new Map<string, number>();
  for (const position of positions) {
    const key = dimensionKey(position, dimension);
    values.set(key, (values.get(key) ?? 0) + position.valuePlnMinor);
  }
  if (cashPlnMinor !== 0) {
    const cashKey = dimension === 'asset_class' ? 'cash' : dimension === 'currency' ? 'PLN' : 'unknown';
    values.set(cashKey, (values.get(cashKey) ?? 0) + cashPlnMinor);
  }
  return values;
}

/** Suma odchyleń bezwzględnych od celu — miara jakości dopasowania portfela. */
export function totalDriftBp(values: Map<string, number>, targets: TargetEntry[], total: number): number {
  if (total <= 0) return 0;
  let drift = 0;
  for (const target of targets) {
    const current = shareBp(values.get(target.key) ?? 0, total);
    drift += Math.abs(current - target.targetBp);
  }
  return drift;
}

export function buildPlan(input: RebalanceInput, mode: RebalanceMode): RebalancePlan {
  const { positions, cashPlnMinor, targets, dimension, contributionPlnMinor } = input;

  const values = currentValues(positions, cashPlnMinor, dimension);
  const currentTotal = [...values.values()].reduce((sum, v) => sum + v, 0);
  // Po dopłacie portfel będzie większy, więc cele liczymy od nowej sumy.
  const targetTotal = currentTotal + contributionPlnMinor;

  const actions: RebalanceAction[] = [];

  if (targets.length === 0 || targetTotal <= 0) {
    return {
      mode,
      dimension,
      totalValuePlnMinor: currentTotal,
      contributionPlnMinor,
      actions: [],
      driftBeforeBp: 0,
      driftAfterBp: 0,
      note:
        targets.length === 0
          ? 'Nie zdefiniowano alokacji docelowej. Ustaw cele w widoku Rebalans, żeby zobaczyć propozycję.'
          : 'Portfel jest pusty.',
    };
  }

  for (const target of targets) {
    const current = values.get(target.key) ?? 0;
    const desired = Math.round((targetTotal * target.targetBp) / 10_000);
    const currentShare = shareBp(current, currentTotal);
    const driftBp = currentShare - target.targetBp;
    const withinTolerance = Math.abs(driftBp) <= target.toleranceBp;

    let delta = desired - current;
    // W trybie samego dokupowania nie proponujemy sprzedaży, nawet jeśli
    // dana pozycja przekracza cel — nadwyżka rozwiąże się kolejnymi wpłatami.
    if (mode === 'buy_only' && delta < 0) delta = 0;

    actions.push({
      dimension,
      key: target.key,
      label: labelFor(target.key, dimension),
      currentValuePlnMinor: current,
      currentShareBp: currentShare,
      targetShareBp: target.targetBp,
      toleranceBp: target.toleranceBp,
      driftBp,
      withinTolerance,
      deltaPlnMinor: delta,
      suggestion: '',
    });
  }

  if (mode === 'buy_only') {
    scaleToContribution(actions, contributionPlnMinor);
  } else {
    // Pełny rebalans musi się bilansować: suma kupna i sprzedaży plus dopłata
    // powinny dać zero, inaczej plan wymagałby pieniędzy znikąd.
    balanceFullPlan(actions, contributionPlnMinor);
  }

  for (const action of actions) {
    action.suggestion = describeAction(action, mode);
  }

  const after = new Map(values);
  for (const action of actions) {
    after.set(action.key, (after.get(action.key) ?? 0) + action.deltaPlnMinor);
  }

  return {
    mode,
    dimension,
    totalValuePlnMinor: currentTotal,
    contributionPlnMinor,
    actions: actions.sort((a, b) => Math.abs(b.driftBp) - Math.abs(a.driftBp)),
    driftBeforeBp: totalDriftBp(values, targets, currentTotal),
    driftAfterBp: totalDriftBp(after, targets, targetTotal),
    note: noteFor(mode, contributionPlnMinor),
  };
}

/**
 * Rozdziela dostępną wpłatę proporcjonalnie do niedoborów.
 *
 * Gdy wpłata nie wystarcza na pełne wyrównanie, każdy niedobór dostaje część
 * proporcjonalną do swojej wielkości — to minimalizuje sumę odchyleń przy
 * zadanym budżecie.
 */
function scaleToContribution(actions: RebalanceAction[], contributionPlnMinor: number): void {
  const deficits = actions.filter((a) => a.deltaPlnMinor > 0);
  const totalDeficit = deficits.reduce((sum, a) => sum + a.deltaPlnMinor, 0);

  if (contributionPlnMinor <= 0 || totalDeficit === 0) {
    // Bez zadanej wpłaty pokazujemy sam niedobór — to informacja, ile brakuje,
    // a nie polecenie zakupu.
    return;
  }

  let assigned = 0;
  deficits.forEach((action, index) => {
    const isLast = index === deficits.length - 1;
    const share = isLast
      ? contributionPlnMinor - assigned
      : Math.round((contributionPlnMinor * action.deltaPlnMinor) / totalDeficit);
    action.deltaPlnMinor = share;
    assigned += share;
  });

  for (const action of actions) {
    if (action.deltaPlnMinor < 0) action.deltaPlnMinor = 0;
  }
}

/** Domyka plan tak, żeby suma zmian równała się dopłacie. */
function balanceFullPlan(actions: RebalanceAction[], contributionPlnMinor: number): void {
  const sum = actions.reduce((s, a) => s + a.deltaPlnMinor, 0);
  const residual = contributionPlnMinor - sum;
  if (residual === 0) return;

  // Resztę z zaokrągleń dokładamy do pozycji o największym odchyleniu.
  const largest = actions.reduce((best, a) => (Math.abs(a.driftBp) > Math.abs(best.driftBp) ? a : best), actions[0]!);
  largest.deltaPlnMinor += residual;
}

function describeAction(action: RebalanceAction, mode: RebalanceMode): string {
  const amount = formatPln(Math.abs(action.deltaPlnMinor));

  if (action.deltaPlnMinor === 0) {
    return action.withinTolerance ? 'W granicach tolerancji — bez zmian.' : 'Bez zmian w tym trybie.';
  }
  if (action.deltaPlnMinor > 0) {
    return mode === 'buy_only' ? `Dokup za ${amount}.` : `Dokup za ${amount}.`;
  }
  return `Sprzedaj za ${amount}.`;
}

function noteFor(mode: RebalanceMode, contributionPlnMinor: number): string {
  if (mode === 'buy_only') {
    return contributionPlnMinor > 0
      ? `Podział wpłaty ${formatPln(contributionPlnMinor)} bez sprzedaży — nie generuje zdarzenia podatkowego.`
      : 'Podaj kwotę dopłaty, żeby zobaczyć proponowany podział. Bez niej widać sam niedobór do celu.';
  }
  return 'Pełny rebalans obejmuje sprzedaż nadwyżek. Pamiętaj, że sprzedaż w portfelu opodatkowanym rodzi podatek od zysku.';
}

function formatPln(minor: number): string {
  return `${(minor / 100).toFixed(2).replace('.', ',')} zł`;
}
