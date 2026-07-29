import { config } from '../config.js';
import { earliestTransactionDate, refreshAllBenchmarks, BENCHMARKS } from '../services/analytics.js';
import { writeDailySnapshot } from '../services/snapshots.js';
import { evaluateAlerts } from '../services/alerts.js';
import { refreshDividendHistory } from '../services/corporate-actions.js';
import { analyzePendingNews, fetchNews } from '../services/news.js';
import { refreshAllRecommendations } from '../services/recommendations.js';
import { refreshFxRates } from '../services/fx.js';
import { backfillAllHistory, instrumentsNeedingPrices, isMarketHours, refreshQuotes } from '../services/prices.js';
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

  // Snapshot pod koniec dnia, po zamknięciu sesji na GPW i w USA.
  schedule('portfolio:snapshot', '50 23 * * *', config.cron.snapshot, async () => writeDailySnapshot());

  // Benchmarki zmieniają się raz dziennie — wystarczy odświeżenie po sesji.
  schedule('benchmarks:refresh', '30 23 * * 1-5', config.cron.snapshot, async () =>
    refreshAllBenchmarks(Object.keys(BENCHMARKS), earliestTransactionDate()),
  );

  // Newsy co godzinę; analiza AI idzie zaraz po pobraniu, żeby nie mnożyć
  // wywołań modelu na te same wiadomości.
  schedule('news:fetch', '5 * * * *', config.cron.news, async () => {
    const fetched = await fetchNews();
    const analyzed = await analyzePendingNews();
    return `${fetched}; ${analyzed}`;
  });

  // Alerty sprawdzamy częściej niż newsy, ale rzadziej niż ceny.
  schedule('alerts:check', '*/15 * * * *', config.cron.alerts, async () => evaluateAlerts());

  /*
   * Rekomendacje wychodzą w cyklu raportowym, nie codziennie — raz na dobę
   * z zapasem. Pobranie jest tanie, ale idzie przez wyszukiwarkę wiadomości,
   * więc nie ma powodu robić tego częściej.
   */
  schedule('recommendations:refresh', '20 6 * * 1-5', config.cron.news, async () => refreshAllRecommendations());

  // Zdarzenia korporacyjne zmieniają się rzadko — raz na dobę wystarczy.
  schedule('dividends:history', '40 23 * * *', config.cron.snapshot, async () => refreshDividendHistory());

  /*
   * Nocne uzupełnianie historii notowań.
   *
   * `refreshQuotes` dopisuje wyłącznie dzisiejszy dzień i tylko w godzinach
   * sesji, więc każda przerwa w działaniu aplikacji zostawiała lukę, której
   * nic potem nie zasypywało — a wskaźniki techniczne liczą się właśnie
   * z tych świec. Funkcja istniała, ale nie była nigdzie wywoływana.
   *
   * Poza godzinami sesji, żeby nie konkurować o limity dostawcy z bieżącym
   * odświeżaniem cen.
   */
  schedule('prices:backfill', '10 2 * * *', config.cron.prices, async () => backfillAllHistory());
}
