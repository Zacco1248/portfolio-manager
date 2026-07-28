import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { shareBp } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, newsItems, pricesDaily, realizedGains, transactions } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { checkFeature } from './ai-config.js';
import { complete } from './ai.js';
import { activePortfolioIds, buildPositions } from './positions.js';
import { readHistory } from './snapshots.js';
import { buildTaxReport } from './tax.js';

const log = createLogger('ai-assist');

/**
 * Funkcje asystenta oparte o model językowy.
 *
 * Każda z nich trzyma się tego samego podziału pracy: liczby powstają lokalnie
 * z bazy, a model dostaje wyłącznie gotowe wnioski i układa z nich zdania.
 * Dzięki temu wyłączenie AI odbiera komentarz, ale nie odbiera danych — i widać
 * dokładnie, co wychodzi na zewnątrz.
 *
 * Żadna z nich nie wydaje rekomendacji inwestycyjnych.
 */

export const ASSIST_DISCLAIMER =
  'Materiał informacyjny wygenerowany automatycznie. Nie stanowi rekomendacji ani doradztwa inwestycyjnego.';

export interface AssistResult<T> {
  data: T;
  text: string | null;
  unavailableReason: string | null;
  disclaimer: string;
}

/**
 * Wspólna obsługa: sprawdzenie zgody, wywołanie modelu, przechwycenie błędu.
 * Fakty zwracamy zawsze — także gdy model jest wyłączony albo nie odpowiedział.
 */
async function withModel<T>(
  feature: Parameters<typeof checkFeature>[0],
  data: T,
  prompt: string,
  payload: string,
  maxTokens = 1200,
): Promise<AssistResult<T>> {
  const availability = checkFeature(feature);
  if (!availability.enabled) {
    return { data, text: null, unavailableReason: availability.reason, disclaimer: ASSIST_DISCLAIMER };
  }

  try {
    return {
      data,
      text: await complete(prompt, payload, maxTokens),
      unavailableReason: null,
      disclaimer: ASSIST_DISCLAIMER,
    };
  } catch (err) {
    log.warn(`${feature}: model nie odpowiedział — ${errorMessage(err)}`);
    return { data, text: null, unavailableReason: 'Model nie odpowiedział.', disclaimer: ASSIST_DISCLAIMER };
  }
}

const pln = (minor: number): string => `${(minor / 100).toFixed(2)} zł`;
const pct = (bp: number): string => `${bp >= 0 ? '+' : ''}${(bp / 100).toFixed(1)}%`;

// ── Podsumowanie miesiąca ────────────────────────────────────

export interface MonthlyFacts {
  month: string;
  valueStartPlnMinor: number | null;
  valueEndPlnMinor: number | null;
  contributedPlnMinor: number;
  changeBp: number | null;
  buys: number;
  sells: number;
  dividendsPlnMinor: number;
  realizedPlnMinor: number;
  movers: { symbol: string; name: string; changeBp: number }[];
}

/** Miesiąc w formacie RRRR-MM; domyślnie poprzedni zamknięty. */
export function previousMonth(reference = today(config.timezone)): string {
  const [year, month] = reference.split('-').map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function monthlyFacts(portfolioIds: number[], month: string): MonthlyFacts {
  const from = `${month}-01`;
  const to = `${month}-31`;

  const history = readHistory(portfolioIds).filter((h) => h.date >= from && h.date <= to);
  const first = history[0] ?? null;
  const last = history[history.length - 1] ?? null;

  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.portfolioId, portfolioIds),
        gte(transactions.tradeDate, from),
        lte(transactions.tradeDate, to),
      ),
    )
    .all();

  const contributed = rows
    .filter((r) => r.type === 'deposit')
    .reduce((sum, r) => sum + Math.round((r.grossMinor * r.fxRateE6) / 1_000_000), 0);

  const dividends = rows
    .filter((r) => r.type === 'dividend')
    .reduce((sum, r) => sum + Math.round((r.grossMinor * r.fxRateE6) / 1_000_000), 0);

  const realized = db
    .select()
    .from(realizedGains)
    .where(inArray(realizedGains.portfolioId, portfolioIds))
    .all()
    .filter((g) => g.saleDate >= from && g.saleDate <= to)
    .reduce((sum, g) => sum + (g.proceedsPlnMinor - g.costPlnMinor), 0);

  // Zmiana liczona po odjęciu wpłat — inaczej dopłata wyglądałaby jak zysk.
  const changeBp =
    first && last && first.valuePlnMinor > 0
      ? Math.round(
          ((last.valuePlnMinor - (last.investedPlnMinor - first.investedPlnMinor)) / first.valuePlnMinor - 1) * 10_000,
        )
      : null;

  return {
    month,
    valueStartPlnMinor: first?.valuePlnMinor ?? null,
    valueEndPlnMinor: last?.valuePlnMinor ?? null,
    contributedPlnMinor: contributed,
    changeBp,
    buys: rows.filter((r) => r.type === 'buy').length,
    sells: rows.filter((r) => r.type === 'sell').length,
    dividendsPlnMinor: dividends,
    realizedPlnMinor: realized,
    movers: instrumentMoves(portfolioIds, from, to).slice(0, 6),
  };
}

