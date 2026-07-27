import { Router } from 'express';
import multer from 'multer';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { columnMappingSchema, idParam, importCommitSchema } from '@portfolio/shared';
import { db } from '../db/index.js';
import { importBatches } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { parserInfo } from '../parsers/registry.js';
import { MAPPABLE_FIELDS, detectDelimiter, parseCsv, suggestMapping } from '../parsers/csv.js';
import { commitImport, discardImport, previewImport } from '../services/import.js';

export const importsRouter = Router();

// Pliki trzymamy w pamięci — eksporty brokerskie to najwyżej kilka megabajtów,
// a zapis na dysk wymagałby sprzątania plików tymczasowych.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

importsRouter.get('/parsers', (_req, res) => {
  res.json({ parsers: parserInfo(), mappableFields: MAPPABLE_FIELDS });
});

importsRouter.get('/batches', (_req, res) => {
  const rows = db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(30).all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      parserId: r.parserId,
      filename: r.filename,
      portfolioId: r.portfolioId,
      status: r.status,
      stats: r.stats,
      createdAt: r.createdAt,
      committedAt: r.committedAt,
    })),
  );
});

const previewBodySchema = z.object({
  portfolioId: z.coerce.number().int().positive(),
  parserId: z.string().trim().min(1).optional(),
  mapping: z.string().optional(),
});

importsRouter.post(
  '/preview',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Nie przesłano pliku');

    const parsed = previewBodySchema.parse(req.body);
    let mapping;
    if (parsed.mapping) {
      try {
        mapping = columnMappingSchema.parse(JSON.parse(parsed.mapping));
      } catch {
        throw badRequest('Mapowanie kolumn ma nieprawidłowy format JSON');
      }
    }

    const result = await previewImport({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      portfolioId: parsed.portfolioId,
      parserId: parsed.parserId,
      mapping,
    });

    res.json(result);
  }),
);

/** Podpowiedź mapowania dla pliku CSV — używane przez kreator przed podglądem. */
importsRouter.post(
  '/inspect',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Nie przesłano pliku');

    const text = req.file.buffer.toString('utf8');
    const table = parseCsv(text);
    const headers = table[0] ?? [];

    res.json({
      delimiter: detectDelimiter(text),
      headers,
      sampleRows: table.slice(1, 6),
      suggestedMapping: suggestMapping(headers),
      mappableFields: MAPPABLE_FIELDS,
    });
  }),
);

importsRouter.post(
  '/commit',
  asyncHandler(async (req, res) => {
    const parsed = importCommitSchema.parse(req.body);
    res.json(await commitImport(parsed.batchId, parsed.acceptedRowIds));
  }),
);

importsRouter.post('/:id/discard', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  discardImport(id.data);
  res.json({ ok: true });
});
