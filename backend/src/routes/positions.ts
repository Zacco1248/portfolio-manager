import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { activePortfolioIds, buildPositions } from '../services/positions.js';
import { instrumentsNeedingPrices, refreshQuotes } from '../services/prices.js';
import { refreshFxRates } from '../services/fx.js';

export const positionsRouter = Router();

const querySchema = z.object({
  portfolioId: z.coerce.number().int().positive().optional(),
});

positionsRouter.get('/', (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const ids = activePortfolioIds(parsed.data.portfolioId);
  const result = buildPositions(ids);

  res.json({
    positions: result.positions,
    cash: [...result.cashByPortfolio.entries()].map(([portfolioId, cashPlnMinor]) => ({
      portfolioId,
      cashPlnMinor,
    })),
    totalValuePlnMinor: result.totalValuePlnMinor,
  });
});

/** Ręczne wymuszenie odświeżenia cen — przycisk w UI obok znacznika czasu. */
positionsRouter.post(
  '/refresh',
  asyncHandler(async (_req, res) => {
    const fx = await refreshFxRates();
    const prices = await refreshQuotes(instrumentsNeedingPrices());
    res.json({ ok: true, fx, prices });
  }),
);
