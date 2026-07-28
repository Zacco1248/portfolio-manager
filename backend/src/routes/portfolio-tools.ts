import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  alertCreateSchema,
  alertUpdateSchema,
  bondHoldingSchema,
  idParam,
  notificationSettingsSchema,
  parseDecimal,
  rebalanceQuerySchema,
  settingsUpdateSchema,
  targetAllocationSchema,
  taxReportQuerySchema,
} from '@portfolio/shared';
import type { AlertKind, RebalanceResponse } from '@portfolio/shared';
import { db } from '../db/index.js';
import { alerts, instruments, portfolios } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { evaluateAlerts, recentAlertEvents } from '../services/alerts.js';
import { AI_FEATURES, AI_PROVIDERS, aiStatus, updateAiSettings } from '../services/ai-config.js';
import { classifyAll } from '../services/classify.js';
import { duplicateSummary } from '../services/duplicates.js';
import { buildSuggestions } from '../services/suggestions.js';
import { deleteTransaction } from '../services/transactions.js';
import { buildInsights, buildProjection, emergencyFundStatus } from '../services/insights.js';
import { generateNarrative } from '../services/ai.js';
import {
  addReportDate,
  deleteReportDate,
  dividendHistory,
  etfsMissingHoldings,
  getHoldings,
  listReportDates,
  parseHoldingsText,
  refreshDividendHistory,
  setHoldings,
} from '../services/corporate-actions.js';
import { createBond, deleteBond, listBonds, listCpi, upsertCpi } from '../services/bonds.js';
import {
  addToWatchlist,
  analyzePendingNews,
  fetchNews,
  listNews,
  listWatchlist,
  newsDisclaimer,
  removeFromWatchlist,
} from '../services/news.js';
import { activePortfolioIds, buildPositions, netInvested, toInstrumentDto } from '../services/positions.js';
import { buildPlan } from '../services/rebalance.js';
import { detectConcentration, detectStalePrices, loadThresholds } from '../services/risk.js';
import { allSettings, updateSettings } from '../services/settings.js';
import { deleteTarget, listTargets, loadTargets, targetsSumBp, upsertTarget } from '../services/targets.js';
import { availableTaxYears, buildTaxReport, taxReportToCsv } from '../services/tax.js';
import { testTelegram } from '../services/telegram.js';

export const toolsRouter = Router();

const portfolioQuerySchema = z.object({
  portfolioId: z.coerce.number().int().positive().optional(),
});

// ── Rebalans ─────────────────────────────────────────────────
toolsRouter.get('/rebalance', (req, res, next) => {
  const parsed = rebalanceQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  // Poduszka finansowa nie jest celem inwestycyjnym — wciągnięcie jej do
  // rebalansu kazałoby „dokupić akcji" za pieniądze trzymane na awarie.
  const emergencyIds = new Set(
    db.select().from(portfolios).all().filter((p) => p.emergencyFund).map((p) => p.id),
  );
  const ids = activePortfolioIds(parsed.data.portfolioId).filter((id) => !emergencyIds.has(id));

  const { positions, cashByPortfolio } = buildPositions(ids);
  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const targets = loadTargets(parsed.data.portfolioId ?? null, parsed.data.dimension);
  const contribution = parsed.data.contribution === undefined ? 0 : parseDecimal(parsed.data.contribution, 2);

  const input = {
    positions,
    cashPlnMinor: cash,
    targets,
    dimension: parsed.data.dimension,
    contributionPlnMinor: contribution,
  };

  // Oba warianty liczone naraz — interfejs pokazuje je obok siebie.
  const response: RebalanceResponse = {
    full: buildPlan(input, 'full'),
    buyOnly: buildPlan(input, 'buy_only'),
    warnings: [...detectConcentration(positions, loadThresholds()), ...detectStalePrices(positions)],
  };

  res.json(response);
});

