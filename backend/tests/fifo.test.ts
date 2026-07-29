import { describe, expect, it } from 'vitest';
import { toQty } from '@portfolio/shared';
import { computeFifo, groupForFifo, sortForFifo } from '../src/services/fifo.js';
import type { FifoTransaction } from '../src/services/fifo.js';

const E8 = 100_000_000;

function tx(partial: Partial<FifoTransaction> & Pick<FifoTransaction, 'id' | 'type' | 'tradeDate'>): FifoTransaction {
  return {
    portfolioId: 1,
    instrumentId: 10,
    qtyE8: 0,
    amountPlnMinor: 0,
    ...partial,
  };
}

const stocks = { assetClass: 'stock_pl' as const, taxExempt: false };

describe('FIFO — podstawy', () => {
  it('rozlicza sprzedaż całej pozycji z jednego lotu', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-06-10', qtyE8: 10 * E8, amountPlnMinor: 150_00 }),
      ],
      stocks,
    );

    expect(result.gains).toHaveLength(1);
    expect(result.gains[0]).toMatchObject({
      costPlnMinor: 100_00,
      proceedsPlnMinor: 150_00,
      gainPlnMinor: 50_00,
      purchaseDate: '2025-01-10',
      saleDate: '2025-06-10',
      year: 2025,
      taxCategory: 'securities',
    });
    expect(result.remainingQtyE8).toBe(0);
    expect(result.remainingCostPlnMinor).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('zabiera najstarszy lot jako pierwszy, nie najtańszy', () => {
    const result = computeFifo(
      [
        // Najstarszy jest droższy — metoda LIFO albo "średnia" dałyby inny wynik.
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -200_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 10 * E8, amountPlnMinor: 250_00 }),
      ],
      stocks,
    );

    expect(result.gains).toHaveLength(1);
    expect(result.gains[0]?.buyTransactionId).toBe(1);
    expect(result.gains[0]?.costPlnMinor).toBe(200_00);
    expect(result.gains[0]?.gainPlnMinor).toBe(50_00);
    expect(result.remainingQtyE8).toBe(10 * E8);
    expect(result.remainingCostPlnMinor).toBe(100_00);
  });

  it('dzieli jedną sprzedaż między kilka lotów', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 5 * E8, amountPlnMinor: -50_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 5 * E8, amountPlnMinor: -80_00 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 8 * E8, amountPlnMinor: 160_00 }),
      ],
      stocks,
    );

    expect(result.gains).toHaveLength(2);
    expect(result.gains[0]).toMatchObject({ buyTransactionId: 1, qtyE8: 5 * E8, costPlnMinor: 50_00 });
    expect(result.gains[1]).toMatchObject({ buyTransactionId: 2, qtyE8: 3 * E8, costPlnMinor: 48_00 });
    // Przychód rozdzielony proporcjonalnie i w całości przypisany.
    const proceeds = result.gains.reduce((s, g) => s + g.proceedsPlnMinor, 0);
    expect(proceeds).toBe(160_00);
    expect(result.remainingQtyE8).toBe(2 * E8);
    expect(result.remainingCostPlnMinor).toBe(32_00);
  });
});

describe('FIFO — rozdział portfeli', () => {
  it('nie miesza lotów między portfelami', () => {
    const all = [
      tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00, portfolioId: 1 }),
      tx({ id: 2, type: 'buy', tradeDate: '2025-01-11', qtyE8: 10 * E8, amountPlnMinor: -500_00, portfolioId: 2 }),
      tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 10 * E8, amountPlnMinor: 150_00, portfolioId: 2 }),
    ];

    const groups = groupForFifo(all);
    expect(groups.size).toBe(2);

    const portfolio2 = computeFifo(groups.get('2:10') ?? [], stocks);
    // Gdyby loty się mieszały, sprzedaż zabrałaby tańszy lot z portfela 1
    // i pokazała zysk zamiast straty.
    expect(portfolio2.gains).toHaveLength(1);
    expect(portfolio2.gains[0]?.costPlnMinor).toBe(500_00);
    expect(portfolio2.gains[0]?.gainPlnMinor).toBe(-350_00);

    const portfolio1 = computeFifo(groups.get('1:10') ?? [], stocks);
    expect(portfolio1.gains).toHaveLength(0);
    expect(portfolio1.remainingQtyE8).toBe(10 * E8);
  });

  it('pomija transakcje bez instrumentu przy grupowaniu', () => {
    const groups = groupForFifo([
      { portfolioId: 1, instrumentId: null },
      { portfolioId: 1, instrumentId: 5 },
    ]);
    expect(groups.size).toBe(1);
    expect(groups.has('1:5')).toBe(true);
  });
});

