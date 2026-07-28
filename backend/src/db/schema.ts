import { relations, sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Konwencje nazw kolumn:
 *   *_minor → kwota jako liczba całkowita w minor units waluty (grosze/centy)
 *   *_e8    → wartość ×10^8 (ilości, ceny)
 *   *_e6    → wartość ×10^6 (kursy walut)
 *   *_bp    → punkty bazowe (10000 = 100%)
 * Daty: TEXT w ISO 'YYYY-MM-DD'. Znaczniki czasu: TEXT w ISO 8601 UTC.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// ─────────────────────────────────────────────────────────────
// Portfele
// ─────────────────────────────────────────────────────────────
export const portfolios = sqliteTable(
  'portfolios',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** Swobodna etykieta, np. "Główny", "IKE XTB", "Długoterminowy". */
    kind: text('kind'),
    /**
     * taxable | ike | ikze — IKE i IKZE są zwolnione z podatku Belki,
     * więc raport PIT-38 musi je pomijać.
     */
    taxRegime: text('tax_regime').notNull().default('taxable'),
    baseCurrency: text('base_currency').notNull().default('PLN'),
    broker: text('broker'),
    note: text('note'),
    /**
     * Portfel oznaczony jako poduszka finansowa. Nie jest celem inwestycyjnym,
     * tylko buforem bezpieczeństwa — dlatego wypada z propozycji rebalansu
     * i jest liczony osobno względem docelowej liczby miesięcy wydatków.
     */
    emergencyFund: integer('emergency_fund', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('portfolios_name_uq').on(t.name)],
);

// ─────────────────────────────────────────────────────────────
// Instrumenty
// ─────────────────────────────────────────────────────────────
export const instruments = sqliteTable(
  'instruments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Kanoniczny symbol wewnętrzny, np. "WSE:XTB". */
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    /** stock | etf | bond | metal | crypto | cash */
    assetClass: text('asset_class').notNull(),
    currency: text('currency').notNull(),
    isin: text('isin'),
    exchange: text('exchange'),
    sector: text('sector'),
    country: text('country'),
    /** Preferowany dostawca cen; null = wybór automatyczny z rejestru. */
    provider: text('provider'),
    providerSymbol: text('provider_symbol'),
    /** Dla metali: jednostka pozycji (g, oz, kg) — wycena idzie przez cenę spot za uncję. */
    unit: text('unit'),
    /**
     * Czy pozycja liczy się do poduszki finansowej.
     *
     * Poduszka nie musi być osobnym portfelem — obligacje skarbowe trzymane
     * obok akcji pełnią tę rolę równie dobrze, a przenoszenie ich gdzie indziej
     * psułoby historię i FIFO.
     */
    emergencyFund: integer('emergency_fund', { mode: 'boolean' }).notNull().default(false),
    /** Ekspozycja ETF-a na spółki, do wykrywania nakładania się funduszy. */
    holdings: text('holdings', { mode: 'json' }).$type<{ symbol: string; weightBp: number }[]>(),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('instruments_symbol_uq').on(t.symbol),
    index('instruments_asset_class_idx').on(t.assetClass),
    index('instruments_isin_idx').on(t.isin),
  ],
);

/**
 * Ten sam papier ma inny zapis w każdym źródle: XTB używa "IUIT.UK",
 * Inwestomat "LON:IUIT", Stooq jeszcze inaczej. Bez tej tabeli kolejne
 * importy tworzyłyby duplikaty instrumentów.
 */
export const instrumentAliases = sqliteTable(
  'instrument_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** xtb | inwestomat | stooq | yahoo | coingecko | manual */
    source: text('source').notNull(),
    symbol: text('symbol').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('instrument_aliases_uq').on(t.source, t.symbol),
    index('instrument_aliases_instrument_idx').on(t.instrumentId),
  ],
);