toolsRouter.get('/targets', (req, res) => {
  const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : undefined;
  res.json({
    targets: listTargets(portfolioId),
    sumBp: targetsSumBp(portfolioId ?? null, 'asset_class'),
  });
});

toolsRouter.put('/targets', (req, res, next) => {
  const parsed = targetAllocationSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  res.json(upsertTarget(parsed.data));
});

toolsRouter.delete('/targets/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  deleteTarget(id.data);
  res.json({ ok: true });
});

// ── Alerty ───────────────────────────────────────────────────
toolsRouter.get('/alerts', (_req, res) => {
  const rows = db.select().from(alerts).all();
  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i.symbol]));

  res.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind as AlertKind,
      portfolioId: r.portfolioId,
      instrumentId: r.instrumentId,
      instrumentSymbol: r.instrumentId ? (instrumentMap.get(r.instrumentId) ?? null) : null,
      condition: r.condition,
      enabled: r.enabled,
      cooldownMinutes: r.cooldownMinutes,
      lastTriggeredAt: r.lastTriggeredAt,
    })),
  );
});

toolsRouter.post('/alerts', (req, res, next) => {
  const parsed = alertCreateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const row = db
    .insert(alerts)
    .values({
      kind: parsed.data.kind,
      portfolioId: parsed.data.portfolioId ?? null,
      instrumentId: parsed.data.instrumentId ?? null,
      condition: parsed.data.condition,
      enabled: parsed.data.enabled,
      cooldownMinutes: parsed.data.cooldownMinutes,
    })
    .returning()
    .get();

  res.status(201).json(row);
});

toolsRouter.patch('/alerts/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const parsed = alertUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const current = db.select().from(alerts).where(eq(alerts.id, id.data)).get();
  if (!current) return next(notFound('Nie ma takiego alertu'));

  const row = db
    .update(alerts)
    .set({
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.condition !== undefined ? { condition: parsed.data.condition } : {}),
      ...(parsed.data.cooldownMinutes !== undefined ? { cooldownMinutes: parsed.data.cooldownMinutes } : {}),
    })
    .where(eq(alerts.id, id.data))
    .returning()
    .get();

  res.json(row);
});

toolsRouter.delete('/alerts/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  db.delete(alerts).where(eq(alerts.id, id.data)).run();
  res.json({ ok: true });
});

toolsRouter.get('/alerts/events', (_req, res) => {
  res.json(recentAlertEvents());
});

toolsRouter.post(
  '/alerts/check',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, message: await evaluateAlerts() });
  }),
);

