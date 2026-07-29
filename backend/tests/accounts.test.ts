import { describe, expect, it } from 'vitest';
import { computeFifo, groupForFifo } from '../src/services/fifo.js';
import type { FifoTransaction } from '../src/services/fifo.js';
import { splitByAccount } from '../src/services/positions.js';

/**
 * Konto jest wymiarem raportowym, nie rozliczeniowym.
 *
 * Te testy pilnują dwóch rzeczy naraz: że rozbicie pozycji na konta jest
 * dokładne co do grosza i — co ważniejsze — że dołożenie kont NIE zmieniło
 * niczego w samym FIFO. Druga część jest bezpiecznikiem: rozdzielenie kolejki
 * lotów po kontach rozerwałoby podstawę kosztu przy przeniesieniu papieru
 * między rachunkami i zawyżyło dochód w PIT-38.
 */

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

/** Konto A = 1, konto B = 2. */
const ACCOUNTS = new Map<number, number | null>([
  [1, 1],
  [2, 2],
]);

describe('FIFO nie wie nic o kontach', () => {
  it('trzyma jedną kolejkę lotów dla transakcji z dwóch kont', () => {
    // Kupno na koncie A jest starsze, więc sprzedaż musi zjeść je pierwsze —
    // niezależnie od tego, że pieniądze wpłynęły na konto B.
    const result = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 10 * E8, amountPlnMinor: -300_00 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 15 * E8, amountPlnMinor: 300_00 }),
      ],
      stocks,
    );

    // Dwa rozliczenia: cały lot z konta A i połowa lotu z konta B.
    expect(result.gains).toHaveLength(2);
    expect(result.gains[0]?.buyTransactionId).toBe(1);
    expect(result.gains[1]?.buyTransactionId).toBe(2);
    expect(result.remainingQtyE8).toBe(5 * E8);
    expect(result.warnings).toHaveLength(0);
  });

  it('grupuje wyłącznie po portfelu i instrumencie, nigdy po koncie', () => {
    const groups = groupForFifo([
      { id: 1, portfolioId: 1, instrumentId: 10, accountId: 1 },
      { id: 2, portfolioId: 1, instrumentId: 10, accountId: 2 },
      { id: 3, portfolioId: 2, instrumentId: 10, accountId: 1 },
    ]);

    expect([...groups.keys()].sort()).toEqual(['1:10', '2:10']);
    expect(groups.get('1:10')).toHaveLength(2);
  });
});

describe('splitByAccount', () => {
  it('przypisuje pozostałe sztuki kontu, na którym kupowano najpóźniej', () => {
    // 10 szt. na koncie A, 10 na B, sprzedaż 15 → zostaje 5, wszystkie z B,
    // bo FIFO zdjął najpierw cały lot A.
    const fifo = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 10 * E8, amountPlnMinor: -100_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 10 * E8, amountPlnMinor: -300_00 }),
        tx({ id: 3, type: 'sell', tradeDate: '2025-06-10', qtyE8: 15 * E8, amountPlnMinor: 300_00 }),
      ],
      stocks,
    );

    const slices = splitByAccount(fifo.openLots, ACCOUNTS, 400_00);

    expect(slices).toHaveLength(1);
    expect(slices[0]?.accountId).toBe(2);
    expect(slices[0]?.qtyE8).toBe(5 * E8);
    expect(slices[0]?.valuePlnMinor).toBe(400_00);
  });

  it('dzieli pozycję leżącą na dwóch kontach proporcjonalnie do ilości', () => {
    const fifo = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 3 * E8, amountPlnMinor: -300_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 1 * E8, amountPlnMinor: -100_00 }),
      ],
      stocks,
    );

    const slices = splitByAccount(fifo.openLots, ACCOUNTS, 800_00);

    expect(slices).toHaveLength(2);
    expect(slices.find((s) => s.accountId === 1)?.valuePlnMinor).toBe(600_00);
    expect(slices.find((s) => s.accountId === 2)?.valuePlnMinor).toBe(200_00);
  });

  it('sumuje się do całości co do grosza mimo niepodzielnej wartości', () => {
    // 1/3 z 100,01 zł nie dzieli się równo — reszta musi trafić do ostatniej
    // porcji, inaczej suma kont różniłaby się od wartości pozycji.
    const fifo = computeFifo(
      [
        tx({ id: 1, type: 'buy', tradeDate: '2025-01-10', qtyE8: 1 * E8, amountPlnMinor: -50_00 }),
        tx({ id: 2, type: 'buy', tradeDate: '2025-02-10', qtyE8: 2 * E8, amountPlnMinor: -50_00 }),
      ],
      stocks,
    );

    const value = 100_01;
    const slices = splitByAccount(fifo.openLots, ACCOUNTS, value);

    expect(slices.reduce((sum, s) => sum + s.valuePlnMinor, 0)).toBe(value);
    expect(slices.reduce((sum, s) => sum + s.qtyE8, 0)).toBe(fifo.remainingQtyE8);
    expect(slices.reduce((sum, s) => sum + s.costPlnMinor, 0)).toBe(fifo.remainingCostPlnMinor);
  });

  it('zbiera transakcje bez konta do kubełka „nieprzypisane”', () => {
    const fifo = computeFifo(
      [tx({ id: 99, type: 'buy', tradeDate: '2025-01-10', qtyE8: 2 * E8, amountPlnMinor: -200_00 })],
      stocks,
    );

    const slices = splitByAccount(fifo.openLots, new Map(), 250_00);

    expect(slices).toHaveLength(1);
    expect(slices[0]?.accountId).toBeNull();
    expect(slices[0]?.valuePlnMinor).toBe(250_00);
  });

  it('zwraca pustą listę, gdy nic nie zostało', () => {
    expect(splitByAccount([], ACCOUNTS, 0)).toEqual([]);
  });
});
