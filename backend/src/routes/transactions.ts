import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import {
  idParam,
  transactionCreateSchema,
  transactionQuerySchema,
  transactionUpdateSchema,
} from '@portfolio/shared';
import type { Transaction, TransactionType } from '@portfolio/shared';
import { db } from '../db/index.js';
import { accounts, instruments, portfolios, transactions } from '../db/schema.js';
import type { TransactionRow } from '../db/schema.js';
import { asyncHandler } from '../lib/http.js';
import { backfillInstrumentHistory } from '../services/prices.js';
import { toInstrumentDto } from '../services/positions.js';
import {
  createTransaction,
  deleteTransaction,
  listDeletedTransactions,
  listTransactions,
  purgeDeletedTransaction,
  restoreTransaction,
  updateTransaction,
} from '../services/transactions.js';

export const transactionsRouter = Router();

function hydrate(rows: TransactionRow[]): Transaction[] {
  const instrumentIds = [...new Set(rows.map((r) => r.instrumentId).filter((id): id is number => id !== null))];
  const instrumentMap = new Map(
    instrumentIds.length > 0
      ? db
          .select()
          .from(instruments)
          .where(inArray(instruments.id, instrumentIds))
          .all()
          .map((i) => [i.id, i])
      : [],
  );
  const portfolioMap = new Map(
    db
      .select()
      .from(portfolios)
      .all()
      .map((p) => [p.id, p.name]),
  );
  const accountMap = new Map(
    db
      .select()
      .from(accounts)
      .all()
      .map((a) => [a.id, a.name]),
  );

  return rows.map((row) => ({
    id: row.id,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
    accountId: row.accountId,
    type: row.type as TransactionType,
    tradeDate: row.tradeDate,
    settlementDate: row.settlementDate,
    qtyE8: row.qtyE8,
    priceE8: row.priceE8,
    grossMinor: row.grossMinor,
    feeMinor: row.feeMinor,
    taxMinor: row.taxMinor,
    currency: row.currency,
    fxRateE6: row.fxRateE6,
    fxDate: row.fxDate,
    settlementFxRateE6: row.settlementFxRateE6,
    amountPlnMinor: row.amountPlnMinor,
    taxAmountPlnMinor: row.taxAmountPlnMinor,
    note: row.note,
    importBatchId: row.importBatchId,
    createdAt: row.createdAt,
    instrument: row.instrumentId ? (instrumentMap.get(row.instrumentId) ? toInstrumentDto(instrumentMap.get(row.instrumentId)!) : null) : null,
    portfolioName: portfolioMap.get(row.portfolioId) ?? '',
    accountName: row.accountId === null ? null : (accountMap.get(row.accountId) ?? null),
  }));
}

transactionsRouter.get('/', (req, res, next) => {
  const parsed = transactionQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json(hydrate(listTransactions(parsed.data)));
});

/**
 * Kosz — transakcje usunięte, ale możliwe do przywrócenia.
 *
 * Trasa musi być zadeklarowana przed `/:id`, inaczej Express potraktowałby
 * „kosz" jako identyfikator.
 */
transactionsRouter.get('/kosz', (_req, res) => {
  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));
  const portfolioMap = new Map(db.select().from(portfolios).all().map((p) => [p.id, p.name]));
  const accountMap = new Map(db.select().from(accounts).all().map((a) => [a.id, a.name]));

  res.json(
    listDeletedTransactions().map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      type: entry.type as TransactionType,
      tradeDate: entry.tradeDate,
      amountPlnMinor: entry.amountPlnMinor,
      deletedAt: entry.deletedAt,
      portfolioName: portfolioMap.get(entry.portfolioId) ?? '',
      accountName: entry.accountId === null ? null : (accountMap.get(entry.accountId) ?? null),
      instrument: entry.instrumentId ? (instrumentMap.get(entry.instrumentId) ? toInstrumentDto(instrumentMap.get(entry.instrumentId)!) : null) : null,
    })),
  );
});

transactionsRouter.post('/kosz/:id/przywroc', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);

  try {
    const { transaction, warnings } = restoreTransaction(id.data);
    res.json({ transaction: hydrate([transaction])[0], warnings });
  } catch (err) {
    next(err);
  }
});

/** Trwałe usunięcie z kosza — po tym transakcji nie da się już odzyskać. */
transactionsRouter.delete('/kosz/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  purgeDeletedTransaction(id.data);
  res.json({ ok: true });
});

transactionsRouter.get('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const row = db.select().from(transactions).where(eq(transactions.id, id.data)).get();
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Nie ma takiej transakcji' });
  res.json(hydrate([row])[0]);
});

transactionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = transactionCreateSchema.parse(req.body);
    const { transaction, warnings } = await createTransaction(parsed);

    /*
     * Nowa pozycja potrzebuje historii notowań — bez niej wykres wartości
     * portfela ma dziurę, a analiza techniczna nie ma czego liczyć. Leci w tle,
     * bo pobranie kilkuset sesji trwa dłużej niż zapis transakcji.
     */
    if (transaction.instrumentId !== null) {
      void backfillInstrumentHistory(transaction.instrumentId);
    }

    res.status(201).json({ transaction: hydrate([transaction])[0], warnings });
  }),
);

transactionsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const patch = transactionUpdateSchema.parse(req.body);
    const { transaction, warnings } = await updateTransaction(id, patch);
    res.json({ transaction: hydrate([transaction])[0], warnings });
  }),
);

transactionsRouter.delete('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const warnings = deleteTransaction(id.data);
  res.json({ ok: true, warnings });
});