// ─────────────────────────────────────────────────────────────
// Transakcje
// ─────────────────────────────────────────────────────────────
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    portfolioId: integer('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    /** null dla wpłat/wypłat gotówki niezwiązanych z instrumentem. */
    instrumentId: integer('instrument_id').references(() => instruments.id, { onDelete: 'restrict' }),
    /** buy | sell | dividend | interest | fee | tax | deposit | withdrawal | split */
    type: text('type').notNull(),
    tradeDate: text('trade_date').notNull(),
    settlementDate: text('settlement_date'),
    qtyE8: integer('qty_e8').notNull().default(0),
    /** Cena w walucie instrumentu. */
    priceE8: integer('price_e8').notNull().default(0),
    /** Kwota brutto w walucie transakcji (bez prowizji). */
    grossMinor: integer('gross_minor').notNull().default(0),
    feeMinor: integer('fee_minor').notNull().default(0),
    /** Podatek u źródła / pobrany przez brokera. */
    taxMinor: integer('tax_minor').notNull().default(0),
    currency: text('currency').notNull(),
    /** Kurs NBP tabela A z dnia poprzedzającego transakcję (D-1) — tak liczy skarbówka. */
    fxRateE6: integer('fx_rate_e6').notNull().default(1_000_000),
    fxDate: text('fx_date'),
    /**
     * Kurs faktycznie zastosowany przez brokera przy rozliczeniu. Bywa inny niż
     * NBP D-1 (XTB przelicza po własnym kursie z chwili transakcji), więc bez
     * tego pola saldo gotówki nie zgadzałoby się z wyciągiem.
     */
    settlementFxRateE6: integer('settlement_fx_rate_e6'),
    /** Faktyczny przepływ gotówki w PLN, z prowizją. Podpisany: ujemny = wypływ. */
    amountPlnMinor: integer('amount_pln_minor').notNull().default(0),
    /**
     * Ta sama kwota przeliczona po kursie NBP D-1 — wyłącznie podstawa
     * rozliczenia podatkowego. Dla transakcji w PLN równa `amount_pln_minor`.
     */
    taxAmountPlnMinor: integer('tax_amount_pln_minor').notNull().default(0),
    note: text('note'),
    importBatchId: integer('import_batch_id').references(() => importBatches.id, { onDelete: 'set null' }),
    /**
     * Hash znormalizowanego wiersza źródłowego. Gwarantuje idempotencję
     * ponownego importu tego samego pliku.
     */
    rowHash: text('row_hash'),
    /** Hash logiczny (portfel+data+instrument+typ+ilość+kwota) do dedup między źródłami. */
    dedupeKey: text('dedupe_key'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('transactions_row_hash_uq').on(t.rowHash),
    index('transactions_portfolio_date_idx').on(t.portfolioId, t.tradeDate),
    index('transactions_instrument_idx').on(t.instrumentId, t.tradeDate),
    index('transactions_type_idx').on(t.type),
    index('transactions_dedupe_idx').on(t.dedupeKey),
  ],
);

/**
 * Wynik FIFO per sprzedaż. Tabela jest cache'em — źródłem prawdy pozostają
 * transakcje, a zawartość przeliczamy od zera po każdej mutacji, żeby edycja
 * wstecz nie rozjechała historii.
 */
