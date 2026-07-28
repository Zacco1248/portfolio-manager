import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  ImportCommitResponse,
  ImportPreviewResponse,
  ImportRowPreview,
  TransactionCreateInput,
} from '@portfolio/shared';
import { db } from '../db/index.js';
import { importBatches, instruments, portfolios } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/errors.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { detectParser, parserById } from '../parsers/registry.js';
import type { ColumnMapping, ParsedBond, ParsedRow } from '../parsers/types.js';
import { parserAliasSource } from '../parsers/types.js';
import { resolveInstrument } from './instruments.js';
import { importSnapshots } from './snapshots.js';
import { upsertCpi } from './bonds.js';
import {
  createTransaction,
  findByRowHash,
  findDuplicates,
  prepareTransaction,
  recomputeRealizedGains,
} from './transactions.js';

const log = createLogger('import');

/**
 * Import przebiega dwuetapowo: najpierw podgląd, potem zatwierdzenie.
 *
 * Nigdy nie zapisujemy niczego bez decyzji użytkownika i nigdy nie nadpisujemy
 * istniejących transakcji — wiersze rozpoznane jako duplikat lub konflikt
 * trafiają do podglądu z odpowiednim statusem, a użytkownik wybiera, co
 * faktycznie zaimportować.
 */

/** Hash pliku — pozwala rozpoznać ponowny wrzut tego samego eksportu. */
export function hashFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Hash pojedynczego wiersza źródłowego. Gwarantuje idempotencję: ponowny
 * import tego samego pliku nie utworzy duplikatów, bo hash trafia do bazy
 * z ograniczeniem unikalności.
 */
