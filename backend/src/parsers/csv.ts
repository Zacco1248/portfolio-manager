import { equityClassFor } from '@portfolio/shared';
import type { AssetClass, TransactionType } from '@portfolio/shared';
import { normalizeDate } from '../lib/dates.js';
import type { ColumnMapping, ImportParser, ParseResult, ParsedRow, ParserFileMeta } from './types.js';

/**
 * Uniwersalny parser CSV z kreatorem mapowania kolumn.
 *
 * Służy jako furtka dla źródeł, dla których nie ma dedykowanego parsera —
 * na przykład eksportu z giełdy krypto. Użytkownik wskazuje, która kolumna
 * odpowiada której wartości, a reszta ścieżki importu jest wspólna.
 */

/** Pola, które kreator pozwala zmapować. */
export const MAPPABLE_FIELDS = [
  'date',
  'type',
  'symbol',
  'name',
  'currency',
  'quantity',
  'price',
  'amount',
  'fee',
  'tax',
  'fxRate',
  'note',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** Automatyczne podpowiedzi mapowania na podstawie nazw kolumn. */
const FIELD_HINTS: Record<MappableField, string[]> = {
  date: ['date', 'data', 'time', 'czas', 'trade date', 'data transakcji'],
  type: ['type', 'typ', 'rodzaj', 'side', 'operation', 'operacja', 'transaction type'],
  symbol: ['symbol', 'ticker', 'instrument', 'pair', 'asset', 'market'],
  name: ['name', 'nazwa', 'description', 'opis'],
  currency: ['currency', 'waluta', 'quote currency'],
  quantity: ['quantity', 'qty', 'liczba', 'ilosc', 'amount of', 'volume', 'wolumen', 'szt'],
  price: ['price', 'cena', 'rate', 'kurs jednostkowy'],
  amount: ['amount', 'kwota', 'total', 'wartosc', 'value', 'net'],
  fee: ['fee', 'commission', 'prowizja', 'oplata'],
  tax: ['tax', 'podatek', 'withholding'],
  fxRate: ['fx', 'kurs', 'exchange rate', 'kurs pln'],
  note: ['note', 'comment', 'komentarz', 'uwagi'],
};

const TYPE_HINTS: { match: string[]; type: TransactionType }[] = [
  { match: ['buy', 'zakup', 'kupno', 'purchase'], type: 'buy' },
  { match: ['sell', 'sprzedaz', 'sale'], type: 'sell' },
  { match: ['deposit', 'wplata', 'funding'], type: 'deposit' },
  { match: ['withdraw', 'wyplata'], type: 'withdrawal' },
  { match: ['dividend', 'dywidenda'], type: 'dividend' },
  { match: ['interest', 'odsetki', 'staking', 'reward'], type: 'interest' },
  { match: ['tax', 'podatek'], type: 'tax' },
  { match: ['fee', 'commission', 'prowizja'], type: 'fee' },
];

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .trim();
}

/**
 * Parser CSV zgodny z RFC 4180: obsługuje cudzysłowy, przecinki i nowe linie
 * wewnątrz pól oraz podwojone cudzysłowy jako znak ucieczki.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const content = text.replace(/^﻿/, '');

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Zgaduje separator po liczbie wystąpień w pierwszej linii. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Proponuje mapowanie kolumn na podstawie nagłówków. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const field of MAPPABLE_FIELDS) {
    const hints = FIELD_HINTS[field];
    const match = headers.find((h) => {
      const folded = fold(h);
      return hints.some((hint) => folded === hint || folded.includes(hint));
    });
    mapping[field] = match ?? null;
  }
  return mapping;
}

function mapType(raw: string): TransactionType | null {
  const folded = fold(raw);
  for (const entry of TYPE_HINTS) {
    if (entry.match.some((m) => folded.includes(m))) return entry.type;
  }
  return null;
}

export const csvParser: ImportParser = {
  id: 'generic-csv',
  name: 'Plik CSV — kreator mapowania',
  description:
    'Dowolny plik CSV. Po wczytaniu wskazujesz, które kolumny odpowiadają dacie, rodzajowi ' +
    'operacji, tickerowi i kwotom. Użyj tego dla źródeł bez dedykowanego parsera.',
  extensions: ['.csv', '.txt', '.tsv'],
  requiresMapping: true,

  async detect(meta: ParserFileMeta): Promise<number> {
    const name = meta.filename.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.tsv')) return 0.4;
    if (name.endsWith('.txt') && meta.head.includes(',')) return 0.2;
    return 0;
  },

  async parse(buffer: Buffer, mapping?: ColumnMapping): Promise<ParseResult> {
    const table = parseCsv(buffer.toString('utf8'));
    if (table.length === 0) {
      return { rows: [], detectedColumns: [], notes: ['Plik jest pusty.'] };
    }

    const headers = (table[0] ?? []).map((h) => h.trim());
    const effective = mapping ?? suggestMapping(headers);
    const notes: string[] = [];

    const indexOf = (field: MappableField): number => {
      const column = effective[field];
      return column ? headers.findIndex((h) => h.trim() === column.trim()) : -1;
    };

    const idx = Object.fromEntries(MAPPABLE_FIELDS.map((f) => [f, indexOf(f)])) as Record<MappableField, number>;

    if (idx.date === -1 || idx.type === -1) {
      return {
        rows: headers.length > 0 ? [] : [],
        detectedColumns: headers,
        notes: ['Wskaż przynajmniej kolumny z datą i rodzajem operacji.'],
      };
    }

    const rows: ParsedRow[] = [];
    let skipped = 0;

    for (let r = 1; r < table.length; r += 1) {
      const cells = table[r] ?? [];
      const get = (field: MappableField): string => (idx[field] === -1 ? '' : (cells[idx[field]] ?? '').trim());

      const tradeDate = normalizeDate(get('date'));
      const type = mapType(get('type'));
      if (!tradeDate || !type) {
        skipped += 1;
        continue;
      }

      const symbol = get('symbol') || null;
      const currency = (get('currency') || 'PLN').toUpperCase();
      rows.push({
        rowId: `${r}`,
        tradeDate,
        type,
        rawSymbol: symbol,
        instrumentName: get('name') || null,
        // Format generyczny nie ma ustalonej kolumny konta.
        account: null,
        assetClass: guessAssetClass(symbol, currency),
        currency,
        currencyInferred: get('currency') === '',
        quantity: get('quantity') || '0',
        price: get('price') || '0',
        grossAmount: get('amount') || null,
        fee: get('fee') || '0',
        tax: get('tax') || '0',
        fxRate: get('fxRate') || null,
        note: get('note') || null,
        issues: [],
      });
    }

    if (skipped > 0) notes.push(`Pominięto ${skipped} wierszy bez rozpoznanej daty lub rodzaju operacji.`);

    return { rows, detectedColumns: headers, notes };
  },
};

/**
 * Klasa aktywów dla CSV nie wynika z pliku. Zgadujemy tylko krypto po
 * popularnych tickerach — resztę użytkownik ustawia na instrumencie.
 */
const CRYPTO_TICKERS = new Set(['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'XRP', 'DOGE', 'LTC', 'AVAX', 'MATIC']);

function guessAssetClass(symbol: string | null, currency = ''): AssetClass {
  if (!symbol) return 'cash';
  const base = symbol.split(/[/:-]/)[0]?.toUpperCase() ?? '';
  if (CRYPTO_TICKERS.has(base)) return 'crypto';
  return equityClassFor('stock', { symbol, exchange: null, currency });
}
