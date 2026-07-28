import { z } from 'zod';
import {
  ALERT_KINDS,
  ALLOCATION_DIMENSIONS,
  ASSET_CLASSES,
  BOND_KINDS,
  REBALANCE_MODES,
  TAX_REGIMES,
  TRANSACTION_TYPES,
} from './domain.js';

/** Data w formacie ISO YYYY-MM-DD — tak trzymamy wszystkie daty w bazie. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data musi być w formacie RRRR-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Nieprawidłowa data');

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Kod waluty to 3 litery, np. PLN');

/**
 * Liczby dziesiętne przyjmujemy jako string albo number i dopiero w backendzie
 * skalujemy do liczb całkowitych. Nigdy nie ufamy floatowi z JSON-a.
 */
export const decimalInput = z.union([z.string().trim().min(1), z.number().finite()]);

export const idParam = z.coerce.number().int().positive();

// ── Auth ─────────────────────────────────────────────────────
export const loginSchema = z.object({
  password: z.string().min(1, 'Podaj hasło'),
});

// ── Portfele ─────────────────────────────────────────────────
export const portfolioCreateSchema = z.object({
  name: z.string().trim().min(1, 'Nazwa jest wymagana').max(80),
  kind: z.string().trim().max(40).optional(),
  taxRegime: z.enum(TAX_REGIMES).default('taxable'),
  baseCurrency: currencyCode.default('PLN'),
  broker: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
});

export const portfolioUpdateSchema = portfolioCreateSchema.partial().extend({
  archived: z.boolean().optional(),
});

// ── Instrumenty ──────────────────────────────────────────────
export const instrumentCreateSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  assetClass: z.enum(ASSET_CLASSES),
  currency: currencyCode,
  isin: z.string().trim().max(12).optional(),
  exchange: z.string().trim().max(40).optional(),
  sector: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  provider: z.string().trim().max(40).optional(),
  providerSymbol: z.string().trim().max(60).optional(),
  /** Jednostka pozycji dla metali: oz, g, kg. Decyduje o przeliczeniu ceny spot. */
  unit: z.enum(['oz', 'g', 'kg']).optional(),
});

export const instrumentUpdateSchema = instrumentCreateSchema.partial();

export const instrumentAliasSchema = z.object({
  instrumentId: idParam,
  source: z.string().trim().min(1).max(40),
  symbol: z.string().trim().min(1).max(60),
});

export const instrumentSearchSchema = z.object({
  q: z.string().trim().min(1).max(60),
  assetClass: z.enum(ASSET_CLASSES).optional(),
});

// ── Transakcje ───────────────────────────────────────────────
export const transactionCreateSchema = z
  .object({
    portfolioId: idParam,
    instrumentId: idParam.optional(),
    type: z.enum(TRANSACTION_TYPES),
    tradeDate: isoDate,
    settlementDate: isoDate.optional(),
    quantity: decimalInput.optional(),
    price: decimalInput.optional(),
    grossAmount: decimalInput.optional(),
    fee: decimalInput.optional(),
    tax: decimalInput.optional(),
    currency: currencyCode,
    /** Kurs NBP; jeśli pominięty, backend pobiera tabelę A z D-1. */
    fxRate: decimalInput.optional(),
    fxDate: isoDate.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    const needsInstrument = !['deposit', 'withdrawal'].includes(v.type);
    if (needsInstrument && !v.instrumentId) {
      ctx.addIssue({ code: 'custom', path: ['instrumentId'], message: 'Wybierz instrument' });
    }
    if (['buy', 'sell'].includes(v.type)) {
      if (v.quantity === undefined) {
        ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Podaj liczbę sztuk' });
      }
      if (v.price === undefined) {
        ctx.addIssue({ code: 'custom', path: ['price'], message: 'Podaj cenę' });
      }
    }
    if (['dividend', 'interest', 'fee', 'tax', 'deposit', 'withdrawal'].includes(v.type)) {
      if (v.grossAmount === undefined) {
        ctx.addIssue({ code: 'custom', path: ['grossAmount'], message: 'Podaj kwotę' });
      }
    }
  });

export const transactionUpdateSchema = z.object({
  tradeDate: isoDate.optional(),
  quantity: decimalInput.optional(),
  price: decimalInput.optional(),
  grossAmount: decimalInput.optional(),
  fee: decimalInput.optional(),
  tax: decimalInput.optional(),
  fxRate: decimalInput.optional(),
  fxDate: isoDate.optional(),
  note: z.string().trim().max(500).optional(),
});