/** Zmiana ceny posiadanych instrumentów w oknie czasowym. */
function instrumentMoves(
  portfolioIds: number[],
  from: string,
  to: string,
): { symbol: string; name: string; changeBp: number }[] {
  const { positions } = buildPositions(portfolioIds);

  const out: { symbol: string; name: string; changeBp: number }[] = [];

  for (const position of positions) {
    const candles = db
      .select()
      .from(pricesDaily)
      .where(
        and(
          eq(pricesDaily.instrumentId, position.instrument.id),
          gte(pricesDaily.date, from),
          lte(pricesDaily.date, to),
        ),
      )
      .all();

    if (candles.length < 2) continue;
    const start = candles[0]!.closeE8;
    const end = candles[candles.length - 1]!.closeE8;
    if (start <= 0) continue;

    out.push({
      symbol: position.instrument.symbol,
      name: position.instrument.name,
      changeBp: Math.round((end / start - 1) * 10_000),
    });
  }

  // Interesują skrajności w obie strony, nie same wzrosty.
  return out.sort((a, b) => Math.abs(b.changeBp) - Math.abs(a.changeBp));
}

const MONTHLY_PROMPT = `Jesteś asystentem inwestora indywidualnego z Polski budującego portfel długoterminowo.

Dostajesz zamknięte podsumowanie jednego miesiąca: zmianę wartości oczyszczoną z wpłat, kwotę dopłat,
liczbę transakcji, dywidendy, wynik zrealizowany i największe ruchy cen posiadanych pozycji.

Napisz zwięzły komentarz po polsku (4-7 zdań):
- co się w tym miesiącu wydarzyło i co za tym stoi,
- co wynika z tego dla kogoś, kto dokłada regularnie,
- na co warto zwrócić uwagę w kolejnym miesiącu.

Zasady: nie prognozuj cen, nie sugeruj konkretnych transakcji, nie oceniaj decyzji jako błędnych.
Jeden zły miesiąc w portfelu długoterminowym to normalna zmienność i tak go opisuj.
Pisz konkretnie, odwołując się do podanych liczb. Bez nagłówków i bez list punktowanych.`;

export async function monthlySummary(portfolioId: number | undefined, month?: string): Promise<AssistResult<MonthlyFacts>> {
  const facts = monthlyFacts(activePortfolioIds(portfolioId), month ?? previousMonth());

  const payload = [
    `Miesiąc: ${facts.month}`,
    `Wartość na początku: ${facts.valueStartPlnMinor === null ? 'brak danych' : pln(facts.valueStartPlnMinor)}`,
    `Wartość na końcu: ${facts.valueEndPlnMinor === null ? 'brak danych' : pln(facts.valueEndPlnMinor)}`,
    `Zmiana bez wpłat: ${facts.changeBp === null ? 'brak danych' : pct(facts.changeBp)}`,
    `Dopłaty: ${pln(facts.contributedPlnMinor)}`,
    `Transakcje: ${facts.buys} kupna, ${facts.sells} sprzedaży`,
    `Dywidendy: ${pln(facts.dividendsPlnMinor)}`,
    `Wynik zrealizowany: ${pln(facts.realizedPlnMinor)}`,
    `Największe ruchy: ${facts.movers.map((m) => `${m.symbol} ${pct(m.changeBp)}`).join('; ') || 'brak danych'}`,
  ].join('\n');

  return withModel('monthlySummary', facts, MONTHLY_PROMPT, payload);
}

