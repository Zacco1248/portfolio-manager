import ExcelJS from 'exceljs';
import type { AssetClass, TransactionType } from '@portfolio/shared';
import { toMinor } from '@portfolio/shared';
import { normalizeDate } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import type {
  ColumnMapping,
  ImportParser,
  ParseResult,
  ParsedRow,
  ParsedSnapshot,
  ParserFileMeta,
} from './types.js';

const log = createLogger('parser:inwestomat');

/**
 * Parser arkusza Inwestomatu (inwestomat.eu).
 *
 * Struktura arkusza bywa modyfikowana przez użytkowników, dlatego kolumny
 * rozpoznajemy po nagłówkach, a nie po pozycji. Gdy któraś z wymaganych
 * kolumn się nie znajdzie, parser zgłasza to jako potrzebę ręcznego mapowania
 * zamiast zgadywać.
 */

const TRANSACTIONS_SHEET = ['transakcje', 'transactions'];
const HISTORY_SHEET = ['historia', 'history'];

/** Nagłówek w arkuszu → pole wewnętrzne. Dopasowanie bez znaków diakrytycznych. */
const COLUMN_ALIASES: Record<string, string[]> = {
  account: ['konto', 'portfel', 'rachunek'],
  date: ['data', 'data transakcji'],
  symbol: ['ticker', 'symbol'],
  currency: ['waluta'],
  name: ['nazwa', 'instrument'],
  assetClass: ['klasa aktywow', 'klasa aktywu', 'typ aktywa'],
  type: ['rodzaj transakcji', 'typ transakcji', 'operacja'],
  quantity: ['liczba', 'ilosc', 'sztuki'],
  price: ['cena'],
  fee: ['prowizje', 'prowizja', 'oplata'],
  fxRate: ['kurs pln transakcji', 'kurs waluty', 'kurs'],
  totalPln: ['total pln', 'wartosc pln', 'razem pln'],
  note: ['komentarz', 'uwagi'],
};

const TYPE_ALIASES: { match: string[]; type: TransactionType }[] = [
  { match: ['zakup', 'kupno', 'buy'], type: 'buy' },
  { match: ['sprzedaz', 'sell'], type: 'sell' },
  { match: ['wplata srodkow', 'wplata', 'deposit'], type: 'deposit' },
  { match: ['wyplata srodkow', 'wyplata', 'withdrawal'], type: 'withdrawal' },
  { match: ['dywidenda'], type: 'dividend' },
  { match: ['odsetki', 'interest'], type: 'interest' },
  { match: ['podatek', 'tax'], type: 'tax' },
  { match: ['prowizja', 'oplata', 'fee'], type: 'fee' },
  { match: ['split'], type: 'split' },
];

const ASSET_CLASS_ALIASES: { match: string[]; assetClass: AssetClass }[] = [
  { match: ['akcje'], assetClass: 'stock' },
  { match: ['etf'], assetClass: 'etf' },
  { match: ['obligacje'], assetClass: 'bond' },
  { match: ['metale', 'surowce'], assetClass: 'metal' },
  { match: ['krypto'], assetClass: 'crypto' },
  { match: ['gotowka', 'waluty'], assetClass: 'cash' },
];

