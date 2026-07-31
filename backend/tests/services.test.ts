import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toPrice, toQty } from '@portfolio/shared';

/**
 * Testy integracyjne serwisów operujących na bazie.
 *
 * Każde uruchomienie dostaje własny plik SQLite w katalogu tymczasowym
 * i wyłączony ruch sieciowy — dzięki temu sprawdzamy wyłącznie własną logikę,
 * a wynik nie zależy od dostępności zewnętrznych API.
 *
 * Konfiguracja musi trafić do zmiennych środowiskowych *przed* zaimportowaniem
 * modułów, bo `config.ts` czyta je w czasie importu i przy braku hasła kończy
 * proces.
 */

const workDir = mkdtempSync(path.join(tmpdir(), 'pm-test-'));

process.env.DATABASE_PATH = path.join(workDir, 'test.sqlite');
process.env.APP_PASSWORD = 'test';
process.env.SESSION_SECRET = 'test-secret-do-testow-1234567890';
process.env.DISABLE_EXTERNAL_FETCH = 'true';
process.env.NODE_ENV = 'test';

type Modules = {
  db: typeof import('../src/db/index.js')['db'];
  schema: typeof import('../src/db/schema.js');
  positions: typeof import('../src/services/positions.js');
  snapshots: typeof import('../src/services/snapshots.js');
  dashboard: typeof import('../src/services/dashboard.js');
  alerts: typeof import('../src/services/alerts.js');
  fx: typeof import('../src/services/fx.js');
  transactions: typeof import('../src/services/transactions.js');
  insights: typeof import('../src/services/insights.js');
};

let m: Modules;

/** Identyfikatory tworzone w `beforeAll`, używane w asercjach. */
let mainPortfolio: number;
let ikePortfolio: number;
let emergencyPortfolio: number;
let cdrId: number;
let iuitId: number;

beforeAll(async () => {
  const dbModule = await import('../src/db/index.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  runMigrations();

  m = {
    db: dbModule.db,
    schema: await import('../src/db/schema.js'),
    positions: await import('../src/services/positions.js'),
    snapshots: await import('../src/services/snapshots.js'),
    dashboard: await import('../src/services/dashboard.js'),
    alerts: await import('../src/services/alerts.js'),
    fx: await import('../src/services/fx.js'),
    transactions: await import('../src/services/transactions.js'),
    insights: await import('../src/services/insights.js'),
  };

  const { db, schema } = m;

  mainPortfolio = db
    .insert(schema.portfolios)
    .values({ name: 'Główny', taxRegime: 'taxable' })
    .returning()
    .get().id;

  ikePortfolio = db.insert(schema.portfolios).values({ name: 'IKE', taxRegime: 'ike' }).returning().get().id;

  emergencyPortfolio = db
    .insert(schema.portfolios)
    .values({ name: 'Poduszka', taxRegime: 'taxable', emergencyFund: true })
    .returning()
    .get().id;

  cdrId = db
    .insert(schema.instruments)
    .values({ symbol: 'WSE:CDR', name: 'CD Projekt', assetClass: 'stock_pl', currency: 'PLN', exchange: 'WSE' })
    .returning()
    .get().id;

  iuitId = db
    .insert(schema.instruments)
    .values({ symbol: 'LON:IUIT', name: 'iShares S&P 500 IT', assetClass: 'etf_foreign', currency: 'USD', exchange: 'LON' })
    .returning()
    .get().id;

  // Kurs potrzebny do wyceny pozycji walutowej.
  db.insert(schema.fxRates).values({ currency: 'USD', date: '2025-01-02', rateE6: 4_000_000 }).run();

  // Portfel główny: wpłata 10 000 zł, zakup 10 szt. CDR po 200 zł.
  db.insert(schema.transactions)
    .values([
      {
        portfolioId: mainPortfolio,
        type: 'deposit',
        tradeDate: '2025-01-02',
        currency: 'PLN',
        grossMinor: 1_000_000,
        amountPlnMinor: 1_000_000,
        taxAmountPlnMinor: 1_000_000,
      },
      {
        portfolioId: mainPortfolio,
        instrumentId: cdrId,
        type: 'buy',
        tradeDate: '2025-01-03',
        currency: 'PLN',
        qtyE8: toQty('10'),
        priceE8: toPrice('200'),
        grossMinor: 200_000,
        amountPlnMinor: -200_000,
        taxAmountPlnMinor: -200_000,
      },
      // IKE: ten sam instrument, inna cena — sprawdzamy rozdział portfeli.
      {
        portfolioId: ikePortfolio,
        type: 'deposit',
        tradeDate: '2025-01-02',
        currency: 'PLN',
        grossMinor: 500_000,
        amountPlnMinor: 500_000,
        taxAmountPlnMinor: 500_000,
      },
      {
        portfolioId: ikePortfolio,
        instrumentId: cdrId,
        type: 'buy',
        tradeDate: '2025-01-04',
        currency: 'PLN',
        qtyE8: toQty('5'),
        priceE8: toPrice('300'),
        grossMinor: 150_000,
        amountPlnMinor: -150_000,
        taxAmountPlnMinor: -150_000,
      },
      // Poduszka: sama gotówka.
      {
        portfolioId: emergencyPortfolio,
        type: 'deposit',
        tradeDate: '2025-01-02',
        currency: 'PLN',
        grossMinor: 3_000_000,
        amountPlnMinor: 3_000_000,
        taxAmountPlnMinor: 3_000_000,
      },
    ])
    .run();

  // Notowanie: CDR po 250 zł.
  db.insert(schema.quotes)
    .values({
      instrumentId: cdrId,
      priceE8: toPrice('250'),
      currency: 'PLN',
      prevCloseE8: toPrice('240'),
      ts: new Date().toISOString(),
      source: 'test',
    })
    .run();
});

afterAll(async () => {
  // Windows trzyma blokadę na otwartym pliku bazy — bez zamknięcia połączenia
  // sprzątanie katalogu tymczasowego kończy się błędem uprawnień.
  const { closeDb } = await import('../src/db/index.js');
  closeDb();

  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Katalog tymczasowy i tak sprząta system; nieudane usunięcie nie jest
    // powodem, żeby oznaczać przebieg testów jako nieudany.
  }
});

