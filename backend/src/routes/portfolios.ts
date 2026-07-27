import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { idParam, portfolioCreateSchema, portfolioUpdateSchema } from '@portfolio/shared';
import type { Portfolio } from '@portfolio/shared';
import { db } from '../db/index.js';
import { portfolios, transactions } from '../db/schema.js';
import type { PortfolioRow } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';

export const portfoliosRouter = Router();

export function toPortfolioDto(row: PortfolioRow): Portfolio {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    taxRegime: row.taxRegime as Portfolio['taxRegime'],
    baseCurrency: row.baseCurrency,
    broker: row.broker,
    note: row.note,
    archived: row.archived,
    createdAt: row.createdAt,
  };
}

portfoliosRouter.get('/', (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  const rows = db.select().from(portfolios).orderBy(asc(portfolios.sortOrder), asc(portfolios.id)).all();
  res.json(rows.filter((r) => includeArchived || !r.archived).map(toPortfolioDto));
});

portfoliosRouter.post('/', (req, res, next) => {
  const parsed = portfolioCreateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const existing = db.select().from(portfolios).where(eq(portfolios.name, parsed.data.name)).get();
  if (existing) return next(conflict(`Portfel o nazwie "${parsed.data.name}" już istnieje`));

  const maxOrder = db.select().from(portfolios).all().reduce((max, p) => Math.max(max, p.sortOrder), 0);
  const row = db
    .insert(portfolios)
    .values({
      name: parsed.data.name,
      kind: parsed.data.kind ?? null,
      taxRegime: parsed.data.taxRegime,
      baseCurrency: parsed.data.baseCurrency,
      broker: parsed.data.broker ?? null,
      note: parsed.data.note ?? null,
      sortOrder: maxOrder + 1,
    })
    .returning()
    .get();

  res.status(201).json(toPortfolioDto(row));
});

portfoliosRouter.patch('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const parsed = portfolioUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const current = db.select().from(portfolios).where(eq(portfolios.id, id.data)).get();
  if (!current) return next(notFound('Nie ma takiego portfela'));

  const row = db
    .update(portfolios)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
      ...(parsed.data.taxRegime !== undefined ? { taxRegime: parsed.data.taxRegime } : {}),
      ...(parsed.data.baseCurrency !== undefined ? { baseCurrency: parsed.data.baseCurrency } : {}),
      ...(parsed.data.broker !== undefined ? { broker: parsed.data.broker } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      ...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {}),
    })
    .where(eq(portfolios.id, id.data))
    .returning()
    .get();

  res.json(toPortfolioDto(row));
});

portfoliosRouter.delete('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);

  const current = db.select().from(portfolios).where(eq(portfolios.id, id.data)).get();
  if (!current) return next(notFound('Nie ma takiego portfela'));

  // Usunięcie portfela skasowałoby jego transakcje kaskadowo. Nie robimy tego
  // po cichu — użytkownik ma najpierw świadomie wyczyścić dane albo zarchiwizować.
  const txCount = db.select().from(transactions).where(eq(transactions.portfolioId, id.data)).all().length;
  if (txCount > 0) {
    return next(
      conflict(
        `Portfel ma ${txCount} transakcji. Zarchiwizuj go zamiast usuwać albo najpierw usuń transakcje.`,
        { transactions: txCount },
      ),
    );
  }

  db.delete(portfolios).where(eq(portfolios.id, id.data)).run();
  res.json({ ok: true });
});
