import { config } from '../config.js';
import { refreshFxRates } from '../services/fx.js';
import { instrumentsNeedingPrices, isMarketHours, refreshQuotes } from '../services/prices.js';
import type { ScheduleFn } from './index.js';

/** Rejestracja zadań operujących na danych. Jeden punkt rozszerzania harmonogramu. */
export function registerDataJobs(schedule: ScheduleFn): void {
  // Ceny: co N minut, ale odpytujemy tylko w godzinach sesji — poza nimi
  // notowania się nie zmieniają, a limity API są wspólne dla całego dnia.
  schedule('prices:refresh', `*/${config.prices.refreshMinutes} * * * *`, config.cron.prices, async () => {
    if (!isMarketHours()) return undefined;
    const targets = instrumentsNeedingPrices();
    if (targets.length === 0) return undefined;
    const result = await refreshQuotes(targets);
    return `zaktualizowano ${result.updated}, bez danych ${result.skipped}, błędy ${result.failed}`;
  });

  // NBP publikuje tabelę A około 12:00 — odpytujemy chwilę później.
  schedule('fx:refresh', '15 12 * * 1-5', config.cron.fx, async () => refreshFxRates());
}
