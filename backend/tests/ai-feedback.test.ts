import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Zachowanie przy niedostępnym modelu.
 *
 * Trzy rzeczy, które wcześniej wyglądały tak samo i wymagały czegoś zupełnie
 * innego: brak klucza, wyłączona funkcja i awaria dostawcy. Do tego dwie
 * zasady, które trzeba utrzymać: kolejka wiadomości nie może być kasowana przez
 * awarię, a harmonogram nie może wydawać tokenów poza streszczeniami.
 *
 * Konfiguracja idzie do zmiennych środowiskowych przed importem modułów —
 * `config.ts` czyta je w czasie importu.
 */

const workDir = mkdtempSync(path.join(tmpdir(), 'pm-ai-test-'));

process.env.DATABASE_PATH = path.join(workDir, 'test.sqlite');
process.env.APP_PASSWORD = 'test';
process.env.SESSION_SECRET = 'test-secret-do-testow-1234567890';
process.env.DISABLE_EXTERNAL_FETCH = 'true';
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

type Modules = {
  db: (typeof import('../src/db/index.js'))['db'];
  schema: typeof import('../src/db/schema.js');
  ai: typeof import('../src/services/ai.js');
  aiConfig: typeof import('../src/services/ai-config.js');
  aiUsage: typeof import('../src/services/ai-usage.js');
  news: typeof import('../src/services/news.js');
  settings: typeof import('../src/services/settings.js');
};

let m: Modules;

beforeAll(async () => {
  const dbModule = await import('../src/db/index.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  m = {
    db: dbModule.db,
    schema: await import('../src/db/schema.js'),
    ai: await import('../src/services/ai.js'),
    aiConfig: await import('../src/services/ai-config.js'),
    aiUsage: await import('../src/services/ai-usage.js'),
    news: await import('../src/services/news.js'),
    settings: await import('../src/services/settings.js'),
  };
});

afterAll(async () => {
  (await import('../src/db/index.js')).closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  m.db.delete(m.schema.aiCalls).run();
  m.db.delete(m.schema.newsItems).run();
  m.aiConfig.setApiKey('anthropic', null);
  m.aiConfig.setApiKey('openai', null);
  m.aiConfig.updateAiSettings({ provider: 'anthropic', features: { news: false } });
  m.aiUsage.setMonthlyBudgetMicroUsd(0);
});

/** Wiadomość czekająca na analizę — zawsze z pustym `ai_analyzed_at`. */
function insertPendingNews(id: number): void {
  m.db
    .insert(m.schema.newsItems)
    .values({
      source: 'test',
      url: `https://example.test/${id}`,
      urlHash: `hash-${id}`,
      title: `Wiadomość ${id}`,
      publishedAt: '2026-08-20T10:00:00.000Z',
    })
    .run();
}

describe('powód niedostępności modelu', () => {
  it('brak klucza i wyłączona funkcja to dwa różne rodzaje', () => {
    // Bez klucza powód dotyczy konfiguracji dostawcy, nie zgody użytkownika —
    // przycisk „Włącz" nie miałby czego naprawić.
    expect(m.aiConfig.checkFeature('news').unavailable?.kind).toBe('no_key');

    m.aiConfig.setApiKey('anthropic', 'sk-ant-test');
    expect(m.aiConfig.checkFeature('news').unavailable?.kind).toBe('feature_off');

    m.aiConfig.updateAiSettings({ features: { news: true } });
    expect(m.aiConfig.checkFeature('news').unavailable).toBeNull();
  });

  it('każdy rodzaj niesie zdanie dla użytkownika', () => {
    const reason = m.aiConfig.checkFeature('quickQuestion').unavailable;
    expect(reason?.message).toBeTruthy();
    // Zdanie ma prowadzić do miejsca naprawy, a nie tylko stwierdzać fakt.
    expect(reason?.message).toContain('Ustawieniach');
  });
});

describe('reguła wydatku tokenów', () => {
  it('harmonogram może wołać model wyłącznie dla streszczeń wiadomości', () => {
    expect(m.aiConfig.SCHEDULED_FEATURES).toEqual(['news']);
  });

  it('wywołanie z harmonogramu poza listą nie idzie do dostawcy', async () => {
    m.aiConfig.setApiKey('anthropic', 'sk-ant-test');
    m.aiConfig.updateAiSettings({ features: { monthlySummary: true } });

    await expect(
      m.ai.completeWithMeta('system', 'user', { feature: 'monthlySummary', origin: 'schedule' }),
    ).rejects.toMatchObject({ unavailable: { kind: 'schedule_blocked' } });

    // Blokada zostaje w rejestrze — inaczej nie dałoby się jej zauważyć.
    const calls = m.db.select().from(m.schema.aiCalls).all();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('blocked');
    expect(calls[0]!.errorKind).toBe('schedule_blocked');
  });

  it('brak klucza zatrzymuje wywołanie zamiast udawać pustą odpowiedź', async () => {
    await expect(
      m.ai.completeWithMeta('system', 'user', { feature: 'news', origin: 'user' }),
    ).rejects.toMatchObject({ unavailable: { kind: 'no_key' } });
  });
});

