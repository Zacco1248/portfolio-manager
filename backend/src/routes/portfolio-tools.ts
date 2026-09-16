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
import { alerts, instruments, newsItems, portfolios, transactions } from '../db/schema.js';
import { errorMessage, notFound } from '../lib/errors.js';
import { fetchText } from '../lib/http-client.js';
import { extractArticle } from '../lib/readability.js';
import { asyncHandler } from '../lib/http.js';
import { evaluateAlerts, recentAlertEvents } from '../services/alerts.js';
import { AI_FEATURES, AI_PROVIDERS, aiStatus, setApiKey, updateAiSettings } from '../services/ai-config.js';
import { setMonthlyBudgetMicroUsd, usageSummary } from '../services/ai-usage.js';
import { classifyAll } from '../services/classify.js';
import { duplicateSummary } from '../services/duplicates.js';
import { buildContext, buildSuggestions } from '../services/suggestions.js';
import { deleteTransaction } from '../services/transactions.js';
import { buildInsights, buildProjection, emergencyFundStatus } from '../services/insights.js';
import { generateNarrative, testAiConnection } from '../services/ai.js';
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
  MAX_BATCHES_ON_DEMAND,
  analyzePendingNews,
  fetchMarketNews,
  fetchNews,
  listNews,
  listWatchlist,
  newsDisclaimer,
  removeFromWatchlist,
} from '../services/news.js';
import { activePortfolioIds, buildPositions, netInvested, toInstrumentDto } from '../services/positions.js';
import { buildPlan } from '../services/rebalance.js';
import { detectConcentration, detectStalePrices, loadThresholds } from '../services/risk.js';
import { allSettings, setSetting, updateSettings } from '../services/settings.js';
import { deleteTarget, listTargets, loadTargets, targetsSumBp, upsertTarget } from '../services/targets.js';
import { availableTaxYears, buildTaxReport, taxReportToCsv } from '../services/tax.js';
import { isTelegramEnabled, testTelegram } from '../services/telegram.js';

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

/**
 * Treść artykułu do przeczytania w aplikacji.
 *
 * Pobieramy stronę na żądanie i wyciągamy z niej tekst — nigdzie go nie
 * zapisujemy, bo to podgląd, a nie archiwum. Adres źródła wraca razem
 * z treścią, żeby przejście do oryginału było jednym kliknięciem.
 */
toolsRouter.get(
  '/news/:id/tresc',
  asyncHandler(async (req, res, next) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return next(id.error);

    const item = db.select().from(newsItems).where(eq(newsItems.id, id.data)).get();
    if (!item) return next(notFound('Nie ma takiej wiadomości'));

    /*
     * Google News nie linkuje do artykułu wprost — daje własną stronę
     * pośredniczącą, która ujawnia adres docelowy dopiero po uruchomieniu
     * skryptów. Odtwarzanie tego wewnętrznego protokołu byłoby kruche
     * i zmieniałoby się bez ostrzeżenia, więc mówimy wprost, że dla tego
     * źródła podgląd nie zadziała.
     */
    if (/(^|\.)news\.google\.com$/i.test(new URL(item.url).hostname)) {
      return res.json({
        url: item.url,
        title: item.title,
        paragraphs: [],
        truncated: false,
        message:
          'Ta wiadomość pochodzi z Google News, które linkuje przez własną stronę pośredniczącą — treści ' +
          'nie da się stąd odczytać. Otwórz oryginał, żeby przejść do artykułu.',
      });
    }

    try {
      const html = await fetchText(item.url, { retries: 1, minIntervalMs: 500, timeoutMs: 15_000 });
      const article = extractArticle(html);

      if (article.paragraphs.length === 0) {
        return res.json({
          url: item.url,
          title: item.title,
          paragraphs: [],
          truncated: false,
          message: article.paywalled
            ? 'Serwis udostępnia ten materiał tylko prenumeratorom — w źródle strony nie ma treści do odczytania.'
            : 'Nie udało się odczytać treści — strona wymaga przeglądarki albo ukrywa tekst za zgodą na pliki cookie.',
        });
      }

      res.json({
        url: item.url,
        // Tytuł ze strony bywa pełniejszy niż ucięty tytuł z kanału RSS.
        title: article.title ?? item.title,
        paragraphs: article.paragraphs,
        truncated: article.truncated,
        // Przy paywallu mamy zwykle sam lead — mówimy o tym, zamiast zostawiać
        // wrażenie, że artykuł tyle właśnie liczy.
        message: article.paywalled
          ? 'To fragment — dalsza część materiału jest dostępna tylko dla prenumeratorów serwisu.'
          : null,
      });
    } catch (err) {
      res.json({
        url: item.url,
        title: item.title,
        paragraphs: [],
        truncated: false,
        message: `Nie udało się pobrać strony: ${errorMessage(err)}`,
      });
    }
  }),
);