describe('pozycje', () => {
  it('liczy wartość pozycji z bieżącego notowania', () => {
    const { positions } = m.positions.buildPositions([mainPortfolio]);
    const cdr = positions.find((p) => p.instrument.id === cdrId)!;

    expect(cdr.qtyE8).toBe(toQty('10'));
    expect(cdr.costPlnMinor).toBe(200_000);
    // 10 szt. × 250 zł = 2500 zł
    expect(cdr.valuePlnMinor).toBe(250_000);
    expect(cdr.unrealizedPlnMinor).toBe(50_000);
  });

  it('podaje średnią cenę nabycia w złotych, a nie sto razy mniejszą', () => {
    const { positions } = m.positions.buildPositions([mainPortfolio]);
    const cdr = positions.find((p) => p.instrument.id === cdrId)!;

    // 2000 zł kosztu na 10 sztuk = 200 zł za sztukę.
    expect(cdr.avgPriceE8).toBe(toPrice('200'));
  });

  it('nie miesza pozycji między portfelami', () => {
    const main = m.positions.buildPositions([mainPortfolio]).positions.find((p) => p.instrument.id === cdrId)!;
    const ike = m.positions.buildPositions([ikePortfolio]).positions.find((p) => p.instrument.id === cdrId)!;

    expect(main.qtyE8).toBe(toQty('10'));
    expect(ike.qtyE8).toBe(toQty('5'));
    expect(ike.avgPriceE8).toBe(toPrice('300'));
  });

  it('nie zwielokrotnia wartości przy kilku portfelach naraz', () => {
    // Regresja: suma dla wszystkich portfeli musi równać się sumie części,
    // a nie ich wielokrotności.
    const all = m.positions.buildPositions([mainPortfolio, ikePortfolio, emergencyPortfolio]);
    const separate =
      m.positions.buildPositions([mainPortfolio]).totalValuePlnMinor +
      m.positions.buildPositions([ikePortfolio]).totalValuePlnMinor +
      m.positions.buildPositions([emergencyPortfolio]).totalValuePlnMinor;

    expect(all.totalValuePlnMinor).toBe(separate);
  });

  it('liczy saldo gotówki z podpisanych przepływów', () => {
    const { cashByPortfolio } = m.positions.buildPositions([mainPortfolio]);
    // 10 000 wpłaty − 2 000 zakupu = 8 000 zł
    expect(cashByPortfolio.get(mainPortfolio)).toBe(800_000);
  });

  it('liczy kapitał wpłacony netto', () => {
    expect(m.positions.netInvested([mainPortfolio])).toBe(1_000_000);
    expect(m.positions.netInvested([mainPortfolio, ikePortfolio])).toBe(1_500_000);
  });
});

