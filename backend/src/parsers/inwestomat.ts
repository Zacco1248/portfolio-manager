import { cellText, readXlsx } from '../lib/xlsx.js';
import type { CellValue, XlsxSheet } from '../lib/xlsx.js';
import type { AssetClass, TransactionType } from '@portfolio/shared';
import { equityClassFor, toMinor } from '@portfolio/shared';
import { normalizeDate } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import type {
  ColumnMapping,
  ImportParser,
  ParseResult,
  ParsedBond,
  ParsedCpi,
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
const BONDS_SHEET = ['obligacje', 'bonds'];
const CPI_SHEET = ['inflacja', 'cpi'];

/** Nagłówek w arkuszu → pole wewnętrzne. Dopasowanie bez znaków diakrytycznych. */
const COLUMN_ALIASES: Record<string, string[]> = {
  account: ['konto', 'rachunek'],
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

/**
 * Etykieta z arkusza → klasa aktywów.
 *
 * Kolejność jest logiką, nie kosmetyką: dopasowanie idzie po zawieraniu
 * podciągu i wygrywa pierwsze trafienie. „Obligacje skarbowe polskie" musi
 * więc trafić przed czymkolwiek reagującym na słowo „polskie", a „Akcje
 * polskie" przed ogólnym „akcje".
 *
 * Wpisy `group` nie rozstrzygają osi krajowej — domyka ją `mapAssetClass`
 * na podstawie symbolu i waluty wiersza.
 */
const ASSET_CLASS_ALIASES: { match: string[]; assetClass?: AssetClass; group?: 'stock' | 'etf' }[] = [
  { match: ['obligacje'], assetClass: 'bond' },
  { match: ['metale', 'surowce'], assetClass: 'metal' },
  { match: ['krypto'], assetClass: 'crypto' },
  { match: ['gotowka', 'waluty'], assetClass: 'cash' },
  { match: ['etf polskie', 'etf polski', 'etf krajowe'], assetClass: 'etf_pl' },
  { match: ['etf zagraniczne', 'etf zagraniczny'], assetClass: 'etf_foreign' },
  { match: ['akcje polskie', 'akcje krajowe'], assetClass: 'stock_pl' },
  { match: ['akcje zagraniczne'], assetClass: 'stock_foreign' },
  { match: ['etf'], group: 'etf' },
  { match: ['akcje'], group: 'stock' },
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

function mapType(raw: string): TransactionType | null {
  const folded = fold(raw);
  // "Dywidenda / Odsetki" to jedna pozycja w arkuszu — traktujemy jako dywidendę,
  // bo rozliczenie podatkowe obu jest w PIT-38 takie samo.
  for (const entry of TYPE_ALIASES) {
    if (entry.match.some((m) => folded.includes(m))) return entry.type;
  }
  return null;
}

function mapAssetClass(raw: string, instrument?: { symbol: string; currency: string }): AssetClass {
  const folded = fold(raw);
  const context = { symbol: instrument?.symbol ?? '', exchange: null, currency: instrument?.currency ?? '' };

  for (const entry of ASSET_CLASS_ALIASES) {
    if (!entry.match.some((m) => folded.includes(m))) continue;
    return entry.assetClass ?? equityClassFor(entry.group!, context);
  }

  // Nierozpoznana etykieta to najczęściej pojedyncza spółka — oś krajową
  // rozstrzygamy z symbolu i waluty, a nie zgadujemy.
  return equityClassFor('stock', context);
}

function findSheet(sheets: XlsxSheet[], names: string[]): XlsxSheet | null {
  for (const sheet of sheets) {
    if (names.some((n) => fold(sheet.name) === n || fold(sheet.name).startsWith(n))) return sheet;
  }
  return null;
}

/** Wartość komórki z wiersza, tolerująca wiersze krótsze niż nagłówek. */
function cellAt(row: CellValue[] | undefined, index: number | undefined): CellValue {
  if (!row || index === undefined || index < 0) return null;
  return row[index] ?? null;
}

interface HeaderInfo {
  /** Indeks wiersza nagłówka, liczony od zera. */
  rowIndex: number;
  /** Pole wewnętrzne → indeks kolumny, liczony od zera. */
  columns: Map<string, number>;
  rawHeaders: string[];
}

function locateHeader(sheet: XlsxSheet, mapping?: ColumnMapping): HeaderInfo | null {
  const maxScan = Math.min(sheet.rows.length, 20);

  for (let r = 0; r < maxScan; r += 1) {
    const rawHeaders = (sheet.rows[r] ?? []).map((cell) => cellText(cell).trim());

    const columns = new Map<string, number>();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      // Mapowanie od użytkownika ma pierwszeństwo nad automatycznym.
      const override = mapping?.[field];
      const index = rawHeaders.findIndex((h) =>
        override ? fold(h) === fold(override) : aliases.includes(fold(h)),
      );
      if (index !== -1) columns.set(field, index);
    }

    // Nagłówek uznajemy za znaleziony, gdy mamy komplet pól bez których
    // wiersza nie da się zinterpretować.
    if (columns.has('date') && columns.has('type') && columns.has('symbol')) {
      return { rowIndex: r, columns, rawHeaders: rawHeaders.filter(Boolean) };
    }
  }

  return null;
}

/**
 * Kolumny arkusza „Historia", które są *podsumowaniem*, a nie składnikiem
 * portfela. Zsumowanie ich razem z klasami aktywów zawyżało wartość portfela
 * około trzykrotnie: wartość konta liczyła się drugi raz, a do tego dochodziły
 * wpłaty netto i zysk.
 */
const HISTORY_TOTAL_COLUMNS = ['wartosc konta', 'wartosc portfela', 'razem', 'suma'];
const HISTORY_IGNORED_COLUMNS = [
  'wplaty netto',
  'wplaty',
  'xirr',
  'zysk / strata',
  'zysk/strata',
  'zysk',
  'strata',
  'drawdown portfela',
  'drawdown',
  'stopa zwrotu',
];

function readSnapshots(sheet: XlsxSheet): ParsedSnapshot[] {
  const labels = (sheet.rows[0] ?? []).map((cell) => fold(cellText(cell)));
  const dateCol = labels.findIndex((l) => l === 'data');
  if (dateCol === -1) return [];

  const totalCol = labels.findIndex((l) => HISTORY_TOTAL_COLUMNS.includes(l));
  const depositsCol = labels.findIndex((l) => l === 'wplaty netto' || l === 'wplaty');

  const snapshots: ParsedSnapshot[] = [];

  for (let r = 1; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] ?? [];
    const date = normalizeDate(cellAt(row, dateCol));
    if (!date) continue;

    let sumOfClasses = 0;
    const byAssetClass: Record<string, number> = {};

    row.forEach((cell, col) => {
      if (col === dateCol || col === totalCol || col === depositsCol) return;

      const label = labels[col];
      if (!label || HISTORY_IGNORED_COLUMNS.includes(label)) return;

      const raw = cellText(cell);
      if (!raw) return;

      const minor = toMinor(raw, 'PLN');
      if (minor === 0) return;

      sumOfClasses += minor;
      const assetClass = mapAssetClass(label);
      byAssetClass[assetClass] = (byAssetClass[assetClass] ?? 0) + minor;
    });

    // Kolumna sumy jest wiarygodniejsza niż nasze zsumowanie klas — arkusz
    // może mieć kolumny, których nie rozpoznajemy.
    const total = totalCol === -1 ? sumOfClasses : toMinor(cellText(cellAt(row, totalCol)), 'PLN');
    if (total === 0) continue;

    snapshots.push({
      date,
      valuePlnMinor: total,
      investedPlnMinor: depositsCol === -1 ? null : toMinor(cellText(cellAt(row, depositsCol)), 'PLN'),
      byAssetClass,
    });
  }

  return snapshots;
}

/**
 * Arkusz „Obligacje" trzyma warunki emisji per zakup. Stawki są zapisane jako
 * ułamki (0,0655 zamiast 6,55%), więc przeliczamy je na procenty.
 */
function readBonds(sheet: XlsxSheet): ParsedBond[] {
  const headerRow = sheet.rows.findIndex((row) =>
    row.some((cell) => fold(cellText(cell)).startsWith('typ obligacji')),
  );
  if (headerRow === -1) return [];

  const labels = (sheet.rows[headerRow] ?? []).map((cell) => fold(cellText(cell)));
  const col = (...names: string[]): number => labels.findIndex((l) => names.some((n) => l.startsWith(n)));

  const kindCol = col('typ obligacji');
  const dateCol = col('data zakupu');
  const rateCol = col('% w 1 roku');
  const marginCol = col('marza w latach', 'marza');
  const countCol = col('liczba obligacji');

  if (kindCol === -1 || dateCol === -1 || rateCol === -1) return [];

  const out: ParsedBond[] = [];

  for (let r = headerRow + 1; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] ?? [];
    const kind = cellText(cellAt(row, kindCol)).trim().toUpperCase();
    const purchaseDate = normalizeDate(cellAt(row, dateCol));
    if (!kind || !purchaseDate) continue;

    const asPercent = (value: CellValue): number => {
      const raw = Number(cellText(value).replace(',', '.'));
      if (!Number.isFinite(raw)) return 0;
      // Arkusz zapisuje stawki jako ułamki; wartości powyżej 1 są już procentami.
      return raw <= 1 ? raw * 100 : raw;
    };

    out.push({
      kind,
      purchaseDate,
      firstYearRatePercent: asPercent(cellAt(row, rateCol)),
      marginPercent: marginCol === -1 ? 0 : asPercent(cellAt(row, marginCol)),
      count: countCol === -1 ? 1 : Math.max(Number(cellText(cellAt(row, countCol))) || 1, 1),
    });
  }

  return out;
}

