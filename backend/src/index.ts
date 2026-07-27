import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { errorMessage } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { seedDefaults } from './services/seed.js';
import { purgeExpiredSessions } from './services/auth.js';
import { startScheduler, stopScheduler } from './jobs/index.js';

const log = createLogger('server');

process.env.TZ = config.timezone;

async function main(): Promise<void> {
  runMigrations();
  seedDefaults();
  purgeExpiredSessions();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info(`Portfolio Manager słucha na http://${config.host}:${config.port}`);
    log.info(
      `Funkcje opcjonalne — AI: ${config.ai.enabled ? 'włączone' : 'wyłączone (brak ANTHROPIC_API_KEY)'}, ` +
        `Telegram: ${config.telegram.enabled ? 'włączony' : 'wyłączony (brak tokenu/chat_id)'}`,
    );
  });

  startScheduler();

  const shutdown = (signal: string): void => {
    log.info(`Otrzymano ${signal}, zamykam...`);
    stopScheduler();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Gdyby jakieś połączenie wisiało, nie blokujemy restartu kontenera w nieskończoność.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error(`Nieobsłużone odrzucenie promisy: ${errorMessage(reason)}`, reason);
  });
}

main().catch((err: unknown) => {
  log.error(`Nie udało się wystartować: ${errorMessage(err)}`, err);
  process.exit(1);
});
