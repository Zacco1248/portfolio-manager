import { parse as parseHtml } from 'node-html-parser';
import type { HTMLElement } from 'node-html-parser';
import type { AssetClass, TransactionType } from '@portfolio/shared';
import { normalizeDate } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import type { ImportParser, ParseResult, ParsedRow, ParserFileMeta } from './types.js';

const log = createLogger('parser:xtb');

/**
 * Parser wyciągu z XTB.
 *
 * Platforma eksportuje raport jako plik MHTML wygenerowany przez SQL Server
 * Reporting Services: wielocześciowy MIME, w środku HTML z głęboko
 * zagnieżdżonymi tabelami. Sekcje to CLOSED POSITION, OPEN POSITION,
 * PENDING ORDERS i CASH OPERATION.
 *
 * Czytamy wyłącznie CASH OPERATION — to jedyna sekcja obejmująca komplet
 * zdarzeń (wpłaty, kupno, sprzedaż, dywidendy, podatek u źródła, odsetki),
 * a pozostałe są jej pochodnymi i wprowadzałyby duplikaty.
 */

const CASH_HEADER = ['id', 'type', 'time', 'comment', 'symbol', 'amount'];

/** Sufiks giełdy w symbolu XTB → waluta notowania. */
const SUFFIX_CURRENCY: Record<string, string> = {
  PL: 'PLN',
  US: 'USD',
  UK: 'USD', // ETF-y na LSE są zwykle notowane w USD; akcje bywają w GBP
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  PT: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  DK: 'DKK',
  SE: 'SEK',
  NO: 'NOK',
  CH: 'CHF',
  CZ: 'CZK',
  HU: 'HUF',
};

/** Sufiksy, dla których waluta bywa niejednoznaczna — wymagają potwierdzenia. */
const AMBIGUOUS_SUFFIXES = new Set(['UK']);

function typeFor(rawType: string): TransactionType | null {
  const t = rawType.toLowerCase().trim();
  if (t.includes('deposit') || t.includes('transfer in')) return 'deposit';
  if (t.includes('withdrawal') || t.includes('transfer out')) return 'withdrawal';
  if (t.includes('stock purchase')) return 'buy';
  if (t.includes('stock sale')) return 'sell';
  if (t.includes('divident') || t.includes('dividend')) return 'dividend';
  if (t.includes('withholding tax') || t.includes('tax')) return 'tax';
  if (t.includes('interest')) return 'interest';
  if (t.includes('commission') || t.includes('fee')) return 'fee';
  return null;
}

const isCloseTrade = (rawType: string): boolean => rawType.toLowerCase().includes('close trade');
const isStockSale = (rawType: string): boolean => rawType.toLowerCase().includes('stock sale');

/**
 * Zamknięcie pozycji XTB księguje w dwóch wierszach: "Stock sale" zwraca samą
 * pierwotną wartość zakupu, a wynik trafia osobno jako "close trade".
 * Przychód ze sprzedaży to dopiero suma obu.
 *
 * Przykład z wyciągu: sprzedaż 1 szt. INTC.US po 65,72 USD daje wiersz
 * "Stock sale" na 125,96 zł (tyle kosztował zakup) i "close trade" na
 * 108,77 zł. Rzeczywisty wpływ to 234,73 zł. Bez połączenia obu wierszy
 * zarówno saldo gotówki, jak i zysk zrealizowany byłyby zaniżone, a kurs
 * walutowy odtworzony z samej kwoty "Stock sale" wychodziłby bez sensu.
 *
 * Wiersze są parowane po symbolu i znaczniku czasu; przy kilku równoczesnych
 * zamknięciach tego samego papieru decyduje kolejność, w jakiej wystąpiły.
 */
function mergeCloseTradeProfits(operations: CashOperationRow[]): Map<string, number> {
  const profitBySaleId = new Map<string, number>();
  const pending: CashOperationRow[] = [];

  for (const op of operations) {
    if (isCloseTrade(op.type)) {
      pending.push(op);
      continue;
    }
    if (!isStockSale(op.type)) continue;

    const matchIndex = pending.findIndex((p) => p.symbol === op.symbol && p.time === op.time);
    if (matchIndex === -1) continue;

    const [match] = pending.splice(matchIndex, 1);
    profitBySaleId.set(op.id, toNumber(match!.amount));
  }

  return profitBySaleId;
}

