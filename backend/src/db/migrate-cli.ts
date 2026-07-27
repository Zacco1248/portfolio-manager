/**
 * Ręczne uruchomienie migracji: `npm run db:migrate`.
 *
 * Osobny plik wejściowy, a nie strażnik wewnątrz `migrate.ts` — ten drugi
 * nie działa poprawnie po zbundlowaniu backendu do jednego pliku.
 */
import { closeDb } from './index.js';
import { runMigrations } from './migrate.js';

runMigrations();
closeDb();
