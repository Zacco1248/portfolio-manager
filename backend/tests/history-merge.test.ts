import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const workDir = mkdtempSync(path.join(tmpdir(), 'pm-test-'));
process.env.DATABASE_PATH = path.join(workDir, 'test.sqlite');
process.env.APP_PASSWORD = 'test';
process.env.SESSION_SECRET = 'test-secret-do-testow-1234567890';
process.env.DISABLE_EXTERNAL_FETCH = 'true';
process.env.NODE_ENV = 'test';

let mods: {
  db: typeof import('../src/db/index.js')['db'];
  schema: typeof import('../src/db/schema.js');
  snapshots: typeof import('../src/services/snapshots.js');
};

beforeAll(async () => {
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();
  mods = {
    db: (await import('../src/db/index.js')).db,
    schema: await import('../src/db/schema.js'),
    snapshots: await import('../src/services/snapshots.js'),
  };

  mods.db
    .insert(mods.schema.portfolios)
    .values([
      { name: 'Stary', taxRegime: 'standard' },
      { name: 'Nowy', taxRegime: 'standard' },
    ])
    .run();
});

afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* Windows trzyma uchwyt do bazy */
  }
});

describe('scalanie historii wielu portfeli', () => {
  it('nie gubi portfela w dniu bez jego pomiaru', () => {
    // Portfel 1 mierzony codziennie, portfel 2 tylko w środku okresu —
    // dokładnie sytuacja, w której jeden ma historię z arkusza, a drugi nie.
    mods.db
      .insert(mods.schema.portfolioSnapshots)
      .values([
        { portfolioId: 1, date: '2026-01-01', valuePlnMinor: 100_000, investedPlnMinor: 100_000, cashPlnMinor: 0, realizedPlnMinor: 0 },
        { portfolioId: 1, date: '2026-01-02', valuePlnMinor: 101_000, investedPlnMinor: 100_000, cashPlnMinor: 0, realizedPlnMinor: 0 },
        { portfolioId: 2, date: '2026-01-02', valuePlnMinor: 50_000, investedPlnMinor: 50_000, cashPlnMinor: 0, realizedPlnMinor: 0 },
        { portfolioId: 1, date: '2026-01-03', valuePlnMinor: 102_000, investedPlnMinor: 100_000, cashPlnMinor: 0, realizedPlnMinor: 0 },
      ])
      .run();

    const history = mods.snapshots.readHistory([1, 2]);
    expect(history).toHaveLength(3);

    // 2 stycznia: oba portfele zmierzone.
    expect(history[1]?.valuePlnMinor).toBe(151_000);

    // 3 stycznia: portfel 2 bez pomiaru, ale nie przestał istnieć — jego
    // ostatni znany stan przenosi się naprzód.
    expect(history[2]?.valuePlnMinor).toBe(152_000);
    expect(history[2]?.investedPlnMinor).toBe(150_000);
  });

  it('nie zgłasza przepływu tam, gdzie kapitał się nie zmienił', () => {
    const history = mods.snapshots.readHistory([1, 2]);

    // Wpłacony kapitał stoi od 2 stycznia, więc różnica między dniami to zero.
    // Bez przeniesienia stanu wyszłoby −50 000 i stopa zwrotu wykazałaby
    // gwałtowny wzrost wyceny, którego nie było.
    const flow = (history[2]?.investedPlnMinor ?? 0) - (history[1]?.investedPlnMinor ?? 0);
    expect(flow).toBe(0);
  });
});