export function hashRow(parserId: string, portfolioId: number, row: ParsedRow): string {
  const payload = [
    parserId,
    portfolioId,
    row.rowId,
    row.tradeDate,
    row.type,
    row.rawSymbol ?? '',
    row.quantity,
    row.price,
    row.grossAmount ?? '',
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

interface PreparedImportRow {
  row: ParsedRow;
  rowHash: string;
  input: TransactionCreateInput & { rowHash: string };
  instrumentId: number | null;
  dedupeKey: string;
}

export interface PreviewOptions {
  buffer: Buffer;
  filename: string;
  portfolioId: number;
  parserId?: string;
  mapping?: ColumnMapping;
}

export async function previewImport(options: PreviewOptions): Promise<ImportPreviewResponse> {
  const portfolio = db.select().from(portfolios).where(eq(portfolios.id, options.portfolioId)).get();
  if (!portfolio) throw notFound('Nie ma takiego portfela');

  const parser = options.parserId
    ? parserById(options.parserId)
    : (await detectParser(options.buffer, options.filename))?.parser ?? null;

  if (!parser) {
    throw badRequest(
      'Nie rozpoznałem formatu pliku. Wybierz parser ręcznie albo użyj importu CSV z kreatorem mapowania.',
    );
  }

  const parsed = await parser.parse(options.buffer, options.mapping);
  const aliasSource = parserAliasSource(parser.id);

  // Instrumenty tworzymy już na etapie podglądu — bez tego nie da się wyliczyć
  // klucza deduplikacji ani pokazać, z czym wiersz koliduje. Sam instrument
  // bez transakcji jest nieszkodliwy i można go usunąć.
  const prepared: PreparedImportRow[] = [];
  const previews: ImportRowPreview[] = [];

  for (const row of parsed.rows) {
    const rowHash = hashRow(parser.id, options.portfolioId, row);
    try {
      let instrumentId: number | null = null;
      let currency = row.currency;

      if (row.rawSymbol) {
        const instrument = resolveInstrument({
          rawSymbol: row.rawSymbol,
          source: aliasSource,
          name: row.instrumentName ?? undefined,
          assetClass: row.assetClass,
          currency: row.currency,
        });
        instrumentId = instrument.id;
        // Waluta znanego instrumentu jest pewniejsza niż wywnioskowana
        // z sufiksu symbolu — wyciąg XTB nie podaje jej wprost.
        if (row.currencyInferred && instrument.currency !== row.currency) {
          currency = instrument.currency;
          row.issues.push(
            `Waluta poprawiona na ${instrument.currency} na podstawie znanego instrumentu ${instrument.symbol}.`,
          );
        }
      }

      const input: TransactionCreateInput & { rowHash: string } = {
        portfolioId: options.portfolioId,
        instrumentId: instrumentId ?? undefined,
        type: row.type,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        price: row.price,
        grossAmount: row.grossAmount ?? undefined,
        fee: row.fee,
        tax: row.tax,
        currency,
        fxRate: row.fxRate ?? undefined,
        note: row.note ?? undefined,
        rowHash,
      };

      const preparedTx = await prepareTransaction(input);
      prepared.push({ row, rowHash, input, instrumentId, dedupeKey: preparedTx.dedupeKey });
    } catch (err) {
      previews.push({
        rowId: row.rowId,
        tradeDate: row.tradeDate,
        type: row.type,
        symbol: row.rawSymbol,
        instrumentName: row.instrumentName,
        quantity: row.quantity,
        price: row.price,
        amount: row.grossAmount ?? '',
        currency: row.currency,
        status: 'error',
        message: errorMessage(err),
        matchedTransactionId: null,
      });
    }
  }

  // Dwie niezależne kontrole duplikatów: hash wiersza łapie ponowny import
  // tego samego pliku, a klucz logiczny — tę samą transakcję wprowadzoną
  // wcześniej ręcznie albo z innego źródła.
  const existingHashes = findByRowHash(prepared.map((p) => p.rowHash));
  const existingKeys = findDuplicates(prepared.map((p) => p.dedupeKey));

  for (const item of prepared) {
    const duplicateByHash = existingHashes.has(item.rowHash);
    const matchedId = existingKeys.get(item.dedupeKey) ?? null;

    const status: ImportRowPreview['status'] = duplicateByHash
      ? 'duplicate'
      : matchedId !== null
        ? 'conflict'
        : 'new';

    const messages = [...item.row.issues];
    if (duplicateByHash) messages.push('Ten wiersz był już importowany z tego samego pliku.');
    else if (matchedId !== null) {
      messages.push(
        `Istnieje już transakcja #${matchedId} o tej samej dacie, instrumencie, ilości i kwocie. ` +
          `Zaznacz wiersz tylko wtedy, gdy to faktycznie druga, osobna operacja.`,
      );
    }

    previews.push({
      rowId: item.row.rowId,
      tradeDate: item.row.tradeDate,
      type: item.row.type,
      symbol: item.row.rawSymbol,
      instrumentName: item.row.instrumentName,
      quantity: item.row.quantity,
      price: item.row.price,
      amount: item.row.grossAmount ?? '',
      currency: item.input.currency,
      status,
      message: messages.length > 0 ? messages.join(' ') : null,
      matchedTransactionId: matchedId,
    });
  }

  const stats = {
    total: previews.length,
    new: previews.filter((p) => p.status === 'new').length,
    duplicate: previews.filter((p) => p.status === 'duplicate').length,
    conflict: previews.filter((p) => p.status === 'conflict').length,
    error: previews.filter((p) => p.status === 'error').length,
  };

  const batch = db
    .insert(importBatches)
    .values({
      parserId: parser.id,
      filename: options.filename,
      fileHash: hashFile(options.buffer),
      portfolioId: options.portfolioId,
      status: 'pending',
      mapping: options.mapping ?? null,
      rows: prepared.map((p) => ({ ...p.input, rowId: p.row.rowId })),
      stats,
    })
    .returning()
    .get();

  // Odczyty inflacji zapisujemy od razu: nie są transakcjami, więc nie ma
  // czego zatwierdzać, a bez nich obligacje indeksowane liczą tylko marżę.
  if (parsed.cpi && parsed.cpi.length > 0) {
    const saved = upsertCpi(parsed.cpi);
    log.info(`Zapisano ${saved} odczytów inflacji`);
  }

  // Warunki emisji obligacji przypisujemy do instrumentów po dacie zakupu —
  // bez nich obligacja stoi na nominale i nie nalicza odsetek.
  if (parsed.bonds && parsed.bonds.length > 0) {
    attachBondTerms(prepared, parsed.bonds);
  }

  // Historia wartości portfela z arkusza trafia do bazy od razu — nie tworzy
  // transakcji, więc nie ma czego zatwierdzać, a nie nadpisuje naszych pomiarów.
  if (parsed.snapshots && parsed.snapshots.length > 0) {
    const inserted = importSnapshots(options.portfolioId, parsed.snapshots);
    log.info(`Zaimportowano ${inserted} historycznych wycen portfela`);
  }

  previews.sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));

  return {
    batchId: batch.id,
    parserId: parser.id,
    parserName: parser.name,
    filename: options.filename,
    detectedColumns: parsed.detectedColumns,
    mapping: options.mapping ?? null,
    requiresMapping: parser.requiresMapping && !options.mapping,
    rows: previews,
    stats,
  };
}

