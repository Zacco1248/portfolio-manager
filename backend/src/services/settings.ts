import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';

/** Odczyt ustawienia z wartością domyślną. Brak klucza nigdy nie jest błędem. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return fallback;
  return (row.value as T) ?? fallback;
}

export function setSetting(key: string, value: unknown): void {
  // Kolumna `value` jest NOT NULL, a i tak `null` znaczy dokładnie to samo, co
  // brak wiersza — kasujemy więc ustawienie zamiast zapisywać pustą wartość.
  if (value === null || value === undefined) {
    deleteSetting(key);
    return;
  }

  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso() } })
    .run();
}

/** Usuwa ustawienie — odczyt wróci wtedy do wartości domyślnej. */
export function deleteSetting(key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}

export function allSettings(): Record<string, unknown> {
  const rows = db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function updateSettings(patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) setSetting(key, value);
  return allSettings();
}