/** `OPEN BUY 0.2301/2.2301 @ 10.485` → ilość 0.2301, cena 10.485. */
const COMMENT_RE = /(OPEN|CLOSE)\s+(BUY|SELL)\s+([\d.,]+)(?:\/[\d.,]+)?\s*@\s*([\d.,]+)/i;

export function parseTradeComment(comment: string): { quantity: string; price: string } | null {
  const m = COMMENT_RE.exec(comment);
  if (!m) return null;
  return { quantity: m[3]!, price: m[4]! };
}

/** Rozbija plik MHTML na części i zwraca pierwszą część HTML. */
export function extractHtmlFromMhtml(buffer: Buffer): string {
  const raw = buffer.toString('binary');
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(raw);

  if (!boundaryMatch) {
    // Plik może być zwykłym HTML-em zapisanym z przeglądarki.
    return buffer.toString('utf8');
  }

  const parts = raw.split(`--${boundaryMatch[1]}`);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') + 4 : part.indexOf('\n\n') + 2;
    if (headerEnd <= 2) continue;

    const headers = part.slice(0, headerEnd).toLowerCase();
    if (!headers.includes('text/html')) continue;

    const body = part.slice(headerEnd);
    if (headers.includes('base64')) {
      return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
    }
    if (headers.includes('quoted-printable')) {
      return decodeQuotedPrintable(body);
    }
    return Buffer.from(body, 'binary').toString('utf8');
  }

  return buffer.toString('utf8');
}

function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === '=' && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(joined.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Komórki należące bezpośrednio do danego wiersza.
 *
 * `querySelectorAll('td')` zwraca wszystkich potomków, więc w dokumencie SSRS
 * — gdzie raport jest opakowany w kilkanaście warstw tabel — zewnętrzny wiersz
 * "zawierałby" komórki z całej głębi drzewa i fałszywie dopasowywał się do
 * nagłówka. Bierzemy wyłącznie bezpośrednie dzieci wiersza i odrzucamy te,
 * które same zawierają zagnieżdżoną tabelę.
 */
function leafCells(row: HTMLElement): string[] {
  return row.childNodes
    .filter(
      (node): node is HTMLElement =>
        node.nodeType === 1 && (node as HTMLElement).rawTagName?.toLowerCase() === 'td',
    )
    .filter((td) => td.querySelectorAll('table').length === 0)
    .map((td) => td.text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim());
}

interface CashOperationRow {
  id: string;
  type: string;
  time: string;
  comment: string;
  symbol: string;
  amount: string;
}

export function extractCashOperations(html: string): CashOperationRow[] {
  const root = parseHtml(html);
  const rows = root.querySelectorAll('tr');

  let headerIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const cells = leafCells(rows[i]!).map((c) => c.toLowerCase());
    if (cells.length < CASH_HEADER.length) continue;
    // Nagłówek rozpoznajemy po komplecie nazw kolumn, nie po pozycji —
    // SSRS potrafi wstawić dodatkowe puste komórki.
    if (CASH_HEADER.every((name) => cells.includes(name))) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return [];

  const headerCells = leafCells(rows[headerIndex]!).map((c) => c.toLowerCase());
  const columnIndex = Object.fromEntries(CASH_HEADER.map((name) => [name, headerCells.indexOf(name)])) as Record<
    string,
    number
  >;

  const out: CashOperationRow[] = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const cells = leafCells(rows[i]!);
    if (cells.length < CASH_HEADER.length) continue;

    const id = cells[columnIndex.id!] ?? '';
    const type = cells[columnIndex.type!] ?? '';
    const time = cells[columnIndex.time!] ?? '';
    // Wiersz sumaryczny ("Total") nie ma identyfikatora ani daty.
    if (!/^\d+$/.test(id) || !time) continue;

    out.push({
      id,
      type,
      time,
      comment: cells[columnIndex.comment!] ?? '',
      symbol: cells[columnIndex.symbol!] ?? '',
      amount: cells[columnIndex.amount!] ?? '',
    });
  }

  return out;
}

