import { bigintToNumber, mulDiv, taxCategoryFor } from '@portfolio/shared';
import type { AssetClass, TaxCategory, TransactionType } from '@portfolio/shared';
import { yearOf } from '../lib/dates.js';

/**
 * Rozliczanie zysków zrealizowanych metodą FIFO.
 *
 * Zasady, których ten moduł pilnuje:
 *  - partie (loty) są prowadzone osobno dla każdej pary portfel + instrument;
 *    sprzedaż w jednym portfelu nigdy nie sięga po loty z innego,
 *  - koszt nabycia obejmuje prowizję zakupu, przychód ze sprzedaży jest
 *    pomniejszony o prowizję sprzedaży,
 *  - wszystko liczone w groszach PLN po kursie z dnia transakcji.
 *
 * Moduł jest czysty: nie dotyka bazy, nie zna Express-a. Dzięki temu da się go
 * przetestować na tabelkach z realnych wyciągów.
 */

export interface FifoTransaction {
  id: number;
  portfolioId: number;
  instrumentId: number;
  type: TransactionType;
  tradeDate: string;
  qtyE8: number;
  /** Podpisany przepływ gotówki w PLN: kupno ujemne, sprzedaż dodatnia. */
  amountPlnMinor: number;
  /**
   * Ta sama kwota po kursie NBP D-1 — podstawa podatkowa. Jeśli pominięta,
   * przyjmujemy `amountPlnMinor` (transakcje w PLN mają obie wartości równe).
   */
  taxAmountPlnMinor?: number;
}

export interface FifoContext {
  assetClass: AssetClass;
  taxExempt: boolean;
}

export interface OpenLot {
  buyTransactionId: number;
  purchaseDate: string;
  qtyE8: number;
  /** Koszt przypadający na pozostałą ilość — maleje wraz z konsumpcją lotu. */
  costPlnMinor: number;
  /** To samo, ale po kursach NBP — podstawa kosztu w rozliczeniu podatkowym. */
  taxCostPlnMinor: number;
}

export interface RealizedGainInput {
  sellTransactionId: number;
  buyTransactionId: number;
  portfolioId: number;
  instrumentId: number;
  taxCategory: TaxCategory;
  taxExempt: boolean;
  saleDate: string;
  purchaseDate: string;
  qtyE8: number;
  costPlnMinor: number;
  proceedsPlnMinor: number;
  gainPlnMinor: number;
  taxCostPlnMinor: number;
  taxProceedsPlnMinor: number;
  taxGainPlnMinor: number;
  year: number;
}

export interface FifoResult {
  gains: RealizedGainInput[];
  openLots: OpenLot[];
  /** Pozostała ilość i jej koszt — podstawa do średniej ceny nabycia pozycji. */
  remainingQtyE8: number;
  remainingCostPlnMinor: number;
  remainingTaxCostPlnMinor: number;
  /** Sytuacje wymagające uwagi użytkownika, np. sprzedaż bez pokrycia w zakupach. */
  warnings: FifoWarning[];
}

export interface FifoWarning {
  kind: 'oversell' | 'zero_quantity' | 'unknown_split';
  transactionId: number;
  message: string;
}

/** Porządek chronologiczny; przy tej samej dacie decyduje kolejność wprowadzenia. */
export function sortForFifo(transactions: FifoTransaction[]): FifoTransaction[] {
  return [...transactions].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
  );
}

export function computeFifo(transactions: FifoTransaction[], context: FifoContext): FifoResult {
  const gains: RealizedGainInput[] = [];
  const warnings: FifoWarning[] = [];
  const lots: OpenLot[] = [];
  const taxCategory = taxCategoryFor(context.assetClass);

  for (const tx of sortForFifo(transactions)) {
    switch (tx.type) {
      case 'buy': {
        if (tx.qtyE8 <= 0) {
          warnings.push({
            kind: 'zero_quantity',
            transactionId: tx.id,
            message: `Kupno ${tx.tradeDate} ma zerową liczbę sztuk — pomijam w rozliczeniu.`,
          });
          break;
        }
        lots.push({
          buyTransactionId: tx.id,
          purchaseDate: tx.tradeDate,
          qtyE8: tx.qtyE8,
          costPlnMinor: Math.abs(tx.amountPlnMinor),
          taxCostPlnMinor: Math.abs(tx.taxAmountPlnMinor ?? tx.amountPlnMinor),
        });
        break;
      }

      case 'sell': {
        if (tx.qtyE8 <= 0) {
          warnings.push({
            kind: 'zero_quantity',
            transactionId: tx.id,
            message: `Sprzedaż ${tx.tradeDate} ma zerową liczbę sztuk — pomijam w rozliczeniu.`,
          });
          break;
        }
        consumeLots(tx, lots, gains, warnings, { taxCategory, taxExempt: context.taxExempt });
        break;
      }

      case 'split': {
        // Ratio zapisany w qtyE8: 2e8 = split 2:1, 0.5e8 = scalenie 1:2.
        // Koszt lotów zostaje bez zmian, zmienia się tylko liczba sztuk.
        if (tx.qtyE8 <= 0) {
          warnings.push({
            kind: 'unknown_split',
            transactionId: tx.id,
            message: `Split ${tx.tradeDate} bez poprawnego współczynnika — pomijam.`,
          });
          break;
        }
        for (const lot of lots) {
          lot.qtyE8 = bigintToNumber(mulDiv(BigInt(lot.qtyE8), BigInt(tx.qtyE8), 100_000_000n));
        }
        break;
      }

      default:
        // Dywidendy, odsetki, opłaty i przepływy gotówkowe nie zmieniają lotów.
        break;
    }
  }

  const remainingQtyE8 = lots.reduce((sum, lot) => sum + lot.qtyE8, 0);
  const remainingCostPlnMinor = lots.reduce((sum, lot) => sum + lot.costPlnMinor, 0);
  const remainingTaxCostPlnMinor = lots.reduce((sum, lot) => sum + lot.taxCostPlnMinor, 0);

  return {
    gains,
    openLots: lots,
    remainingQtyE8,
    remainingCostPlnMinor,
    remainingTaxCostPlnMinor,
    warnings,
  };
}