toolsRouter.post(
  '/news/refresh',
  asyncHandler(async (_req, res) => {
    const fetched = await fetchNews();
    // Przegląd rynku dokładamy po wiadomościach spółek: `url_hash` jest
    // unikalny, więc materiał już przypisany do pozycji nie zdubluje się
    // jako ogólny.
    const market = await fetchMarketNews();
    // Kliknięcie „Odśwież" ma nadrobić zaległości, a nie zdjąć jedną paczkę —
    // przy kilkuset wiadomościach część zostawała bez streszczenia i wyglądało
    // to na losowe działanie funkcji.
    const analysis = await analyzePendingNews({ maxBatches: MAX_BATCHES_ON_DEMAND, origin: 'user' });
    /*
     * `ok` odbija to, co faktycznie się stało. Wcześniej nieudana analiza
     * kończyła się zielonym komunikatem sukcesu z treścią „model nie zwrócił
     * analiz" — dokładnie odwrotnie, niż wyglądała.
     */
    res.json({
      ok: analysis.failure === null,
      fetched,
      market,
      analyzed: analysis.message,
      analyzedCount: analysis.analyzed,
      pending: analysis.pending,
      unavailable: analysis.failure,
    });
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

/*
 * Liczby i komentarz modelu rozdzielone na dwie trasy.
 *
 * Wywołanie modelu trwa kilka do kilkunastu sekund. Dopóki siedziało w tej
 * samej odpowiedzi, cała strona czekała na coś, co jest wyłącznie dodatkiem —
 * a przy wyłączonym AI ładowała się natychmiast, co wyglądało jak kara za
 * podłączenie klucza.
 */
// ── Podsumowanie osiągnięć i projekcja ───────────────────────
toolsRouter.get('/insights', (req, res, next) => {
  const parsed = portfolioQuerySchema
    // Horyzont projekcji wybierany w interfejsie; poza listą i tak zostanie
    // domknięty do rozsądnego zakresu w `buildProjection`.
    .extend({ years: z.coerce.number().int().positive().max(40).optional() })
    .safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const ids = activePortfolioIds(parsed.data.portfolioId);

  res.json({
    insights: buildInsights(ids),
    projection: buildProjection(ids, parsed.data.years),
    emergencyFund: emergencyFundStatus(),
    /** Komentarz przychodzi osobno — patrz /insights/narrative. */
    narrative: null,
  });
});

toolsRouter.get(
  '/insights/narrative',
  asyncHandler(async (req, res) => {
    const parsed = portfolioQuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;

    const ids = activePortfolioIds(parsed.data.portfolioId);
    const projection = buildProjection(ids);
    const emergencyFund = emergencyFundStatus();

    const { positions, cashByPortfolio } = buildPositions(ids);
    const value =
      positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) +
      [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
    const invested = netInvested(ids);

    /*
     * Kontekst dla modelu: sam wynik zbiorczy nie pozwalał odpowiedzieć na
     * pytanie „co go zaniżyło". Wszystko liczone lokalnie — model dostaje
     * gotowe liczby i tylko je opisuje.
     */
    const byContribution = [...positions].sort((a, b) => b.unrealizedPlnMinor - a.unrealizedPlnMinor);
    const contributors = [...byContribution.slice(0, 3), ...byContribution.slice(-3)]
      // Przy krótkiej liście oba wycinki zachodzą na siebie.
      .filter((position, index, list) => list.findIndex((p) => p.instrument.id === position.instrument.id) === index)
      .map((position) => ({
        symbol: position.instrument.symbol,
        name: position.instrument.name,
        resultPlnMinor: position.unrealizedPlnMinor,
        returnBp: position.unrealizedBp,
        sharePortfolioBp: position.sharePortfolioBp,
      }));

    const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
    const targets = loadTargets(parsed.data.portfolioId ?? null, 'asset_class');
    const plan = targets.length > 0
      ? buildPlan({ positions, cashPlnMinor: cash, targets, dimension: 'asset_class', contributionPlnMinor: 0 }, 'full')
      : null;

    const thresholds = loadThresholds();
    const warnings = [
      ...detectConcentration(positions, thresholds),
      ...detectStalePrices(positions),
    ].map((warning) => warning.message);

    // Prowizje i podatki od początku prowadzenia portfela — realny koszt,
    // który w samym wyniku jest niewidoczny.
    const costs = db
      .select({ fee: transactions.feeMinor, tax: transactions.taxMinor, portfolioId: transactions.portfolioId })
      .from(transactions)
      .all()
      .filter((row) => ids.includes(row.portfolioId));

    const narrative = await generateNarrative({
      valuePlnMinor: value,
      investedPlnMinor: invested,
      gainPlnMinor: value - invested,
      monthlyContributionPlnMinor: projection.monthlyContributionPlnMinor,
      projectedIn5YearsPlnMinor: projection.points.at(-1)?.valuePlnMinor ?? value,
      emergencyFundCoveredMonths: emergencyFund.coveredMonths,
      contributors,
      drift: (plan?.actions ?? [])
        .filter((action) => !action.withinTolerance)
        .map((action) => ({
          label: action.label,
          currentShareBp: action.currentShareBp,
          targetShareBp: action.targetShareBp,
        })),
      warnings,
      feesPlnMinor: costs.reduce((sum, row) => sum + row.fee, 0),
      taxesPlnMinor: costs.reduce((sum, row) => sum + row.tax, 0),
    });

    // `narrative` zostaje dla zgodności, `unavailable` niesie powód milczenia —
    // bez niego interfejs zgadywał i zawsze obwiniał wyłączoną funkcję.
    res.json({ narrative: narrative.text, unavailable: narrative.unavailable });
  }),
);

// ── Ustawienia AI ────────────────────────────────────────────
toolsRouter.get('/ai', (_req, res) => {
  res.json(aiStatus());
});

toolsRouter.post(
  '/ai/test',
  asyncHandler(async (_req, res) => {
    res.json(await testAiConnection());
  }),
);

/** Rachunek za bieżący miesiąc: koszt, tokeny, podział na funkcje i ostatnie awarie. */
toolsRouter.get('/ai/usage', (_req, res) => {
  res.json(usageSummary());
});

/**
 * Miesięczny limit kosztów. Zero znosi limit.
 *
 * Kwota przychodzi w dolarach, bo tak ją widać w interfejsie; wewnątrz
 * trzymamy mikrodolary, żeby pojedyncze wywołanie za ułamek centa nie znikało
 * w zaokrągleniu.
 */
toolsRouter.put('/ai/budget', (req, res, next) => {
  const parsed = z.object({ monthlyUsd: z.number().min(0).max(10_000) }).safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  setMonthlyBudgetMicroUsd(Math.round(parsed.data.monthlyUsd * 1_000_000));
  res.json(usageSummary());
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

/**
 * Zapis klucza API dostawcy modelu.
 *
 * Osobna trasa, a nie `PATCH /settings`: tamta przyjmuje dowolny rekord
 * i odsyła całą zawartość ustawień, więc klucz wracałby do przeglądarki
 * w postaci jawnej. Tutaj wraca wyłącznie maska.
 *
 * Po zapisie od razu sprawdzamy połączenie — inaczej użytkownik dowiadywałby
 * się o literówce dopiero przy pierwszym użyciu funkcji AI.
 */
toolsRouter.post(
  '/ai/key',
  asyncHandler(async (req, res, next) => {
    const parsed = z
      .object({
        provider: z.enum(AI_PROVIDERS),
        // Pusty ciąg czyści klucz i przywraca ewentualną wartość z `.env`.
        key: z.string().trim().max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) return next(parsed.error);

    setApiKey(parsed.data.provider, parsed.data.key || null);

    const test = parsed.data.key ? await testAiConnection() : null;
    res.json({ status: aiStatus(), test });
  }),
);

/**
 * Zapis danych bota Telegram. Jak przy kluczach AI: wartości nie wracają
 * do przeglądarki, a puste pole czyści wpis i przywraca ustawienie z `.env`.
 */
toolsRouter.post(
  '/telegram/config',
  asyncHandler(async (req, res, next) => {
    const parsed = z
      .object({
        botToken: z.string().trim().max(200).optional(),
        chatId: z.string().trim().max(64).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return next(parsed.error);

    if (parsed.data.botToken !== undefined) {
      setSetting('telegramBotToken', parsed.data.botToken || null);
    }
    if (parsed.data.chatId !== undefined) {
      setSetting('telegramChatId', parsed.data.chatId || null);
    }

    const test = isTelegramEnabled() ? await testTelegram() : null;
    res.json({ configured: isTelegramEnabled(), test });
  }),
);

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
// Kontekst liczony lokalnie zwracamy natychmiast; propozycje modelu wymagają
// osobnego zapytania, żeby nie blokowały reszty widoku rebalansu.
toolsRouter.get('/suggestions/context', (req, res, next) => {
  const parsed = portfolioQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json({ context: buildContext(parsed.data.portfolioId) });
});

toolsRouter.get(
  '/suggestions',
  asyncHandler(async (req, res) => {
    const parsed = portfolioQuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    res.json(await buildSuggestions(parsed.data.portfolioId));
  }),
);
