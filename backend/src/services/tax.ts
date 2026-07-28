import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { applyBp, isTaxExempt } from '@portfolio/shared';
import type { LossCarryForward, RealizedGain, TaxRegime, TaxReport, TaxSection } from '@portfolio/shared';
import { db } from '../db/index.js';
import { instruments, portfolios, realizedGains, transactions } from '../db/schema.js';
import { computeCryptoCarryForward, computeSecuritiesCarryForward } from './loss-carry.js';
import type { YearResult } from './loss-carry.js';

/**
 * Zestawienie pod PIT-38.
 *
 * Reguły, których pilnuje ten moduł:
 *  - portfele IKE i IKZE są zwolnione z podatku od zysków kapitałowych,
 *    więc w ogóle nie wchodzą do zestawienia — pokazujemy je jako wykluczone,
 *  - krypto rozlicza się osobno od papierów wartościowych (PIT-38 część E),
 *  - podstawą są kwoty przeliczone po kursie NBP z dnia poprzedzającego
 *    transakcję, a nie po kursie rozliczeniowym brokera,
 *  - dywidendy zagraniczne uwzględniają podatek u źródła z limitem odliczenia.
 *
 * To jest pomoc w wypełnieniu zeznania, a nie deklaracja podatkowa.
 * Kwoty należy zweryfikować z dokumentami od brokera.
 */

export const CAPITAL_GAINS_TAX_BP = 1900; // 19%

/** Maksymalna stawka podatku u źródła podlegająca odliczeniu w Polsce. */
const MAX_CREDITABLE_WHT_BP = 1900;

export function buildTaxReport(year: number, portfolioId?: number): TaxReport {
  const allPortfolios = db.select().from(portfolios).all();

  const excluded = allPortfolios
    .filter((p) => isTaxExempt(p.taxRegime as TaxRegime))
    .map((p) => ({ id: p.id, name: p.name, taxRegime: p.taxRegime as TaxRegime }));

  const taxableIds = allPortfolios
    .filter((p) => !isTaxExempt(p.taxRegime as TaxRegime))
    .filter((p) => portfolioId === undefined || p.id === portfolioId)
    .map((p) => p.id);

  if (taxableIds.length === 0) {
    return emptyReport(year, excluded);
  }

  const portfolioNames = new Map(allPortfolios.map((p) => [p.id, p.name]));
  const instrumentMap = new Map(db.select().from(instruments).all().map((i) => [i.id, i]));

  const gains = db
    .select()
    .from(realizedGains)
    .where(and(eq(realizedGains.year, year), inArray(realizedGains.portfolioId, taxableIds)))
    .all()
    // Flaga zwolnienia jest zapisana też na wierszu — podwójne zabezpieczenie
    // przed wejściem IKE do zestawienia po zmianie reżimu portfela.
    .filter((g) => !g.taxExempt);

  const toDto = (row: (typeof gains)[number]): RealizedGain => {
    const instrument = instrumentMap.get(row.instrumentId);
    return {
      id: row.id,
      sellTransactionId: row.sellTransactionId,
      portfolioId: row.portfolioId,
      portfolioName: portfolioNames.get(row.portfolioId) ?? '',
      instrumentId: row.instrumentId,
      instrumentSymbol: instrument?.symbol ?? '',
      instrumentName: instrument?.name ?? '',
      taxCategory: row.taxCategory as RealizedGain['taxCategory'],
      taxExempt: row.taxExempt,
      saleDate: row.saleDate,
      purchaseDate: row.purchaseDate,
      qtyE8: row.qtyE8,
      costPlnMinor: row.costPlnMinor,
      proceedsPlnMinor: row.proceedsPlnMinor,
      gainPlnMinor: row.gainPlnMinor,
      taxCostPlnMinor: row.taxCostPlnMinor,
      taxProceedsPlnMinor: row.taxProceedsPlnMinor,
      taxGainPlnMinor: row.taxGainPlnMinor,
      year: row.year,
    };
  };

  const securities = buildSection(
    gains.filter((g) => g.taxCategory === 'securities').map(toDto),
    securitiesCarry(year, taxableIds),
  );
  const crypto = buildSection(
    gains.filter((g) => g.taxCategory === 'crypto').map(toDto),
    cryptoCarry(year, taxableIds),
  );

  return {
    year,
    excludedPortfolios: excluded,
    securities,
    crypto,
    dividends: buildDividends(year, taxableIds, portfolioNames, instrumentMap),
    note:
      'Zestawienie pomocnicze do PIT-38. Podstawą są kwoty przeliczone po kursie NBP z dnia ' +
      'poprzedzającego transakcję. Zweryfikuj kwoty z dokumentami od brokera przed złożeniem zeznania.',
  };
}