describe('FIFO — ilości ułamkowe i zaokrąglenia', () => {
  it('obsługuje ułamkowe akcje z XTB bez gubienia groszy', () => {
    // Realny przypadek z wyciągu: 0.2301 + 2.0 szt. BY6.DE, potem sprzedaż całości.
    // Ilości przechodzą przez toQty, bo 2.2301 * 1e8 w arytmetyce float daje
    // 223010000.00000003 — dokładnie ten błąd, którego skalowanie ma unikać.
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2026-01-09', qtyE8: toQty('0.2301'), amountPlnMinor: -10_22 }),
        tx({ id: 2, type: 'buy', tradeDate: '2026-01-09', qtyE8: toQty('2'), amountPlnMinor: -88_71 }),
        tx({ id: 3, type: 'sell', tradeDate: '2026-05-27', qtyE8: toQty('2.2301'), amountPlnMinor: 98_93 }),
      ],
      stocks,
    );

    const cost = result.gains.reduce((s, g) => s + g.costPlnMinor, 0);
    const proceeds = result.gains.reduce((s, g) => s + g.proceedsPlnMinor, 0);
    const gain = result.gains.reduce((s, g) => s + g.gainPlnMinor, 0);

    expect(cost).toBe(98_93);
    expect(proceeds).toBe(98_93);
    expect(gain).toBe(0);
    expect(result.remainingQtyE8).toBe(0);
    expect(result.remainingCostPlnMinor).toBe(0);
  });

  it('nie zostawia resztek kosztu po serii sprzedaży częściowych', () => {
    // Kwota niepodzielna przez 3 — sprawdzamy, czy grosze się nie gubią.
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-01', qtyE8: 3 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-02-01', qtyE8: 1 * E8, amountPlnMinor: 40_00 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-03-01', qtyE8: 1 * E8, amountPlnMinor: 40_00 }),
        tx({ id: 4, type: 'sell', tradeDate: '2025-04-01', qtyE8: 1 * E8, amountPlnMinor: 40_00 }),
      ],
      stocks,
    );

    const cost = result.gains.reduce((s, g) => s + g.costPlnMinor, 0);
    expect(cost).toBe(100_00);
    expect(result.remainingQtyE8).toBe(0);
    expect(result.remainingCostPlnMinor).toBe(0);
  });
});

describe('FIFO — przypadki brzegowe', () => {
  it('zgłasza sprzedaż bez pokrycia zamiast liczyć zerowy koszt', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 1 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-06-10', qtyE8: 5 * E8, amountPlnMinor: 500_00 }),
      ],
      stocks,
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('oversell');
    expect(result.gains).toHaveLength(1);
    expect(result.gains[0]?.qtyE8).toBe(1 * E8);
  });

  it('koryguje loty po splicie, zachowując koszt', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'split', tradeDate: '2025-03-01', qtyE8: 2 * E8 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 20 * E8, amountPlnMinor: 120_00 }),
      ],
      stocks,
    );

    expect(result.gains).toHaveLength(1);
    expect(result.gains[0]?.costPlnMinor).toBe(100_00);
    expect(result.gains[0]?.gainPlnMinor).toBe(20_00);
    expect(result.remainingQtyE8).toBe(0);
  });

  it('ignoruje dywidendy i opłaty przy rozliczaniu lotów', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'dividend', tradeDate: '2025-03-01', amountPlnMinor: 5_00 }),
        tx({ id: 3, type: 'fee', tradeDate: '2025-04-01', amountPlnMinor: -1_00 }),
      ],
      stocks,
    );

    expect(result.gains).toHaveLength(0);
    expect(result.remainingQtyE8).toBe(10 * E8);
    expect(result.remainingCostPlnMinor).toBe(100_00);
  });

  it('oznacza krypto osobną kategorią podatkową', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 0.5 * E8, amountPlnMinor: -100_000_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-06-10', qtyE8: 0.5 * E8, amountPlnMinor: 130_000_00 }),
      ],
      { assetClass: 'crypto', taxExempt: false },
    );

    expect(result.gains[0]?.taxCategory).toBe('crypto');
  });

  it('rozdziela podstawę podatkową od faktycznego przepływu przy walucie obcej', () => {
    // Zakup NOVO-B: broker pobrał 100,03 zł po własnym kursie, ale NBP D-1
    // daje 99,05 zł. Sprzedaż analogicznie. Wynik podatkowy musi iść po NBP,
    // a prezentowany zysk po kursach rozliczeniowych.
    const result = computeFifo(
      [
        tx({
          id: 1,
          type: 'buy',
          tradeDate: '2025-09-29',
          qtyE8: toQty('0.5'),
          amountPlnMinor: -100_03,
          taxAmountPlnMinor: -99_05,
        }),
        tx({
          id: 2,
          type: 'sell',
          tradeDate: '2026-06-30',
          qtyE8: toQty('0.5'),
          amountPlnMinor: 120_00,
          taxAmountPlnMinor: 118_00,
        }),
      ],
      stocks,
    );

    expect(result.gains[0]).toMatchObject({
      costPlnMinor: 100_03,
      proceedsPlnMinor: 120_00,
      gainPlnMinor: 19_97,
      taxCostPlnMinor: 99_05,
      taxProceedsPlnMinor: 118_00,
      taxGainPlnMinor: 18_95,
    });
  });

  it('przyjmuje przepływ faktyczny jako podstawę podatkową dla transakcji w PLN', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-06-10', qtyE8: 10 * E8, amountPlnMinor: 150_00 }),
      ],
      stocks,
    );

    expect(result.gains[0]?.taxGainPlnMinor).toBe(result.gains[0]?.gainPlnMinor);
    expect(result.gains[0]?.taxCostPlnMinor).toBe(100_00);
  });

  it('przenosi flagę zwolnienia podatkowego z portfela IKE', () => {
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 1 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'sell', tradeDate: '2025-06-10', qtyE8: 1 * E8, amountPlnMinor: 150_00 }),
      ],
      { assetClass: 'stock_pl', taxExempt: true },
    );

    expect(result.gains[0]?.taxExempt).toBe(true);
  });

  it('sortuje po dacie, a przy równej dacie po kolejności wprowadzenia', () => {
    const sorted = sortForFifo([
      tx({ id: 3, type: 'buy', tradeDate: '2025-01-10' }),
      tx({ id: 1, type: 'buy', tradeDate: '2025-01-10' }),
      tx({ id: 2, type: 'buy', tradeDate: '2025-01-09' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual([2, 1, 3]);
  });
});