describe('miesięczny limit kosztów', () => {
  it('bez limitu nic nie blokuje', () => {
    expect(m.aiUsage.budgetExceeded()).toBeNull();
  });

  it('przekroczony limit blokuje wywołanie i mówi o ile', async () => {
    m.aiConfig.setApiKey('anthropic', 'sk-ant-test');
    m.aiUsage.setMonthlyBudgetMicroUsd(1_000_000); // dolar

    m.aiUsage.recordCall({
      feature: 'news',
      origin: 'schedule',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'ok',
      costMicroUsd: 1_500_000,
    });

    const blocked = m.aiUsage.budgetExceeded();
    expect(blocked?.kind).toBe('budget');
    expect(blocked?.message).toContain('$1.50');

    await expect(
      m.ai.completeWithMeta('system', 'user', { feature: 'news', origin: 'user' }),
    ).rejects.toMatchObject({ unavailable: { kind: 'budget' } });
  });

  it('rachunek rozdziela wydatek automatu od wydatku na żądanie', () => {
    for (const [origin, cost] of [
      ['schedule', 400_000],
      ['user', 100_000],
    ] as const) {
      m.aiUsage.recordCall({
        feature: origin === 'schedule' ? 'news' : 'quickQuestion',
        origin,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        status: 'ok',
        inputTokens: 1000,
        outputTokens: 100,
        costMicroUsd: cost,
      });
    }

    const summary = m.aiUsage.usageSummary();
    expect(summary.costMicroUsd).toBe(500_000);
    expect(summary.scheduledCostMicroUsd).toBe(400_000);
    expect(summary.calls).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('nieudane wywołania trafiają do listy awarii', () => {
    m.aiUsage.recordCall({
      feature: 'news',
      origin: 'schedule',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'error',
      failure: { kind: 'provider_error', message: 'Limit u dostawcy', detail: '429 rate limit', retryable: true },
    });

    const summary = m.aiUsage.usageSummary();
    expect(summary.failed).toBe(1);
    expect(summary.recentFailures[0]?.errorKind).toBe('provider_error');
    // W rejestrze zostaje oryginał od dostawcy, nie nasza parafraza.
    expect(summary.recentFailures[0]?.errorMessage).toBe('429 rate limit');
  });
});

describe('kolejka wiadomości wobec awarii modelu', () => {
  it('wyłączona funkcja zostawia wiadomości nietknięte i podaje powód', async () => {
    insertPendingNews(1);

    const outcome = await m.news.analyzePendingNews({ origin: 'schedule' });

    expect(outcome.analyzed).toBe(0);
    expect(outcome.pending).toBe(1);
    expect(outcome.failure?.kind).toBe('no_key');
    expect(m.db.select().from(m.schema.newsItems).all()[0]!.aiAnalyzedAt).toBeNull();
  });

  it('awaria dostawcy nie kasuje kolejki', async () => {
    /*
     * Sedno sprawy. Wcześniej nieudana paczka i tak stemplowała
     * `ai_analyzed_at`, więc jeden błąd 429 trwale pozbawiał streszczenia
     * dwadzieścia pięć wiadomości i nie było jak tego cofnąć.
     *
     * Klucz jest ustawiony i funkcja włączona, ale ruch sieciowy jest odcięty
     * przez DISABLE_EXTERNAL_FETCH — czyli dostawca jest nieosiągalny.
     */
    m.aiConfig.setApiKey('openai', 'sk-test');
    m.aiConfig.updateAiSettings({ provider: 'openai', features: { news: true } });

    for (const id of [1, 2, 3]) insertPendingNews(id);

    const outcome = await m.news.analyzePendingNews({ maxBatches: 8, origin: 'user' });

    expect(outcome.analyzed).toBe(0);
    expect(outcome.failure).not.toBeNull();
    expect(outcome.pending).toBe(3);

    const rows = m.db.select().from(m.schema.newsItems).all();
    expect(rows.every((row) => row.aiAnalyzedAt === null)).toBe(true);
    // Próby też nie rosną: awaria nie mówi nic o samej wiadomości.
    expect(rows.every((row) => row.aiAttempts === 0)).toBe(true);
  });

  it('awaria przerywa pętlę paczek zamiast powtarzać ten sam błąd', async () => {
    m.aiConfig.setApiKey('openai', 'sk-test');
    m.aiConfig.updateAiSettings({ provider: 'openai', features: { news: true } });
    insertPendingNews(1);

    await m.news.analyzePendingNews({ maxBatches: 8, origin: 'user' });

    // Osiem paczek pod rząd z tym samym odrzuconym kluczem to osiem
    // niepotrzebnych zapytań — po pierwszej awarii pętla ma się zatrzymać.
    expect(m.db.select().from(m.schema.aiCalls).all()).toHaveLength(1);
  });
});
