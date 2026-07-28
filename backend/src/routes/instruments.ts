import { Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { idParam, instrumentCreateSchema, instrumentSearchSchema, instrumentUpdateSchema } from '@portfolio/shared';
import { db } from '../db/index.js';
import { instrumentAliases, instruments, transactions } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { classifyInstrument, localClassification } from '../services/classify.js';
import { normalizeSymbol, registerAlias, suggestSymbols } from '../services/instruments.js';
import { toInstrumentDto } from '../services/positions.js';
import { backfillHistory, backfillInstrumentHistory } from '../services/prices.js';

export const instrumentsRouter = Router();

instrumentsRouter.get('/', (_req, res) => {
  const rows = db.select().from(instruments).orderBy(asc(instruments.symbol)).all();
  res.json(rows.map(toInstrumentDto));
});

/** Autouzupełnianie w formularzu transakcji. */
instrumentsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const parsed = instrumentSearchSchema.parse(req.query);
    res.json(await suggestSymbols(parsed.q, parsed.assetClass));
  }),
);

instrumentsRouter.get('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const row = db.select().from(instruments).where(eq(instruments.id, id.data)).get();
  if (!row) return next(notFound('Nie ma takiego instrumentu'));
  const aliases = db.select().from(instrumentAliases).where(eq(instrumentAliases.instrumentId, id.data)).all();
  res.json({ ...toInstrumentDto(row), aliases: aliases.map((a) => ({ source: a.source, symbol: a.symbol })) });
});

instrumentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = instrumentCreateSchema.parse(req.body);
    const normalized = normalizeSymbol(parsed.symbol, 'manual');

    const existing = db.select().from(instruments).where(eq(instruments.symbol, normalized.canonical)).get();
    if (existing) throw conflict(`Instrument ${normalized.canonical} już istnieje`);

    const row = db
      .insert(instruments)
      .values({
        symbol: normalized.canonical,
        name: parsed.name,
        assetClass: parsed.assetClass,
        currency: parsed.currency,
        isin: parsed.isin ?? null,
        exchange: parsed.exchange ?? normalized.market,
        sector: parsed.sector ?? null,
        country: parsed.country ?? null,
        provider: parsed.provider ?? null,
        providerSymbol: parsed.providerSymbol ?? null,
        // Metale bez jawnej jednostki traktujemy jak uncje — spot jest w nich
        // kwotowany, więc to założenie nie zniekształca wyceny.
        unit: parsed.unit ?? (parsed.assetClass === 'metal' ? 'oz' : null),
      })
      .returning()
      .get();

    registerAlias(row.id, 'match', normalized.matchKey);
    registerAlias(row.id, 'manual', parsed.symbol);

    /*
     * Sektor i kraj uzupełniamy od razu, o ile użytkownik ich nie podał.
     * Zostawienie tego do ręcznego uruchomienia klasyfikacji oznaczało, że
     * świeżo dodana pozycja od razu psuła wykresy struktury.
     */
    const enriched = await enrichNewInstrument(row);

    // Historia notowań w tle — odpowiadamy od razu, bo pobranie kilkuset sesji
    // trwa dłużej niż użytkownik powinien czekać na potwierdzenie zapisu.
    void backfillInstrumentHistory(row.id);

    res.status(201).json(toInstrumentDto(enriched));
  }),
);

instrumentsRouter.patch('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const parsed = instrumentUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  const current = db.select().from(instruments).where(eq(instruments.id, id.data)).get();
  if (!current) return next(notFound('Nie ma takiego instrumentu'));

  const row = db
    .update(instruments)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.assetClass !== undefined ? { assetClass: parsed.data.assetClass } : {}),
      ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
      ...(parsed.data.isin !== undefined ? { isin: parsed.data.isin } : {}),
      ...(parsed.data.exchange !== undefined ? { exchange: parsed.data.exchange } : {}),
      ...(parsed.data.sector !== undefined ? { sector: parsed.data.sector } : {}),
      ...(parsed.data.country !== undefined ? { country: parsed.data.country } : {}),
      ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.providerSymbol !== undefined ? { providerSymbol: parsed.data.providerSymbol } : {}),
      ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit } : {}),
      ...(parsed.data.emergencyFund !== undefined ? { emergencyFund: parsed.data.emergencyFund } : {}),
    })
    .where(eq(instruments.id, id.data))
    .returning()
    .get();

  res.json(toInstrumentDto(row));
});

instrumentsRouter.delete('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);

  const used = db.select().from(transactions).where(eq(transactions.instrumentId, id.data)).limit(1).get();
  if (used) return next(conflict('Instrument ma powiązane transakcje — najpierw usuń transakcje'));

  db.delete(instruments).where(eq(instruments.id, id.data)).run();
  res.json({ ok: true });
});

/** Ręczne uzupełnienie historii notowań, np. po dodaniu starej transakcji. */
instrumentsRouter.post(
  '/:id/backfill',
  asyncHandler(async (req, res) => {
    const id = idParam.parse(req.params.id);
    const row = db.select().from(instruments).where(eq(instruments.id, id)).get();
    if (!row) throw notFound('Nie ma takiego instrumentu');

    const first = db
      .select({ date: transactions.tradeDate })
      .from(transactions)
      .where(eq(transactions.instrumentId, id))
      .orderBy(asc(transactions.tradeDate))
      .limit(1)
      .get();

    const count = await backfillHistory(row, first?.date ?? '2015-01-01');
    res.json({ ok: true, candles: count });
  }),
);


/**
 * Uzupełnienie metadanych nowo utworzonego instrumentu.
 *
 * Najpierw to, co wynika z samych danych (klasa aktywów, rynek), potem pytanie
 * do dostawcy o sektor. Błąd sieci nie może wywrócić tworzenia pozycji, więc
 * przy niepowodzeniu zwracamy wiersz bez wzbogacenia.
 */
async function enrichNewInstrument(row: InstrumentRow): Promise<InstrumentRow> {
  const patch: Partial<InstrumentRow> = {};

  const local = localClassification(row);
  if (!row.sector && local.sector) patch.sector = local.sector;
  if (!row.country && local.country) patch.country = local.country;

  if (!patch.sector && !row.sector && row.assetClass !== 'bond' && row.assetClass !== 'cash') {
    try {
      const classification = await classifyInstrument(row);
      if (classification.sector) patch.sector = classification.sector;
    } catch {
      // Dostawca niedostępny — sektor uzupełni się przy ręcznej klasyfikacji.
    }
  }

  if (Object.keys(patch).length === 0) return row;

  return db.update(instruments).set(patch).where(eq(instruments.id, row.id)).returning().get();
}
