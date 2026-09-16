/**
 * Rachunek za model: ile kosztował, co go wywołało i co poszło nie tak.
 *
 * Do tej pory koszt pojedynczego wywołania był liczony i zapisywany, ale nikt
 * go nigdy nie sumował — nie dało się odpowiedzieć ani „ile wydałem w tym
 * miesiącu", ani „ile z tego poszło samo, bez mojego kliknięcia". Ten moduł
 * odpowiada na oba pytania i pilnuje miesięcznego limitu.
 *
 * Zapisujemy każde podejście, także nieudane: awaria dostawcy zostawiała
 * wcześniej wyłącznie linię na standardowym wyjściu, więc po restarcie procesu
 * nie było już czego szukać.
 */
import { desc, gte, sql } from 'drizzle-orm';
import type { AiUnavailable } from '@portfolio/shared';
import { db } from '../db/index.js';
import { aiCalls } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import type { AiCallOrigin, AiFeature } from './ai-config.js';
import { getSetting, setSetting } from './settings.js';

const BUDGET_SETTING = 'aiMonthlyBudgetMicroUsd';

/**
 * Etykieta wywołania w rachunku.
 *
 * Test połączenia z ustawień nie należy do żadnej funkcji, a przypisywanie go
 * do „Szybkiego pytania" zawyżało koszt tej funkcji o coś, czego użytkownik
 * tam nie zrobił.
 */
export type AiCallFeature = AiFeature | 'connectionTest';

export interface AiCallRecord {
  feature: AiCallFeature;
  origin: AiCallOrigin;
  provider: string;
  model: string;
  status: 'ok' | 'error' | 'blocked';
  failure?: AiUnavailable | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicroUsd?: number | null;
  durationMs?: number | null;
}

export function recordCall(record: AiCallRecord): void {
  db.insert(aiCalls)
    .values({
      createdAt: nowIso(),
      feature: record.feature,
      origin: record.origin,
      provider: record.provider,
      model: record.model,
      status: record.status,
      errorKind: record.failure?.kind ?? null,
      // Do rejestru trafia surowy komunikat dostawcy, jeśli jest — zdanie
      // z podpowiedzią jest dla użytkownika, a przy diagnozie liczy się oryginał.
      errorMessage: record.failure ? (record.failure.detail ?? record.failure.message) : null,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      costMicroUsd: record.costMicroUsd ?? null,
      durationMs: record.durationMs ?? null,
    })
    .run();
}

/** Pierwszy dzień bieżącego miesiąca w postaci ISO — granica okresu rozliczeniowego. */
function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Wydatek od początku miesiąca w mikrodolarach. */
export function monthToDateMicroUsd(): number {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${aiCalls.costMicroUsd}), 0)` })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, monthStart()))
    .get();
  return row?.total ?? 0;
}

/** Limit miesięczny w mikrodolarach; 0 oznacza brak limitu. */
export function monthlyBudgetMicroUsd(): number {
  const value = getSetting<number>(BUDGET_SETTING, 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function setMonthlyBudgetMicroUsd(value: number): number {
  const clean = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  setSetting(BUDGET_SETTING, clean);
  return clean;
}

const usd = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(2)}`;

/**
 * Czy limit został wyczerpany. Zwraca powód gotowy do pokazania, a nie samo
 * `true` — dzięki temu karta w interfejsie mówi, ile i do kiedy.
 */
export function budgetExceeded(): AiUnavailable | null {
  const budget = monthlyBudgetMicroUsd();
  if (budget === 0) return null;

  const spent = monthToDateMicroUsd();
  if (spent < budget) return null;

  const next = new Date();
  const reset = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

  return {
    kind: 'budget',
    message:
      `Miesięczny limit kosztów AI wyczerpany: wydano ${usd(spent)} z ${usd(budget)}. ` +
      `Limit odnawia się ${reset}, możesz go też podnieść w Ustawieniach.`,
    retryable: false,
  };
}

export interface AiUsageFeatureRow {
  feature: string;
  origin: AiCallOrigin;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface AiUsageFailure {
  createdAt: string;
  feature: string;
  origin: string;
  errorKind: string | null;
  errorMessage: string | null;
}

export interface AiUsageSummary {
  /** Początek okresu rozliczeniowego. */
  since: string;
  costMicroUsd: number;
  budgetMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  failed: number;
  /** Ile poszło bez udziału użytkownika — z harmonogramu. */
  scheduledCostMicroUsd: number;
  byFeature: AiUsageFeatureRow[];
  recentFailures: AiUsageFailure[];
}

export function usageSummary(): AiUsageSummary {
  const since = monthStart();

  const rows = db
    .select({
      feature: aiCalls.feature,
      origin: aiCalls.origin,
      calls: sql<number>`COUNT(*)`,
      failed: sql<number>`SUM(CASE WHEN ${aiCalls.status} = 'ok' THEN 0 ELSE 1 END)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiCalls.outputTokens}), 0)`,
      costMicroUsd: sql<number>`COALESCE(SUM(${aiCalls.costMicroUsd}), 0)`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, since))
    .groupBy(aiCalls.feature, aiCalls.origin)
    .all();

  const byFeature: AiUsageFeatureRow[] = rows
    .map((row) => ({ ...row, origin: row.origin as AiCallOrigin }))
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd);

  const recentFailures = db
    .select({
      createdAt: aiCalls.createdAt,
      feature: aiCalls.feature,
      origin: aiCalls.origin,
      errorKind: aiCalls.errorKind,
      errorMessage: aiCalls.errorMessage,
    })
    .from(aiCalls)
    .where(sql`${aiCalls.status} <> 'ok'`)
    .orderBy(desc(aiCalls.createdAt))
    .limit(20)
    .all();

  const sum = (pick: (row: AiUsageFeatureRow) => number): number => byFeature.reduce((acc, row) => acc + pick(row), 0);

  return {
    since,
    costMicroUsd: sum((r) => r.costMicroUsd),
    budgetMicroUsd: monthlyBudgetMicroUsd(),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    calls: sum((r) => r.calls),
    failed: sum((r) => r.failed),
    scheduledCostMicroUsd: byFeature
      .filter((r) => r.origin === 'schedule')
      .reduce((acc, r) => acc + r.costMicroUsd, 0),
    byFeature,
    recentFailures,
  };
}