describe('kursy walut', () => {
  it('zwraca kurs waluty bazowej bez sięgania do bazy', async () => {
    expect(await m.fx.getFxRate('PLN', '2025-01-02')).toBe(1_000_000);
  });

  it('korzysta z kursu zapisanego w bazie', async () => {
    expect(await m.fx.getFxRate('USD', '2025-01-02')).toBe(4_000_000);
  });

  it('wykrywa waluty używane w portfelu', () => {
    // USD pochodzi z instrumentu LON:IUIT, PLN jako bazowa jest pomijana.
    expect(m.fx.currenciesInUse()).toContain('USD');
    expect(m.fx.currenciesInUse()).not.toContain('PLN');
  });
});

describe('snapshoty', () => {
  it('zapisuje dzienny stan każdego aktywnego portfela', () => {
    const message = m.snapshots.writeDailySnapshot('2025-02-01');
    expect(message).toContain('3');

    const history = m.snapshots.readHistory([mainPortfolio], '2025-02-01', '2025-02-01');
    expect(history).toHaveLength(1);
    expect(history[0]?.valuePlnMinor).toBe(1_050_000); // 8000 gotówki + 2500 pozycji
  });

  it('sumuje historię po portfelach', () => {
    m.snapshots.writeDailySnapshot('2025-02-02');
    const combined = m.snapshots.readHistory([mainPortfolio, ikePortfolio], '2025-02-02', '2025-02-02');

    expect(combined).toHaveLength(1);
    const main = m.snapshots.readHistory([mainPortfolio], '2025-02-02', '2025-02-02')[0]!;
    const ike = m.snapshots.readHistory([ikePortfolio], '2025-02-02', '2025-02-02')[0]!;
    expect(combined[0]?.valuePlnMinor).toBe(main.valuePlnMinor + ike.valuePlnMinor);
  });

  it('nie nadpisuje własnych pomiarów danymi z importu', () => {
    const inserted = m.snapshots.importSnapshots(mainPortfolio, [
      { date: '2025-02-01', valuePlnMinor: 999 },
      { date: '2024-12-01', valuePlnMinor: 500_000 },
    ]);

    // Dzień 2025-02-01 mamy zmierzony sami — import go pomija.
    expect(inserted).toBe(1);
    expect(m.snapshots.readHistory([mainPortfolio], '2025-02-01', '2025-02-01')[0]?.valuePlnMinor).toBe(1_050_000);
  });
});

describe('pulpit', () => {
  it('zbiera podsumowanie, alokację i ostrzeżenia', () => {
    const dashboard = m.dashboard.buildDashboard([mainPortfolio]);

    expect(dashboard.summary.valuePlnMinor).toBe(1_050_000);
    expect(dashboard.summary.investedPlnMinor).toBe(1_000_000);
    expect(dashboard.summary.totalReturnPlnMinor).toBe(50_000);
    expect(dashboard.summary.positionsCount).toBe(1);
  });

  it('rozbija alokację na klasy aktywów wraz z gotówką', () => {
    const dashboard = m.dashboard.buildDashboard([mainPortfolio]);
    const keys = dashboard.allocation.assetClass.map((slice) => slice.key);

    expect(keys).toContain('stock_pl');
    expect(keys).toContain('cash');
    const total = dashboard.allocation.assetClass.reduce((sum, s) => sum + s.valuePlnMinor, 0);
    expect(total).toBe(1_050_000);
  });

  it('udziały w alokacji sumują się do stu procent', () => {
    const dashboard = m.dashboard.buildDashboard([mainPortfolio]);
    const sum = dashboard.allocation.assetClass.reduce((s, slice) => s + slice.shareBp, 0);
    // Dopuszczamy odchylenie rzędu zaokrągleń poszczególnych udziałów.
    expect(Math.abs(sum - 10_000)).toBeLessThanOrEqual(5);
  });
});

describe('alerty', () => {
  it('wykrywa przekroczenie progu cenowego dla instrumentu spoza portfela', async () => {
    const { db, schema } = m;

    // Instrument z watchlisty: nie mamy pozycji, ale mamy notowanie.
    const watched = db
      .insert(schema.instruments)
      .values({ symbol: 'WSE:PKO', name: 'PKO BP', assetClass: 'stock_pl', currency: 'PLN', exchange: 'WSE' })
      .returning()
      .get();

    db.insert(schema.quotes)
      .values({
        instrumentId: watched.id,
        priceE8: toPrice('80'),
        currency: 'PLN',
        prevCloseE8: null,
        ts: new Date().toISOString(),
        source: 'test',
      })
      .run();

    db.insert(schema.alerts)
      .values({ kind: 'price', instrumentId: watched.id, condition: { above: 70 }, enabled: true })
      .run();

    const message = await m.alerts.evaluateAlerts();
    expect(message).toContain('wykryto');

    const events = m.alerts.recentAlertEvents();
    expect(events.some((e) => e.kind === 'price' && e.message.includes('PKO'))).toBe(true);
  });
});

