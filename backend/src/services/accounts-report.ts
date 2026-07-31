import { eq, inArray } from 'drizzle-orm';
import type { AccountBreakdown, AccountsReport } from '@portfolio/shared';
import { db } from '../db/index.js';
import { accounts, realizedGains, transactions } from '../db/schema.js';
import { buildPositions } from './positions.js';

/**
 * Zestawienie portfela w rozbiciu na konta — „ile na plus, ile na minus
 * w danym miejscu".
 *
 * Trzy warstwy, żadna nie wymaga zmiany silnika FIFO:
 *
 *  1. Kapitał wniesiony — suma wpłat i wypłat per konto. Świadomie bez kupna
 *     i sprzedaży: te przesuwają pieniądze wewnątrz konta, a wliczone
 *     podnosiłyby „wpłacono" o wartość obrotów.
 *  2. Zysk zrealizowany — każdy wiersz `realized_gains` przypisany do konta
 *     transakcji SPRZEDAŻY. Reguła: zysk zapisuje się tam, gdzie wpłynęły
 *     pieniądze. Gdy zakup był na innym koncie, wynik i tak jest jeden
 *     (FIFO liczy go per portfel+instrument) — dzielimy go wyłącznie
 *     na potrzeby prezentacji.
 *  3. Wartość i wynik niezrealizowany — z rozbicia pozycji na konta
 *     (`splitByAccount`), czyli z lotów, które przetrwały FIFO.
 */
export function buildAccountBreakdown(portfolioIds: number[]): AccountsReport {
  const empty: AccountsReport = { accounts: [], totalValuePlnMinor: 0, totalResultPlnMinor: 0 };
  if (portfolioIds.length === 0) return empty;

  const accountRows = db.select().from(accounts).all();
  const accountMeta = new Map(accountRows.map((a) => [a.id, a]));

  const { positions, cashByAccount } = buildPositions(portfolioIds);

  const buckets = new Map<number | null, AccountBreakdown>();
  const bucketFor = (accountId: number | null): AccountBreakdown => {
    const existing = buckets.get(accountId);
    if (existing) return existing;

    const meta = accountId === null ? null : accountMeta.get(accountId);
    const fresh: AccountBreakdown = {
      accountId,
      name: meta?.name ?? 'Nieprzypisane',
      kind: (meta?.kind as AccountBreakdown['kind']) ?? null,
      contributedPlnMinor: 0,
      cashPlnMinor: 0,
      positionsValuePlnMinor: 0,
      valuePlnMinor: 0,
      realizedPlnMinor: 0,
      unrealizedPlnMinor: 0,
      resultPlnMinor: 0,
    };
    buckets.set(accountId, fresh);
    return fresh;
  };

  // 1. Kapitał wniesiony z zewnątrz — wyłącznie wpłaty i wypłaty.
  const txRows = db
    .select({
      accountId: transactions.accountId,
      type: transactions.type,
      amount: transactions.amountPlnMinor,
    })
    .from(transactions)
    .where(inArray(transactions.portfolioId, portfolioIds))
    .all();

  for (const tx of txRows) {
    const bucket = bucketFor(tx.accountId);
    // Kupno i sprzedaż przesuwają pieniądze wewnątrz konta, nie wnoszą
    // kapitału. Wliczone zawyżałyby „wpłacono" o wartość obrotów.
    if (tx.type === 'deposit' || tx.type === 'withdrawal') bucket.contributedPlnMinor += tx.amount;
  }

  // 2. Zysk zrealizowany — po koncie transakcji sprzedaży.
  const gainRows = db
    .select({
      gain: realizedGains.gainPlnMinor,
      accountId: transactions.accountId,
    })
    .from(realizedGains)
    .innerJoin(transactions, eq(transactions.id, realizedGains.sellTransactionId))
    .where(inArray(realizedGains.portfolioId, portfolioIds))
    .all();

  for (const row of gainRows) bucketFor(row.accountId).realizedPlnMinor += row.gain;

  // 3. Wartość pozycji i wynik niezrealizowany.
  for (const position of positions) {
    for (const slice of position.accounts ?? []) {
      const bucket = bucketFor(slice.accountId);
      bucket.positionsValuePlnMinor += slice.valuePlnMinor;
      bucket.unrealizedPlnMinor += slice.valuePlnMinor - slice.costPlnMinor;
    }
  }

  for (const [accountId, cash] of cashByAccount) bucketFor(accountId).cashPlnMinor += cash;

  for (const bucket of buckets.values()) {
    bucket.valuePlnMinor = bucket.cashPlnMinor + bucket.positionsValuePlnMinor;
    /*
     * Wynik = ile jest teraz warte to, co na koncie leży, minus ile na nie
     * wpłacono z zewnątrz.
     *
     * Przy papierze kupionym na jednym koncie, a sprzedanym z drugiego, wynik
     * przesuwa się razem z gotówką — konta nie są od siebie odizolowane
     * i nie da się tego rozstrzygnąć bez pojęcia transferu.
     */
    bucket.resultPlnMinor = bucket.valuePlnMinor - bucket.contributedPlnMinor;
  }

  const list = [...buckets.values()]
    // Konta bez śladu w danych tylko zaśmiecałyby zestawienie.
    .filter((b) => b.valuePlnMinor !== 0 || b.contributedPlnMinor !== 0 || b.realizedPlnMinor !== 0)
    .sort((a, b) => b.valuePlnMinor - a.valuePlnMinor);

  return {
    accounts: list,
    totalValuePlnMinor: list.reduce((sum, b) => sum + b.valuePlnMinor, 0),
    totalResultPlnMinor: list.reduce((sum, b) => sum + b.resultPlnMinor, 0),
  };
}