/**
 * Arkusz „Inflacja" to zrzut z Banku Danych Lokalnych GUS. Interesuje nas
 * wyłącznie prezentacja „analogiczny miesiąc poprzedniego roku" — to ona jest
 * podstawą indeksacji obligacji EDO i COI. Wartość jest indeksem, w którym
 * 100 oznacza brak zmiany, więc inflacja to wartość pomniejszona o 100.
 */
function readCpi(sheet: XlsxSheet): ParsedCpi[] {
  const labels = (sheet.rows[0] ?? []).map((cell) => fold(cellText(cell)));
  const presentationCol = labels.findIndex((l) => l.startsWith('sposob prezentacji'));
  const yearCol = labels.findIndex((l) => l === 'rok');
  const monthCol = labels.findIndex((l) => l.startsWith('miesiac'));
  const valueCol = labels.findIndex((l) => l.startsWith('wartosc'));

  if (yearCol === -1 || monthCol === -1 || valueCol === -1) return [];

  const out: ParsedCpi[] = [];

  for (let r = 1; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] ?? [];

    if (presentationCol !== -1) {
      const presentation = fold(cellText(cellAt(row, presentationCol)));
      // Pomijamy wariant „grudzień poprzedniego roku" — to inna miara.
      if (!presentation.startsWith('analogiczny miesiac')) continue;
    }

    const year = Number(cellText(cellAt(row, yearCol)));
    const month = Number(cellText(cellAt(row, monthCol)));
    const index = Number(cellText(cellAt(row, valueCol)).replace(',', '.'));

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(index)) continue;
    if (month < 1 || month > 12 || index <= 0) continue;

    out.push({ year, month, cpiYoyPercent: Math.round((index - 100) * 100) / 100 });
  }

  return out;
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
      const names = readXlsx(buffer).map((sheet) => fold(sheet.name));
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
    const sheets = readXlsx(buffer);
    const notes: string[] = [];

    const sheet = findSheet(sheets, TRANSACTIONS_SHEET);
    if (!sheet) {
      return {
        rows: [],
        detectedColumns: sheets.map((w) => w.name),
        notes: ['Nie znalazłem arkusza "Transakcje". Wskaż kolumny ręcznie albo sprawdź plik.'],
      };
    }

    const header = locateHeader(sheet, mapping);
    if (!header) {
      const firstRow = (sheet.rows[0] ?? []).map((cell) => cellText(cell).trim());
      return {
        rows: [],
        detectedColumns: firstRow.filter(Boolean),
        notes: [
          'Nie rozpoznałem nagłówków arkusza. Użyj kreatora mapowania kolumn, ' +
            'żeby wskazać datę, rodzaj transakcji i ticker.',
        ],
      };
    }

    const rows: ParsedRow[] = [];
    let skipped = 0;

    for (let r = header.rowIndex + 1; r < sheet.rows.length; r += 1) {
      const sheetRow = sheet.rows[r];
      const read = (field: string): string =>
        cellText(cellAt(sheetRow, header.columns.get(field))).trim();
      // Daty Excel trzyma jako numery seryjne. Konwersja na tekst przed
      // normalizacją gubiłaby tę informację, więc datę czytamy surową.
      const readRaw = (field: string): CellValue => cellAt(sheetRow, header.columns.get(field));

      const rawDate = readRaw('date');
      const rawType = read('type');
      if (rawDate === null && !rawType) continue;

      const tradeDate = normalizeDate(rawDate);
      const type = mapType(rawType);
      const issues: string[] = [];

      if (!tradeDate || !type) {
        skipped += 1;
        continue;
      }

      const rawSymbol = read('symbol');
      const assetClass = mapAssetClass(read('assetClass'), { symbol: rawSymbol, currency: read('currency') || 'PLN' });
      const isCash = assetClass === 'cash' || fold(rawSymbol) === 'gotowka';
      const currency = (read('currency') || 'PLN').toUpperCase();

      // Wpłaty i wypłaty arkusz zapisuje z ilością 1 i ceną 1, a właściwa kwota
      // siedzi w kolumnie Total PLN.
      const isCashFlow = type === 'deposit' || type === 'withdrawal';
      const totalPln = read('totalPln');

      rows.push({
        rowId: `${r + 1}`,
        tradeDate,
        type,
        rawSymbol: isCash ? null : rawSymbol || null,
        instrumentName: read('name') || null,
        account: read('account') || null,
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

    const bondsSheet = findSheet(sheets, BONDS_SHEET);
    const bonds = bondsSheet ? readBonds(bondsSheet) : [];
    if (bonds.length > 0) {
      notes.push(
        `Odczytano warunki emisji ${bonds.length} zakupów obligacji — posłużą do naliczenia odsetek.`,
      );
    }

    const cpiSheet = findSheet(sheets, CPI_SHEET);
    const cpi = cpiSheet ? readCpi(cpiSheet) : [];
    if (cpi.length > 0) {
      notes.push(
        `Odczytano ${cpi.length} miesięcznych odczytów inflacji — posłużą do indeksacji obligacji EDO i COI.`,
      );
    }

    const historySheet = findSheet(sheets, HISTORY_SHEET);
    const snapshots = historySheet ? readSnapshots(historySheet) : [];
    if (snapshots.length > 0) {
      notes.push(
        `Znaleziono ${snapshots.length} dziennych wycen portfela w arkuszu "Historia" — ` +
          `zostaną użyte jako historia wykresu sprzed uruchomienia aplikacji.`,
      );
    }

    log.info(`Odczytano ${rows.length} transakcji z arkusza Inwestomatu`);
    return { rows, detectedColumns: header.rawHeaders, snapshots, bonds, cpi, notes };
  },
};