// ── Wyjaśnianie ruchu ceny ───────────────────────────────────

export interface PriceMoveFacts {
  symbol: string;
  name: string;
  changeBp: number | null;
  days: number;
  headlines: { title: string; publishedAt: string; summary: string | null }[];
}

/** Okno, w którym szukamy przyczyn ruchu ceny. */
const MOVE_WINDOW_DAYS = 14;

export function priceMoveFacts(instrumentId: number): PriceMoveFacts | null {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return null;

  const from = addDays(today(config.timezone), -MOVE_WINDOW_DAYS);

  const candles = db
    .select()
    .from(pricesDaily)
    .where(and(eq(pricesDaily.instrumentId, instrumentId), gte(pricesDaily.date, from)))
    .all();

  const changeBp =
    candles.length >= 2 && candles[0]!.closeE8 > 0
      ? Math.round((candles[candles.length - 1]!.closeE8 / candles[0]!.closeE8 - 1) * 10_000)
      : null;

  const headlines = db
    .select()
    .from(newsItems)
    .where(and(eq(newsItems.instrumentId, instrumentId), gte(newsItems.publishedAt, from)))
    .orderBy(desc(newsItems.publishedAt))
    .limit(12)
    .all()
    .map((item) => ({
      title: item.title,
      publishedAt: item.publishedAt.slice(0, 10),
      summary: item.aiSummaryPl ?? item.rawSummary,
    }));

  return { symbol: instrument.symbol, name: instrument.name, changeBp, days: MOVE_WINDOW_DAYS, headlines };
}

const MOVE_PROMPT = `Jesteś analitykiem tłumaczącym inwestorowi indywidualnemu, co dzieje się z kursem spółki.

Dostajesz zmianę kursu z ostatnich dwóch tygodni i nagłówki z tego samego okresu.

Napisz po polsku 3-5 zdań: z czym zbiega się ten ruch według dostępnych nagłówków i czego z nich NIE wynika.
Jeśli nagłówki nie tłumaczą ruchu, napisz to wprost — kursy zmieniają się też bez powodu w wiadomościach.

Zasady: rozróżniaj zbieżność w czasie od przyczyny i nazywaj to wprost. Nie prognozuj dalszego kierunku.
Nie sugeruj kupna ani sprzedaży. Bez nagłówków i bez list punktowanych.`;

export async function explainPriceMove(instrumentId: number): Promise<AssistResult<PriceMoveFacts | null>> {
  const facts = priceMoveFacts(instrumentId);
  if (!facts) {
    return { data: null, text: null, unavailableReason: 'Nie ma takiego instrumentu.', disclaimer: ASSIST_DISCLAIMER };
  }

  const payload = [
    `Instrument: ${facts.symbol} (${facts.name})`,
    `Zmiana kursu przez ${facts.days} dni: ${facts.changeBp === null ? 'brak notowań' : pct(facts.changeBp)}`,
    'Nagłówki:',
    ...(facts.headlines.length > 0
      ? facts.headlines.map((h) => `- ${h.publishedAt}: ${h.title}${h.summary ? ` — ${h.summary.slice(0, 200)}` : ''}`)
      : ['- brak wiadomości w tym okresie']),
  ].join('\n');

  return withModel('priceMoves', facts, MOVE_PROMPT, payload);
}

// ── Kontrola przed zakupem ───────────────────────────────────

export interface PurchaseCheckFacts {
  symbol: string;
  amountPlnMinor: number;
  known: boolean;
  assetClass: string | null;
  sector: string | null;
  country: string | null;
  shareBeforeBp: number;
  shareAfterBp: number;
  assetClassShareBeforeBp: number;
  assetClassShareAfterBp: number;
  sectorShareAfterBp: number;
  countryShareAfterBp: number;
  portfolioValuePlnMinor: number;
  warnings: string[];
}

