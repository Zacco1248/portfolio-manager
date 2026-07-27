import { Router } from 'express';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { analyticsQuerySchema, idParam, technicalQuerySchema } from '@portfolio/shared';
import type { Candle, DividendEntry, DividendSummary, TechnicalResponse } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, portfolios, pricesDaily, transactions } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { notFound } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import {
  BENCHMARKS,
  buildAnalytics,
  earliestTransactionDate,
  refreshAllBenchmarks,
} from '../services/analytics.js';
import { buildDashboard } from '../services/dashboard.js';
import { upcomingDividends } from '../services/corporate-actions.js';
import { activePortfolioIds, buildPositions, toInstrumentDto } from '../services/positions.js';
import { computeIndicators, currentState, detectSignals } from '../services/technical.js';
import { writeDailySnapshot } from '../services/snapshots.js';

export const analyticsRouter = Router();

const CADENCE_LABELS: Record<string, string> = {
  monthly: 'miesięczny',
  quarterly: 'kwartalny',
  semiannual: 'półroczny',
  annual: 'roczny',
};

const cadenceLabel = (cadence: string): string => CADENCE_LABELS[cadence] ?? cadence;

const portfolioQuery = z.object({ portfolioId: z.coerce.number().int().positive().optional() });

analyticsRouter.get('/dashboard', (req, res, next) => {
  const parsed = portfolioQuery.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);
  res.json(buildDashboard(activePortfolioIds(parsed.data.portfolioId)));
});

analyticsRouter.get('/', (req, res, next) => {
  const parsed = analyticsQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const keys = parsed.data.benchmarks
    ? parsed.data.benchmarks.split(',').map((s) => s.trim()).filter((s) => s in BENCHMARKS)
    : ['WIG20TR', 'SP500'];

  res.json(
    buildAnalytics(activePortfolioIds(parsed.data.portfolioId), parsed.data.from, parsed.data.to, keys),
  );
});

analyticsRouter.get('/benchmarks', (_req, res) => {
  res.json(Object.entries(BENCHMARKS).map(([key, meta]) => ({ key, label: meta.label, symbol: meta.symbol })));
});

analyticsRouter.post(
  '/benchmarks/refresh',
  asyncHandler(async (_req, res) => {
    const message = await refreshAllBenchmarks(Object.keys(BENCHMARKS), earliestTransactionDate());
    res.json({ ok: true, message });
  }),
);

/** Ręczne wymuszenie snapshotu — przydatne po imporcie historii. */
analyticsRouter.post('/snapshot', (_req, res) => {
  res.json({ ok: true, message: writeDailySnapshot() });
});

// ── Analiza techniczna ───────────────────────────────────────
analyticsRouter.get('/technical', (req, res, next) => {
  const parsed = technicalQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const instrument = db.select().from(instruments).where(eq(instruments.id, parsed.data.instrumentId)).get();
  if (!instrument) return next(notFound('Nie ma takiego instrumentu'));

  const to = parsed.data.to ?? today(config.timezone);
  // Domyślnie dwa lata — SMA 200 potrzebuje sporo historii, żeby w ogóle zaistnieć.
  const from = parsed.data.from ?? addDays(to, -730);

  const rows = db
    .select()
    .from(pricesDaily)
    .where(
      and(eq(pricesDaily.instrumentId, instrument.id), gte(pricesDaily.date, from), lte(pricesDaily.date, to)),
    )
    .orderBy(asc(pricesDaily.date))
    .all();

  const candles: Candle[] = rows.map((r) => ({
    date: r.date,
    openE8: r.openE8 ?? r.closeE8,
    highE8: r.highE8 ?? r.closeE8,
    lowE8: r.lowE8 ?? r.closeE8,
    closeE8: r.closeE8,
    volume: r.volume,
  }));

  const indicators = computeIndicators(candles);
  const response: TechnicalResponse & { state: ReturnType<typeof currentState> } = {
    instrument: toInstrumentDto(instrument),
    candles,
    indicators,
    signals: detectSignals(candles, indicators),
    state: currentState(indicators),
  };

  res.json(response);
});