describe('poduszka finansowa', () => {
  it('liczy wyłącznie portfele oznaczone jako poduszka', () => {
    const status = m.insights.emergencyFundStatus();

    expect(status.configured).toBe(true);
    expect(status.portfolioNames).toEqual(['Poduszka']);
    expect(status.currentPlnMinor).toBe(3_000_000);
  });
});

describe('przeliczanie zysków zrealizowanych', () => {
  it('rozlicza sprzedaż metodą FIFO w obrębie portfela', async () => {
    await m.transactions.createTransaction({
      portfolioId: mainPortfolio,
      instrumentId: cdrId,
      type: 'sell',
      tradeDate: '2025-03-01',
      quantity: '4',
      price: '260',
      currency: 'PLN',
    });

    const { positions } = m.positions.buildPositions([mainPortfolio]);
    const cdr = positions.find((p) => p.instrument.id === cdrId)!;

    expect(cdr.qtyE8).toBe(toQty('6'));
    // Sprzedano 4 szt. kupione po 200 zł za 260 zł → 240 zł zysku.
    expect(m.positions.realizedTotal([mainPortfolio])).toBe(24_000);
  });
});

/**
 * Kosz na transakcje.
 *
 * Usunięcie przenosi wiersz do osobnej tabeli, zamiast oznaczać go flagą —
 * dzięki temu żaden odczyt liczący pieniądze nie musi pamiętać o filtrze.
 * Te testy pilnują, że przeniesienie i powrót nie gubią nic po drodze.
 */
describe('kosz na transakcje', () => {
  it('usunięcie zdejmuje transakcję z wyliczeń i przenosi ją do kosza', async () => {
    const { transaction } = await m.transactions.createTransaction({
      portfolioId: mainPortfolio,
      instrumentId: cdrId,
      type: 'sell',
      tradeDate: '2025-04-01',
      quantity: '2',
      price: '300',
      currency: 'PLN',
    });

    const realizedBefore = m.positions.realizedTotal([mainPortfolio]);
    const qtyBefore = m.positions.buildPositions([mainPortfolio]).positions.find((p) => p.instrument.id === cdrId)!.qtyE8;

    m.transactions.deleteTransaction(transaction.id);

    // Sprzedaż zniknęła: sztuki wróciły do pozycji, a jej zysk z rozliczenia.
    const after = m.transactions.listTransactions({ limit: 500, offset: 0 });
    expect(after.some((t) => t.id === transaction.id)).toBe(false);
    expect(m.positions.realizedTotal([mainPortfolio])).toBeLessThan(realizedBefore);
    expect(
      m.positions.buildPositions([mainPortfolio]).positions.find((p) => p.instrument.id === cdrId)!.qtyE8,
    ).toBeGreaterThan(qtyBefore);

    const trash = m.transactions.listDeletedTransactions();
    expect(trash.some((entry) => entry.transactionId === transaction.id)).toBe(true);
  });

  it('przywrócenie odtwarza wynik zrealizowany co do grosza', async () => {
    const { transaction } = await m.transactions.createTransaction({
      portfolioId: mainPortfolio,
      instrumentId: cdrId,
      type: 'sell',
      tradeDate: '2025-05-01',
      quantity: '1',
      price: '280',
      currency: 'PLN',
    });

    const realizedBefore = m.positions.realizedTotal([mainPortfolio]);

    m.transactions.deleteTransaction(transaction.id);
    const entry = m.transactions.listDeletedTransactions().find((e) => e.transactionId === transaction.id)!;
    const restored = m.transactions.restoreTransaction(entry.id);

    // Nowy identyfikator, ta sama treść i ten sam wynik podatkowy.
    expect(restored.transaction.id).not.toBe(0);
    expect(restored.transaction.tradeDate).toBe('2025-05-01');
    expect(m.positions.realizedTotal([mainPortfolio])).toBe(realizedBefore);

    // Wpis znika z kosza — nie da się przywrócić tej samej transakcji dwa razy.
    expect(m.transactions.listDeletedTransactions().some((e) => e.id === entry.id)).toBe(false);
  });
});
