import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  convertMinor,
  minorDecimals,
  parseDecimal,
  positionValueMinor,
  toMinor,
  toPrice,
  toQty,
} from '@portfolio/shared';
import type { AssetClass, TransactionCreateInput, TransactionType } from '@portfolio/shared';
import { db } from '../db/index.js';
import { accounts, deletedTransactions, instruments, portfolios, realizedGains, transactions } from '../db/schema.js';
import type { DeletedTransactionRow, TransactionRow } from '../db/schema.js';
import { config } from '../config.js';
import { nowIso } from '../lib/dates.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { computeFifo, groupForFifo, parseGroupKey } from './fifo.js';
import type { FifoTransaction } from './fifo.js';
import { getTaxFxRate } from './fx.js';

const log = createLogger('transactions');

/**
 * Znak przepływu gotówkowego dla każdego typu operacji. `amount_pln_minor`
 * jest zawsze podpisany z punktu widzenia portfela: ujemny = pieniądze wyszły.
 * Ta jedna konwencja obsługuje saldo gotówki, XIRR i FIFO naraz.
 */
const CASH_SIGN: Record<TransactionType, -1 | 1> = {
  buy: -1,
  sell: 1,
  dividend: 1,
  interest: 1,
  fee: -1,
  tax: -1,
  deposit: 1,
  withdrawal: -1,
  split: 1,
};

export interface PreparedTransaction {
  portfolioId: number;
  instrumentId: number | null;
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
  fxRateE6: number;
  fxDate: string | null;
  settlementFxRateE6: number | null;
  amountPlnMinor: number;
  taxAmountPlnMinor: number;
  note: string | null;
  rowHash: string | null;
  dedupeKey: string;
}

/**
 * Przelicza wejście użytkownika (albo wiersz importu) na rekord bazy:
 * skaluje liczby, dobiera kurs NBP i wylicza podpisany przepływ w PLN.
 */
export async function prepareTransaction(
  input: TransactionCreateInput & { rowHash?: string | null },
): Promise<PreparedTransaction> {
  const currency = input.currency.toUpperCase();
  const decimals = minorDecimals(currency);

  const qtyE8 = input.quantity === undefined ? 0 : toQty(input.quantity);
  const priceE8 = input.price === undefined ? 0 : toPrice(input.price);
  const feeMinor = Math.abs(parseDecimal(input.fee ?? 0, decimals));
  const taxMinor = Math.abs(parseDecimal(input.tax ?? 0, decimals));

  // Dla kupna/sprzedaży kwota brutto wynika z ilości i ceny; dla pozostałych
  // typów użytkownik podaje ją wprost.
  const grossMinor =
    input.grossAmount !== undefined
      ? Math.abs(parseDecimal(input.grossAmount, decimals))
      : Math.abs(positionValueMinor(qtyE8, priceE8, currency));

  // Kurs podatkowy (NBP D-1) i kurs rozliczeniowy brokera to dwie różne
  // liczby. Pierwszy decyduje o podstawie w PIT-38, drugi o tym, ile pieniędzy
  // faktycznie ubyło z konta. Mieszanie ich rozjeżdża albo saldo, albo podatek.
  const { fxRateE6, fxDate } = await resolveTaxFx(input, currency);
  const settlementFxRateE6 =
    input.fxRate !== undefined && currency !== config.baseCurrency ? parseDecimal(input.fxRate, 6) : null;

  const netMinor = netAmountMinor(input.type, grossMinor, feeMinor, taxMinor);
  const sign = CASH_SIGN[input.type];
  const amountPlnMinor =
    sign * convertMinor(netMinor, settlementFxRateE6 ?? fxRateE6, currency, config.baseCurrency);
  const taxAmountPlnMinor = sign * convertMinor(netMinor, fxRateE6, currency, config.baseCurrency);

  return {
    portfolioId: input.portfolioId,
    instrumentId: input.instrumentId ?? null,
    accountId: input.accountId ?? null,
    type: input.type,
    tradeDate: input.tradeDate,
    settlementDate: input.settlementDate ?? null,
    qtyE8,
    priceE8,
    grossMinor,
    feeMinor,
    taxMinor,
    currency,
    fxRateE6,
    fxDate,
    settlementFxRateE6,
    amountPlnMinor,
    taxAmountPlnMinor,
    note: input.note ?? null,
    rowHash: input.rowHash ?? null,
    dedupeKey: buildDedupeKey({
      portfolioId: input.portfolioId,
      instrumentId: input.instrumentId ?? null,
      type: input.type,
      tradeDate: input.tradeDate,
      qtyE8,
      amountPlnMinor,
    }),
  };
}

