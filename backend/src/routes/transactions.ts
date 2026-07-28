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
import { instruments, portfolios, transactions } from '../db/schema.js';
import type { TransactionRow } from '../db/schema.js';
import { asyncHandler } from '../lib/http.js';
import { backfillInstrumentHistory } from '../services/prices.js';
import { toInstrumentDto } from '../services/positions.js';
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
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

  return rows.map((row) => ({
    id: row.id,
    portfolioId: row.portfolioId,
    instrumentId: row.instrumentId,
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
  }));
}

transactionsRouter.get('/', (req, res, next) => {
  const parsed = transactionQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json(hydrate(listTransactions(parsed.data)));
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
