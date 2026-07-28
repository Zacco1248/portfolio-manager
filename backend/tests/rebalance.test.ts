import { describe, expect, it } from 'vitest';
import type { Position } from '@portfolio/shared';
import { buildPlan, currentValues, dimensionKey, totalDriftBp } from '../src/services/rebalance.js';
import { detectConcentration, detectEtfOverlap, detectStalePrices } from '../src/services/risk.js';

function position(
  symbol: string,
  valuePlnMinor: number,
  overrides: Partial<Position['instrument']> = {},
): Position {
  return {
    portfolioId: 1,
    portfolioName: 'Główny',
    instrument: {
      id: symbol.length,
      symbol,
      name: symbol,
      assetClass: 'stock',
      currency: 'PLN',
      isin: null,
      exchange: null,
      sector: null,
      country: null,
      provider: null,
      providerSymbol: null,
      unit: null,
      ...overrides,
    },
    qtyE8: 100_000_000,
    avgPriceE8: 0,
    costPlnMinor: valuePlnMinor,
    priceE8: 0,
    valuePlnMinor,
    unrealizedPlnMinor: 0,
    unrealizedBp: 0,
    dayChangePlnMinor: null,
    dayChangeBp: null,
    sharePortfolioBp: 0,
    priceStale: false,
    fxRateE6: 1_000_000,
  };
}

const targets = [
  { key: 'stock', targetBp: 6000, toleranceBp: 500 },
  { key: 'bond', targetBp: 3000, toleranceBp: 500 },
  { key: 'cash', targetBp: 1000, toleranceBp: 500 },
];

describe('rebalans — grupowanie', () => {
  it('grupuje po klasie aktywów i dolicza gotówkę', () => {
    const values = currentValues(
      [position('A', 6000_00), position('B', 2000_00, { assetClass: 'bond' })],
      2000_00,
      'asset_class',
    );

    expect(values.get('stock')).toBe(6000_00);
    expect(values.get('bond')).toBe(2000_00);
    expect(values.get('cash')).toBe(2000_00);
  });

  it('grupuje po wybranym wymiarze', () => {
    const p = position('A', 100, { sector: 'Technologia', country: 'USA', currency: 'USD' });
    expect(dimensionKey(p, 'sector')).toBe('Technologia');
    expect(dimensionKey(p, 'geo')).toBe('USA');
    expect(dimensionKey(p, 'currency')).toBe('USD');
    expect(dimensionKey(p, 'instrument')).toBe('A');
  });

  it('oznacza brak przypisania zamiast zgadywać', () => {
    expect(dimensionKey(position('A', 100), 'sector')).toBe('unknown');
  });
});

describe('rebalans — tryb pełny', () => {
  it('proponuje sprzedaż nadwyżki i dokupienie niedoboru', () => {
    // Akcje 80% przy celu 60%, obligacji brak przy celu 30%.
    const plan = buildPlan(
      {
        positions: [position('A', 8000_00)],
        cashPlnMinor: 2000_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 0,
      },
      'full',
    );

    const stock = plan.actions.find((a) => a.key === 'stock')!;
    const bond = plan.actions.find((a) => a.key === 'bond')!;

    expect(stock.deltaPlnMinor).toBeLessThan(0);
    expect(bond.deltaPlnMinor).toBeGreaterThan(0);
    expect(stock.suggestion).toContain('Sprzedaj');
    expect(bond.suggestion).toContain('Dokup');
  });

  it('bilansuje plan do zera przy braku dopłaty', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 8000_00)],
        cashPlnMinor: 2000_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 0,
      },
      'full',
    );

    // Plan nie może wymagać pieniędzy znikąd.
    expect(plan.actions.reduce((s, a) => s + a.deltaPlnMinor, 0)).toBe(0);
  });

  it('zmniejsza łączne odchylenie od celu', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 9000_00)],
        cashPlnMinor: 1000_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 0,
      },
      'full',
    );

    expect(plan.driftAfterBp).toBeLessThan(plan.driftBeforeBp);
  });
});

describe('rebalans — tryb tylko dokupowanie', () => {
  it('nigdy nie proponuje sprzedaży', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 9000_00)],
        cashPlnMinor: 1000_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 1000_00,
      },
      'buy_only',
    );

    expect(plan.actions.every((a) => a.deltaPlnMinor >= 0)).toBe(true);
  });

  it('rozdziela całą wpłatę i nic nie gubi', () => {
    const contribution = 1000_00;
    const plan = buildPlan(
      {
        positions: [position('A', 6000_00)],
        cashPlnMinor: 0,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: contribution,
      },
      'buy_only',
    );

    expect(plan.actions.reduce((s, a) => s + a.deltaPlnMinor, 0)).toBe(contribution);
  });

  it('kieruje wpłatę tam, gdzie niedobór jest największy', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 9000_00), position('B', 500_00, { assetClass: 'bond' })],
        cashPlnMinor: 500_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 1000_00,
      },
      'buy_only',
    );

    const bond = plan.actions.find((a) => a.key === 'bond')!;
    const stock = plan.actions.find((a) => a.key === 'stock')!;
    expect(bond.deltaPlnMinor).toBeGreaterThan(stock.deltaPlnMinor);
  });

  it('bez podanej wpłaty pokazuje sam niedobór, nie polecenie zakupu', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 10_000_00)],
        cashPlnMinor: 0,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 0,
      },
      'buy_only',
    );

    expect(plan.note).toContain('Podaj kwotę dopłaty');
    expect(plan.actions.find((a) => a.key === 'bond')!.deltaPlnMinor).toBeGreaterThan(0);
  });
});

