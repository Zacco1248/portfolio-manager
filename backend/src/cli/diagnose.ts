/**
 * Raport uzgodnienia: dlaczego liczby w aplikacji różnią się od rachunku brokera.
 *
 * Uruchomienie: `npm run diagnose` (opcjonalnie `-- --portfolio 1`).
 *
 * Raport wyłącznie czyta bazę. Powstał, bo różnica wobec wyciągu może brać się
 * z czterech niezależnych powodów — nieaktualnej ceny, nieaktualnego kursu NBP,
 * braku notowania albo niekompletnej historii operacji — a dashboard pokazuje
 * jedną liczbę i nie mówi, który z nich zadziałał. Każda sekcja odpowiada za
 * jeden powód i kończy się jawną flagą, żeby dało się to czytać bez wiedzy
 * o wnętrzu aplikacji.
 */
import { desc, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { closeDb, db } from '../db/index.js';
import { accounts, fxRates, portfolios, transactions } from '../db/schema.js';
import { today } from '../lib/dates.js';
import { getLatestPrice } from '../services/prices.js';
import { activePortfolioIds, buildPositions, netInvested, realizedTotal } from '../services/positions.js';

/** Po ilu dniach uznajemy daną za nieaktualną. Ceny mają weekend, kursy NBP też. */
const PRICE_STALE_DAYS = 4;
const FX_STALE_DAYS = 7;

const pln = (minor: number): string =>
  new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', minimumFractionDigits: 2 }).format(minor / 100);

const qty = (qtyE8: number): string =>
  new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 8 }).format(qtyE8 / 1e8);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function heading(text: string): void {
  console.log(`\n${text}`);
  console.log('─'.repeat(text.length));
}

/** Najświeższy kurs każdej waluty razem z datą — data jest tu ważniejsza niż sam kurs. */
function latestFx(): Map<string, { rateE6: number; date: string }> {
  const rows = db
    .select({ currency: fxRates.currency, rateE6: fxRates.rateE6, date: fxRates.date })
    .from(fxRates)
    .orderBy(fxRates.currency, desc(fxRates.date))
    .all();

  const map = new Map<string, { rateE6: number; date: string }>();
  for (const row of rows) {
    if (!map.has(row.currency)) map.set(row.currency, { rateE6: row.rateE6, date: row.date });
  }
  return map;
}