/** Udział, powyżej którego pojedyncza pozycja robi się dominująca. */
const SINGLE_POSITION_WARN_BP = 1500;

/** Udział jednego sektora lub regionu, przy którym warto się zatrzymać. */
const GROUP_WARN_BP = 4000;

export function purchaseCheckFacts(
  portfolioIds: number[],
  symbol: string,
  amountPlnMinor: number,
): PurchaseCheckFacts {
  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const before = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0) + cash;
  const after = before + amountPlnMinor;

  const needle = symbol.trim().toUpperCase();
  const held = positions.find(
    (p) => p.instrument.symbol.toUpperCase() === needle || p.instrument.symbol.toUpperCase().endsWith(`:${needle}`),
  );

  const catalogue =
    held?.instrument ??
    db
      .select()
      .from(instruments)
      .all()
      .find((i) => i.symbol.toUpperCase() === needle || i.symbol.toUpperCase().endsWith(`:${needle}`));

  const currentValue = held?.valuePlnMinor ?? 0;

  const groupValue = (pick: (p: (typeof positions)[number]) => string | null, key: string | null): number =>
    key === null ? 0 : positions.filter((p) => pick(p) === key).reduce((sum, p) => sum + p.valuePlnMinor, 0);

  const assetClass = catalogue?.assetClass ?? null;
  const sector = catalogue?.sector ?? null;
  const country = catalogue?.country ?? null;

  const classBefore = groupValue((p) => p.instrument.assetClass, assetClass);
  const sectorBefore = groupValue((p) => p.instrument.sector, sector);
  const countryBefore = groupValue((p) => p.instrument.country, country);

  const facts: PurchaseCheckFacts = {
    symbol: catalogue?.symbol ?? needle,
    amountPlnMinor,
    known: Boolean(catalogue),
    assetClass,
    sector,
    country,
    shareBeforeBp: Math.round(shareBp(currentValue, before)),
    shareAfterBp: Math.round(shareBp(currentValue + amountPlnMinor, after)),
    assetClassShareBeforeBp: Math.round(shareBp(classBefore, before)),
    assetClassShareAfterBp: Math.round(shareBp(classBefore + amountPlnMinor, after)),
    sectorShareAfterBp: Math.round(shareBp(sectorBefore + amountPlnMinor, after)),
    countryShareAfterBp: Math.round(shareBp(countryBefore + amountPlnMinor, after)),
    portfolioValuePlnMinor: before,
    warnings: [],
  };

  if (facts.shareAfterBp >= SINGLE_POSITION_WARN_BP) {
    facts.warnings.push(
      `Po zakupie ta jedna pozycja to ${pct(facts.shareAfterBp)} portfela — powyżej progu koncentracji.`,
    );
  }
  if (sector && facts.sectorShareAfterBp >= GROUP_WARN_BP) {
    facts.warnings.push(`Sektor „${sector}" urośnie do ${pct(facts.sectorShareAfterBp)} portfela.`);
  }
  if (country && facts.countryShareAfterBp >= GROUP_WARN_BP) {
    facts.warnings.push(`Region „${country}" urośnie do ${pct(facts.countryShareAfterBp)} portfela.`);
  }
  if (!catalogue) {
    facts.warnings.push('Tego instrumentu nie ma jeszcze w bazie — wpływ policzony wyłącznie na wartość portfela.');
  }

  return facts;
}

const PURCHASE_PROMPT = `Jesteś asystentem inwestora indywidualnego, który rozważa dokupienie jednej pozycji.

Dostajesz wpływ tego zakupu na strukturę portfela: udział pozycji, klasy aktywów, sektora i regionu
przed zakupem i po nim, oraz automatycznie wykryte ostrzeżenia.

Napisz po polsku 3-5 zdań: co ten zakup zmienia w strukturze i o co warto się upewnić przed decyzją.

Zasady: nie mów „kup" ani „nie kupuj" — decyzja należy do użytkownika, a Ty nie znasz jego sytuacji,
horyzontu ani dochodów. Nie prognozuj cen. Jeśli struktura po zakupie zostaje zdrowa, napisz to wprost
zamiast szukać problemów na siłę. Bez nagłówków i bez list punktowanych.`;