/** Usuwa polskie znaki i normalizuje do porównań nagłówków. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Komórki z formułami mają postać { formula, result }, a bogaty tekst
    // rozbity jest na fragmenty.
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join('');
    }
    return '';
  }
  return String(value);
}

function mapType(raw: string): TransactionType | null {
  const folded = fold(raw);
  // "Dywidenda / Odsetki" to jedna pozycja w arkuszu — traktujemy jako dywidendę,
  // bo rozliczenie podatkowe obu jest w PIT-38 takie samo.
  for (const entry of TYPE_ALIASES) {
    if (entry.match.some((m) => folded.includes(m))) return entry.type;
  }
  return null;
}

function mapAssetClass(raw: string): AssetClass {
  const folded = fold(raw);
  for (const entry of ASSET_CLASS_ALIASES) {
    if (entry.match.some((m) => folded.includes(m))) return entry.assetClass;
  }
  return 'stock';
}

function findSheet(workbook: ExcelJS.Workbook, names: string[]): ExcelJS.Worksheet | null {
  for (const sheet of workbook.worksheets) {
    if (names.some((n) => fold(sheet.name) === n || fold(sheet.name).startsWith(n))) return sheet;
  }
  return null;
}

interface HeaderInfo {
  rowNumber: number;
  columns: Map<string, number>;
  rawHeaders: string[];
}

function locateHeader(sheet: ExcelJS.Worksheet, mapping?: ColumnMapping): HeaderInfo | null {
  const maxScan = Math.min(sheet.rowCount, 20);

  for (let r = 1; r <= maxScan; r += 1) {
    const row = sheet.getRow(r);
    const rawHeaders: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      rawHeaders[col - 1] = cellText(cell.value).trim();
    });

    const columns = new Map<string, number>();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      // Mapowanie od użytkownika ma pierwszeństwo nad automatycznym.
      const override = mapping?.[field];
      const index = rawHeaders.findIndex((h) =>
        override ? fold(h) === fold(override) : aliases.includes(fold(h)),
      );
      if (index !== -1) columns.set(field, index + 1);
    }

    // Nagłówek uznajemy za znaleziony, gdy mamy komplet pól bez których
    // wiersza nie da się zinterpretować.
    if (columns.has('date') && columns.has('type') && columns.has('symbol')) {
      return { rowNumber: r, columns, rawHeaders: rawHeaders.filter(Boolean) };
    }
  }

  return null;
}

function readSnapshots(sheet: ExcelJS.Worksheet): ParsedSnapshot[] {
  const header = sheet.getRow(1);
  const labels: string[] = [];
  header.eachCell({ includeEmpty: true }, (cell, col) => {
    labels[col - 1] = fold(cellText(cell.value));
  });

  const dateCol = labels.findIndex((l) => l === 'data');
  if (dateCol === -1) return [];

  const snapshots: ParsedSnapshot[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const date = normalizeDate(cellText(row.getCell(dateCol + 1).value));
    if (!date) continue;

    let total = 0;
    const byAssetClass: Record<string, number> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (col === dateCol + 1) return;
      const label = labels[col - 1];
      if (!label) return;
      const raw = cellText(cell.value);
      if (!raw) return;
      const minor = toMinor(raw, 'PLN');
      if (minor === 0) return;
      total += minor;
      const assetClass = mapAssetClass(label);
      byAssetClass[assetClass] = (byAssetClass[assetClass] ?? 0) + minor;
    });

    if (total !== 0) snapshots.push({ date, valuePlnMinor: total, byAssetClass });
  }

  return snapshots;
}

export const inwestomatParser: ImportParser = {
  id: 'inwestomat-xlsx',
  name: 'Inwestomat — arkusz monitorowania inwestycji',
  description:
    'Arkusz xlsx z inwestomat.eu. Czytany jest arkusz "Transakcje", a z arkusza "Historia" ' +
    'pobierana jest historyczna wartość portfela, żeby wykres nie zaczynał się od dnia instalacji.',
  extensions: ['.xlsx', '.xlsm'],
  requiresMapping: false,

  async detect(meta: ParserFileMeta, buffer: Buffer): Promise<number> {
    if (!meta.filename.toLowerCase().endsWith('.xlsx') && !meta.filename.toLowerCase().endsWith('.xlsm')) {
      return 0;
    }
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const names = workbook.worksheets.map((w) => fold(w.name));
      const hasTransactions = names.some((n) => TRANSACTIONS_SHEET.includes(n));
      const hasSignature = names.some((n) => ['portfolio', 'multi-asset', 'dashboard'].includes(n));
      if (hasTransactions && hasSignature) return 0.95;
      if (hasTransactions) return 0.6;
      return 0.15;
    } catch {
      return 0;
    }
  },

  async parse(buffer: Buffer, mapping?: ColumnMapping): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const notes: string[] = [];

    const sheet = findSheet(workbook, TRANSACTIONS_SHEET);
    if (!sheet) {
      return {
        rows: [],
        detectedColumns: workbook.worksheets.map((w) => w.name),
        notes: ['Nie znalazłem arkusza "Transakcje". Wskaż kolumny ręcznie albo sprawdź plik.'],
      };
    }

    const header = locateHeader(sheet, mapping);
    if (!header) {
      const firstRow: string[] = [];
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        firstRow[col - 1] = cellText(cell.value).trim();
      });
      return {
        rows: [],
        detectedColumns: firstRow.filter(Boolean),
        notes: [
          'Nie rozpoznałem nagłówków arkusza. Użyj kreatora mapowania kolumn, ' +
            'żeby wskazać datę, rodzaj transakcji i ticker.',
        ],
      };
    }

    const col = (field: string): number | undefined => header.columns.get(field);
    const rows: ParsedRow[] = [];
    let skipped = 0;

    for (let r = header.rowNumber + 1; r <= sheet.rowCount; r += 1) {
      const excelRow = sheet.getRow(r);
      const read = (field: string): string => {
        const index = col(field);
        return index === undefined ? '' : cellText(excelRow.getCell(index).value).trim();
      };

      const rawDate = read('date');
      const rawType = read('type');
      if (!rawDate && !rawType) continue;

      const tradeDate = normalizeDate(rawDate);
      const type = mapType(rawType);
      const issues: string[] = [];

      if (!tradeDate || !type) {
        skipped += 1;
        continue;
      }

      const rawSymbol = read('symbol');
      const assetClass = mapAssetClass(read('assetClass'));
      const isCash = assetClass === 'cash' || fold(rawSymbol) === 'gotowka';
      const currency = (read('currency') || 'PLN').toUpperCase();

      // Wpłaty i wypłaty arkusz zapisuje z ilością 1 i ceną 1, a właściwa kwota
      // siedzi w kolumnie Total PLN.
      const isCashFlow = type === 'deposit' || type === 'withdrawal';
      const totalPln = read('totalPln');

      rows.push({
        rowId: `${r}`,
        tradeDate,
        type,
        rawSymbol: isCash ? null : rawSymbol || null,
        instrumentName: read('name') || null,
        assetClass,
        currency: isCashFlow ? 'PLN' : currency,
        currencyInferred: false,
        quantity: isCashFlow ? '0' : read('quantity') || '0',
        price: isCashFlow ? '0' : read('price') || '0',
        grossAmount: isCashFlow || type === 'dividend' || type === 'interest' ? totalPln || null : null,
        fee: read('fee') || '0',
        tax: '0',
        fxRate: isCashFlow ? null : read('fxRate') || null,
        note: read('note') || null,
        issues,
      });
    }

    if (skipped > 0) {
      notes.push(`Pominięto ${skipped} wierszy bez rozpoznanej daty lub rodzaju transakcji.`);
    }

    const historySheet = findSheet(workbook, HISTORY_SHEET);
    const snapshots = historySheet ? readSnapshots(historySheet) : [];
    if (snapshots.length > 0) {
      notes.push(
        `Znaleziono ${snapshots.length} dziennych wycen portfela w arkuszu "Historia" — ` +
          `zostaną użyte jako historia wykresu sprzed uruchomienia aplikacji.`,
      );
    }

    log.info(`Odczytano ${rows.length} transakcji z arkusza Inwestomatu`);
    return { rows, detectedColumns: header.rawHeaders, snapshots, notes };
  },
};