/**
 * Kwota netto operacji przed nadaniem znaku:
 *  - kupno powiększa się o prowizję (wchodzi do kosztu nabycia),
 *  - sprzedaż i dywidenda pomniejszają się o prowizję i podatek u źródła.
 */
function netAmountMinor(type: TransactionType, gross: number, fee: number, tax: number): number {
  switch (type) {
    case 'buy':
      return gross + fee;
    case 'sell':
    case 'dividend':
    case 'interest':
      return gross - fee - tax;
    default:
      return gross;
  }
}

/**
 * Kurs do celów podatkowych zawsze pochodzi z tabeli A NBP z dnia
 * poprzedzającego transakcję — nawet gdy import przyniósł kurs brokera.
 * Ten drugi trafia do `settlementFxRateE6` i służy tylko do odtworzenia
 * faktycznego przepływu gotówki.
 *
 * Wyjątek: gdy NBP jest nieosiągalny, kurs brokera jest lepszym przybliżeniem
 * niż brak wyceny.
 */
async function resolveTaxFx(
  input: TransactionCreateInput,
  currency: string,
): Promise<{ fxRateE6: number; fxDate: string | null }> {
  if (currency === config.baseCurrency) return { fxRateE6: 1_000_000, fxDate: null };

  try {
    const { rateE6, fxDate } = await getTaxFxRate(currency, input.tradeDate);
    return { fxRateE6: rateE6, fxDate };
  } catch (err) {
    if (input.fxRate !== undefined) {
      log.warn(
        `Brak kursu NBP dla ${currency} na ${input.tradeDate} — używam kursu brokera. ` +
          `Podstawa podatkowa może wymagać korekty.`,
      );
      return { fxRateE6: parseDecimal(input.fxRate, 6), fxDate: null };
    }
    throw err;
  }
}

/**
 * Klucz logiczny do wykrywania duplikatów między źródłami.
 *
 * Konto świadomie nie wchodzi do klucza: ta sama operacja opisana raz
 * z kontem, a raz bez (bo drugie źródło go nie podaje) to nadal jedna
 * operacja. Dopisanie konta osłabiłoby wykrywanie duplikatów.
 */
export function buildDedupeKey(tx: {
  portfolioId: number;
  instrumentId: number | null;
  type: TransactionType;
  tradeDate: string;
  qtyE8: number;
  amountPlnMinor: number;
}): string {
  return [tx.portfolioId, tx.tradeDate, tx.instrumentId ?? 'cash', tx.type, tx.qtyE8, tx.amountPlnMinor].join('|');
}

export interface CreateResult {
  transaction: TransactionRow;
  warnings: string[];
}

export async function createTransaction(
  input: TransactionCreateInput & {
    rowHash?: string | null;
    importBatchId?: number | null;
    /**
     * Tryb wsadowy: pomija przeliczenie FIFO po tej transakcji. Import wywołuje
     * jedno przeliczenie na końcu — bez tego wgranie n wierszy kosztowałoby
     * n pełnych przeliczeń portfela.
     */
    deferRecompute?: boolean;
  },
): Promise<CreateResult> {
  const portfolio = db.select().from(portfolios).where(eq(portfolios.id, input.portfolioId)).get();
  if (!portfolio) throw notFound('Nie ma takiego portfela');

  if (input.instrumentId !== undefined && input.instrumentId !== null) {
    const instrument = db.select().from(instruments).where(eq(instruments.id, input.instrumentId)).get();
    if (!instrument) throw notFound('Nie ma takiego instrumentu');
  }

  if (input.accountId !== undefined && input.accountId !== null) {
    const account = db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
    if (!account) throw notFound('Nie ma takiego konta');
  }

  const prepared = await prepareTransaction(input);

  const row = db
    .insert(transactions)
    .values({ ...prepared, importBatchId: input.importBatchId ?? null })
    .returning()
    .get();

  if (input.deferRecompute) return { transaction: row, warnings: [] };

  const warnings = recomputeRealizedGains(prepared.portfolioId, prepared.instrumentId);
  return { transaction: row, warnings };
}

