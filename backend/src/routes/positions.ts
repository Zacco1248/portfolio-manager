import { Router } from 'express';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';
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

/**
 * Ręczne wymuszenie odświeżenia cen.
 *
 * Każdy etap jest odporny na własną awarię: niedostępny NBP nie może
 * zablokować pobrania notowań, a brak notowań nie może wywrócić odpowiedzi.
 * Interfejs dostaje wtedy częściowy wynik z opisem, co się nie udało.
 */
positionsRouter.post(
  '/refresh',
  asyncHandler(async (_req, res) => {
    const problems: string[] = [];

    let fx = 'pominięto';
    try {
      fx = await refreshFxRates();
    } catch (err) {
      fx = `błąd: ${errorMessage(err)}`;
      problems.push('kursy walut');
    }

    let prices = { updated: 0, failed: 0, skipped: 0 };
    try {
      prices = await refreshQuotes(instrumentsNeedingPrices());
    } catch (err) {
      problems.push(`notowania (${errorMessage(err)})`);
    }

    res.json({
      ok: problems.length === 0,
      fx,
      prices,
      message:
        problems.length === 0
          ? // Kursy wymieniamy wprost: to ta sama akcja co notowania, ale bez
            // nazwania jej nie było widać, że martwy kurs NBP właśnie się odświeżył.
            `Zaktualizowano ${prices.updated} notowań, ${prices.skipped} bez danych. Kursy NBP: ${fx}.`
          : `Częściowe odświeżenie — nie powiodło się: ${problems.join(', ')}.`,
    });
  }),
);
