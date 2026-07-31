import type {
  AccountKind,
  AlertKind,
  AllocationDimension,
  AssetClass,
  BondKind,
  Importance,
  RebalanceMode,
  Sentiment,
  TaxCategory,
  TaxRegime,
  TransactionType,
} from './domain.js';

/**
 * Kontrakt API. Wszystkie pola z sufiksem oznaczającym skalę są liczbami
 * całkowitymi: `*Minor` = grosze/centy, `*E8` = ×1e8, `*E6` = ×1e6, `*Bp` = punkty bazowe.
 * Frontend formatuje je funkcjami z `money.ts` — nigdy nie liczy na nich arytmetyki.
 */

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

export interface Portfolio {
  id: number;
  name: string;
  kind: string | null;
  taxRegime: TaxRegime;
  baseCurrency: string;
  broker: string | null;
  note: string | null;
  /** Portfel oznaczony jako poduszka finansowa — wyłączony z propozycji rebalansu. */
  emergencyFund: boolean;
  archived: boolean;
  createdAt: string;
}

/**
 * Konto — miejsce, w którym fizycznie leżą aktywa (rachunek maklerski, bank,
 * giełda krypto, sejf). Wymiar niezależny od portfela.
 */
export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  note: string | null;
  archived: boolean;
  createdAt: string;
  /** Liczba transakcji — router odmawia usunięcia konta, które ich używa. */
  transactionCount?: number;
}

export interface Instrument {
  id: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  isin: string | null;
  exchange: string | null;
  sector: string | null;
  country: string | null;
  provider: string | null;
  providerSymbol: string | null;
  /** Jednostka pozycji dla metali (oz, g, kg); null dla pozostałych klas. */
  unit: string | null;
  /** Czy pozycja wlicza się do poduszki finansowej. */
  emergencyFund?: boolean;
}

export interface Transaction {
  id: number;
  portfolioId: number;
  instrumentId: number | null;
  /** Konto, na którym operacja się odbyła. null = nieprzypisane. */
  accountId: number | null;
  type: TransactionType;
  tradeDate: string;
  settlementDate: string | null;
  qtyE8: number;
  priceE8: number;
  grossMinor: number;
  feeMinor: number;
  taxMinor: number;
  currency: string;
  /** Kurs NBP D-1 — podstawa podatkowa. */
  fxRateE6: number;
  fxDate: string | null;
  /** Kurs faktycznie zastosowany przez brokera, jeśli znany z importu. */
  settlementFxRateE6: number | null;
  /** Faktyczny przepływ gotówki w PLN. */
  amountPlnMinor: number;
  /** Ten sam przepływ po kursie NBP — wyłącznie do rozliczenia podatkowego. */
  taxAmountPlnMinor: number;
  note: string | null;
  importBatchId: number | null;
  createdAt: string;
  instrument?: Instrument | null;
  portfolioName?: string;
  accountName?: string | null;
}

export interface Quote {
  instrumentId: number;
  priceE8: number;
  currency: string;
  ts: string;
  source: string;
  /** Zmiana względem poprzedniego zamknięcia, w punktach bazowych. */
  dayChangeBp: number | null;
  stale: boolean;
}

export interface Position {
  portfolioId: number;
  portfolioName: string;
  instrument: Instrument;
  qtyE8: number;
  /** Średnia cena nabycia w walucie instrumentu. */
  avgPriceE8: number;
  costPlnMinor: number;
  priceE8: number | null;
  valuePlnMinor: number;
  unrealizedPlnMinor: number;
  unrealizedBp: number | null;
  dayChangePlnMinor: number | null;
  dayChangeBp: number | null;
  sharePortfolioBp: number;
  priceStale: boolean;
  fxRateE6: number;
  /**
   * Rozbicie pozycji na konta. Obecne tylko wtedy, gdy papier leży na więcej
   * niż jednym koncie albo gdy konto w ogóle jest przypisane.
   */
  accounts?: PositionAccountSlice[];
}