export async function updateTransaction(
  id: number,
  patch: Record<string, unknown>,
): Promise<CreateResult> {
  const current = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!current) throw notFound('Nie ma takiej transakcji');

  // Edycja idzie przez tę samą ścieżkę co tworzenie, żeby kwoty i kurs
  // przeliczyły się dokładnie tak samo.
  const merged = {
    portfolioId: current.portfolioId,
    instrumentId: current.instrumentId ?? undefined,
    // Konto wolno zmienić — nie wchodzi ani do FIFO, ani do dedupe.
    // `null` w patchu znaczy „odepnij", brak klucza znaczy „zostaw".
    accountId:
      patch.accountId !== undefined
        ? ((patch.accountId as number | null) ?? undefined)
        : (current.accountId ?? undefined),
    type: current.type as TransactionType,
    tradeDate: (patch.tradeDate as string) ?? current.tradeDate,
    settlementDate: current.settlementDate ?? undefined,
    quantity: patch.quantity !== undefined ? (patch.quantity as string) : formatFromE8(current.qtyE8, 8),
    price: patch.price !== undefined ? (patch.price as string) : formatFromE8(current.priceE8, 8),
    grossAmount:
      patch.grossAmount !== undefined
        ? (patch.grossAmount as string)
        : formatFromE8(current.grossMinor, minorDecimals(current.currency)),
    fee: patch.fee !== undefined ? (patch.fee as string) : formatFromE8(current.feeMinor, minorDecimals(current.currency)),
    tax: patch.tax !== undefined ? (patch.tax as string) : formatFromE8(current.taxMinor, minorDecimals(current.currency)),
    currency: current.currency,
    // `fxRate` na wejściu oznacza kurs rozliczeniowy brokera; kurs podatkowy
    // jest zawsze dobierany z NBP, więc nie przenosimy go tutaj.
    fxRate:
      patch.fxRate !== undefined
        ? (patch.fxRate as string)
        : current.settlementFxRateE6 !== null
          ? formatFromE8(current.settlementFxRateE6, 6)
          : undefined,
    fxDate: (patch.fxDate as string) ?? current.fxDate ?? undefined,
    note: patch.note !== undefined ? (patch.note as string) : (current.note ?? undefined),
  } as TransactionCreateInput;

  // Dla kupna/sprzedaży kwota ma wynikać z ilości × cena, a nie z zapisanej
  // wcześniej wartości brutto — inaczej zmiana ceny nie miałaby efektu.
  if (merged.type === 'buy' || merged.type === 'sell') delete (merged as { grossAmount?: unknown }).grossAmount;

  const prepared = await prepareTransaction(merged);

  const row = db
    .update(transactions)
    .set({ ...prepared, updatedAt: nowIso() })
    .where(eq(transactions.id, id))
    .returning()
    .get();

  const warnings = new Set(recomputeRealizedGains(current.portfolioId, current.instrumentId));
  if (row.portfolioId !== current.portfolioId || row.instrumentId !== current.instrumentId) {
    for (const w of recomputeRealizedGains(row.portfolioId, row.instrumentId)) warnings.add(w);
  }

  return { transaction: row, warnings: [...warnings] };
}

function formatFromE8(value: number, decimals: number): string {
  const negative = value < 0;
  const s = Math.abs(value).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? `.${s.slice(s.length - decimals)}` : '';
  return `${negative ? '-' : ''}${int}${frac}`;
}

/**
 * Usuwa transakcję, zachowując jej kopię w koszu.
 *
 * Wiersz znika z `transactions`, więc żaden odczyt liczący pieniądze nie musi
 * go pomijać — pełna treść ląduje w `deleted_transactions` i da się ją cofnąć.
 */
