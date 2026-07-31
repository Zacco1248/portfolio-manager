/** Słowniki domenowe. Kod po angielsku, etykiety UI po polsku. */

/**
 * Klasy zapisywalne na instrumencie — wyłącznie liście hierarchii.
 *
 * Dla portfela prowadzonego w złotych podział na krajowe i zagraniczne jest
 * istotniejszy niż sam podział akcje/fundusze: decyduje o ekspozycji walutowej
 * i o tym, czy dywidenda wymaga rozliczenia podatku u źródła.
 */
export const ASSET_CLASSES = [
  'stock_pl',
  'stock_foreign',
  'etf_pl',
  'etf_foreign',
  'bond',
  'metal',
  'crypto',
  'cash',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/**
 * Grupy nadrzędne. Nigdy nie trafiają do kolumny `instruments.asset_class` —
 * służą do zwijania raportów („ile mam w akcjach"), do celów alokacji
 * ustawianych na wyższym poziomie ogólności i do odczytu historycznych
 * snapshotów sprzed rozbicia klas.
 */
export const ASSET_CLASS_GROUPS = ['stock', 'etf', 'bond', 'metal', 'crypto', 'cash'] as const;
export type AssetClassGroup = (typeof ASSET_CLASS_GROUPS)[number];

export const ASSET_CLASS_PARENT: Record<AssetClass, AssetClassGroup> = {
  stock_pl: 'stock',
  stock_foreign: 'stock',
  etf_pl: 'etf',
  etf_foreign: 'etf',
  bond: 'bond',
  metal: 'metal',
  crypto: 'crypto',
  cash: 'cash',
};

/** Odwrotność ASSET_CLASS_PARENT — liście grupy, w kolejności prezentacji. */
export const ASSET_CLASS_CHILDREN: Record<AssetClassGroup, readonly AssetClass[]> = {
  stock: ['stock_pl', 'stock_foreign'],
  etf: ['etf_pl', 'etf_foreign'],
  bond: ['bond'],
  metal: ['metal'],
  crypto: ['crypto'],
  cash: ['cash'],
};

/** Liść → grupa. Podstawa wszystkich porównań typu „czy to akcja". */
export const rollUp = (assetClass: AssetClass): AssetClassGroup => ASSET_CLASS_PARENT[assetClass];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock_pl: 'Akcje polskie',
  stock_foreign: 'Akcje zagraniczne',
  etf_pl: 'ETF-y polskie',
  etf_foreign: 'ETF-y zagraniczne',
  bond: 'Obligacje',
  metal: 'Metale',
  crypto: 'Kryptowaluty',
  cash: 'Gotówka',
};

export const ASSET_CLASS_GROUP_LABELS: Record<AssetClassGroup, string> = {
  stock: 'Akcje',
  etf: 'ETF-y',
  bond: 'Obligacje',
  metal: 'Metale',
  crypto: 'Kryptowaluty',
  cash: 'Gotówka',
};

export const isAssetClass = (key: string): key is AssetClass =>
  (ASSET_CLASSES as readonly string[]).includes(key);

export const isAssetClassGroup = (key: string): key is AssetClassGroup =>
  (ASSET_CLASS_GROUPS as readonly string[]).includes(key);

/**
 * Etykieta dla dowolnego klucza: liścia, grupy albo klucza z historycznego
 * snapshotu. Nigdy nie rzuca — nierozpoznany klucz wraca jako własna nazwa.
 * Używać wszędzie zamiast bezpośredniego `ASSET_CLASS_LABELS[x]`.
 */
export const assetClassLabel = (key: string): string =>
  ASSET_CLASS_LABELS[key as AssetClass] ?? ASSET_CLASS_GROUP_LABELS[key as AssetClassGroup] ?? key;

/**
 * Zwija klucz dowolnego pochodzenia do poziomu grupy.
 *
 * Klucze historyczne („stock", „etf") są już grupami, więc przechodzą bez
 * zmian — na tym opiera się ciągłość wykresu historii przez moment migracji.
 */
export const toGroupKey = (key: string): string => (isAssetClass(key) ? ASSET_CLASS_PARENT[key] : key);

/** Kody rynków, które uznajemy za krajowe. */
const DOMESTIC_MARKETS = new Set(['WSE', 'GPW', 'WAR', 'WA']);

/**
 * Czy instrument jest krajowy — jedno źródło prawdy dla osi PL/zagranica.
 *
 * Sama giełda nie wystarcza: wyciąg brokera nie zawsze ją podaje, więc
 * instrument zaimportowany z historii transakcji ma ją pustą. Stąd dodatkowe
 * przesłanki z symbolu (`WSE:PKO`, `PKO.WA`) i waluty.
 */
export function isDomesticInstrument(instrument: {
  symbol: string;
  exchange: string | null;
  currency: string;
}): boolean {
  if (instrument.exchange && DOMESTIC_MARKETS.has(instrument.exchange.toUpperCase())) return true;
  const symbol = instrument.symbol.toUpperCase();
  if (symbol.startsWith('WSE:') || symbol.endsWith('.WA')) return true;
  // Instrument bez rynku, ale notowany w złotych, też traktujemy jak krajowy.
  return instrument.exchange === null && instrument.currency === 'PLN';
}

