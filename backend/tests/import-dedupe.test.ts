import { describe, expect, it } from 'vitest';
import { toQty } from '@portfolio/shared';
import { buildDedupeKey } from '../src/services/transactions.js';
import { hashRow } from '../src/services/import.js';
import { detectCadence } from '../src/services/corporate-actions.js';
import type { ParsedRow } from '../src/parsers/types.js';

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    rowId: '1',
    tradeDate: '2025-09-29',
    type: 'buy',
    rawSymbol: 'XTB.PL',
    instrumentName: null,
    assetClass: 'stock',
    currency: 'PLN',
    currencyInferred: false,
    quantity: '2',
    price: '72.02',
    grossAmount: null,
    fee: '0',
    tax: '0',
    fxRate: null,
    note: null,
    issues: [],
    ...overrides,
  };
}

describe('hash wiersza importu', () => {
  it('jest stabilny dla tych samych danych', () => {
    // Na tym opiera się idempotencja: ponowny wrzut pliku musi dać ten sam hash.
    expect(hashRow('xtb-mhtml', 1, row())).toBe(hashRow('xtb-mhtml', 1, row()));
  });

  it('różni się przy innym portfelu', () => {
    // Ta sama transakcja w dwóch portfelach to dwie osobne transakcje.
    expect(hashRow('xtb-mhtml', 1, row())).not.toBe(hashRow('xtb-mhtml', 2, row()));
  });

  it('różni się przy innym parserze', () => {
    expect(hashRow('xtb-mhtml', 1, row())).not.toBe(hashRow('inwestomat-xlsx', 1, row()));
  });

  it('reaguje na zmianę ilości, ceny i daty', () => {
    const base = hashRow('xtb-mhtml', 1, row());
    expect(hashRow('xtb-mhtml', 1, row({ quantity: '3' }))).not.toBe(base);
    expect(hashRow('xtb-mhtml', 1, row({ price: '72.03' }))).not.toBe(base);
    expect(hashRow('xtb-mhtml', 1, row({ tradeDate: '2025-09-30' }))).not.toBe(base);
  });

  it('nie zmienia się od pola, które nie identyfikuje transakcji', () => {
    // Notatka i ostrzeżenia parsera nie mogą wpływać na tożsamość wiersza,
    // inaczej drobna zmiana w opisie zrobiłaby z duplikatu nową transakcję.
    expect(hashRow('xtb-mhtml', 1, row({ note: 'inny opis', issues: ['cokolwiek'] }))).toBe(
      hashRow('xtb-mhtml', 1, row()),
    );
  });
});

describe('klucz deduplikacji między źródłami', () => {
  const base = {
    portfolioId: 1,
    instrumentId: 10,
    type: 'buy' as const,
    tradeDate: '2025-09-29',
    qtyE8: toQty('2'),
    amountPlnMinor: -144_04,
  };

  it('zgadza się dla tej samej transakcji z dwóch źródeł', () => {
    // Klucz nie zawiera niczego, co zależy od formatu pliku — dzięki temu
    // ta sama operacja z XTB i z arkusza Inwestomatu jest rozpoznana.
    expect(buildDedupeKey(base)).toBe(buildDedupeKey({ ...base }));
  });

  it('rozróżnia portfele', () => {
    expect(buildDedupeKey({ ...base, portfolioId: 2 })).not.toBe(buildDedupeKey(base));
  });

  it('rozróżnia kwoty', () => {
    expect(buildDedupeKey({ ...base, amountPlnMinor: -144_05 })).not.toBe(buildDedupeKey(base));
  });

  it('rozróżnia typ operacji', () => {
    expect(buildDedupeKey({ ...base, type: 'sell' })).not.toBe(buildDedupeKey(base));
  });

  it('traktuje transakcje gotówkowe bez instrumentu spójnie', () => {
    const cash = { ...base, instrumentId: null };
    expect(buildDedupeKey(cash)).toBe(buildDedupeKey({ ...cash }));
    expect(buildDedupeKey(cash)).not.toBe(buildDedupeKey(base));
  });
});

describe('rytm wypłat dywidend', () => {
  it('rozpoznaje wypłatę roczną', () => {
    expect(detectCadence(['2023-07-07', '2024-05-31', '2025-06-13', '2026-06-12'])).toMatchObject({
      label: 'annual',
    });
  });

  it('rozpoznaje wypłatę kwartalną', () => {
    expect(detectCadence(['2025-03-01', '2025-06-01', '2025-09-01', '2025-12-01'])).toMatchObject({
      label: 'quarterly',
    });
  });

  it('rozpoznaje wypłatę miesięczną', () => {
    expect(detectCadence(['2025-01-05', '2025-02-05', '2025-03-05', '2025-04-05'])).toMatchObject({
      label: 'monthly',
    });
  });

  it('nie daje się zwieść pojedynczej wypłacie specjalnej', () => {
    // Mediana odstępów odporna na jeden wyskok; średnia by tu zawiodła.
    expect(detectCadence(['2022-06-01', '2023-06-01', '2023-08-15', '2024-06-01', '2025-06-01'])).toMatchObject({
      label: 'annual',
    });
  });

  it('nie zgaduje rytmu z jednej wypłaty', () => {
    expect(detectCadence(['2025-06-01'])).toBeNull();
    expect(detectCadence([])).toBeNull();
  });

  it('zwraca null dla odstępów spoza znanych rytmów', () => {
    // Ponad dwa lata przerwy — prognoza byłaby zgadywaniem.
    expect(detectCadence(['2019-01-01', '2025-01-01'])).toBeNull();
  });
});