export const transactionQuerySchema = z.object({
  portfolioId: idParam.optional(),
  instrumentId: idParam.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Obligacje detaliczne ─────────────────────────────────────
export const bondHoldingSchema = z.object({
  portfolioId: idParam,
  instrumentId: idParam.optional(),
  series: z.string().trim().min(1).max(20),
  kind: z.enum(BOND_KINDS),
  purchaseDate: isoDate,
  count: z.coerce.number().int().positive(),
  nominalAmount: decimalInput.default(100),
  firstYearRatePercent: decimalInput,
  marginPercent: decimalInput.default(0),
  /** Miesiące trwania emisji: EDO 120, COI 48, TOS 36. */
  termMonths: z.coerce.number().int().positive(),
  capitalization: z.enum(['annual', 'none']).default('annual'),
  earlyRedemptionFee: decimalInput.default(0),
});

// ── Alokacja docelowa i rebalans ─────────────────────────────
export const targetAllocationSchema = z.object({
  portfolioId: idParam.nullable().optional(),
  dimension: z.enum(ALLOCATION_DIMENSIONS),
  key: z.string().trim().min(1).max(80),
  targetPercent: decimalInput,
  tolerancePercent: decimalInput.default(5),
});

export const rebalanceQuerySchema = z.object({
  portfolioId: idParam.optional(),
  mode: z.enum(REBALANCE_MODES).default('full'),
  /** Kwota planowanej dopłaty — planer podziału wpłaty miesięcznej. */
  contribution: decimalInput.optional(),
  dimension: z.enum(ALLOCATION_DIMENSIONS).default('asset_class'),
});

// ── Alerty ───────────────────────────────────────────────────
export const alertCreateSchema = z.object({
  kind: z.enum(ALERT_KINDS),
  portfolioId: idParam.nullable().optional(),
  instrumentId: idParam.nullable().optional(),
  condition: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
  cooldownMinutes: z.coerce.number().int().min(0).max(10080).default(720),
});

export const alertUpdateSchema = alertCreateSchema.partial();

// ── Import ───────────────────────────────────────────────────
export const columnMappingSchema = z.record(z.string(), z.string().nullable());

export const importPreviewSchema = z.object({
  parserId: z.string().trim().min(1).optional(),
  portfolioId: idParam,
  mapping: columnMappingSchema.optional(),
});

export const importCommitSchema = z.object({
  batchId: idParam,
  /** Wiersze zatwierdzone przez użytkownika — reszta pomijana. */
  acceptedRowIds: z.array(z.string()).default([]),
});

// ── Ustawienia ───────────────────────────────────────────────
export const settingsUpdateSchema = z.record(z.string(), z.unknown());

export const notificationSettingsSchema = z.object({
  telegramEnabled: z.boolean().optional(),
  kinds: z.record(z.string(), z.boolean()).optional(),
  dailyMoveThresholdPercent: decimalInput.optional(),
  concentrationInstrumentPercent: decimalInput.optional(),
  concentrationSectorPercent: decimalInput.optional(),
});

// ── Raport podatkowy ─────────────────────────────────────────
export const taxReportQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  portfolioId: idParam.optional(),
});

// ── Analityka ────────────────────────────────────────────────
export const analyticsQuerySchema = z.object({
  portfolioId: idParam.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  benchmarks: z.string().trim().optional(),
});

export const technicalQuerySchema = z.object({
  instrumentId: idParam,
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type PortfolioCreateInput = z.infer<typeof portfolioCreateSchema>;
export type PortfolioUpdateInput = z.infer<typeof portfolioUpdateSchema>;
export type InstrumentCreateInput = z.infer<typeof instrumentCreateSchema>;
export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type BondHoldingInput = z.infer<typeof bondHoldingSchema>;
export type TargetAllocationInput = z.infer<typeof targetAllocationSchema>;
export type RebalanceQuery = z.infer<typeof rebalanceQuerySchema>;
export type AlertCreateInput = z.infer<typeof alertCreateSchema>;
export type ImportPreviewInput = z.infer<typeof importPreviewSchema>;
export type ImportCommitInput = z.infer<typeof importCommitSchema>;
export type TaxReportQuery = z.infer<typeof taxReportQuerySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type TechnicalQuery = z.infer<typeof technicalQuerySchema>;
