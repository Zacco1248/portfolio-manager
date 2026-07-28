import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { shareBp } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { aiAnalyses, instruments, newsItems, pricesDaily, realizedGains, transactions } from '../db/schema.js';
import { addDays, today } from '../lib/dates.js';
import { headlineImportance, stripPublisher } from '../lib/headlines.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { checkFeature } from './ai-config.js';
import { completeWithMeta, estimateCostMicroUsd } from './ai.js';
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

export interface AssistUsage {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Szacunkowy koszt w mikrodolarach. Orientacyjny — rozstrzyga panel dostawcy. */
  costMicroUsd: number | null;
}

export interface AssistResult<T> {
  data: T;
  text: string | null;
  unavailableReason: string | null;
  disclaimer: string;
  usage?: AssistUsage;
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
    const meta = await completeWithMeta(prompt, payload, maxTokens);
    return {
      data,
      text: meta.text,
      unavailableReason: meta.text ? null : 'Model nie zwrócił treści.',
      disclaimer: ASSIST_DISCLAIMER,
      usage: {
        provider: meta.provider,
        model: meta.model,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        costMicroUsd: estimateCostMicroUsd(meta),
      },
    };
  } catch (err) {
    log.warn(`${feature}: model nie odpowiedział — ${errorMessage(err)}`);
    return { data, text: null, unavailableReason: 'Model nie odpowiedział.', disclaimer: ASSIST_DISCLAIMER };
  }
}

/** Zapisanie odpowiedzi, żeby przetrwała odświeżenie strony. */
function saveAnalysis(
  kind: string,
  result: AssistResult<unknown>,
  context: { instrumentId?: number; portfolioId?: number; facts: unknown },
): void {
  if (!result.text || !result.usage) return;

  db.insert(aiAnalyses)
    .values({
      kind,
      instrumentId: context.instrumentId ?? null,
      portfolioId: context.portfolioId ?? null,
      provider: result.usage.provider,
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costMicroUsd: result.usage.costMicroUsd,
      facts: context.facts as Record<string, unknown>,
      text: result.text,
    })
    .run();
}

export interface SavedAnalysis {
  id: number;
  kind: string;
  instrumentId: number | null;
  createdAt: string;
  provider: string;
  model: string;
  costMicroUsd: number | null;
  facts: Record<string, unknown> | null;
  text: string;
}

/** Wcześniejsze analizy danego rodzaju, od najnowszej. */
export function listAnalyses(kind?: string, instrumentId?: number, limit = 20): SavedAnalysis[] {
  return db
    .select()
    .from(aiAnalyses)
    .orderBy(desc(aiAnalyses.createdAt))
    .all()
    .filter((row) => (kind === undefined || row.kind === kind) && (instrumentId === undefined || row.instrumentId === instrumentId))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      instrumentId: row.instrumentId,
      createdAt: row.createdAt,
      provider: row.provider,
      model: row.model,
      costMicroUsd: row.costMicroUsd,
      facts: row.facts,
      text: row.text,
    }));
}

export function deleteAnalysis(id: number): void {
  db.delete(aiAnalyses).where(eq(aiAnalyses.id, id)).run();
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

  const result = await withModel('monthlySummary', facts, MONTHLY_PROMPT, payload);
  if (result.text) saveAnalysis('monthly_summary', result, { portfolioId, facts });
  return result;
}

// ── Wyjaśnianie ruchu ceny ───────────────────────────────────

export interface PriceMoveFacts {
  symbol: string;
  name: string;
  changeBp: number | null;
  days: number;
  headlines: {
    title: string;
    publishedAt: string;
    summary: string | null;
    source: string;
    linked: boolean;
    importance: number;
  }[];
  /** Ile wiadomości w ogóle zebrano w tym okresie — odróżnia brak newsów od braku dopasowania. */
  newsInWindow: number;
  /** Liczba sesji w naszej bazie. Zero oznacza lukę w danych, nie brak obrotu na giełdzie. */
  candleCount: number;
  /** Skąd pochodzi zmiana kursu: z zapisanej historii czy z odpytania dostawcy. */
  priceSource: 'baza' | 'dostawca' | null;
}

/**
 * Czy nagłówek dotyczy tego instrumentu.
 *
 * Nazwy w bazie bywają rozbudowane („XTB S.A.", „iShares Core S&P 500 UCITS ETF"),
 * a w tytułach występuje sama nazwa własna. Bierzemy więc pierwszy człon nazwy
 * i goły ticker, oba przynajmniej trzyznakowe — krótsze dawałyby przypadkowe
 * trafienia w środku innych słów.
 */