function buildSection(entries: RealizedGain[], carry: LossCarryForward | null): TaxSection {
  const revenue = entries.reduce((sum, e) => sum + e.taxProceedsPlnMinor, 0);
  const cost = entries.reduce((sum, e) => sum + e.taxCostPlnMinor, 0);
  const gain = revenue - cost;

  // Podstawą opodatkowania jest dochód pomniejszony o rozliczone straty
  // z lat ubiegłych. Sama strata nie generuje podatku.
  const taxable = carry ? carry.taxableGainPlnMinor : gain;

  return {
    revenuePlnMinor: revenue,
    costPlnMinor: cost,
    gainPlnMinor: gain,
    taxPlnMinor: taxable > 0 ? applyBp(taxable, CAPITAL_GAINS_TAX_BP) : 0,
    entries: entries.sort((a, b) => (a.saleDate < b.saleDate ? -1 : 1)),
    lossCarryForward: carry,
  };
}

/** Wyniki roczne danej kategorii — podstawa symulacji strat z lat ubiegłych. */
function yearlyResults(taxableIds: number[], category: 'securities' | 'crypto'): YearResult[] {
  const rows = db
    .select()
    .from(realizedGains)
    .where(inArray(realizedGains.portfolioId, taxableIds))
    .all()
    .filter((g) => !g.taxExempt && g.taxCategory === category);

  const byYear = new Map<number, number>();
  for (const row of rows) {
    byYear.set(row.year, (byYear.get(row.year) ?? 0) + (row.taxProceedsPlnMinor - row.taxCostPlnMinor));
  }

  return [...byYear.entries()].map(([year, gainPlnMinor]) => ({ year, gainPlnMinor }));
}

function securitiesCarry(year: number, taxableIds: number[]): LossCarryForward | null {
  const history = yearlyResults(taxableIds, 'securities');
  if (history.every((y) => y.gainPlnMinor >= 0)) return null;

  const result = computeSecuritiesCarryForward(history, year);
  return {
    regime: 'securities',
    availablePlnMinor: result.availablePlnMinor,
    appliedPlnMinor: result.appliedPlnMinor,
    taxableGainPlnMinor: result.taxableGainPlnMinor,
    carryToNextYearPlnMinor: result.remaining.reduce((sum, r) => sum + r.remainingPlnMinor, 0),
    expiredPlnMinor: result.expiredPlnMinor,
    note:
      'Stratę z papierów wartościowych odlicza się przez pięć kolejnych lat, ' +
      'maksymalnie 50% jej wysokości w jednym roku. Reszta po pięciu latach przepada.',
  };
}

function cryptoCarry(year: number, taxableIds: number[]): LossCarryForward | null {
  const history = yearlyResults(taxableIds, 'crypto');
  if (history.every((y) => y.gainPlnMinor >= 0)) return null;

  const result = computeCryptoCarryForward(history, year);
  return {
    regime: 'crypto',
    availablePlnMinor: result.carriedCostPlnMinor,
    appliedPlnMinor: result.carriedCostPlnMinor,
    taxableGainPlnMinor: result.taxableGainPlnMinor,
    carryToNextYearPlnMinor: result.carryToNextYearPlnMinor,
    expiredPlnMinor: 0,
    note:
      'Przy kryptowalutach nadwyżka kosztów nad przychodami nie jest stratą, tylko powiększa ' +
      'koszty uzyskania przychodu w roku następnym — bez limitu procentowego i bezterminowo.',
  };
}

/**
 * Ubruttowienie dywidendy wypłaconej po potrąceniu podatku.
 *
 * Polski płatnik przekazuje kwotę już pomniejszoną o 19% i nie raportuje
 * osobnego wiersza podatku, więc brutto z wyciągu równa się netto. Bez tej
 * korekty zestawienia pokazują zerowy podatek i zaniżoną kwotę brutto.
 *
 * Zwraca kwoty w tej samej jednostce, w jakiej je dostało.
 */
export function grossUpWithheld(
  grossMinor: number,
  taxMinor: number,
  instrument: { symbol: string; country: string | null } | undefined,
): { grossMinor: number; taxMinor: number } {
  if (taxMinor !== 0 || grossMinor <= 0 || !isDomestic(instrument)) {
    return { grossMinor, taxMinor };
  }

  const grossedUp = Math.round((grossMinor * 10_000) / (10_000 - CAPITAL_GAINS_TAX_BP));
  return { grossMinor: grossedUp, taxMinor: grossedUp - grossMinor };
}

