import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import {
  DOCUMENT_LIMIT,
  deleteAnalysis,
  listAnalyses,
  explainPriceMove,
  monthlySummary,
  purchaseCheck,
  suggestImportMapping,
  summarizeDocument,
  taxAssistant,
} from '../services/ai-assist.js';

/**
 * Funkcje asystenta. Każda trasa zwraca wyliczone lokalnie fakty niezależnie
 * od tego, czy model jest włączony — wyłączenie AI odbiera komentarz, nie dane.
 */
export const assistRouter = Router();

const portfolioId = z.coerce.number().int().positive().optional();

const monthlySchema = z.object({
  portfolioId,
  /** Miesiąc w formacie RRRR-MM; domyślnie ostatni zamknięty. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Miesiąc w formacie RRRR-MM')
    .optional(),
});

assistRouter.post(
  '/monthly-summary',
  asyncHandler(async (req, res) => {
    const parsed = monthlySchema.parse(req.body ?? {});
    res.json(await monthlySummary(parsed.portfolioId, parsed.month));
  }),
);

assistRouter.post(
  '/price-move',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ instrumentId: z.coerce.number().int().positive() }).parse(req.body ?? {});
    res.json(await explainPriceMove(parsed.instrumentId));
  }),
);

const purchaseSchema = z.object({
  portfolioId,
  symbol: z.string().trim().min(1).max(60),
  /** Kwota zakupu w złotych, jako tekst — parsowanie przez float gubiłoby grosze. */
  amount: z.string().trim().min(1).max(20),
});

assistRouter.post(
  '/purchase-check',
  asyncHandler(async (req, res) => {
    const parsed = purchaseSchema.parse(req.body ?? {});
    const minor = Math.round(Number(parsed.amount.replace(/\s/g, '').replace(',', '.')) * 100);
    if (!Number.isFinite(minor) || minor <= 0) {
      res.status(400).json({ error: { message: 'Kwota musi być liczbą dodatnią' } });
      return;
    }
    res.json(await purchaseCheck(parsed.portfolioId, parsed.symbol, minor));
  }),
);

assistRouter.post(
  '/document',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ text: z.string().min(50).max(DOCUMENT_LIMIT * 2) }).parse(req.body ?? {});
    res.json(await summarizeDocument(parsed.text));
  }),
);

assistRouter.post(
  '/tax',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        portfolioId,
        year: z.coerce.number().int().min(2000).max(2100),
        question: z.string().trim().min(3).max(500),
      })
      .parse(req.body ?? {});
    res.json(await taxAssistant(parsed.year, parsed.portfolioId, parsed.question));
  }),
);

assistRouter.post(
  '/import-mapping',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        headers: z.array(z.string()).min(1).max(60),
        samples: z.array(z.array(z.string())).max(10).default([]),
      })
      .parse(req.body ?? {});
    res.json(await suggestImportMapping(parsed.headers, parsed.samples));
  }),
);

// ── Zapisane analizy ─────────────────────────────────────────
assistRouter.get('/history', (req, res, next) => {
  const parsed = z
    .object({
      kind: z.string().trim().max(40).optional(),
      instrumentId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  res.json(listAnalyses(parsed.data.kind, parsed.data.instrumentId, parsed.data.limit));
});

assistRouter.delete('/history/:id', (req, res, next) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) return next(id.error);
  deleteAnalysis(id.data);
  res.json({ ok: true });
});