export async function commitImport(batchId: number, acceptedRowIds: string[]): Promise<ImportCommitResponse> {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) throw notFound('Nie ma takiej partii importu');
  if (batch.status === 'committed') throw badRequest('Ta partia została już zatwierdzona');

  const accepted = new Set(acceptedRowIds);
  const stored = (batch.rows ?? []) as (TransactionCreateInput & { rowHash: string; rowId: string })[];
  const errors: ImportCommitResponse['errors'] = [];

  let imported = 0;
  let skipped = 0;

  for (const input of stored) {
    if (!accepted.has(input.rowId)) {
      skipped += 1;
      continue;
    }
    try {
      await createTransaction({ ...input, importBatchId: batchId, deferRecompute: true });
      imported += 1;
    } catch (err) {
      // Ograniczenie unikalności na row_hash oznacza, że wiersz już istnieje —
      // to nie jest błąd, tylko potwierdzenie idempotencji.
      const message = errorMessage(err);
      if (message.includes('UNIQUE') && message.includes('row_hash')) {
        skipped += 1;
        continue;
      }
      errors.push({ rowId: input.rowId, message });
    }
  }

  db.update(importBatches)
    .set({ status: 'committed', committedAt: nowIso() })
    .where(eq(importBatches.id, batchId))
    .run();

  // Wiersze wstawiamy bez przeliczania FIFO, a na końcu robimy jedno pełne
  // przeliczenie portfela. Kolejność chronologiczna i tak jest odtwarzana
  // wewnątrz silnika, więc wynik jest identyczny, a koszt liniowy zamiast
  // kwadratowego.
  const warnings = recomputeRealizedGains(batch.portfolioId);
  if (warnings.length > 0) {
    for (const warning of warnings.slice(0, 20)) errors.push({ rowId: '-', message: warning });
  }

  log.info(`Import #${batchId}: zapisano ${imported}, pominięto ${skipped}, błędów ${errors.length}`);
  return { batchId, imported, skipped, errors };
}

export function discardImport(batchId: number): void {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) throw notFound('Nie ma takiej partii importu');
  db.update(importBatches).set({ status: 'discarded', rows: null }).where(eq(importBatches.id, batchId)).run();
}


/**
 * Łączy warunki emisji z instrumentami obligacyjnymi.
 *
 * Parametry zapisujemy na instrumencie, a nie jako osobną pozycję obligacyjną —
 * zakup jest już w transakcjach, więc druga reprezentacja podwoiłaby wartość
 * portfela. Dopasowanie idzie po dacie zakupu, którą mają obie strony.
 */
function attachBondTerms(rows: PreparedImportRow[], bonds: ParsedBond[]): void {
  const byDate = new Map<string, ParsedBond>();
  for (const bond of bonds) byDate.set(bond.purchaseDate, bond);

  for (const item of rows) {
    if (item.instrumentId === null) continue;
    if (item.row.assetClass !== 'bond' || item.row.type !== 'buy') continue;

    const terms = byDate.get(item.row.tradeDate);
    if (!terms) continue;

    const instrument = db.select().from(instruments).where(eq(instruments.id, item.instrumentId)).get();
    if (!instrument) continue;

    db.update(instruments)
      .set({
        assetClass: 'bond',
        meta: {
          ...(instrument.meta ?? {}),
          bondKind: terms.kind,
          purchaseDate: terms.purchaseDate,
          firstYearRatePercent: terms.firstYearRatePercent,
          marginPercent: terms.marginPercent,
        },
      })
      .where(eq(instruments.id, item.instrumentId))
      .run();
  }
}
