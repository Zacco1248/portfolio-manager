import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { instruments, portfolios, transactions } from '../db/schema.js';

/**
 * Wyszukiwanie zduplikowanych transakcji.
 *
 * Deduplikacja przy imporcie chroni przed wgraniem tego samego pliku dwa razy,
 * ale nie cofnie duplikatów, które już są w bazie — na przykład gdy ktoś
 * zatwierdził wiersze oznaczone jako konflikt albo wgrał ten sam portfel
 * do dwóch różnych portfeli. Efektem jest zawyżona wartość portfela.
 *
 * Grupujemy po kluczu logicznym: portfel, data, instrument, typ, ilość i kwota.
 * Dwie identyczne operacje tego samego dnia bywają prawdziwe, więc niczego nie
 * usuwamy automatycznie — pokazujemy grupy do decyzji użytkownika.
 */

export interface DuplicateGroup {
  key: string;
  portfolioName: string;
  instrumentSymbol: string | null;
  tradeDate: string;
  type: string;
  amountPlnMinor: number;
  count: number;
  /** Identyfikatory wszystkich transakcji w grupie, od najstarszej. */
  transactionIds: number[];
  /** Ile wartości portfela zniknie po usunięciu nadmiarowych kopii. */
  excessPlnMinor: number;
}

export function findDuplicateGroups(): DuplicateGroup[] {
  const rows = db.select().from(transactions).all();

  const portfolioNames = new Map(db.select().from(portfolios).all().map((p) => [p.id, p.name]));
  const instrumentIds = [...new Set(rows.map((r) => r.instrumentId).filter((id): id is number => id !== null))];
  const symbols = new Map(
    instrumentIds.length > 0
      ? db.select().from(instruments).where(inArray(instruments.id, instrumentIds)).all().map((i) => [i.id, i.symbol])
      : [],
  );

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key =
      row.dedupeKey ??
      [row.portfolioId, row.tradeDate, row.instrumentId ?? 'cash', row.type, row.qtyE8, row.amountPlnMinor].join('|');
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => {
      const sorted = [...bucket].sort((a, b) => a.id - b.id);
      const first = sorted[0]!;
      return {
        key,
        portfolioName: portfolioNames.get(first.portfolioId) ?? '',
        instrumentSymbol: first.instrumentId ? (symbols.get(first.instrumentId) ?? null) : null,
        tradeDate: first.tradeDate,
        type: first.type,
        amountPlnMinor: first.amountPlnMinor,
        count: sorted.length,
        transactionIds: sorted.map((r) => r.id),
        excessPlnMinor: first.amountPlnMinor * (sorted.length - 1),
      };
    })
    .sort((a, b) => Math.abs(b.excessPlnMinor) - Math.abs(a.excessPlnMinor));
}

export interface DuplicateSummary {
  groups: DuplicateGroup[];
  totalExtraTransactions: number;
  /** Łączny wpływ nadmiarowych kopii na przepływy w portfelu. */
  totalExcessPlnMinor: number;
}

export function duplicateSummary(): DuplicateSummary {
  const groups = findDuplicateGroups();
  return {
    groups,
    totalExtraTransactions: groups.reduce((sum, g) => sum + (g.count - 1), 0),
    totalExcessPlnMinor: groups.reduce((sum, g) => sum + g.excessPlnMinor, 0),
  };
}