export function mentionsInstrument(title: string, instrument: { symbol: string; name: string }): boolean {
  const haystack = stripPublisher(title).toLowerCase();

  const ticker = (instrument.symbol.split(':').pop() ?? instrument.symbol).split('.')[0]!.toLowerCase();
  const firstWord = instrument.name.split(/[\s,.]+/)[0]?.toLowerCase() ?? '';

  const needles = [ticker, firstWord].filter((needle) => needle.length >= 3);

  // Granice słowa, żeby „PKO" nie trafiało w „pokoje", a „XTB" tylko jako całość.
  return needles.some((needle) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'i').test(haystack));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  /*
   * Wiadomości szukamy dwiema drogami. Powiązanie po instrumencie jest pewne,
   * ale niepełne: adres artykułu jest w bazie unikalny, więc tekst opisujący
   * kilka spółek przypina się tylko do tej, która trafiła tam pierwsza.
   * Drugi przebieg łapie te przypisane gdzie indziej albo wcale, szukając
   * nazwy i tickera w tytule.
   */
  const recent = db
    .select()
    .from(newsItems)
    .where(gte(newsItems.publishedAt, from))
    .orderBy(desc(newsItems.publishedAt))
    .all();

  const matches = recent.filter(
    (item) => item.instrumentId === instrumentId || mentionsInstrument(item.title, instrument),
  );

  const headlines = matches
    .map((item) => ({
      title: item.title,
      publishedAt: item.publishedAt.slice(0, 10),
      summary: item.aiSummaryPl ?? item.rawSummary,
      source: item.source,
      /** Skąd wzięło się dopasowanie — przydaje się przy diagnozowaniu pustych wyników. */
      linked: item.instrumentId === instrumentId,
      importance: headlineImportance(item.title, item.rawSummary),
    }))
    // Najpierw waga, przy równej świeższe. Model czyta od góry, więc kolejność
    // decyduje o tym, wokół czego zbuduje wyjaśnienie.
    .sort((a, b) => b.importance - a.importance || (a.publishedAt < b.publishedAt ? 1 : -1))
    .slice(0, 15);

  return {
    symbol: instrument.symbol,
    name: instrument.name,
    changeBp,
    days: MOVE_WINDOW_DAYS,
    headlines,
    newsInWindow: recent.length,
    candleCount: candles.length,
    priceSource: changeBp === null ? null : 'baza',
  };
}

const MOVE_PROMPT = `Jesteś analitykiem tłumaczącym polskiemu inwestorowi indywidualnemu, co dzieje się z kursem spółki.

Dostajesz zmianę kursu z ostatnich dwóch tygodni i nagłówki z tego samego okresu.

Napisz po polsku 4-7 zdań, w tej kolejności:

1. Nazwij ruch: skala i czy jest duży jak na tę spółkę.
2. Wskaż konkretne nagłówki, które mogą go tłumaczyć — cytuj ich treść, nie ograniczaj się do stwierdzenia,
   że coś było. Jeśli nagłówki układają się w wątek (wyniki, zmiana w zarządzie, dane operacyjne, regulacje,
   sytuacja całej branży), nazwij ten wątek.
3. Oceń siłę powiązania: czy daty się zgadzają, czy to raczej tło niż wyzwalacz, czy ruch wyprzedził wiadomość.
4. Podaj, co jeszcze mogło zadziałać, a czego w nagłówkach nie widać — wyniki konkurencji, dane makro,
   nastroje na szerokim rynku, przepływy w funduszach, zmiany kursu walut przy spółkach z ekspozycją zagraniczną.
5. Zakończ tym, co warto sprawdzić dalej: konkretne miejsce (raport bieżący, kalendarz publikacji, dane operacyjne),
   a nie ogólnik „obserwować sytuację".

Zasady:
- Nagłówki dostajesz uszeregowane od najważniejszego. Buduj wyjaśnienie wokół pierwszych z listy —
  rekomendacji, wyników, komunikatów giełdowych — a przeglądy sesji traktuj jako tło.
- Jeśli zmiana kursu jest opisana jako NIEZNANA, znaczy to, że brakuje danych w lokalnej bazie aplikacji.
  NIE wyciągaj z tego wniosku o zawieszeniu notowań, wstrzymaniu obrotu ani o jakimkolwiek zdarzeniu
  na giełdzie. Napisz, że nie znasz skali ruchu, i skomentuj same wiadomości.
- Rozróżniaj zbieżność w czasie od przyczyny i nazywaj to wprost, ale nie zatrzymuj się na tym rozróżnieniu —
  ono jest zastrzeżeniem, nie treścią odpowiedzi.
- Jeśli nagłówków brak, nie pisz o tym pięciu zdań. Stwierdź to raz i przejdź do tego, co typowo stoi
  za ruchem tej wielkości bez komunikatów spółki, oraz gdzie inwestor może szukać dalej.
- Nie prognozuj dalszego kierunku kursu i nie sugeruj kupna ani sprzedaży.
- Piszesz zwartym tekstem ciągłym, bez nagłówków, bez numeracji i bez list punktowanych.
- Konkret zamiast asekuracji. Zdanie „to jedynie hipotezy" wnosi mniej niż wskazanie, która hipoteza jest
  najbardziej prawdopodobna i dlaczego.`;