/** Część pozycji leżąca na jednym koncie. Suma części równa się pozycji co do grosza. */
export interface PositionAccountSlice {
  accountId: number | null;
  accountName: string | null;
  qtyE8: number;
  costPlnMinor: number;
  valuePlnMinor: number;
}

/**
 * Zestawienie jednego konta na dashboardzie — odpowiedź na pytanie
 * „ile na plus, ile na minus w danym miejscu".
 */
export interface AccountBreakdown {
  accountId: number | null;
  /** „Nieprzypisane" dla accountId === null. */
  name: string;
  kind: AccountKind | null;
  /**
   * Kapitał wniesiony na konto z zewnątrz: wpłaty minus wypłaty.
   *
   * Świadomie NIE obejmuje przepływów z kupna i sprzedaży — te tylko
   * przesuwają pieniądze między gotówką a papierami wewnątrz konta
   * i wliczone podnosiłyby „wpłacono" o obroty.
   */
  contributedPlnMinor: number;
  cashPlnMinor: number;
  positionsValuePlnMinor: number;
  valuePlnMinor: number;
  realizedPlnMinor: number;
  unrealizedPlnMinor: number;
  /** Wartość bieżąca minus kapitał wniesiony. */
  resultPlnMinor: number;
}

export interface AccountsReport {
  accounts: AccountBreakdown[];
  totalValuePlnMinor: number;
  totalResultPlnMinor: number;
}

export interface AllocationSlice {
  key: string;
  label: string;
  valuePlnMinor: number;
  shareBp: number;
}

export interface PortfolioSummary {
  portfolioIds: number[];
  valuePlnMinor: number;
  cashPlnMinor: number;
  investedPlnMinor: number;
  realizedPlnMinor: number;
  unrealizedPlnMinor: number;
  totalReturnPlnMinor: number;
  totalReturnBp: number | null;
  dayChangePlnMinor: number | null;
  dayChangeBp: number | null;
  weekChangePlnMinor: number | null;
  weekChangeBp: number | null;
  positionsCount: number;
  asOf: string;
}

export interface SnapshotPoint {
  date: string;
  valuePlnMinor: number;
  investedPlnMinor: number;
  /**
   * Rozbicie wartości na klasy aktywów w dniu pomiaru.
   *
   * Świadomie `string`, nie `AssetClass`: snapshoty sprzed rozbicia klas mają
   * klucze grupowe („stock"), a te zapisane później — liściaste („stock_pl").
   * Odczyt zwija jedne i drugie do poziomu grupy.
   */
  byAssetClass?: Record<string, number>;
}

export interface DashboardResponse {
  summary: PortfolioSummary;
  history: SnapshotPoint[];
  allocation: {
    assetClass: AllocationSlice[];
    currency: AllocationSlice[];
    sector: AllocationSlice[];
    geo: AllocationSlice[];
  };
  topMovers: { instrument: Instrument; dayChangeBp: number | null; dayChangePlnMinor: number | null }[];
  warnings: RiskWarning[];
}

export interface RiskWarning {
  kind: 'concentration_instrument' | 'concentration_sector' | 'etf_overlap' | 'allocation_drift' | 'stale_prices';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  detail?: string;
}

export interface RealizedGain {
  id: number;
  sellTransactionId: number;
  portfolioId: number;
  portfolioName: string;
  instrumentId: number;
  instrumentSymbol: string;
  instrumentName: string;
  taxCategory: TaxCategory;
  taxExempt: boolean;
  saleDate: string;
  purchaseDate: string;
  qtyE8: number;
  /** Wynik faktyczny — po kursach rozliczeniowych. */
  costPlnMinor: number;
  proceedsPlnMinor: number;
  gainPlnMinor: number;
  /** Wynik podatkowy — po kursach NBP D-1. To trafia do PIT-38. */
  taxCostPlnMinor: number;
  taxProceedsPlnMinor: number;
  taxGainPlnMinor: number;
  year: number;
}

export interface XirrResult {
  /** Roczna stopa zwrotu w punktach bazowych; null gdy brak zbieżności. */
  rateBp: number | null;
  cashflowCount: number;
  from: string | null;
  to: string | null;
  converged: boolean;
}