function consumeLots(
  sell: FifoTransaction,
  lots: OpenLot[],
  gains: RealizedGainInput[],
  warnings: FifoWarning[],
  meta: { taxCategory: TaxCategory; taxExempt: boolean },
): void {
  let qtyToSell = sell.qtyE8;
  const sellQtyTotal = sell.qtyE8;
  const proceedsTotal = Math.abs(sell.amountPlnMinor);
  const taxProceedsTotal = Math.abs(sell.taxAmountPlnMinor ?? sell.amountPlnMinor);
  let proceedsAssigned = 0;
  let taxProceedsAssigned = 0;

  while (qtyToSell > 0 && lots.length > 0) {
    const lot = lots[0]!;
    const qtyTaken = Math.min(qtyToSell, lot.qtyE8);
    const isWholeLot = qtyTaken === lot.qtyE8;

    // Koszt liczymy z tego, co w locie *zostało*, a nie z pierwotnej kwoty.
    // Dzięki temu grosze z zaokrągleń nie gubią się przy wielokrotnych
    // częściowych sprzedażach — ostatnia porcja zabiera dokładnie resztę.
    const costPortion = isWholeLot
      ? lot.costPlnMinor
      : bigintToNumber(mulDiv(BigInt(lot.costPlnMinor), BigInt(qtyTaken), BigInt(lot.qtyE8)));
    const taxCostPortion = isWholeLot
      ? lot.taxCostPlnMinor
      : bigintToNumber(mulDiv(BigInt(lot.taxCostPlnMinor), BigInt(qtyTaken), BigInt(lot.qtyE8)));

    // Analogicznie po stronie przychodu: ostatnia porcja dostaje resztę,
    // więc suma przypisanych kwot równa się dokładnie kwocie sprzedaży.
    const isLastPortion = qtyTaken === qtyToSell;
    const proceedsPortion = isLastPortion
      ? proceedsTotal - proceedsAssigned
      : bigintToNumber(mulDiv(BigInt(proceedsTotal), BigInt(qtyTaken), BigInt(sellQtyTotal)));
    const taxProceedsPortion = isLastPortion
      ? taxProceedsTotal - taxProceedsAssigned
      : bigintToNumber(mulDiv(BigInt(taxProceedsTotal), BigInt(qtyTaken), BigInt(sellQtyTotal)));

    gains.push({
      sellTransactionId: sell.id,
      buyTransactionId: lot.buyTransactionId,
      portfolioId: sell.portfolioId,
      instrumentId: sell.instrumentId,
      taxCategory: meta.taxCategory,
      taxExempt: meta.taxExempt,
      saleDate: sell.tradeDate,
      purchaseDate: lot.purchaseDate,
      qtyE8: qtyTaken,
      costPlnMinor: costPortion,
      proceedsPlnMinor: proceedsPortion,
      gainPlnMinor: proceedsPortion - costPortion,
      taxCostPlnMinor: taxCostPortion,
      taxProceedsPlnMinor: taxProceedsPortion,
      taxGainPlnMinor: taxProceedsPortion - taxCostPortion,
      year: yearOf(sell.tradeDate),
    });

    proceedsAssigned += proceedsPortion;
    taxProceedsAssigned += taxProceedsPortion;
    lot.qtyE8 -= qtyTaken;
    lot.costPlnMinor -= costPortion;
    lot.taxCostPlnMinor -= taxCostPortion;
    qtyToSell -= qtyTaken;
    if (lot.qtyE8 <= 0) lots.shift();
  }

  if (qtyToSell > 0) {
    // Sprzedaż bez pokrycia zwykle znaczy, że brakuje transakcji historycznej
    // (np. import obejmuje tylko część historii). Nie zgadujemy kosztu — zerowy
    // koszt zawyżyłby zysk, więc zgłaszamy to użytkownikowi.
    warnings.push({
      kind: 'oversell',
      transactionId: sell.id,
      message:
        `Sprzedaż ${sell.tradeDate} przekracza stan posiadania o ${(qtyToSell / 1e8).toString()} szt. ` +
        `Prawdopodobnie brakuje wcześniejszej transakcji kupna — uzupełnij historię, ` +
        `bo inaczej zysk zrealizowany będzie zawyżony.`,
    });
  }
}

/**
 * Grupuje transakcje po parze portfel+instrument. Ta granica jest twarda:
 * mieszanie lotów między portfelami zafałszowałoby zarówno koszt nabycia,
 * jak i rozliczenie podatkowe.
 */
export function groupForFifo<T extends { portfolioId: number; instrumentId: number | null }>(
  transactions: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const tx of transactions) {
    if (tx.instrumentId === null) continue;
    const key = `${tx.portfolioId}:${tx.instrumentId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(tx);
    else groups.set(key, [tx]);
  }
  return groups;
}

export function parseGroupKey(key: string): { portfolioId: number; instrumentId: number } {
  const [p, i] = key.split(':');
  return { portfolioId: Number(p), instrumentId: Number(i) };
}