export async function explainPriceMove(instrumentId: number): Promise<AssistResult<PriceMoveFacts | null>> {
  let facts = priceMoveFacts(instrumentId);
  if (!facts) {
    return { data: null, text: null, unavailableReason: 'Nie ma takiego instrumentu.', disclaimer: ASSIST_DISCLAIMER };
  }

  /*
   * Bez wiadomości nie ma czego analizować, a czekanie do najbliższego przebiegu
   * co godzinę oznaczałoby pustą odpowiedź teraz. Dociągamy je w locie i liczymy
   * fakty jeszcze raz — wywołanie modelu i tak potrwa dłużej niż to pobranie.
   */
  if (facts.headlines.length === 0) {
    try {
      const { fetchNewsForInstrument } = await import('./news.js');
      log.info(`Brak wiadomości dla instrumentu ${instrumentId} — pobieram: ${await fetchNewsForInstrument(instrumentId)}`);
      facts = priceMoveFacts(instrumentId) ?? facts;
    } catch (err) {
      log.warn(`Doraźne pobranie wiadomości nieudane: ${errorMessage(err)}`);
    }
  }

  /*
   * To samo z notowaniami. Pusta historia to luka w naszej bazie, a nie
   * zawieszenie obrotu — ale bez uzupełnienia nie ma czego wyjaśniać, a model
   * dostawszy „brak notowań" potrafi wysnuć z tego nieistniejące zdarzenie.
   */
  if (facts.candleCount < 2) {
    try {
      const { backfillInstrumentHistory } = await import('./prices.js');
      log.info(
        `Brak notowań instrumentu ${instrumentId} — uzupełniam: ${await backfillInstrumentHistory(instrumentId)} świec`,
      );
      facts = priceMoveFacts(instrumentId) ?? facts;
    } catch (err) {
      log.warn(`Doraźne uzupełnienie notowań nieudane: ${errorMessage(err)}`);
    }
  }

  /*
   * Ostatnia deska ratunku: zmiana liczona wprost z odpowiedzi dostawcy, bez
   * pośrednictwa bazy. Zapis potrafi się nie udać z powodów niezwiązanych
   * z dostępnością notowań, a do wyjaśnienia ruchu wystarczy sama liczba.
   */
  if (facts.changeBp === null) {
    const live = await livePriceChange(instrumentId);
    if (live !== null) facts = { ...facts, changeBp: live, priceSource: 'dostawca' };
  }

  const payload = [
    `Instrument: ${facts.symbol} (${facts.name})`,
    facts.changeBp === null
      ? `Zmiana kursu przez ${facts.days} dni: NIEZNANA — w lokalnej bazie aplikacji brakuje notowań ` +
        `(mamy ${facts.candleCount} sesji). To luka w danych, a NIE przerwa w obrocie na giełdzie.`
      : `Zmiana kursu przez ${facts.days} dni: ${pct(facts.changeBp)}`,
    'Nagłówki, od najważniejszego:',
    ...(facts.headlines.length > 0
      ? facts.headlines.map((h) => `- ${h.publishedAt}: ${h.title}${h.summary ? ` — ${h.summary.slice(0, 200)}` : ''}`)
      : ['- brak wiadomości dotyczących tej spółki w tym okresie']),
  ].join('\n');

  const result = await withModel('priceMoves', facts, MOVE_PROMPT, payload);
  if (result.text) saveAnalysis('price_move', result, { instrumentId, facts });
  return result;
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

  const result = await withModel('purchaseCheck', facts, PURCHASE_PROMPT, payload);
  if (result.text) saveAnalysis('purchase_check', result, { portfolioId, facts });
  return result;
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

  const result = await withModel('taxAssistant', facts, TAX_PROMPT, payload, 1500);
  if (result.text) saveAnalysis('tax', result, { portfolioId, facts });
  return result;
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


/**
 * Zmiana kursu odczytana bezpośrednio od dostawcy notowań.
 *
 * Rejestr sam próbuje kolejnych źródeł (Yahoo, Stooq, CoinGecko) i zwraca
 * pierwsze, które odpowie. Nie zapisujemy tych świec — chodzi wyłącznie o to,
 * żeby móc podać skalę ruchu, gdy lokalna historia jest pusta.
 */
async function livePriceChange(instrumentId: number): Promise<number | null> {
  try {
    const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
    if (!instrument) return null;

    const { fetchHistory } = await import('../providers/registry.js');
    const { toProviderInstrument } = await import('./prices.js');

    const to = today(config.timezone);
    const result = await fetchHistory(toProviderInstrument(instrument), addDays(to, -MOVE_WINDOW_DAYS), to);
    if (!result || result.candles.length < 2) return null;

    const first = result.candles[0]!.closeE8;
    const last = result.candles[result.candles.length - 1]!.closeE8;
    if (first <= 0) return null;

    log.info(`Zmiana kursu ${instrument.symbol} wprost od dostawcy ${result.providerId}`);
    return Math.round((last / first - 1) * 10_000);
  } catch (err) {
    log.warn(`Odczyt zmiany kursu od dostawcy nieudany: ${errorMessage(err)}`);
    return null;
  }
}