export function deleteTransaction(id: number): string[] {
  const current = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!current) throw notFound('Nie ma takiej transakcji');

  db.transaction((tx) => {
    tx.insert(deletedTransactions)
      .values({
        transactionId: current.id,
        portfolioId: current.portfolioId,
        instrumentId: current.instrumentId,
        accountId: current.accountId,
        type: current.type,
        tradeDate: current.tradeDate,
        amountPlnMinor: current.amountPlnMinor,
        payload: current as unknown as Record<string, unknown>,
      })
      .run();
    tx.delete(transactions).where(eq(transactions.id, id)).run();
  });

  return recomputeRealizedGains(current.portfolioId, current.instrumentId);
}

export interface RestoreResult {
  transaction: TransactionRow;
  warnings: string[];
}

/**
 * Przywraca transakcję z kosza.
 *
 * Wiersz wraca z oryginalną treścią, ale nowym identyfikatorem — stary mógł
 * w międzyczasie zostać nadany innej transakcji. Nie ma to znaczenia dla
 * rozliczeń: `realized_gains` jest cache'em liczonym od zera.
 */
export function restoreTransaction(id: number): RestoreResult {
  const entry = db.select().from(deletedTransactions).where(eq(deletedTransactions.id, id)).get();
  if (!entry) throw notFound('Nie ma takiego wpisu w koszu');

  const payload = entry.payload as Record<string, unknown>;
  const { id: _oldId, ...values } = payload;

  /*
   * `row_hash` jest unikalny globalnie. Jeśli po usunięciu ten sam wiersz
   * wrócił przez ponowny import, przywrócenie utworzyłoby duplikat —
   * odmawiamy i mówimy wprost, co się stało.
   */
  const rowHash = values.rowHash as string | null | undefined;
  if (rowHash) {
    const clash = db.select().from(transactions).where(eq(transactions.rowHash, rowHash)).get();
    if (clash) {
      throw conflict(
        'Ta transakcja została w międzyczasie wgrana ponownie przez import — nie ma czego przywracać.',
      );
    }
  }

  const restored = db.transaction((tx) => {
    const row = tx
      .insert(transactions)
      .values(values as typeof transactions.$inferInsert)
      .returning()
      .get();
    tx.delete(deletedTransactions).where(eq(deletedTransactions.id, id)).run();
    return row;
  });

  return { transaction: restored, warnings: recomputeRealizedGains(restored.portfolioId, restored.instrumentId) };
}

/** Zawartość kosza, od najświeżej usuniętych. */
export function listDeletedTransactions(limit = 50): DeletedTransactionRow[] {
  return db.select().from(deletedTransactions).orderBy(desc(deletedTransactions.deletedAt)).limit(limit).all();
}

/** Trwałe usunięcie wpisu z kosza — bez możliwości odzyskania. */
export function purgeDeletedTransaction(id: number): void {
  db.delete(deletedTransactions).where(eq(deletedTransactions.id, id)).run();
}

/**
 * Przelicza zyski zrealizowane od zera dla wskazanego zakresu.
 *
 * Tabela `realized_gains` jest wyłącznie cache'em — źródłem prawdy są
 * transakcje. Pełne przeliczenie po każdej mutacji kosztuje niewiele przy
 * skali osobistego portfela, a gwarantuje, że dodanie transakcji wstecz
 * poprawnie przebuduje kolejność FIFO.
 */
