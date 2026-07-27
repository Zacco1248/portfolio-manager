import { Router } from 'express';
import { formatMinor, formatQty } from '@portfolio/shared';
import { db } from '../db/index.js';
import {
  bondHoldings,
  instrumentAliases,
  instruments,
  portfolioSnapshots,
  portfolios,
  realizedGains,
  targetAllocations,
  transactions,
} from '../db/schema.js';
import { today } from '../lib/dates.js';
import { config } from '../config.js';

export const exportRouter = Router();

/**
 * Pełny eksport danych użytkownika.
 *
 * Zawiera wszystko, co wprowadził użytkownik — bez cache'ów cen i newsów,
 * które da się odtworzyć. Plik nadaje się do przeniesienia na inny serwer
 * albo do trzymania jako kopia zapasowa poza wolumenem Dockera.
 */
exportRouter.get('/json', (_req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    baseCurrency: config.baseCurrency,
    portfolios: db.select().from(portfolios).all(),
    instruments: db.select().from(instruments).all(),
    instrumentAliases: db.select().from(instrumentAliases).all(),
    transactions: db.select().from(transactions).all(),
    realizedGains: db.select().from(realizedGains).all(),
    bondHoldings: db.select().from(bondHoldings).all(),
    targetAllocations: db.select().from(targetAllocations).all(),
    snapshots: db.select().from(portfolioSnapshots).all(),
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="portfolio-${today(config.timezone)}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

/** Transakcje w CSV — do arkusza kalkulacyjnego. */
exportRouter.get('/transactions.csv', (_req, res) => {
  const portfolioNames = new Map(db.select().from(portfolios).all().map((p) => [p.id, p.name]));
  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));
  const rows = db.select().from(transactions).orderBy(transactions.tradeDate).all();

  const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  const header = [
    'Data',
    'Portfel',
    'Typ',
    'Ticker',
    'Nazwa',
    'Liczba',
    'Cena',
    'Waluta',
    'Prowizja',
    'Podatek',
    'Kurs NBP',
    'Data kursu',
    'Kurs brokera',
    'Przeplyw PLN',
    'Podstawa podatkowa PLN',
    'Notatka',
  ];

  const lines = [header.map(esc).join(';')];

  for (const row of rows) {
    const instrument = row.instrumentId ? instrumentMap.get(row.instrumentId) : undefined;
    lines.push(
      [
        row.tradeDate,
        portfolioNames.get(row.portfolioId) ?? '',
        row.type,
        instrument?.symbol ?? '',
        instrument?.name ?? '',
        formatQty(row.qtyE8),
        formatMinor(Math.round(row.priceE8 / 1_000_000), row.currency),
        row.currency,
        formatMinor(row.feeMinor, row.currency),
        formatMinor(row.taxMinor, row.currency),
        (row.fxRateE6 / 1_000_000).toFixed(6),
        row.fxDate ?? '',
        row.settlementFxRateE6 === null ? '' : (row.settlementFxRateE6 / 1_000_000).toFixed(6),
        formatMinor(row.amountPlnMinor),
        formatMinor(row.taxAmountPlnMinor),
        row.note ?? '',
      ]
        .map(esc)
        .join(';'),
    );
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transakcje-${today(config.timezone)}.csv"`);
  res.send(`﻿${lines.join('\n')}`);
});