/** Kody walut, w których XTB prowadzi rachunki. */
const ACCOUNT_CURRENCIES = new Set(['PLN', 'EUR', 'USD', 'GBP', 'CZK', 'HUF', 'RON']);

/**
 * Waluta rachunku z nagłówka raportu.
 *
 * Nie da się tego wyciągnąć zwykłym regexem po słowie "Currency" — w treści
 * raportu pełno jest trzyliterowych ciągów (np. "DIV" z nazwy ETF-a), które
 * łapią się jako pierwsze. Szukamy komórki o dokładnej treści "Currency"
 * i bierzemy najbliższą kolejną komórkę będącą znanym kodem waluty.
 */
function accountCurrency(root: HTMLElement): string {
  const cells = root.querySelectorAll('td').map((td) => td.text.replace(/\s+/g, ' ').trim());
  const labelIndex = cells.findIndex((c) => c.toLowerCase() === 'currency');
  if (labelIndex !== -1) {
    for (let i = labelIndex + 1; i < Math.min(cells.length, labelIndex + 12); i += 1) {
      const value = cells[i]!.toUpperCase();
      if (ACCOUNT_CURRENCIES.has(value)) return value;
    }
  }
  // Raporty dla rachunków IKE nie wypełniają tego pola. Rachunek IKE jest
  // z definicji złotowy, a dla pozostałych brak wartości i tak oznacza PLN.
  return 'PLN';
}

function currencyForSymbol(symbol: string): { currency: string; inferred: boolean; ambiguous: boolean } {
  const idx = symbol.lastIndexOf('.');
  if (idx === -1) return { currency: 'USD', inferred: true, ambiguous: true };
  const suffix = symbol.slice(idx + 1).toUpperCase();
  const currency = SUFFIX_CURRENCY[suffix];
  if (!currency) return { currency: 'USD', inferred: true, ambiguous: true };
  return { currency, inferred: true, ambiguous: AMBIGUOUS_SUFFIXES.has(suffix) };
}

function assetClassFor(symbol: string): AssetClass {
  // XTB nie rozróżnia akcji i ETF-ów w wyciągu. Zgadywanie po nazwie byłoby
  // zawodne, więc wszystko trafia jako akcje, a użytkownik może poprawić
  // klasę na instrumencie — dotyczy to garstki pozycji.
  return symbol ? 'stock' : 'cash';
}

