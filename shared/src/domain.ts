/** Słowniki domenowe. Kod po angielsku, etykiety UI po polsku. */

export const ASSET_CLASSES = ['stock', 'etf', 'bond', 'metal', 'crypto', 'cash'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Akcje',
  etf: 'ETF-y',
  bond: 'Obligacje',
  metal: 'Metale',
  crypto: 'Kryptowaluty',
  cash: 'Gotówka',
};

export const TRANSACTION_TYPES = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'tax',
  'deposit',
  'withdrawal',
  'split',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  buy: 'Kupno',
  sell: 'Sprzedaż',
  dividend: 'Dywidenda',
  interest: 'Odsetki',
  fee: 'Opłata',
  tax: 'Podatek',
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  split: 'Split',
};

/**
 * Reżim podatkowy portfela. Kluczowe dla raportu PIT-38: zyski z IKE i IKZE
 * są zwolnione z podatku Belki, więc nie mogą trafić do zestawienia.
 */
export const TAX_REGIMES = ['taxable', 'ike', 'ikze'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
  taxable: 'Zwykły (opodatkowany)',
  ike: 'IKE (zwolniony)',
  ikze: 'IKZE (zwolniony)',
};

export const isTaxExempt = (regime: TaxRegime): boolean => regime === 'ike' || regime === 'ikze';

/** Kategoria rozliczenia — krypto rozlicza się osobno od papierów wartościowych. */
export const TAX_CATEGORIES = ['securities', 'crypto'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const taxCategoryFor = (assetClass: AssetClass): TaxCategory =>
  assetClass === 'crypto' ? 'crypto' : 'securities';

export const BOND_KINDS = ['EDO', 'COI', 'TOS', 'ROR', 'DOR', 'ROS', 'ROD', 'OTS'] as const;
export type BondKind = (typeof BOND_KINDS)[number];

/** Czy dana emisja indeksuje oprocentowanie inflacją po pierwszym okresie. */
export const INFLATION_INDEXED_BONDS: readonly BondKind[] = ['EDO', 'COI', 'ROS', 'ROD'];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const IMPORTANCE_LEVELS = ['signal', 'noise'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

export const ALERT_KINDS = [
  'price',
  'allocation_drift',
  'technical',
  'daily_move',
  'report_date',
  'news',
  'concentration',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  price: 'Alert cenowy',
  allocation_drift: 'Odchylenie alokacji',
  technical: 'Sygnał techniczny',
  daily_move: 'Duża zmiana dzienna',
  report_date: 'Raport okresowy',
  news: 'Istotny news',
  concentration: 'Koncentracja',
};

export const REBALANCE_MODES = ['full', 'buy_only'] as const;
export type RebalanceMode = (typeof REBALANCE_MODES)[number];

export const ALLOCATION_DIMENSIONS = [
  'asset_class',
  'equity_split',
  'instrument',
  'sector',
  'geo',
  'currency',
] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

export const ALLOCATION_DIMENSION_LABELS: Record<AllocationDimension, string> = {
  asset_class: 'Klasa aktywów',
  equity_split: 'Klasa aktywów (akcje PL/zagr.)',
  instrument: 'Instrument',
  sector: 'Sektor',
  geo: 'Geografia',
  currency: 'Waluta',
};

/**
 * Stały tekst wymagany przy każdym sygnale generowanym przez AI.
 * Nie usuwaj i nie skracaj — to nie jest doradztwo inwestycyjne.
 */
export const AI_DISCLAIMER =
  'Materiał informacyjny wygenerowany automatycznie. Nie stanowi rekomendacji ani doradztwa inwestycyjnego.';