export function recomputeRealizedGains(portfolioId?: number, instrumentId?: number | null): string[] {
  const filters: SQL[] = [];
  if (portfolioId !== undefined) filters.push(eq(transactions.portfolioId, portfolioId));
  if (instrumentId !== undefined && instrumentId !== null) {
    filters.push(eq(transactions.instrumentId, instrumentId));
  }

  const rows = db
    .select()
    .from(transactions)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all();

  const portfolioMeta = new Map(
    db
      .select()
      .from(portfolios)
      .all()
      .map((p) => [p.id, p]),
  );
  const instrumentMeta = new Map(
    db
      .select()
      .from(instruments)
      .all()
      .map((i) => [i.id, i]),
  );

  const groups = groupForFifo(rows);
  const warnings: string[] = [];

  // Usuwamy stare wyniki tylko dla przeliczanego zakresu, żeby nie skasować
  // rozliczeń pozostałych portfeli.
  const deleteFilters: SQL[] = [];
  if (portfolioId !== undefined) deleteFilters.push(eq(realizedGains.portfolioId, portfolioId));
  if (instrumentId !== undefined && instrumentId !== null) {
    deleteFilters.push(eq(realizedGains.instrumentId, instrumentId));
  }
  db.delete(realizedGains)
    .where(deleteFilters.length > 0 ? and(...deleteFilters) : undefined)
    .run();

  for (const [key, groupRows] of groups) {
    const { portfolioId: pid, instrumentId: iid } = parseGroupKey(key);
    const portfolio = portfolioMeta.get(pid);
    const instrument = instrumentMeta.get(iid);
    if (!portfolio || !instrument) continue;

    const fifoInput: FifoTransaction[] = groupRows.map((r) => ({
      id: r.id,
      portfolioId: r.portfolioId,
      instrumentId: r.instrumentId!,
      type: r.type as TransactionType,
      tradeDate: r.tradeDate,
      qtyE8: r.qtyE8,
      amountPlnMinor: r.amountPlnMinor,
      taxAmountPlnMinor: r.taxAmountPlnMinor,
    }));

    const result = computeFifo(fifoInput, {
      assetClass: instrument.assetClass as AssetClass,
      taxExempt: portfolio.taxRegime === 'ike' || portfolio.taxRegime === 'ikze',
    });

    if (result.gains.length > 0) {
      db.insert(realizedGains).values(result.gains).run();
    }

    for (const warning of result.warnings) {
      warnings.push(`${instrument.symbol} (${portfolio.name}): ${warning.message}`);
    }
  }

  if (warnings.length > 0) log.warn(`Przeliczenie FIFO zgłosiło ${warnings.length} ostrzeżeń`);
  return warnings;
}

/** Pełne przeliczenie — używane po imporcie i przy naprawie danych. */
export function recomputeAll(): string[] {
  return recomputeRealizedGains();
}

export interface TransactionFilters {
  portfolioId?: number;
  instrumentId?: number;
  accountId?: number;
  type?: TransactionType;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export function listTransactions(filters: TransactionFilters): TransactionRow[] {
  const conditions: SQL[] = [];
  if (filters.portfolioId) conditions.push(eq(transactions.portfolioId, filters.portfolioId));
  if (filters.instrumentId) conditions.push(eq(transactions.instrumentId, filters.instrumentId));
  if (filters.accountId) conditions.push(eq(transactions.accountId, filters.accountId));
  if (filters.type) conditions.push(eq(transactions.type, filters.type));
  if (filters.from) conditions.push(gte(transactions.tradeDate, filters.from));
  if (filters.to) conditions.push(lte(transactions.tradeDate, filters.to));

  return db
    .select()
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(transactions.tradeDate, transactions.id)
    .limit(filters.limit)
    .offset(filters.offset)
    .all()
    .reverse();
}

/** Wykrywa transakcje wyglądające na duplikat — używane przy imporcie. */
export function findDuplicates(dedupeKeys: string[]): Map<string, number> {
  if (dedupeKeys.length === 0) return new Map();
  const found = new Map<string, number>();
  for (let i = 0; i < dedupeKeys.length; i += 400) {
    const chunk = dedupeKeys.slice(i, i + 400);
    const rows = db
      .select({ id: transactions.id, key: transactions.dedupeKey })
      .from(transactions)
      .where(inArray(transactions.dedupeKey, chunk))
      .all();
    for (const row of rows) if (row.key) found.set(row.key, row.id);
  }
  return found;
}

export function findByRowHash(hashes: string[]): Set<string> {
  const found = new Set<string>();
  if (hashes.length === 0) return found;
  for (let i = 0; i < hashes.length; i += 400) {
    const chunk = hashes.slice(i, i + 400);
    const rows = db
      .select({ hash: transactions.rowHash })
      .from(transactions)
      .where(inArray(transactions.rowHash, chunk))
      .all();
    for (const row of rows) if (row.hash) found.add(row.hash);
  }
  return found;
}

export function toMinorAmount(value: string | number, currency: string): number {
  return toMinor(value, currency);
}