// ── Newsy ────────────────────────────────────────────────────
const newsQuerySchema = z.object({
  instrumentId: z.coerce.number().int().positive().optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  importance: z.enum(['signal', 'noise']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

toolsRouter.get('/news', (req, res, next) => {
  const parsed = newsQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json({ items: listNews(parsed.data), disclaimer: newsDisclaimer });
});

toolsRouter.post(
  '/news/refresh',
  asyncHandler(async (_req, res) => {
    const fetched = await fetchNews();
    const analyzed = await analyzePendingNews();
    res.json({ ok: true, fetched, analyzed });
  }),
);

toolsRouter.get('/watchlist', (_req, res) => {
  res.json(listWatchlist().map(toInstrumentDto));
});

toolsRouter.post('/watchlist', (req, res, next) => {
  const parsed = z.object({ instrumentId: idParam, note: z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  addToWatchlist(parsed.data.instrumentId, parsed.data.note);
  res.status(201).json({ ok: true });
});

toolsRouter.delete('/watchlist/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  removeFromWatchlist(id.data);
  res.json({ ok: true });
});

// ── Obligacje detaliczne ─────────────────────────────────────
toolsRouter.get('/bonds', (req, res) => {
  const portfolioId = req.query.portfolioId ? Number(req.query.portfolioId) : undefined;
  res.json(listBonds(portfolioId));
});

toolsRouter.post('/bonds', (req, res, next) => {
  const parsed = bondHoldingSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  res.status(201).json(createBond(parsed.data));
});

toolsRouter.delete('/bonds/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  deleteBond(id.data);
  res.json({ ok: true });
});

toolsRouter.get('/cpi', (_req, res) => {
  res.json(listCpi());
});

toolsRouter.put('/cpi', (req, res, next) => {
  const parsed = z
    .array(
      z.object({
        year: z.coerce.number().int().min(1990).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        cpiYoyPercent: z.union([z.string(), z.number()]),
      }),
    )
    .safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  res.json({ ok: true, saved: upsertCpi(parsed.data) });
});

// ── Raport podatkowy ─────────────────────────────────────────
toolsRouter.get('/tax/years', (_req, res) => {
  res.json(availableTaxYears());
});

toolsRouter.get('/tax', (req, res, next) => {
  const parsed = taxReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json(buildTaxReport(parsed.data.year, parsed.data.portfolioId));
});

toolsRouter.get('/tax/csv', (req, res, next) => {
  const parsed = taxReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const csv = taxReportToCsv(buildTaxReport(parsed.data.year, parsed.data.portfolioId));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pit38-${parsed.data.year}.csv"`);
  // BOM, żeby Excel poprawnie odczytał polskie znaki.
  res.send(`﻿${csv}`);
});

// ── Ustawienia i integracje ──────────────────────────────────
toolsRouter.get('/settings', (_req, res) => {
  res.json(allSettings());
});

toolsRouter.patch('/settings', (req, res, next) => {
  const parsed = settingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  res.json(updateSettings(parsed.data));
});

toolsRouter.patch('/settings/notifications', (req, res, next) => {
  const parsed = notificationSettingsSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const patch: Record<string, unknown> = {};
  if (parsed.data.kinds) patch.notifications = parsed.data.kinds;
  if (parsed.data.dailyMoveThresholdPercent !== undefined) {
    patch.dailyMoveThresholdBp = parseDecimal(parsed.data.dailyMoveThresholdPercent, 2);
  }
  if (parsed.data.concentrationInstrumentPercent !== undefined) {
    patch.concentrationInstrumentBp = parseDecimal(parsed.data.concentrationInstrumentPercent, 2);
  }
  if (parsed.data.concentrationSectorPercent !== undefined) {
    patch.concentrationSectorBp = parseDecimal(parsed.data.concentrationSectorPercent, 2);
  }

  res.json(updateSettings(patch));
});

toolsRouter.post(
  '/telegram/test',
  asyncHandler(async (_req, res) => {
    res.json(await testTelegram());
  }),
);

// ── Zdarzenia korporacyjne ───────────────────────────────────
toolsRouter.post(
  '/corporate-actions/refresh',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, message: await refreshDividendHistory() });
  }),
);

toolsRouter.get('/corporate-actions/dividends/:instrumentId', (req, res, next) => {
  const id = idParam.safeParse(req.params.instrumentId);
  if (!id.success) return next(id.error);
  res.json(dividendHistory(id.data));
});

// ── Terminy raportów okresowych ──────────────────────────────
toolsRouter.get('/report-dates', (_req, res) => {
  res.json(listReportDates());
});