export async function purchaseCheck(
  portfolioId: number | undefined,
  symbol: string,
  amountPlnMinor: number,
): Promise<AssistResult<PurchaseCheckFacts>> {
  const facts = purchaseCheckFacts(activePortfolioIds(portfolioId), symbol, amountPlnMinor);

  const payload = [
    `Rozważany zakup: ${facts.symbol} za ${pln(facts.amountPlnMinor)}`,
    `Wartość portfela przed zakupem: ${pln(facts.portfolioValuePlnMinor)}`,
    `Udział tej pozycji: ${pct(facts.shareBeforeBp)} → ${pct(facts.shareAfterBp)}`,
    `Klasa aktywów (${facts.assetClass ?? 'nieznana'}): ${pct(facts.assetClassShareBeforeBp)} → ${pct(facts.assetClassShareAfterBp)}`,
    `Sektor (${facts.sector ?? 'nieprzypisany'}) po zakupie: ${pct(facts.sectorShareAfterBp)}`,
    `Region (${facts.country ?? 'nieprzypisany'}) po zakupie: ${pct(facts.countryShareAfterBp)}`,
    `Ostrzeżenia: ${facts.warnings.join(' ') || 'brak'}`,
  ].join('\n');

  return withModel('purchaseCheck', facts, PURCHASE_PROMPT, payload);
}

// ── Streszczanie dokumentów ──────────────────────────────────

/** Górny limit wklejanego tekstu — dłuższe raporty przycinamy. */
export const DOCUMENT_LIMIT = 60_000;

const DOCUMENT_PROMPT = `Jesteś analitykiem streszczającym dokumenty spółek giełdowych dla inwestora indywidualnego z Polski.

Dostajesz tekst raportu okresowego, komunikatu bieżącego albo prospektu funduszu.

Napisz po polsku streszczenie w tej strukturze, czystym tekstem bez markdownu:
1. O czym jest ten dokument (jedno zdanie).
2. Najważniejsze liczby, dokładnie tak, jak podano je w dokumencie.
3. Co się zmieniło wobec poprzedniego okresu, jeśli dokument to podaje.
4. Ryzyka i zastrzeżenia wymienione przez samą spółkę.
5. Czego w dokumencie NIE ma, a o co inwestor mógłby zapytać.

Zasady: opierasz się wyłącznie na dostarczonym tekście. Nie dopowiadasz z pamięci i nie mieszasz
wiedzy o spółce spoza dokumentu. Jeśli czegoś w tekście nie ma, piszesz że tego nie ma.
Nie oceniasz, czy to dobry moment na zakup.`;

export async function summarizeDocument(text: string): Promise<AssistResult<{ characters: number; truncated: boolean }>> {
  const trimmed = text.slice(0, DOCUMENT_LIMIT);
  const data = { characters: trimmed.length, truncated: text.length > DOCUMENT_LIMIT };

  return withModel('documentSummary', data, DOCUMENT_PROMPT, trimmed, 2000);
}

// ── Asystent podatkowy ───────────────────────────────────────

const TAX_PROMPT = `Jesteś asystentem tłumaczącym polskiemu inwestorowi indywidualnemu jego własne zestawienie do PIT-38.

Dostajesz wyliczone zestawienie za jeden rok i pytanie użytkownika.

Odpowiadasz po polsku, zwięźle, odwołując się do konkretnych kwot z zestawienia. Wyjaśniasz, z czego
wynikają liczby i do której pozycji formularza trafiają.

Zasady:
- Opierasz się wyłącznie na dostarczonych liczbach. Nie zmyślasz kwot, których nie podano.
- Papiery wartościowe i kryptowaluty rozlicza się w osobnych częściach PIT-38.
- IKE i IKZE są zwolnione z podatku od zysków kapitałowych i nie wchodzą do zeznania.
- Kończysz zdaniem, że to pomoc w wypełnieniu zeznania, a nie porada podatkowa, i że kwoty
  należy zweryfikować z dokumentami od brokera.`;

