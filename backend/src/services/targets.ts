import { and, eq, isNull } from 'drizzle-orm';
import { parseDecimal } from '@portfolio/shared';
import type { AllocationDimension, TargetAllocationInput } from '@portfolio/shared';
import { db } from '../db/index.js';
import { targetAllocations } from '../db/schema.js';
import type { TargetEntry } from './rebalance.js';

/**
 * Alokacja docelowa. `portfolioId = null` oznacza cel dla widoku zbiorczego
 * wszystkich portfeli — przy trzech rachunkach o różnym przeznaczeniu
 * sensowne bywa jedno i drugie.
 */
export function loadTargets(portfolioId: number | null, dimension: AllocationDimension): TargetEntry[] {
  const rows = db
    .select()
    .from(targetAllocations)
    .where(
      and(
        eq(targetAllocations.dimension, dimension),
        portfolioId === null
          ? isNull(targetAllocations.portfolioId)
          : eq(targetAllocations.portfolioId, portfolioId),
      ),
    )
    .all();

  // Brak celu dla konkretnego portfela → sięgamy po cel globalny.
  if (rows.length === 0 && portfolioId !== null) {
    return loadTargets(null, dimension);
  }

  return rows.map((r) => ({ key: r.key, targetBp: r.targetBp, toleranceBp: r.toleranceBp }));
}

export function listTargets(portfolioId?: number) {
  const rows = db.select().from(targetAllocations).all();
  return rows
    .filter((r) => portfolioId === undefined || r.portfolioId === portfolioId || r.portfolioId === null)
    .map((r) => ({
      id: r.id,
      portfolioId: r.portfolioId,
      dimension: r.dimension as AllocationDimension,
      key: r.key,
      targetBp: r.targetBp,
      toleranceBp: r.toleranceBp,
    }));
}

export function upsertTarget(input: TargetAllocationInput) {
  const targetBp = parseDecimal(input.targetPercent, 2);
  const toleranceBp = parseDecimal(input.tolerancePercent, 2);

  return db
    .insert(targetAllocations)
    .values({
      portfolioId: input.portfolioId ?? null,
      dimension: input.dimension,
      key: input.key,
      targetBp,
      toleranceBp,
    })
    .onConflictDoUpdate({
      target: [targetAllocations.portfolioId, targetAllocations.dimension, targetAllocations.key],
      set: { targetBp, toleranceBp },
    })
    .returning()
    .get();
}

export function deleteTarget(id: number): void {
  db.delete(targetAllocations).where(eq(targetAllocations.id, id)).run();
}

/** Suma celów w danym wymiarze — UI ostrzega, gdy nie sumuje się do 100%. */
export function targetsSumBp(portfolioId: number | null, dimension: AllocationDimension): number {
  return loadTargets(portfolioId, dimension).reduce((sum, t) => sum + t.targetBp, 0);
}
