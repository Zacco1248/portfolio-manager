import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createLogger } from '../lib/logger.js';
import { db } from './index.js';

const log = createLogger('migrate');

/**
 * Katalog migracji rozwiązujemy względem tego pliku, bo w obrazie produkcyjnym
 * kod leży w `dist/`, a migracje obok w `drizzle/`.
 */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dev: src/db → ../../drizzle | prod: dist → ../drizzle
  return here.includes(`${path.sep}src${path.sep}`)
    ? path.resolve(here, '../../drizzle')
    : path.resolve(here, '../drizzle');
}

export function runMigrations(): void {
  const folder = migrationsFolder();
  log.info(`Uruchamiam migracje z ${folder}`);
  migrate(db, { migrationsFolder: folder });
  log.info('Migracje zastosowane');
}

// Uruchomienie bezpośrednie: `npm run db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations();
  process.exit(0);
}