toolsRouter.post('/report-dates', (req, res, next) => {
  const parsed = z
    .object({
      instrumentId: idParam,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      label: z.string().trim().min(1).max(120),
      note: z.string().trim().max(300).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return next(parsed.error);
  res.status(201).json(addReportDate(parsed.data));
});

toolsRouter.delete('/report-dates/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  deleteReportDate(id.data);
  res.json({ ok: true });
});

// ── Skład ETF-ów ─────────────────────────────────────────────
toolsRouter.get('/holdings/missing', (_req, res) => {
  res.json(etfsMissingHoldings());
});

toolsRouter.get('/holdings/:instrumentId', (req, res, next) => {
  const id = idParam.safeParse(req.params.instrumentId);
  if (!id.success) return next(id.error);
  res.json(getHoldings(id.data));
});

toolsRouter.put('/holdings/:instrumentId', (req, res, next) => {
  const id = idParam.safeParse(req.params.instrumentId);
  if (!id.success) return next(id.error);

  const parsed = z
    .object({
      // Skład da się podać jako listę albo jako wklejony tekst ze strony emitenta.
      holdings: z.array(z.object({ symbol: z.string(), weightPercent: z.union([z.string(), z.number()]) })).optional(),
      text: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const entries = parsed.data.holdings ?? (parsed.data.text ? parseHoldingsText(parsed.data.text) : []);
  const saved = setHoldings(id.data, entries);
  res.json({ ok: true, saved, holdings: getHoldings(id.data) });
});

// ── Podsumowanie osiągnięć i projekcja ───────────────────────
toolsRouter.get(
  '/insights',
  asyncHandler(async (req, res) => {
    const parsed = portfolioQuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;

    const ids = activePortfolioIds(parsed.data.portfolioId);
    const insights = buildInsights(ids);
    const projection = buildProjection(ids);
    const emergencyFund = emergencyFundStatus();

    const { positions, cashByPortfolio } = buildPositions(ids);
    const value =
      positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
      [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
    const invested = netInvested(ids);

    // Komentarz od modelu jest dodatkiem — wszystkie liczby powyżej powstały
    // lokalnie i nie zmieniają się, gdy AI jest wyłączone.
    const narrative = await generateNarrative({
      valuePlnMinor: value,
      investedPlnMinor: invested,
      gainPlnMinor: value - invested,
      monthlyContributionPlnMinor: projection.monthlyContributionPlnMinor,
      projectedIn5YearsPlnMinor: projection.points.at(-1)?.valuePlnMinor ?? value,
      emergencyFundCoveredMonths: emergencyFund.coveredMonths,
    });

    res.json({ insights, projection, emergencyFund, narrative });
  }),
);

// ── Ustawienia AI ────────────────────────────────────────────
toolsRouter.get('/ai', (_req, res) => {
  res.json(aiStatus());
});

toolsRouter.patch('/ai', (req, res, next) => {
  const parsed = z
    .object({
      provider: z.enum(AI_PROVIDERS).optional(),
      model: z.string().trim().min(1).max(80).optional(),
      features: z.record(z.enum(AI_FEATURES), z.boolean()).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  updateAiSettings(parsed.data);
  res.json(aiStatus());
});

// ── Automatyczna klasyfikacja instrumentów ───────────────────
toolsRouter.post(
  '/instruments/classify',
  asyncHandler(async (req, res) => {
    const force = req.body?.force === true;
    res.json(await classifyAll({ force }));
  }),
);

// ── Wykrywanie zduplikowanych transakcji ─────────────────────
toolsRouter.get('/duplicates', (_req, res) => {
  res.json(duplicateSummary());
});

/**
 * Usuwa nadmiarowe kopie, zostawiając w każdej grupie najstarszą transakcję.
 * Nigdy nie kasuje wszystkich wpisów z grupy — duplikat to kopia, a nie powód
 * do utraty operacji.
 */
toolsRouter.post('/duplicates/resolve', (req, res, next) => {
  const parsed = z.object({ keys: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const selected = new Set(parsed.data.keys);
  let removed = 0;

  for (const group of duplicateSummary().groups) {
    if (!selected.has(group.key)) continue;
    for (const id of group.transactionIds.slice(1)) {
      deleteTransaction(id);
      removed += 1;
    }
  }

  res.json({ ok: true, removed });
});

// ── Propozycje uzupełnienia portfela ─────────────────────────
toolsRouter.get(
  '/suggestions',
  asyncHandler(async (req, res) => {
    const parsed = portfolioQuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    res.json(await buildSuggestions(parsed.data.portfolioId));
  }),
);
