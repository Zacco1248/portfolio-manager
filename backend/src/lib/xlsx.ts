import { unzipSync, strFromU8 } from 'fflate';

/**
 * Minimalny czytnik plików xlsx.
 *
 * Zastępuje ExcelJS, który ciągnął za sobą łańcuch przestarzałych zależności
 * (archiver, glob, rimraf, uuid) odpowiadający za większość zgłoszeń
 * bezpieczeństwa w tej aplikacji, a z którego korzystaliśmy wyłącznie do
 * odczytu wartości komórek.
 *
 * Zakres jest celowo wąski: xlsx to archiwum ZIP z XML-em, a my potrzebujemy
 * tylko nazw arkuszy i wartości komórek. Nie obsługujemy formatowania,
 * wykresów ani zapisu plików.
 *
 * Daty zwracamy jako surowe liczby (numer seryjny Excela) — warstwa parsera
 * i tak przepuszcza je przez `normalizeDate`, która ten format rozumie.
 * Dzięki temu nie musimy interpretować `styles.xml`.
 */

export type CellValue = string | number | null;

export interface XlsxSheet {
  name: string;
  /** Wiersze w kolejności z pliku; komórki puste są `null`. */
  rows: CellValue[][];
}

/** Zamienia adres komórki (`B12`) na indeks kolumny liczony od zera. */
export function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/** Rozwiązuje encje XML występujące w treści arkuszy. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Tablica tekstów współdzielonych. Excel trzyma powtarzalne napisy raz,
 * a w komórkach zapisuje indeksy do tej tablicy.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const itemRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const body = match[1]!;
    // Tekst bywa rozbity na fragmenty <r><t>…</t></r> przy mieszanym formatowaniu.
    const parts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!));
    out.push(parts.join(''));
  }

  return out;
}

interface SheetRef {
  name: string;
  relationId: string;
}

function parseWorkbook(xml: string): SheetRef[] {
  const out: SheetRef[] = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    const relationId = /r:id="([^"]*)"/.exec(attrs)?.[1];
    if (name && relationId) out.push({ name: decodeXml(name), relationId });
  }
  return out;
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const id = /Id="([^"]*)"/.exec(attrs)?.[1];
    const target = /Target="([^"]*)"/.exec(attrs)?.[1];
    if (id && target) map.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  return map;
}

/** Parsuje pojedynczy arkusz do tablicy wierszy. */
function parseSheet(xml: string, sharedStrings: string[]): CellValue[][] {
  const rows: CellValue[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: CellValue[] = [];

    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? '';

      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      const index = ref ? columnIndex(ref) : cells.length;

      // Komórki puste nie są zapisywane w pliku — uzupełniamy luki.
      while (cells.length < index) cells.push(null);

      cells[index] = readCell(type, body, sharedStrings);
    }

    rows.push(cells);
  }

  return rows;
}

function readCell(type: string, body: string, sharedStrings: string[]): CellValue {
  if (type === 'inlineStr') {
    const parts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!));
    return parts.length > 0 ? parts.join('') : null;
  }

  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return null;

  switch (type) {
    case 's': {
      // Indeks do tablicy tekstów współdzielonych.
      const index = Number(raw);
      return sharedStrings[index] ?? null;
    }
    case 'str':
      // Wynik formuły zwracającej tekst.
      return decodeXml(raw);
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      // Błąd formuły (#N/D, #DZIEL/0!) — dla nas to brak wartości.
      return null;
    default: {
      const value = Number(raw);
      return Number.isFinite(value) ? value : decodeXml(raw);
    }
  }
}

/**
 * Czyta cały skoroszyt. Zwraca arkusze w kolejności z pliku.
 *
 * Rzuca, gdy plik nie jest poprawnym xlsx — warstwa importu traktuje to
 * jako nierozpoznany format i proponuje inny parser.
 */
export function readXlsx(buffer: Buffer): XlsxSheet[] {
  const files = unzipSync(new Uint8Array(buffer));

  const workbookXml = files['xl/workbook.xml'];
  if (!workbookXml) throw new Error('To nie jest plik xlsx: brak xl/workbook.xml');

  const relsXml = files['xl/_rels/workbook.xml.rels'];
  const relations = relsXml ? parseRelationships(strFromU8(relsXml)) : new Map<string, string>();

  const sharedXml = files['xl/sharedStrings.xml'];
  const sharedStrings = sharedXml ? parseSharedStrings(strFromU8(sharedXml)) : [];

  const sheetRefs = parseWorkbook(strFromU8(workbookXml));
  const out: XlsxSheet[] = [];

  sheetRefs.forEach((ref, position) => {
    const target = relations.get(ref.relationId);
    // Gdy relacje są niekompletne, wracamy do konwencji nazewniczej Excela.
    const path = target ? `xl/${target}` : `xl/worksheets/sheet${position + 1}.xml`;
    const data = files[path] ?? files[path.replace('xl/', '')];
    if (!data) return;

    out.push({ name: ref.name, rows: parseSheet(strFromU8(data), sharedStrings) });
  });

  return out;
}

/** Wartość komórki jako tekst — wygodne przy porównywaniu nagłówków. */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