describe('rebalans — przypadki brzegowe', () => {
  it('informuje o braku zdefiniowanych celów', () => {
    const plan = buildPlan(
      { positions: [position('A', 100_00)], cashPlnMinor: 0, targets: [], dimension: 'asset_class', contributionPlnMinor: 0 },
      'full',
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.note).toContain('alokacji docelowej');
  });

  it('radzi sobie z pustym portfelem', () => {
    const plan = buildPlan(
      { positions: [], cashPlnMinor: 0, targets, dimension: 'asset_class', contributionPlnMinor: 0 },
      'full',
    );
    expect(plan.actions).toHaveLength(0);
  });

  it('oznacza pozycje mieszczące się w tolerancji', () => {
    const plan = buildPlan(
      {
        positions: [position('A', 6100_00), position('B', 3000_00, { assetClass: 'bond' })],
        cashPlnMinor: 900_00,
        targets,
        dimension: 'asset_class',
        contributionPlnMinor: 0,
      },
      'full',
    );

    expect(plan.actions.every((a) => a.withinTolerance)).toBe(true);
  });

  it('liczy łączne odchylenie', () => {
    const values = new Map([['stock', 8000_00], ['bond', 2000_00]]);
    // 80% vs 60% = 2000 bp, 20% vs 30% = 1000 bp, brak gotówki vs 10% = 1000 bp
    expect(totalDriftBp(values, targets, 10_000_00)).toBe(4000);
  });
});

describe('kontrola koncentracji', () => {
  const thresholds = { instrumentBp: 1500, sectorBp: 3500, overlapBp: 3000 };

  it('ostrzega o zbyt dużym udziale pojedynczej spółki', () => {
    const warnings = detectConcentration(
      [position('CDR', 3000_00), position('XTB', 7000_00)],
      thresholds,
    );
    expect(warnings.some((w) => w.kind === 'concentration_instrument' && w.message.includes('XTB'))).toBe(true);
  });

  it('nie traktuje ETF-a jak pojedynczej spółki', () => {
    const warnings = detectConcentration(
      [position('SWRD', 9000_00, { assetClass: 'etf' }), position('CDR', 1000_00)],
      thresholds,
    );
    expect(warnings.some((w) => w.kind === 'concentration_instrument')).toBe(false);
  });

  it('ostrzega o koncentracji sektorowej', () => {
    const warnings = detectConcentration(
      [
        position('A', 4000_00, { sector: 'Technologia' }),
        position('B', 1000_00, { sector: 'Technologia' }),
        position('C', 5000_00, { sector: 'Finanse' }),
      ],
      thresholds,
    );
    expect(warnings.some((w) => w.kind === 'concentration_sector' && w.message.includes('Technologia'))).toBe(true);
  });

  it('milczy przy zdrowej dywersyfikacji', () => {
    const warnings = detectConcentration(
      Array.from({ length: 10 }, (_, i) => position(`S${i}`, 1000_00)),
      thresholds,
    );
    expect(warnings).toHaveLength(0);
  });

  it('wykrywa nakładanie się ETF-ów', () => {
    const a = position('ETF1', 5000_00, { assetClass: 'etf', id: 1 });
    const b = position('ETF2', 5000_00, { assetClass: 'etf', id: 2 });
    const holdings = new Map([
      [1, [{ symbol: 'AAPL', weightBp: 3000 }, { symbol: 'MSFT', weightBp: 2000 }]],
      [2, [{ symbol: 'AAPL', weightBp: 2500 }, { symbol: 'NVDA', weightBp: 1000 }]],
    ]);

    // Wspólne AAPL: min(3000, 2500) = 2500 bp... poniżej progu 3000.
    expect(detectEtfOverlap([a, b], holdings, 3000)).toHaveLength(0);
    expect(detectEtfOverlap([a, b], holdings, 2000)).toHaveLength(1);
  });

  it('nie zgaduje składu funduszu bez danych o ekspozycji', () => {
    const a = position('ETF1', 5000_00, { assetClass: 'etf', id: 1 });
    const b = position('ETF2', 5000_00, { assetClass: 'etf', id: 2 });
    expect(detectEtfOverlap([a, b], new Map(), 3000)).toHaveLength(0);
  });

  it('sygnalizuje nieaktualne ceny', () => {
    const stale = { ...position('A', 1000_00), priceStale: true };
    const warnings = detectStalePrices([stale]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toContain('A');
  });
});