function parsePortfolioArg(): number | undefined {
  const index = process.argv.indexOf('--portfolio');
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

export function runDiagnose(portfolioId?: number): void {
  const day = today(config.timezone);
  const ids = activePortfolioIds(portfolioId);

  if (ids.length === 0) {
    console.log('Brak portfeli do zdiagnozowania.');
    return;
  }

  const names = new Map(
    db
      .select()
      .from(portfolios)
      .all()
      .map((p) => [p.id, p.name]),
  );

  console.log(`Raport uzgodnienia — ${day}`);
  console.log(`Portfele: ${ids.map((id) => `${names.get(id) ?? id} (#${id})`).join(', ')}`);
  console.log(`Waluta bazowa: ${config.baseCurrency}`);

  const { positions, cashByAccount, totalValuePlnMinor } = buildPositions(ids);
  const fx = latestFx();

  /*
   * Zgłoszenia zbieramy z kategorią, a nie jako gotowe zdania. Pierwsza wersja
   * raportu wypisywała w podsumowaniu trzydzieści linii, z czego dwadzieścia
   * mówiło to samo o różnych papierach — czyta się to gorzej niż jedna linia
   * z listą symboli.
   */
  const flags: { category: string; subject: string | null }[] = [];
  const flag = (category: string, subject: string | null = null): void => {
    flags.push({ category, subject });
  };

  // ── 1. Rozbicie wartości ────────────────────────────────────────────────
  heading('1. Rozbicie wartości pozycji');

  let positionsValue = 0;
  let positionsCost = 0;
  let valuedAtCost = 0;

  for (const position of positions) {
    positionsValue += position.valuePlnMinor;
    positionsCost += position.costPlnMinor;

    const instrument = position.instrument;
    /*
     * Obligacje detaliczne nie mają notowania i wycenia je wzór z warunków
     * emisji, nie rynek — `getLatestPrice` zwraca dla nich `null`, ale
     * `position.priceE8` jest wypełnione. Rozstrzyga więc pozycja, inaczej
     * każdy EDO trafiałby na listę „brak ceny" bez powodu.
     */
    const quote = getLatestPrice(instrument.id, instrument.currency);
    const priceDate = quote ? quote.ts.slice(0, 10) : null;
    const priceAge = priceDate ? daysBetween(priceDate, day) : null;
    const pricedByFormula = quote === null && position.priceE8 !== null;

    // Wycena idzie po walucie notowania, nie po walucie instrumentu — dla
    // papierów bez notowania wracamy do tej drugiej, tak jak robi to wycena.
    const quoteCurrency = (quote?.currency ?? instrument.currency).toUpperCase();
    const rate = fx.get(quoteCurrency);
    const fxAge = rate ? daysBetween(rate.date, day) : null;

    const notes: string[] = [];
    if (position.priceE8 === null) {
      // Bez ceny wycena podstawia koszt nabycia (positions.ts), więc pozycja
      // raportuje wynik 0 — wygląda to na brak zmiany, a jest brakiem danych.
      // To jedna z realnych przyczyn rozjazdu wobec rachunku brokera.
      notes.push('BRAK CENY — WYCENA PO KOSZCIE, WYNIK POZORNIE ZEROWY');
      valuedAtCost += position.costPlnMinor;
      flag('brak notowania — wycena po koszcie nabycia', instrument.symbol);
    } else if (priceAge !== null && priceAge > PRICE_STALE_DAYS) {
      notes.push(`CENA STARSZA NIŻ ${PRICE_STALE_DAYS} DNI (${priceDate}, ${priceAge} dni)`);
      // Wiek trzymamy w podmiocie, nie w kategorii: inaczej papier z 25 dniami
      // i papier z 26 tworzyłyby dwie osobne przyczyny mówiące to samo.
      flag('notowania nieaktualne', `${instrument.symbol} (${priceAge} dni)`);
    }

    if (quoteCurrency !== config.baseCurrency) {
      if (!rate) {
        notes.push(`BRAK KURSU ${quoteCurrency} — WYCENA PO KURSIE 1,0`);
        flag(`brak kursu ${quoteCurrency} — wycena po kursie 1,0`, instrument.symbol);
      } else if (fxAge !== null && fxAge > FX_STALE_DAYS) {
        notes.push(`KURS ${quoteCurrency} STARSZY NIŻ ${FX_STALE_DAYS} DNI (${rate.date}, ${fxAge} dni)`);
        flag(`cena przeliczana nieaktualnym kursem ${quoteCurrency} (z ${rate.date})`, instrument.symbol);
      }
    }

    const priceText = pricedByFormula
      ? `${(position.priceE8! / 1e8).toFixed(4)} PLN z warunków emisji`
      : quote
        ? `${(quote.priceE8 / 1e8).toFixed(4)} ${quote.currency} z ${priceDate} (${quote.source})`
        : 'brak';

    console.log(
      `\n  ${instrument.symbol}  ${instrument.name ?? ''}`.trimEnd() +
        `\n    ilość ${qty(position.qtyE8)}   koszt ${pln(position.costPlnMinor)}   wartość ${pln(position.valuePlnMinor)}` +
        `\n    cena ${priceText}` +
        `   kurs ${
          quoteCurrency === config.baseCurrency
            ? '—'
            : rate
              ? `${(rate.rateE6 / 1e6).toFixed(4)} z ${rate.date}`
              : 'brak'
        }` +
        `\n    wynik ${pln(position.unrealizedPlnMinor)}`,
    );
    for (const note of notes) console.log(`    ⚠ ${note}`);
  }

  console.log(`\n  Razem koszt pozycji:    ${pln(positionsCost)}`);
  console.log(`  Razem wartość pozycji:  ${pln(positionsValue)}`);
  if (valuedAtCost > 0) {
    console.log(`  W tym wyceniono po koszcie (brak notowania): ${pln(valuedAtCost)}`);
  }

  // ── 2. Gotówka ──────────────────────────────────────────────────────────
  heading('2. Gotówka wg kont');

  const accountNames = new Map(
    db
      .select()
      .from(accounts)
      .all()
      .map((a) => [a.id, a.name]),
  );

  let cashTotal = 0;
  for (const [accountId, amount] of [...cashByAccount.entries()].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    cashTotal += amount;
    const label = accountId === null ? 'Nieprzypisane' : (accountNames.get(accountId) ?? `#${accountId}`);
    const warning = amount < 0 ? '  ⚠ SALDO UJEMNE — HISTORIA OPERACJI JEST NIEPEŁNA' : '';
    console.log(`  ${label.padEnd(16)} ${pln(amount).padStart(16)}${warning}`);
    if (amount < 0) flag(`ujemne saldo gotówki (${pln(amount)}) — niepełna historia operacji`, label);
  }
  console.log(`  ${'Razem'.padEnd(16)} ${pln(cashTotal).padStart(16)}`);
  console.log(
    '\n  Saldo to suma przepływów ze wszystkich transakcji, nie odczyt z rachunku.\n' +
      '  Import obejmujący tylko część historii daje tu wynik zaniżony albo ujemny.',
  );

  // ── 3. Prowizje i podatki ───────────────────────────────────────────────
  heading('3. Prowizje i podatki w zaimportowanych danych');

  const txRows = db.select().from(transactions).where(inArray(transactions.portfolioId, ids)).all();

  const byType = new Map<string, number>();
  let feeTotal = 0;
  let taxTotal = 0;
  let dividends = 0;
  let dividendsWithoutTax = 0;

  for (const row of txRows) {
    byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
    feeTotal += row.feeMinor;
    taxTotal += row.taxMinor;
    if (row.type === 'dividend') {
      dividends += 1;
      if (row.taxMinor === 0) dividendsWithoutTax += 1;
    }
  }

  console.log(`  Transakcje wg typu: ${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`  Suma prowizji (fee_minor): ${pln(feeTotal)} przy ${txRows.length} transakcjach`);
  console.log(`  Suma podatku u źródła (tax_minor): ${pln(taxTotal)} przy ${dividends} dywidendach`);

  const trades = (byType.get('buy') ?? 0) + (byType.get('sell') ?? 0);
  if (trades > 0 && feeTotal / trades < 50) {
    const note =
      `średnia prowizja ${pln(Math.round(feeTotal / trades))} na transakcję — ` +
      'źródło importu prawdopodobnie nie zawiera prowizji, więc koszt nabycia jest zaniżony';
    console.log(`  ⚠ ${note}`);
    flag(note);
  }
  if (dividends > 0 && dividendsWithoutTax === dividends) {
    const note =
      `wszystkie dywidendy (${dividends}) bez zapisanego podatku u źródła — ` +
      'raport podatkowy dolicza go szacunkowo przez ubruttowienie';
    console.log(`  ⚠ ${note}`);
    flag(note);
  }

  const noSettlementFx = txRows.filter((r) => r.currency !== config.baseCurrency && r.settlementFxRateE6 === null);
  if (noSettlementFx.length > 0) {
    const note = `transakcje walutowe bez kursu brokera: ${noSettlementFx.length} — koszt policzono po kursie NBP`;
    console.log(`  ⚠ ${note}`);
    flag(note);
  }

  // ── 4. Test tożsamości ──────────────────────────────────────────────────
  heading('4. Test tożsamości');

  const invested = netInvested(ids);
  const realized = realizedTotal(ids);
  const unrealized = positionsValue - positionsCost;
  const totalReturn = totalValuePlnMinor - invested;

  const dividendFlow = txRows.filter((r) => r.type === 'dividend').reduce((s, r) => s + r.amountPlnMinor, 0);
  const interestFlow = txRows.filter((r) => r.type === 'interest').reduce((s, r) => s + r.amountPlnMinor, 0);
  const feeFlow = txRows.filter((r) => r.type === 'fee' || r.type === 'tax').reduce((s, r) => s + r.amountPlnMinor, 0);

  const sumCheck = positionsValue + cashTotal - totalValuePlnMinor;
  console.log(`  wartość pozycji + gotówka = ${pln(positionsValue + cashTotal)}`);
  console.log(`  wartość portfela z aplikacji = ${pln(totalValuePlnMinor)}`);
  console.log(`  różnica = ${pln(sumCheck)}${sumCheck === 0 ? '  ✓' : '  ⚠ NIEZGODNOŚĆ'}`);
  if (sumCheck !== 0) flag(`suma pozycji i gotówki nie zgadza się z wartością portfela: ${pln(sumCheck)}`);

  const explained = realized + unrealized + dividendFlow + interestFlow + feeFlow;
  const residual = totalReturn - explained;
  const row = (label: string, value: number): string => `  ${label.padEnd(24)}${pln(value).padStart(14)}`;

  console.log('');
  console.log(row('wpłacono netto', invested));
  console.log(row('wynik całkowity', totalReturn));
  console.log(row('  zrealizowany', realized));
  console.log(row('  niezrealizowany', unrealized));
  console.log(row('  dywidendy', dividendFlow));
  console.log(row('  odsetki', interestFlow));
  console.log(row('  prowizje i podatki', feeFlow));
  console.log(row('  reszta niewyjaśniona', residual));
  console.log(
    '\n  Reszta to miara rozjazdu podstaw. Wynik całkowity liczy się przez saldo\n' +
      '  gotówki, a niezrealizowany tylko z otwartych lotów — różnica pokazuje,\n' +
      '  ile wyniku siedzi w przepływach, których żadna z tych dwóch liczb nie widzi.',
  );

  // ── 5. Świeżość źródeł ──────────────────────────────────────────────────
  heading('5. Świeżość źródeł danych');

  for (const [currency, rate] of [...fx.entries()].sort()) {
    const age = daysBetween(rate.date, day);
    const stale = age > FX_STALE_DAYS;
    console.log(
      `  kurs ${currency}: ${(rate.rateE6 / 1e6).toFixed(4)} z ${rate.date} (${age} dni)${stale ? '  ⚠ NIEAKTUALNY' : ''}`,
    );
    if (stale) flag(`kurs ${currency} nieodświeżany od ${age} dni (ostatni z ${rate.date})`);
  }

  const lastJobs = db
    .all<{ job: string; started_at: string; status: string }>(
      sql`SELECT job, MAX(started_at) AS started_at, status FROM job_runs GROUP BY job ORDER BY job`,
    )
    .map((r) => `${r.job} ${r.started_at.slice(0, 10)} (${r.status})`);
  console.log(`  ostatnie zadania: ${lastJobs.length > 0 ? lastJobs.join(', ') : 'brak wpisów'}`);

  const fxJobRan = db
    .all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM job_runs WHERE job = 'fx:refresh'`)
    .at(0)?.n ?? 0;
  if (fxJobRan === 0) {
    const note = 'zadanie fx:refresh nigdy się nie wykonało — kursy pochodzą wyłącznie z importu i backfillu';
    console.log(`  ⚠ ${note}`);
    flag(note);
  }

  // ── Podsumowanie ────────────────────────────────────────────────────────
  heading('Podsumowanie');
  if (flags.length === 0) {
    console.log('  Nie znalazłem niczego, co tłumaczyłoby różnicę wobec rachunku brokera.');
    console.log('');
    return;
  }

  // Grupujemy po kategorii i sortujemy po liczbie dotkniętych pozycji —
  // przyczyna obejmująca pół portfela jest ważniejsza niż pojedynczy papier.
  const grouped = new Map<string, string[]>();
  for (const entry of flags) {
    const subjects = grouped.get(entry.category) ?? [];
    if (entry.subject) subjects.push(entry.subject);
    grouped.set(entry.category, subjects);
  }

  console.log(`  ${grouped.size} przyczyn do sprawdzenia, od najszerzej działającej:`);
  for (const [category, subjects] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   • ${category}${subjects.length > 0 ? `\n     dotyczy: ${subjects.join(', ')}` : ''}`);
  }
  console.log('');
}

// Uruchomienie z linii poleceń. Import w testach nie odpala raportu.
if (process.argv[1]?.endsWith('diagnose.ts') || process.argv[1]?.endsWith('diagnose.js')) {
  runDiagnose(parsePortfolioArg());
  closeDb();
}
