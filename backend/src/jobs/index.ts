import { eq } from 'drizzle-orm';
import cron from 'node-cron';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { jobRuns } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { purgeExpiredSessions } from '../services/auth.js';
import { registerDataJobs } from './data-jobs.js';

const log = createLogger('cron');
const tasks: cron.ScheduledTask[] = [];

/**
 * Opakowanie zadania: każde uruchomienie ląduje w `job_runs`, a wyjątek nigdy
 * nie wychodzi poza zadanie — awaria jednego crona nie może położyć procesu
 * ani zatrzymać pozostałych.
 */
export async function runJob(name: string, fn: () => Promise<string | void>): Promise<void> {
  const row = db.insert(jobRuns).values({ job: name, startedAt: nowIso(), status: 'ok' }).returning().get();
  try {
    const message = await fn();
    db.update(jobRuns)
      .set({ finishedAt: nowIso(), status: 'ok', message: message ?? null })
      .where(eq(jobRuns.id, row.id))
      .run();
    if (message) log.info(`${name}: ${message}`);
  } catch (err) {
    const message = errorMessage(err);
    db.update(jobRuns)
      .set({ finishedAt: nowIso(), status: 'error', message })
      .where(eq(jobRuns.id, row.id))
      .run();
    log.error(`${name} zakończone błędem: ${message}`);
  }
}

export function schedule(
  name: string,
  expression: string,
  enabled: boolean,
  fn: () => Promise<string | void>,
): void {
  if (!enabled) {
    log.info(`Zadanie ${name} wyłączone w konfiguracji`);
    return;
  }
  const task = cron.schedule(expression, () => void runJob(name, fn), { timezone: config.timezone });
  tasks.push(task);
  log.info(`Zadanie ${name} zaplanowane: ${expression}`);
}

export type ScheduleFn = typeof schedule;

export function startScheduler(): void {
  schedule('sessions:purge', '0 4 * * *', true, async () => {
    const removed = purgeExpiredSessions();
    return removed > 0 ? `usunięto ${removed} sesji` : undefined;
  });

  registerDataJobs(schedule);
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}
