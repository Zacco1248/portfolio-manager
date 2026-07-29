import { asc, eq, sql } from 'drizzle-orm';
import type { Account, AccountCreateInput, AccountUpdateInput } from '@portfolio/shared';
import { db } from '../db/index.js';
import { accounts, bondHoldings, transactions } from '../db/schema.js';
import type { AccountRow } from '../db/schema.js';

/**
 * Konta — miejsca, w których fizycznie leżą aktywa.
 *
 * Wymiar niezależny od portfela: portfel odpowiada za reżim podatkowy
 * (IKE/IKZE) i jest jednostką rozliczeniową FIFO, konto odpowiada na pytanie
 * „gdzie to jest". Ta sama para portfel+instrument może mieć transakcje
 * z dwóch kont, dlatego konto nigdy nie wchodzi do klucza FIFO ani do
 * kluczy deduplikacji importu — jest wyłącznie wymiarem raportowym.
 */

export function toAccountDto(row: AccountRow, transactionCount?: number): Account {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as Account['kind'],
    institution: row.institution,
    currency: row.currency,
    note: row.note,
    archived: row.archived,
    createdAt: row.createdAt,
    ...(transactionCount === undefined ? {} : { transactionCount }),
  };
}

/** Liczba transakcji per konto — jednym zapytaniem, nie N+1. */
function transactionCounts(): Map<number, number> {
  const rows = db
    .select({ accountId: transactions.accountId, count: sql<number>`count(*)` })
    .from(transactions)
    .groupBy(transactions.accountId)
    .all();

  const out = new Map<number, number>();
  for (const row of rows) {
    if (row.accountId !== null) out.set(row.accountId, Number(row.count));
  }
  return out;
}

export function listAccounts(includeArchived = false): Account[] {
  const counts = transactionCounts();
  return db
    .select()
    .from(accounts)
    .orderBy(asc(accounts.sortOrder), asc(accounts.id))
    .all()
    .filter((row) => includeArchived || !row.archived)
    .map((row) => toAccountDto(row, counts.get(row.id) ?? 0));
}

export function getAccount(id: number): AccountRow | null {
  return db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function findAccountByName(name: string): AccountRow | null {
  const needle = name.trim();
  if (!needle) return null;
  return db.select().from(accounts).all().find((row) => row.name === needle) ?? null;
}

export function createAccount(input: AccountCreateInput): AccountRow {
  const maxOrder = db.select().from(accounts).all().reduce((max, a) => Math.max(max, a.sortOrder), 0);
  return db
    .insert(accounts)
    .values({
      name: input.name,
      kind: input.kind,
      institution: input.institution ?? null,
      currency: input.currency,
      note: input.note ?? null,
      sortOrder: maxOrder + 1,
    })
    .returning()
    .get();
}

export function updateAccount(id: number, patch: AccountUpdateInput): AccountRow {
  return db
    .update(accounts)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.institution !== undefined ? { institution: patch.institution } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    })
    .where(eq(accounts.id, id))
    .returning()
    .get();
}

/** Ile obiektów wskazuje na konto — router odmawia usunięcia, gdy cokolwiek wskazuje. */
export function accountUsage(id: number): { transactions: number; bonds: number } {
  return {
    transactions: db.select().from(transactions).where(eq(transactions.accountId, id)).all().length,
    bonds: db.select().from(bondHoldings).where(eq(bondHoldings.accountId, id)).all().length,
  };
}

export function deleteAccount(id: number): void {
  db.delete(accounts).where(eq(accounts.id, id)).run();
}

/**
 * Konto o zadanej nazwie — tworzone, gdy jeszcze nie istnieje.
 *
 * Używane przez import, który dostaje nazwę konta z pliku („XTB", „PKO").
 * Zakładanie konta na etapie podglądu jest nieszkodliwe z tego samego powodu
 * co zakładanie instrumentu: konto bez transakcji niczego nie zmienia
 * w wyliczeniach, a użytkownik i tak zatwierdza wiersze osobno.
 */
export function resolveAccountByName(name: string): AccountRow | null {
  const needle = name.trim();
  if (!needle) return null;

  const existing = findAccountByName(needle);
  if (existing) return existing;

  return createAccount({ name: needle.slice(0, 80), kind: 'broker', currency: 'PLN' });
}