export interface BenchmarkSeries {
  symbol: string;
  label: string;
  /** Wartość znormalizowana do 100 na starcie okresu, ×100 (czyli 10000 = 100.00). */
  points: { date: string; indexed: number }[];
  totalReturnBp: number | null;
}

export interface AnalyticsResponse {
  portfolioXirr: XirrResult;
  positionXirr: { instrumentId: number; symbol: string; name: string; xirr: XirrResult }[];
  benchmarks: BenchmarkSeries[];
  portfolioIndexed: { date: string; indexed: number }[];
}

export interface Candle {
  date: string;
  openE8: number;
  highE8: number;
  lowE8: number;
  closeE8: number;
  volume: number | null;
}

export interface TechnicalIndicators {
  sma50: (number | null)[];
  sma200: (number | null)[];
  ema12: (number | null)[];
  ema26: (number | null)[];
  rsi14: (number | null)[];
  macd: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
  bollinger: { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] };
  atr14: (number | null)[];
  stochastic: { k: (number | null)[]; d: (number | null)[] };
  roc20: (number | null)[];
  obv: (number | null)[];
}

export interface TechnicalSignal {
  date: string;
  kind: 'golden_cross' | 'death_cross' | 'rsi_overbought' | 'rsi_oversold' | 'macd_bullish' | 'macd_bearish';
  label: string;
  detail: string;
}

export interface TechnicalResponse {
  instrument: Instrument;
  candles: Candle[];
  indicators: TechnicalIndicators;
  signals: TechnicalSignal[];
}

export interface DividendEntry {
  transactionId: number;
  instrument: Instrument;
  portfolioName: string;
  date: string;
  grossMinor: number;
  taxMinor: number;
  netPlnMinor: number;
  currency: string;
}

export interface DividendSummary {
  entries: DividendEntry[];
  byYear: { year: number; grossPlnMinor: number; taxPlnMinor: number; netPlnMinor: number }[];
  /** Stopa dywidendy portfela liczona z ostatnich 12 miesięcy, w punktach bazowych. */
  trailingYieldBp: number | null;
  upcoming: { instrument: Instrument; exDate: string | null; payDate: string | null; note: string }[];
}

export interface RebalanceAction {
  dimension: AllocationDimension;
  key: string;
  label: string;
  currentValuePlnMinor: number;
  currentShareBp: number;
  targetShareBp: number;
  toleranceBp: number;
  driftBp: number;
  withinTolerance: boolean;
  /** Dodatnia = dokup, ujemna = sprzedaj. */
  deltaPlnMinor: number;
  suggestion: string;
}

export interface RebalancePlan {
  mode: RebalanceMode;
  dimension: AllocationDimension;
  totalValuePlnMinor: number;
  contributionPlnMinor: number;
  actions: RebalanceAction[];
  /** Suma odchyleń bezwzględnych przed i po zastosowaniu planu. */
  driftBeforeBp: number;
  driftAfterBp: number;
  note: string;
}

export interface RebalanceResponse {
  full: RebalancePlan;
  buyOnly: RebalancePlan;
  warnings: RiskWarning[];
}

export interface NewsItem {
  id: number;
  instrumentId: number | null;
  instrumentSymbol: string | null;
  source: string;
  url: string;
  title: string;
  publishedAt: string;
  aiSummaryPl: string | null;
  /** Czy streszczenie wytworzył model, czy jest to zajawka z kanału. */
  aiGenerated?: boolean;
  sentiment: Sentiment | null;
  importance: Importance | null;
  aiSignal: { hold: string[]; reduce: string[]; rationale: string } | null;
  aiModel: string | null;
  /** Zawsze true dla treści z AI — UI musi pokazać zastrzeżenie. */
  informationalOnly: boolean;
}

export interface Alert {
  id: number;
  kind: AlertKind;
  portfolioId: number | null;
  instrumentId: number | null;
  instrumentSymbol: string | null;
  condition: Record<string, unknown>;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
}

export interface AlertEvent {
  id: number;
  alertId: number;
  kind: AlertKind;
  triggeredAt: string;
  message: string;
  delivered: boolean;
  deliveryError: string | null;
}