/**
 * Grupa akcje/ETF + oś krajowa → konkretny liść.
 *
 * Dostawcy danych rozstrzygają wyłącznie oś akcje/fundusz — o tym, czy papier
 * jest krajowy, decydujemy sami na podstawie rynku notowania.
 */
export function equityClassFor(
  group: 'stock' | 'etf',
  instrument: { symbol: string; exchange: string | null; currency: string },
): AssetClass {
  const domestic = isDomesticInstrument(instrument);
  if (group === 'stock') return domestic ? 'stock_pl' : 'stock_foreign';
  return domestic ? 'etf_pl' : 'etf_foreign';
}

/**
 * Rodzaj konta — miejsca, w którym fizycznie leżą aktywa.
 *
 * Wymiar niezależny od portfela: portfel niesie reżim podatkowy (IKE/IKZE),
 * konto odpowiada na pytanie „gdzie to jest". Rodzaj steruje wyłącznie
 * prezentacją, nie ma wpływu na żadne wyliczenie.
 */
export const ACCOUNT_KINDS = ['broker', 'bank', 'exchange', 'vault', 'other'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  broker: 'Rachunek maklerski',
  bank: 'Bank',
  exchange: 'Giełda krypto',
  vault: 'Sejf / przechowanie',
  other: 'Inne',
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

/**
 * Kategoria podatkowa instrumentu.
 *
 * Wszystkie klasy akcyjne i funduszowe są papierami wartościowymi. Gdyby
 * kiedykolwiek pojawił się liść krypto inny niż `crypto`, ta funkcja musi
 * zmienić się razem z nim — inaczej PIT-38 wymiesza dwa reżimy rozliczenia.
 */
export const taxCategoryFor = (assetClass: AssetClass): TaxCategory =>
  assetClass === 'crypto' ? 'crypto' : 'securities';

export const BOND_KINDS = ['EDO', 'COI', 'TOS', 'ROR', 'DOR', 'ROS', 'ROD', 'OTS'] as const;
export type BondKind = (typeof BOND_KINDS)[number];

/** Czy dana emisja indeksuje oprocentowanie inflacją po pierwszym okresie. */
export const INFLATION_INDEXED_BONDS: readonly BondKind[] = ['EDO', 'COI', 'ROS', 'ROD'];

/**
 * Warunki emisji detalicznych obligacji skarbowych.
 *
 * Jedno źródło prawdy dla formularza, importu i wyceny pozycji. Wcześniej te
 * dane były w trzech kopiach, a import zakładał kapitalizację roczną dla
 * wszystkich rodzajów — przez co COI i ROR, które odsetki wypłacają, zamiast
 * je dopisywać do kapitału, wyceniały się za wysoko.
 *
 * `capitalization: 'annual'` znaczy „odsetki powiększają kapitał"; `'none'` —
 * „są wypłacane, kapitał zostaje na nominale".
 */
export const BOND_TERMS: Record<BondKind, { termMonths: number; capitalization: 'annual' | 'none' }> = {
  EDO: { termMonths: 120, capitalization: 'annual' },
  COI: { termMonths: 48, capitalization: 'none' },
  TOS: { termMonths: 36, capitalization: 'annual' },
  ROR: { termMonths: 12, capitalization: 'none' },
  DOR: { termMonths: 24, capitalization: 'none' },
  ROS: { termMonths: 72, capitalization: 'annual' },
  ROD: { termMonths: 144, capitalization: 'annual' },
  OTS: { termMonths: 3, capitalization: 'none' },
};

/** Domyślne warunki dla nieznanego oznaczenia — jak dla EDO. */
export const DEFAULT_BOND_TERMS = { termMonths: 120, capitalization: 'annual' as const };

export const bondTermsFor = (kind: string): { termMonths: number; capitalization: 'annual' | 'none' } =>
  BOND_TERMS[kind as BondKind] ?? DEFAULT_BOND_TERMS;

/**
 * Oznaczenie serii wg konwencji Ministerstwa Finansów: rodzaj plus miesiąc
 * i rok wykupu, np. zakup EDO w lutym 2025 → `EDO0235`.
 *
 * Da się je wyliczyć z danych, które formularz i tak zbiera, więc nie ma
 * powodu, żeby użytkownik przepisywał je ręcznie z potwierdzenia zakupu.
 */
export function defaultBondSeries(kind: string, purchaseDate: string): string {
  const [year, month] = purchaseDate.split('-').map(Number);
  if (!year || !month) return kind;

  const { termMonths } = bondTermsFor(kind);
  const zeroBased = month - 1 + termMonths;
  const maturityYear = year + Math.floor(zeroBased / 12);
  const maturityMonth = (zeroBased % 12) + 1;

  return `${kind}${String(maturityMonth).padStart(2, '0')}${String(maturityYear % 100).padStart(2, '0')}`;
}

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

/**
 * Wymiar `equity_split` został usunięty razem z rozbiciem klas aktywów:
 * `asset_class` zwraca teraz dokładnie te same klucze, które on produkował.
 */
export const ALLOCATION_DIMENSIONS = ['asset_class', 'instrument', 'sector', 'geo', 'currency'] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

export const ALLOCATION_DIMENSION_LABELS: Record<AllocationDimension, string> = {
  asset_class: 'Klasa aktywów',
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
