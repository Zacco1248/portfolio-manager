import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { SnapshotPoint } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { portfolioSnapshots, portfolios } from '../db/schema.js';
import { today } from '../lib/dates.js';
import type { IsoDate } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import { buildPositions, netInvested, realizedTotal } from './positions.js';

const log = createLogger('snapshots');

/**
 * Dzienny snapshot wartości portfela. Zapisujemy stan na dziś dla każdego
 * aktywnego portfela — z tego powstaje wykres wartości w czasie.
 *
 * Snapshot jest liczony z bieżących cen, nie odtwarzany wstecz. Historia
 * sprzed uruchomienia aplikacji może pochodzić wyłącznie z importu
 * (arkusz Inwestomatu) i jest oznaczana flagą `imported`.
 */
export function writeDailySnapshot(date?: IsoDate): string {
  const day = date ?? today(config.timezone);
  const active = db
    .select()
    .from(portfolios)
    .all()
    .filter((p) => !p.archived);

  if (active.length === 0) return 'brak aktywnych portfeli';

  let written = 0;
  for (const portfolio of active) {
    const { positions, cashByPortfolio } = buildPositions([portfolio.id]);
    const cash = cashByPortfolio.get(portfolio.id) ?? 0;
    const positionsValue = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);
    const cost = positions.reduce((sum, p) => sum + p.costPlnMinor, 0);

    const byAssetClass: Record<string, number> = {};
    for (const position of positions) {
      const key = position.instrument.assetClass;
      byAssetClass[key] = (byAssetClass[key] ?? 0) + position.valuePlnMinor;
    }
    if (cash !== 0) byAssetClass.cash = (byAssetClass.cash ?? 0) + cash;

    db.insert(portfolioSnapshots)
      .values({
        portfolioId: portfolio.id,
        date: day,
        valuePlnMinor: positionsValue + cash,
        cashPlnMinor: cash,
        investedPlnMinor: netInvested([portfolio.id]),
        realizedPlnMinor: realizedTotal([portfolio.id]),
        unrealizedPlnMinor: positionsValue - cost,
        byAssetClass,
        imported: false,
      })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.portfolioId, portfolioSnapshots.date],
        set: {
          valuePlnMinor: positionsValue + cash,
          cashPlnMinor: cash,
          investedPlnMinor: netInvested([portfolio.id]),
          realizedPlnMinor: realizedTotal([portfolio.id]),
          unrealizedPlnMinor: positionsValue - cost,
          byAssetClass,
          imported: false,
        },
      })
      .run();
    written += 1;
  }

  log.debug(`Zapisano snapshot ${day} dla ${written} portfeli`);
  return `zapisano ${written} snapshotów na ${day}`;
}

/** Historia wartości — sumowana po portfelach, gdy wybrano więcej niż jeden. */
export function readHistory(portfolioIds: number[], from?: IsoDate, to?: IsoDate): SnapshotPoint[] {
  if (portfolioIds.length === 0) return [];

  const conditions = [inArray(portfolioSnapshots.portfolioId, portfolioIds)];
  if (from) conditions.push(gte(portfolioSnapshots.date, from));
  if (to) conditions.push(lte(portfolioSnapshots.date, to));

  const rows = db
    .select()
    .from(portfolioSnapshots)
    .where(and(...conditions))
    .orderBy(asc(portfolioSnapshots.date))
    .all();

  const byDate = new Map<string, SnapshotPoint>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (existing) {
      existing.valuePlnMinor += row.valuePlnMinor;
      existing.investedPlnMinor += row.investedPlnMinor;
      mergeAssetClasses(existing, row.byAssetClass);
    } else {
      const point: SnapshotPoint = {
        date: row.date,
        valuePlnMinor: row.valuePlnMinor,
        investedPlnMinor: row.investedPlnMinor,
        byAssetClass: {},
      };
      mergeAssetClasses(point, row.byAssetClass);
      byDate.set(row.date, point);
    }
  }

  return [...byDate.values()];
}

function mergeAssetClasses(point: SnapshotPoint, source: Record<string, number> | null): void {
  if (!source) return;
  const target = (point.byAssetClass ?? {}) as Record<string, number>;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
  point.byAssetClass = target as SnapshotPoint['byAssetClass'];
}

/** Wartość portfela na wskazany dzień lub najbliższy wcześniejszy. */
export function valueOn(portfolioIds: number[], date: IsoDate): number | null {
  if (portfolioIds.length === 0) return null;
  const history = readHistory(portfolioIds, undefined, date);
  return history.at(-1)?.valuePlnMinor ?? null;
}

/**
 * Wstawia punkty historii pochodzące z importu. Nie nadpisuje snapshotów
 * policzonych przez aplikację — dane użytkownika z arkusza są uzupełnieniem,
 * a nie źródłem prawdy dla dni, które sami zmierzyliśmy.
 */
export function importSnapshots(
  portfolioId: number,
  points: {
    date: IsoDate;
    valuePlnMinor: number;
    investedPlnMinor?: number | null;
    byAssetClass?: Record<string, number>;
  }[],
): number {
  if (points.length === 0) return 0;

  const existing = new Set(
    db
      .select({ date: portfolioSnapshots.date })
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.portfolioId, portfolioId), eq(portfolioSnapshots.imported, false)))
      .all()
      .map((r) => r.date),
  );

  const rows = points
    .filter((p) => !existing.has(p.date))
    .map((p) => ({
      portfolioId,
      date: p.date,
      valuePlnMinor: p.valuePlnMinor,
      cashPlnMinor: p.byAssetClass?.cash ?? 0,
      // Wpłacony kapitał z historii jest potrzebny do policzenia stopy zwrotu
      // ważonej czasem — bez niego nie da się oddzielić wpłat od zysku.
      investedPlnMinor: p.investedPlnMinor ?? 0,
      realizedPlnMinor: 0,
      unrealizedPlnMinor: 0,
      byAssetClass: p.byAssetClass ?? null,
      imported: true,
    }));

  for (let i = 0; i < rows.length; i += 200) {
    db.insert(portfolioSnapshots)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .run();
  }

  return rows.length;
}