export const realizedGains = sqliteTable(
  'realized_gains',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sellTransactionId: integer('sell_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    buyTransactionId: integer('buy_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    portfolioId: integer('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** securities | crypto — krypto rozliczane osobno w PIT-38. */
    taxCategory: text('tax_category').notNull(),
    /** Skopiowane z portfela, żeby raport nie musiał joinować przy każdym wierszu. */
    taxExempt: integer('tax_exempt', { mode: 'boolean' }).notNull().default(false),
    saleDate: text('sale_date').notNull(),
    purchaseDate: text('purchase_date').notNull(),
    qtyE8: integer('qty_e8').notNull(),
    /** Wynik faktyczny — po kursach rozliczeniowych brokera. Do prezentacji. */
    costPlnMinor: integer('cost_pln_minor').notNull(),
    proceedsPlnMinor: integer('proceeds_pln_minor').notNull(),
    gainPlnMinor: integer('gain_pln_minor').notNull(),
    /** Wynik podatkowy — po kursach NBP D-1. To trafia do PIT-38. */
    taxCostPlnMinor: integer('tax_cost_pln_minor').notNull().default(0),
    taxProceedsPlnMinor: integer('tax_proceeds_pln_minor').notNull().default(0),
    taxGainPlnMinor: integer('tax_gain_pln_minor').notNull().default(0),
    year: integer('year').notNull(),
  },
  (t) => [
    index('realized_gains_year_idx').on(t.year, t.taxCategory),
    index('realized_gains_portfolio_idx').on(t.portfolioId),
    index('realized_gains_sell_idx').on(t.sellTransactionId),
  ],
);

// ─────────────────────────────────────────────────────────────
// Ceny, kursy, snapshoty
// ─────────────────────────────────────────────────────────────
export const pricesDaily = sqliteTable(
  'prices_daily',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    openE8: integer('open_e8'),
    highE8: integer('high_e8'),
    lowE8: integer('low_e8'),
    closeE8: integer('close_e8').notNull(),
    volume: integer('volume'),
    source: text('source').notNull(),
    fetchedAt: text('fetched_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.date] }), index('prices_daily_date_idx').on(t.date)],
);

/** Ostatnia znana cena (intraday). Jedna aktualna wartość na instrument. */
export const quotes = sqliteTable('quotes', {
  instrumentId: integer('instrument_id')
    .primaryKey()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  priceE8: integer('price_e8').notNull(),
  currency: text('currency').notNull(),
  /** Poprzednie zamknięcie — do liczenia zmiany dziennej. */
  prevCloseE8: integer('prev_close_e8'),
  ts: text('ts').notNull(),
  source: text('source').notNull(),
});

export const fxRates = sqliteTable(
  'fx_rates',
  {
    currency: text('currency').notNull(),
    date: text('date').notNull(),
    rateE6: integer('rate_e6').notNull(),
    /** Tabela NBP: A (średni) — używana do celów podatkowych. */
    tableName: text('table_name').notNull().default('A'),
    source: text('source').notNull().default('NBP'),
    fetchedAt: text('fetched_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.currency, t.date] })],
);

export const portfolioSnapshots = sqliteTable(
  'portfolio_snapshots',
  {
    portfolioId: integer('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    valuePlnMinor: integer('value_pln_minor').notNull(),
    cashPlnMinor: integer('cash_pln_minor').notNull().default(0),
    /** Kapitał wpłacony netto (wpłaty - wypłaty) na dany dzień. */
    investedPlnMinor: integer('invested_pln_minor').notNull().default(0),
    realizedPlnMinor: integer('realized_pln_minor').notNull().default(0),
    unrealizedPlnMinor: integer('unrealized_pln_minor').notNull().default(0),
    byAssetClass: text('by_asset_class', { mode: 'json' }).$type<Record<string, number>>(),
    /** true gdy wpis pochodzi z importu historii, a nie z naszego crona. */
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.date] }), index('portfolio_snapshots_date_idx').on(t.date)],
);

/** Historyczne serie benchmarków (WIG, S&P 500) — trzymane osobno od instrumentów. */
export const benchmarkSeries = sqliteTable(
  'benchmark_series',
  {
    symbol: text('symbol').notNull(),
    date: text('date').notNull(),
    closeE8: integer('close_e8').notNull(),
    currency: text('currency').notNull().default('PLN'),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

// ─────────────────────────────────────────────────────────────
// Obligacje detaliczne
// ─────────────────────────────────────────────────────────────
export const bondHoldings = sqliteTable(
  'bond_holdings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    portfolioId: integer('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: integer('instrument_id').references(() => instruments.id, { onDelete: 'set null' }),
    /** Oznaczenie emisji, np. EDO0536. */
    series: text('series').notNull(),
    /** EDO | COI | TOS | ROR | DOR | ROS | ROD | OTS */
    kind: text('kind').notNull(),
    purchaseDate: text('purchase_date').notNull(),
    count: integer('count').notNull(),
    nominalMinor: integer('nominal_minor').notNull().default(10_000),
    /** Parametry emisji zapisane per zakup — kolejne emisje mają inne stawki. */
    firstYearRateBp: integer('first_year_rate_bp').notNull(),
    marginBp: integer('margin_bp').notNull().default(0),
    termMonths: integer('term_months').notNull(),
    maturityDate: text('maturity_date').notNull(),
    /** annual | none — EDO kapitalizuje rocznie, COI wypłaca odsetki. */
    capitalization: text('capitalization').notNull().default('annual'),
    earlyRedemptionFeeMinor: integer('early_redemption_fee_minor').notNull().default(0),
    redeemedAt: text('redeemed_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('bond_holdings_portfolio_idx').on(t.portfolioId)],
);

/** Odczyty inflacji GUS do indeksacji obligacji EDO/COI. */
export const cpiRates = sqliteTable(
  'cpi_rates',
  {
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    /** Inflacja rok do roku w punktach bazowych. */
    cpiYoyBp: integer('cpi_yoy_bp').notNull(),
    source: text('source').notNull().default('GUS'),
  },
  (t) => [primaryKey({ columns: [t.year, t.month] })],
);

// ─────────────────────────────────────────────────────────────
// Alokacja docelowa i kontrola ryzyka
// ─────────────────────────────────────────────────────────────
export const targetAllocations = sqliteTable(
  'target_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** null = cel dla widoku zbiorczego wszystkich portfeli. */
    portfolioId: integer('portfolio_id').references(() => portfolios.id, { onDelete: 'cascade' }),
    /** asset_class | instrument | sector | geo | currency */
    dimension: text('dimension').notNull(),
    key: text('key').notNull(),
    targetBp: integer('target_bp').notNull(),
    toleranceBp: integer('tolerance_bp').notNull().default(500),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('target_allocations_uq').on(t.portfolioId, t.dimension, t.key)],
);

// ─────────────────────────────────────────────────────────────
// Newsy i watchlist
// ─────────────────────────────────────────────────────────────
export const watchlist = sqliteTable(
  'watchlist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('watchlist_instrument_uq').on(t.instrumentId)],
);

export const newsItems = sqliteTable(
  'news_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentId: integer('instrument_id').references(() => instruments.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    url: text('url').notNull(),
    urlHash: text('url_hash').notNull(),
    title: text('title').notNull(),
    publishedAt: text('published_at').notNull(),
    rawSummary: text('raw_summary'),
    /** Pola AI puste, gdy brak ANTHROPIC_API_KEY — wtedy UI pokazuje sam nagłówek. */
    aiSummaryPl: text('ai_summary_pl'),
    sentiment: text('sentiment'),
    importance: text('importance'),
    aiSignal: text('ai_signal', { mode: 'json' }).$type<{ hold: string[]; reduce: string[]; rationale: string }>(),
    aiModel: text('ai_model'),
    aiAnalyzedAt: text('ai_analyzed_at'),
    fetchedAt: text('fetched_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('news_items_url_hash_uq').on(t.urlHash),
    index('news_items_instrument_idx').on(t.instrumentId, t.publishedAt),
    index('news_items_published_idx').on(t.publishedAt),
  ],
);

/**
 * Historia zdarzeń korporacyjnych pobrana od dostawcy cen: wypłaty dywidend
 * i splity. Służy do zbudowania kalendarza dywidend i do wykrycia splitu,
 * którego użytkownik nie wprowadził ręcznie.
 */
export const dividendEvents = sqliteTable(
  'dividend_events',
  {
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    /** Dzień ustalenia prawa do dywidendy (ex-date). */
    exDate: text('ex_date').notNull(),
    amountE8: integer('amount_e8').notNull(),
    currency: text('currency').notNull(),
    source: text('source').notNull(),
    fetchedAt: text('fetched_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.exDate] })],
);

/** Terminy raportów okresowych — do przypomnień. */
export const reportDates = sqliteTable(
  'report_dates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    label: text('label').notNull(),
    /** manual | provider — skąd wzięliśmy termin. Zawsze ustawiane wprost w kodzie. */
    source: text('source'),
    note: text('note'),
  },
  (t) => [uniqueIndex('report_dates_uq').on(t.instrumentId, t.date, t.label)],
);

// ─────────────────────────────────────────────────────────────
// Alerty i powiadomienia
// ─────────────────────────────────────────────────────────────
export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    portfolioId: integer('portfolio_id').references(() => portfolios.id, { onDelete: 'cascade' }),
    instrumentId: integer('instrument_id').references(() => instruments.id, { onDelete: 'cascade' }),
    condition: text('condition', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Zapobiega zalewaniu Telegrama tym samym alertem. */
    cooldownMinutes: integer('cooldown_minutes').notNull().default(720),
    lastTriggeredAt: text('last_triggered_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('alerts_kind_idx').on(t.kind, t.enabled)],
);

export const alertEvents = sqliteTable(
  'alert_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    triggeredAt: text('triggered_at').notNull().default(now),
    message: text('message').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    deliveryError: text('delivery_error'),
  },
  (t) => [index('alert_events_triggered_idx').on(t.triggeredAt)],
);

// ─────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────
export const importBatches = sqliteTable(
  'import_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parserId: text('parser_id').notNull(),
    filename: text('filename').notNull(),
    /** Hash pliku — ponowny wrzut tego samego pliku jest rozpoznawany. */
    fileHash: text('file_hash').notNull(),
    portfolioId: integer('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    /** pending | committed | discarded */
    status: text('status').notNull().default('pending'),
    mapping: text('mapping', { mode: 'json' }).$type<Record<string, string | null>>(),
    /** Sparsowane wiersze zachowane do momentu zatwierdzenia przez użytkownika. */
    rows: text('rows', { mode: 'json' }).$type<unknown[]>(),
    stats: text('stats', { mode: 'json' }).$type<Record<string, number>>(),
    createdAt: text('created_at').notNull().default(now),
    committedAt: text('committed_at'),
  },
  (t) => [index('import_batches_file_hash_idx').on(t.fileHash)],
);

// ─────────────────────────────────────────────────────────────
// System
// ─────────────────────────────────────────────────────────────
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_expires_idx').on(t.expiresAt)],
);

/** Stan dostawców cen — do circuit breakera i widoku diagnostycznego. */
export const providerHealth = sqliteTable('provider_health', {
  id: text('id').primaryKey(),
  lastSuccessAt: text('last_success_at'),
  lastErrorAt: text('last_error_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Do kiedy dostawca jest wyłączony po serii błędów. */
  disabledUntil: text('disabled_until'),
});

/** Log zadań cron — żeby widzieć, co i kiedy się wykonało. */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    job: text('job').notNull(),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
    /** ok | error | skipped */
    status: text('status').notNull().default('ok'),
    message: text('message'),
  },
  (t) => [index('job_runs_job_idx').on(t.job, t.startedAt)],
);

// ─────────────────────────────────────────────────────────────
// Relacje
// ─────────────────────────────────────────────────────────────
export const portfoliosRelations = relations(portfolios, ({ many }) => ({
  transactions: many(transactions),
  snapshots: many(portfolioSnapshots),
  bonds: many(bondHoldings),
}));

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  transactions: many(transactions),
  aliases: many(instrumentAliases),
  prices: many(pricesDaily),
  news: many(newsItems),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  portfolio: one(portfolios, { fields: [transactions.portfolioId], references: [portfolios.id] }),
  instrument: one(instruments, { fields: [transactions.instrumentId], references: [instruments.id] }),
}));

export const instrumentAliasesRelations = relations(instrumentAliases, ({ one }) => ({
  instrument: one(instruments, { fields: [instrumentAliases.instrumentId], references: [instruments.id] }),
}));

export const newsItemsRelations = relations(newsItems, ({ one }) => ({
  instrument: one(instruments, { fields: [newsItems.instrumentId], references: [instruments.id] }),
}));

export type PortfolioRow = typeof portfolios.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type RealizedGainRow = typeof realizedGains.$inferSelect;
export type PriceDailyRow = typeof pricesDaily.$inferSelect;
export type QuoteRow = typeof quotes.$inferSelect;
export type FxRateRow = typeof fxRates.$inferSelect;
export type SnapshotRow = typeof portfolioSnapshots.$inferSelect;
export type BondHoldingRow = typeof bondHoldings.$inferSelect;
export type TargetAllocationRow = typeof targetAllocations.$inferSelect;
export type NewsItemRow = typeof newsItems.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;
export type ImportBatchRow = typeof importBatches.$inferSelect;
export type DividendEventRow = typeof dividendEvents.$inferSelect;
export type ReportDateRow = typeof reportDates.$inferSelect;