/**
 * Czy instrument jest notowany w Polsce.
 *
 * Rozstrzyga o sposobie poboru podatku od dywidendy: krajowy płatnik potrąca
 * 19% u źródła i sprawa jest zamknięta, zagraniczny potrąca stawkę traktatową,
 * a różnicę do 19% dopłaca się w PIT-38.
 */
function isDomestic(instrument: { symbol: string; country: string | null } | undefined): boolean {
  if (!instrument) return false;
  if (instrument.country === 'Polska') return true;
  return instrument.symbol.endsWith('.WA') || instrument.symbol.startsWith('WSE:');
}

function buildDividends(
  year: number,
  portfolioIds: number[],
  portfolioNames: Map<number, string>,
  instrumentMap: Map<number, { symbol: string; country: string | null }>,
): TaxReport['dividends'] {
  void portfolioNames;

  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.portfolioId, portfolioIds),
        gte(transactions.tradeDate, `${year}-01-01`),
        lte(transactions.tradeDate, `${year}-12-31`),
      ),
    )
    .all()
    .filter((r) => r.type === 'dividend' || r.type === 'tax');

  const entries: TaxReport['dividends']['entries'] = [];
  let gross = 0;
  let withholding = 0;

  /**
   * Ten sam podatek u źródła może przyjść dwiema drogami: przy dywidendzie
   * (arkusz Inwestomatu) albo osobnym wierszem (wyciąg XTB). Zliczenie obu
   * zawyżyłoby odliczenie, więc pamiętamy pary instrument+data, dla których
   * podatek został już ujęty razem z dywidendą.
   */
  const withholdingSeen = new Set(
    rows
      .filter((r) => r.type === 'dividend' && r.taxMinor > 0)
      .map((r) => `${r.instrumentId ?? 'x'}|${r.tradeDate}`),
  );

  for (const row of rows) {
    const instrument = row.instrumentId ? instrumentMap.get(row.instrumentId) : undefined;

    if (row.type === 'dividend') {
      // Kwota brutto po kursie NBP D-1 — bez odjęcia podatku u źródła.
      let grossPln = Math.round((row.grossMinor * row.fxRateE6) / 1_000_000);
      let whtPln = Math.round((row.taxMinor * row.fxRateE6) / 1_000_000);

      /*
       * Dywidendę ze spółki notowanej w Polsce płatnik wypłaca już po potrąceniu
       * 19% — broker raportuje kwotę netto i nie pokazuje osobnego wiersza podatku.
       * Bez ubruttowienia policzylibyśmy podatek drugi raz, od kwoty już opodatkowanej.
       */
      const adjusted = grossUpWithheld(grossPln, whtPln, instrument);
      grossPln = adjusted.grossMinor;
      whtPln = adjusted.taxMinor;

      gross += grossPln;
      withholding += whtPln;

      entries.push({
        date: row.tradeDate,
        symbol: instrument?.symbol ?? '',
        country: instrument?.country ?? null,
        grossPlnMinor: grossPln,
        withholdingPlnMinor: whtPln,
        currency: row.currency,
      });
      continue;
    }

    // XTB księguje podatek u źródła jako osobną operację, nie jako pole
    // przy dywidendzie — doliczamy ją do puli potrąceń, chyba że ta sama
    // kwota została już ujęta przy dywidendzie z innego źródła.
    if (withholdingSeen.has(`${row.instrumentId ?? 'x'}|${row.tradeDate}`)) continue;

    const whtPln = Math.abs(Math.round((row.grossMinor * row.fxRateE6) / 1_000_000));
    withholding += whtPln;
    entries.push({
      date: row.tradeDate,
      symbol: instrument?.symbol ?? '',
      country: instrument?.country ?? null,
      grossPlnMinor: 0,
      withholdingPlnMinor: whtPln,
      currency: row.currency,
    });
  }

  // Podatek należny w Polsce to 19% od brutto, pomniejszone o podatek
  // zapłacony za granicą — ale nie więcej niż 19% (nadwyżki nie odlicza się).
  const duePl = applyBp(gross, CAPITAL_GAINS_TAX_BP);
  const creditable = Math.min(withholding, applyBp(gross, MAX_CREDITABLE_WHT_BP));
  const due = Math.max(duePl - creditable, 0);

  return {
    grossPlnMinor: gross,
    withholdingTaxPlnMinor: withholding,
    duePlnMinor: due,
    entries: entries.sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

function emptyReport(year: number, excluded: TaxReport['excludedPortfolios']): TaxReport {
  const empty: TaxSection = {
    revenuePlnMinor: 0,
    costPlnMinor: 0,
    gainPlnMinor: 0,
    taxPlnMinor: 0,
    entries: [],
    lossCarryForward: null,
  };
  return {
    year,
    excludedPortfolios: excluded,
    securities: empty,
    crypto: empty,
    dividends: { grossPlnMinor: 0, withholdingTaxPlnMinor: 0, duePlnMinor: 0, entries: [] },
    note:
      excluded.length > 0
        ? 'Wszystkie portfele są zwolnione z podatku (IKE/IKZE) — nie ma czego wykazywać w PIT-38.'
        : 'Brak transakcji podlegających opodatkowaniu w tym roku.',
  };
}

/** Lata, dla których są jakiekolwiek zrealizowane transakcje. */
export function availableTaxYears(): number[] {
  const years = new Set(db.select().from(realizedGains).all().map((r) => r.year));

  // Rok, w którym coś sprzedano albo wpłynęła dywidenda, wypada pokazać nawet
  // gdy zestawienie wyjdzie zerowe — inaczej brak roku na liście wygląda jak
  // zgubione dane, a nie jak „nie było czego rozliczać".
  for (const row of db.select().from(transactions).all()) {
    if (row.type === 'dividend' || row.type === 'sell' || row.type === 'tax') {
      years.add(Number(row.tradeDate.slice(0, 4)));
    }
  }
  return [...years].sort((a, b) => b - a);
}

/** Eksport CSV zestawienia rocznego. */
export function taxReportToCsv(report: TaxReport): string {
  const lines: string[] = [];
  const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  const money = (minor: number): string => (minor / 100).toFixed(2).replace('.', ',');

  lines.push(`# Zestawienie pomocnicze PIT-38 za ${report.year}`);
  if (report.excludedPortfolios.length > 0) {
    lines.push(`# Wykluczone portfele zwolnione: ${report.excludedPortfolios.map((p) => p.name).join(', ')}`);
  }
  lines.push('');

  for (const [label, section] of [
    ['Papiery wartościowe', report.securities],
    ['Kryptowaluty', report.crypto],
  ] as const) {
    lines.push(`# ${label}`);
    lines.push(
      ['Data sprzedazy', 'Data nabycia', 'Instrument', 'Portfel', 'Przychod PLN', 'Koszt PLN', 'Dochod PLN']
        .map(esc)
        .join(';'),
    );
    for (const entry of section.entries) {
      lines.push(
        [
          entry.saleDate,
          entry.purchaseDate,
          entry.instrumentSymbol,
          entry.portfolioName,
          money(entry.taxProceedsPlnMinor),
          money(entry.taxCostPlnMinor),
          money(entry.taxGainPlnMinor),
        ]
          .map(esc)
          .join(';'),
      );
    }
    lines.push(
      ['RAZEM', '', '', '', money(section.revenuePlnMinor), money(section.costPlnMinor), money(section.gainPlnMinor)]
        .map(esc)
        .join(';'),
    );
    if (section.lossCarryForward) {
      const carry = section.lossCarryForward;
      lines.push(
        ['Odliczona strata z lat ubieglych', '', '', '', '', '', money(carry.appliedPlnMinor)].map(esc).join(';'),
      );
      lines.push(
        ['Podstawa po odliczeniu', '', '', '', '', '', money(carry.taxableGainPlnMinor)].map(esc).join(';'),
      );
      lines.push(
        ['Strata do rozliczenia w kolejnych latach', '', '', '', '', '', money(carry.carryToNextYearPlnMinor)]
          .map(esc)
          .join(';'),
      );
    }
    lines.push(['Podatek 19%', '', '', '', '', '', money(section.taxPlnMinor)].map(esc).join(';'));
    lines.push('');
  }

  lines.push('# Dywidendy');
  lines.push(['Data', 'Instrument', 'Kraj', 'Brutto PLN', 'Podatek u zrodla PLN'].map(esc).join(';'));
  for (const entry of report.dividends.entries) {
    lines.push(
      [
        entry.date,
        entry.symbol,
        entry.country ?? '',
        money(entry.grossPlnMinor),
        money(entry.withholdingPlnMinor),
      ]
        .map(esc)
        .join(';'),
    );
  }
  lines.push(
    ['RAZEM', '', '', money(report.dividends.grossPlnMinor), money(report.dividends.withholdingTaxPlnMinor)]
      .map(esc)
      .join(';'),
  );
  lines.push(['Podatek do doplaty w PL', '', '', '', money(report.dividends.duePlnMinor)].map(esc).join(';'));

  return lines.join('\n');
}