/** Dzieli tekst na liczbę, tolerując spacje i przecinki dziesiętne. */
function toNumber(value: string): number {
  const cleaned = value.replace(/[\s ]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export const xtbParser: ImportParser = {
  id: 'xtb-mhtml',
  name: 'XTB — wyciąg z konta',
  description:
    'Raport z xStation zapisany jako MHTML. Czytana jest sekcja CASH OPERATION HISTORY, ' +
    'która zawiera komplet operacji: wpłaty, transakcje, dywidendy, podatek u źródła i odsetki.',
  extensions: ['.mhtml', '.mht', '.html'],
  requiresMapping: false,

  async detect(meta: ParserFileMeta, buffer: Buffer): Promise<number> {
    const head = meta.head.toLowerCase();
    if (head.includes('statementonline')) return 0.98;
    if (head.includes('mssqlrs') && head.includes('multipart/related')) return 0.9;

    const isMhtml = /\.(mhtml|mht)$/i.test(meta.filename);
    if (!isMhtml && !head.includes('multipart/related')) return 0;

    // Treść raportu bywa zakodowana base64, więc sam nagłówek pliku nie
    // wystarcza — zaglądamy do rozpakowanego HTML-a.
    try {
      const html = extractHtmlFromMhtml(buffer).toLowerCase();
      if (html.includes('cash operation')) return 0.85;
      if (html.includes('closed position') || html.includes('open position')) return 0.6;
    } catch {
      // Uszkodzony MIME oznacza po prostu brak dopasowania.
    }

    return isMhtml ? 0.2 : 0;
  },

  async parse(buffer: Buffer): Promise<ParseResult> {
    const html = extractHtmlFromMhtml(buffer);
    const operations = extractCashOperations(html);
    const currency = accountCurrency(parseHtml(html));
    const notes: string[] = [];

    if (operations.length === 0) {
      notes.push(
        'Nie znalazłem sekcji CASH OPERATION HISTORY. Upewnij się, że eksport z xStation ' +
          'obejmuje historię operacji gotówkowych.',
      );
      return { rows: [], detectedColumns: CASH_HEADER, notes };
    }

    const rows: ParsedRow[] = [];
    const profitBySaleId = mergeCloseTradeProfits(operations);
    let mergedCloseTrades = 0;

    for (const op of operations) {
      if (isCloseTrade(op.type)) {
        // Wynik jest doliczany do odpowiadającego wiersza sprzedaży.
        mergedCloseTrades += 1;
        continue;
      }

      const type = typeFor(op.type);
      if (type === null) continue;

      const tradeDate = normalizeDate(op.time);
      if (!tradeDate) continue;

      // Dla sprzedaży kwotą rozliczenia jest suma zwróconego kapitału i wyniku.
      const amount = toNumber(op.amount) + (profitBySaleId.get(op.id) ?? 0);
      const issues: string[] = [];
      const symbol = op.symbol.trim() || null;

      if (type === 'buy' || type === 'sell') {
        const trade = parseTradeComment(op.comment);
        if (!trade || !symbol) {
          issues.push(`Nie umiem odczytać ilości i ceny z opisu: "${op.comment}"`);
          continue;
        }

        const detected = currencyForSymbol(symbol);
        const qty = toNumber(trade.quantity);
        const price = toNumber(trade.price);
        // Kurs brokera odtwarzamy z relacji kwoty w PLN do wartości transakcji
        // w walucie notowania. Dla instrumentów złotowych wyjdzie 1.
        const impliedFx = qty > 0 && price > 0 ? Math.abs(amount) / (qty * price) : null;
        const isBaseCurrency = impliedFx !== null && Math.abs(impliedFx - 1) < 0.005;
        const rowCurrency = isBaseCurrency ? currency : detected.currency;

        if (!isBaseCurrency && detected.ambiguous) {
          issues.push(
            `Waluta ${detected.currency} wywnioskowana z sufiksu symbolu — sprawdź, ` +
              `czy zgadza się z rzeczywistą walutą notowania.`,
          );
        }

        rows.push({
          rowId: op.id,
          tradeDate,
          type,
          rawSymbol: symbol,
          instrumentName: null,
          assetClass: assetClassFor(symbol),
          currency: rowCurrency,
          currencyInferred: !isBaseCurrency,
          quantity: trade.quantity,
          price: trade.price,
          grossAmount: null,
          fee: '0',
          tax: '0',
          fxRate: isBaseCurrency || impliedFx === null ? null : impliedFx.toFixed(6),
          note: op.comment || null,
          issues,
        });
        continue;
      }

      // Pozostałe operacje mają kwotę wprost w walucie konta.
      rows.push({
        rowId: op.id,
        tradeDate,
        type,
        rawSymbol: symbol,
        instrumentName: null,
        assetClass: symbol ? 'stock' : 'cash',
        currency,
        currencyInferred: false,
        quantity: '0',
        price: '0',
        grossAmount: Math.abs(amount).toString(),
        fee: '0',
        tax: '0',
        fxRate: null,
        note: op.comment || null,
        issues,
      });
    }

    if (mergedCloseTrades > 0) {
      notes.push(
        `Połączono ${mergedCloseTrades} wierszy "close trade" z odpowiadającymi im sprzedażami — ` +
          `XTB księguje zwrot kapitału i wynik pozycji osobno, a przychód ze sprzedaży to suma obu.`,
      );
    }

    const inferred = rows.filter((r) => r.currencyInferred).length;
    if (inferred > 0) {
      notes.push(
        `Dla ${inferred} transakcji waluta notowania została wywnioskowana z symbolu — ` +
          `wyciąg XTB podaje kwoty wyłącznie w walucie konta. Kurs brokera odtworzono z kwoty rozliczenia.`,
      );
    }

    log.info(`Odczytano ${rows.length} operacji z wyciągu XTB`);
    return { rows, detectedColumns: CASH_HEADER, notes };
  },
};
