import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const sqlite = new Database(config.databasePath);

// WAL pozwala czytać w trakcie zapisu — cron i requesty HTTP nie blokują się nawzajem.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;
export { schema };

log.info(`Baza: ${config.databasePath}`);

export function closeDb(): void {
  try {
    sqlite.close();
  } catch {
    // Zamknięcie już zamkniętej bazy nie jest błędem, który warto propagować.
  }
}
