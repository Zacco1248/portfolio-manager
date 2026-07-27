import { Router } from 'express';
import { desc } from 'drizzle-orm';
import type { SystemStatus } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { fxRates, jobRuns, portfolioSnapshots, providerHealth, quotes } from '../db/schema.js';

export const statusRouter = Router();

statusRouter.get('/', (_req, res) => {
  const lastQuote = db.select().from(quotes).orderBy(desc(quotes.ts)).limit(1).get();
  const lastFx = db.select().from(fxRates).orderBy(desc(fxRates.date)).limit(1).get();
  const lastSnap = db.select().from(portfolioSnapshots).orderBy(desc(portfolioSnapshots.date)).limit(1).get();
  const providers = db.select().from(providerHealth).all();

  const status: SystemStatus = {
    version: '0.1.0',
    baseCurrency: config.baseCurrency,
    features: {
      ai: config.ai.enabled,
      telegram: config.telegram.enabled,
      externalFetch: !config.prices.disableExternalFetch,
    },
    lastPriceUpdate: lastQuote?.ts ?? null,
    lastFxUpdate: lastFx?.date ?? null,
    lastSnapshot: lastSnap?.date ?? null,
    providers: providers.map((p) => ({
      id: p.id,
      healthy: p.consecutiveFailures === 0,
      lastError: p.lastError,
      lastSuccessAt: p.lastSuccessAt,
    })),
  };

  res.json(status);
});

/** Ostatnie uruchomienia zadań cron — do diagnostyki w widoku ustawień. */
statusRouter.get('/jobs', (_req, res) => {
  const rows = db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50).all();
  res.json(rows);
});