export interface TaxAssistantFacts {
  year: number;
  securitiesGainPlnMinor: number;
  securitiesTaxPlnMinor: number;
  cryptoGainPlnMinor: number;
  cryptoTaxPlnMinor: number;
  dividendGrossPlnMinor: number;
  dividendWithholdingPlnMinor: number;
  dividendDuePlnMinor: number;
  excludedPortfolios: string[];
}

export async function taxAssistant(
  year: number,
  portfolioId: number | undefined,
  question: string,
): Promise<AssistResult<TaxAssistantFacts>> {
  const report = buildTaxReport(year, portfolioId);

  const facts: TaxAssistantFacts = {
    year,
    securitiesGainPlnMinor: report.securities.gainPlnMinor,
    securitiesTaxPlnMinor: report.securities.taxPlnMinor,
    cryptoGainPlnMinor: report.crypto.gainPlnMinor,
    cryptoTaxPlnMinor: report.crypto.taxPlnMinor,
    dividendGrossPlnMinor: report.dividends.grossPlnMinor,
    dividendWithholdingPlnMinor: report.dividends.withholdingTaxPlnMinor,
    dividendDuePlnMinor: report.dividends.duePlnMinor,
    excludedPortfolios: report.excludedPortfolios.map((p) => p.name),
  };

  const payload = [
    `Rok: ${facts.year}`,
    `Papiery wartościowe — dochód: ${pln(facts.securitiesGainPlnMinor)}, podatek: ${pln(facts.securitiesTaxPlnMinor)}`,
    `Kryptowaluty — dochód: ${pln(facts.cryptoGainPlnMinor)}, podatek: ${pln(facts.cryptoTaxPlnMinor)}`,
    `Dywidendy — brutto: ${pln(facts.dividendGrossPlnMinor)}, podatek u źródła: ${pln(facts.dividendWithholdingPlnMinor)}, do dopłaty: ${pln(facts.dividendDuePlnMinor)}`,
    `Portfele zwolnione (poza zeznaniem): ${facts.excludedPortfolios.join(', ') || 'brak'}`,
    '',
    `Pytanie użytkownika: ${question}`,
  ].join('\n');

  return withModel('taxAssistant', facts, TAX_PROMPT, payload, 1500);
}

// ── Rozpoznawanie formatu importu ────────────────────────────

const MAPPING_PROMPT = `Jesteś asystentem mapującym kolumny pliku z historią transakcji maklerskich na pola aplikacji.

Dostajesz nagłówki kolumn i kilka przykładowych wierszy.

Pola docelowe: tradeDate (data transakcji), type (rodzaj: buy, sell, dividend, interest, fee, tax,
deposit, withdrawal, split), symbol (ticker albo nazwa instrumentu), qty (liczba sztuk), price (cena
jednostkowa), gross (kwota transakcji), currency (waluta), fee (prowizja), tax (podatek), note (opis).

Odpowiadasz wyłącznie obiektem JSON: {"mapping":{"<nagłówek>":"<pole>"},"dateFormat":"...","decimalSeparator":".","notes":"..."}
Nagłówki, których nie potrafisz przypisać, pomijasz w mapping i wymieniasz w notes.
Jeśli rodzaj transakcji jest zakodowany wartościami w kolumnie, opisz to w notes.`;

export interface MappingFacts {
  headers: string[];
  sampleCount: number;
}

export async function suggestImportMapping(
  headers: string[],
  samples: string[][],
): Promise<AssistResult<MappingFacts>> {
  const data: MappingFacts = { headers, sampleCount: samples.length };

  const payload = [
    `Nagłówki: ${headers.join(' | ')}`,
    'Przykładowe wiersze:',
    ...samples.slice(0, 5).map((row) => row.join(' | ')),
  ].join('\n');

  return withModel('importMapping', data, MAPPING_PROMPT, payload, 1200);
}
