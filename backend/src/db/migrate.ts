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

// Uwaga: nie ma tu strażnika „czy uruchomiono bezpośrednio" opartego na
// porównaniu `import.meta.url` z `process.argv[1]`. W builds produkcyjnym
// cały backend jest bundlowany do jednego pliku, więc każdy moduł dzieli ten
// sam `import.meta.url` — taki warunek byłby zawsze prawdziwy i proces
// kończyłby się zaraz po migracjach, nigdy nie startując serwera.
// Ręczne uruchomienie migracji obsługuje osobny skrypt `migrate-cli.ts`.