export interface BondHolding {
  id: number;
  portfolioId: number;
  series: string;
  kind: BondKind;
  purchaseDate: string;
  count: number;
  nominalMinor: number;
  firstYearRateBp: number;
  marginBp: number;
  termMonths: number;
  maturityDate: string;
  capitalization: 'annual' | 'none';
  /** Wartość wykupu na dziś: kapitał + skumulowane odsetki. */
  currentValueMinor: number;
  accruedInterestMinor: number;
  currentPeriodRateBp: number;
  periods: BondPeriod[];
}

export interface BondPeriod {
  index: number;
  from: string;
  to: string;
  rateBp: number;
  /** Czy stopa jest już znana, czy prognozowana (brak odczytu CPI). */
  projected: boolean;
  openingCapitalMinor: number;
  interestMinor: number;
  closingCapitalMinor: number;
}

export interface ImportParserInfo {
  id: string;
  name: string;
  description: string;
  extensions: string[];
  requiresMapping: boolean;
}

export interface ImportRowPreview {
  rowId: string;
  tradeDate: string;
  type: TransactionType;
  symbol: string | null;
  instrumentName: string | null;
  quantity: string;
  price: string;
  amount: string;
  currency: string;
  status: 'new' | 'duplicate' | 'conflict' | 'error';
  message: string | null;
  /** Id istniejącej transakcji, z którą wiersz koliduje. */
  matchedTransactionId: number | null;
}

export interface ImportPreviewResponse {
  batchId: number;
  parserId: string;
  parserName: string;
  filename: string;
  detectedColumns: string[];
  mapping: Record<string, string | null> | null;
  requiresMapping: boolean;
  rows: ImportRowPreview[];
  stats: { total: number; new: number; duplicate: number; conflict: number; error: number };
}

export interface ImportCommitResponse {
  batchId: number;
  imported: number;
  skipped: number;
  errors: { rowId: string; message: string }[];
}

export interface TaxReport {
  year: number;
  /** Portfele zwolnione (IKE/IKZE) są wyłączone z zestawienia. */
  excludedPortfolios: { id: number; name: string; taxRegime: TaxRegime }[];
  securities: TaxSection;
  crypto: TaxSection;
  dividends: {
    grossPlnMinor: number;
    withholdingTaxPlnMinor: number;
    /** Podatek należny w PL po odliczeniu podatku u źródła (limit 19%). */
    duePlnMinor: number;
    entries: {
      date: string;
      symbol: string;
      country: string | null;
      grossPlnMinor: number;
      withholdingPlnMinor: number;
      currency: string;
    }[];
  };
  note: string;
}

export interface TaxSection {
  revenuePlnMinor: number;
  costPlnMinor: number;
  /** Wynik roku przed uwzględnieniem strat z lat ubiegłych. */
  gainPlnMinor: number;
  taxPlnMinor: number;
  entries: RealizedGain[];
  /** Rozliczenie strat z lat poprzednich; null gdy nie ma czego rozliczać. */
  lossCarryForward: LossCarryForward | null;
}

export interface LossCarryForward {
  /** securities — limit 50% rocznie przez 5 lat; crypto — pełne przeniesienie kosztów. */
  regime: 'securities' | 'crypto';
  availablePlnMinor: number;
  appliedPlnMinor: number;
  /** Podstawa opodatkowania po odliczeniu. */
  taxableGainPlnMinor: number;
  /** Co zostaje na kolejne lata. */
  carryToNextYearPlnMinor: number;
  /** Ile przepadło z upływem pięciu lat (tylko papiery wartościowe). */
  expiredPlnMinor: number;
  note: string;
}

export interface SystemStatus {
  version: string;
  baseCurrency: string;
  features: {
    ai: boolean;
    telegram: boolean;
    externalFetch: boolean;
  };
  lastPriceUpdate: string | null;
  lastFxUpdate: string | null;
  lastSnapshot: string | null;
  providers: { id: string; healthy: boolean; lastError: string | null; lastSuccessAt: string | null }[];
}
