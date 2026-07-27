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
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso() } })
    .run();
}

export function allSettings(): Record<string, unknown> {
  const rows = db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function updateSettings(patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) setSetting(key, value);
  return allSettings();
}