// ── Dywidendy ────────────────────────────────────────────────
analyticsRouter.get('/dividends', (req, res, next) => {
  const parsed = portfolioQuery.safeParse(req.query);
  if (!parsed.success) return next(parsed.error);

  const ids = activePortfolioIds(parsed.data.portfolioId);
  if (ids.length === 0) {
    return res.json({ entries: [], byYear: [], trailingYieldBp: null, upcoming: [] } satisfies DividendSummary);
  }

  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));
  const portfolioMap = new Map(db.select().from(portfolios).all().map((p) => [p.id, p.name]));

  const rows = db
    .select()
    .from(transactions)
    .where(and(eq(transactions.type, 'dividend')))
    .orderBy(asc(transactions.tradeDate))
    .all()
    .filter((r) => ids.includes(r.portfolioId));

  const entries: DividendEntry[] = rows
    .filter((r) => r.instrumentId !== null && instrumentMap.has(r.instrumentId))
    .map((r) => ({
      transactionId: r.id,
      instrument: toInstrumentDto(instrumentMap.get(r.instrumentId!)!),
      portfolioName: portfolioMap.get(r.portfolioId) ?? '',
      date: r.tradeDate,
      grossMinor: r.grossMinor,
      taxMinor: r.taxMinor,
      netPlnMinor: r.amountPlnMinor,
      currency: r.currency,
    }));

  const byYearMap = new Map<number, { grossPlnMinor: number; taxPlnMinor: number; netPlnMinor: number }>();
  for (const row of rows) {
    const year = Number(row.tradeDate.slice(0, 4));
    const bucket = byYearMap.get(year) ?? { grossPlnMinor: 0, taxPlnMinor: 0, netPlnMinor: 0 };
    // Kwoty brutto i podatek są w walucie transakcji — przeliczamy kursem
    // zapisanym przy transakcji, żeby zestawienie roczne było w PLN.
    bucket.grossPlnMinor += Math.round((row.grossMinor * row.fxRateE6) / 1_000_000);
    bucket.taxPlnMinor += Math.round((row.taxMinor * row.fxRateE6) / 1_000_000);
    bucket.netPlnMinor += row.amountPlnMinor;
    byYearMap.set(year, bucket);
  }

  // Stopa dywidendy z ostatnich 12 miesięcy względem bieżącej wartości portfela.
  const cutoff = addDays(today(config.timezone), -365);
  const trailing = rows
    .filter((r) => r.tradeDate >= cutoff)
    .reduce((sum, r) => sum + r.amountPlnMinor, 0);
  const { positions } = buildPositions(ids);
  const portfolioValue = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);

  const summary: DividendSummary = {
    entries: entries.reverse(),
    byYear: [...byYearMap.entries()]
      .map(([year, v]) => ({ year, ...v }))
      .sort((a, b) => b.year - a.year),
    trailingYieldBp: portfolioValue > 0 ? Math.round((trailing / portfolioValue) * 10_000) : null,
    // Terminy są prognozą z rytmu poprzednich wypłat — darmowe źródła nie
    // podają przyszłych dat ustalenia prawa. UI musi to oznaczyć.
    upcoming: upcomingDividends([...new Set(positions.map((p) => p.instrument.id))]).map((entry) => ({
      instrument: instrumentMap.has(entry.instrumentId)
        ? toInstrumentDto(instrumentMap.get(entry.instrumentId)!)
        : null,
      exDate: entry.expectedExDate,
      payDate: null,
      note: `Prognoza na podstawie ${entry.observations} poprzednich wypłat (rytm: ${cadenceLabel(entry.cadence)}). Ostatnia: ${entry.lastExDate}.`,
    })).filter((e): e is { instrument: NonNullable<typeof e.instrument>; exDate: string; payDate: null; note: string } => e.instrument !== null),
  };

  res.json(summary);
});
