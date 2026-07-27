import type { AssetClass, TransactionType } from '@portfolio/shared';
import type { IsoDate } from '../lib/dates.js';

/**
 * Jeden wiersz odczytany ze źródła, jeszcze przed zamianą na transakcję.
 * Liczby zostają stringami — skalowaniem zajmuje się warstwa transakcji,
 * żeby parser nie musiał znać reprezentacji pieniędzy.
 */
export interface ParsedRow {
  /** Stabilny identyfikator w obrębie pliku — służy do zaznaczania w podglądzie. */
  rowId: string;
  tradeDate: IsoDate;
  type: TransactionType;
  rawSymbol: string | null;
  instrumentName: string | null;
  assetClass: AssetClass;
  currency: string;
  /** Czy waluta została wywnioskowana, a nie odczytana wprost ze źródła. */
  currencyInferred: boolean;
  quantity: string;
  price: string;
  grossAmount: string | null;
  fee: string;
  tax: string;
  /** Kurs zastosowany przez brokera, jeśli da się go odtworzyć. */
  fxRate: string | null;
  note: string | null;
  /** Ostrzeżenia parsera dotyczące tego wiersza. */
  issues: string[];
}

export interface ParsedSnapshot {
  date: IsoDate;
  valuePlnMinor: number;
  byAssetClass?: Record<string, number>;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Kolumny wykryte w pliku — potrzebne kreatorowi mapowania. */
  detectedColumns: string[];
  /** Historia wartości portfela, jeśli źródło ją zawiera (arkusz Inwestomatu). */
  snapshots?: ParsedSnapshot[];
  /** Komunikaty dotyczące całego pliku, nie pojedynczych wierszy. */
  notes: string[];
}

export interface ColumnMapping {
  [targetField: string]: string | null;
}

export interface ParserFileMeta {
  filename: string;
  /** Pierwsze kilkaset bajtów — wystarczy do rozpoznania formatu. */
  head: string;
  size: number;
}

/**
 * Kontrakt parsera importu.
 *
 * Dodanie kolejnego źródła (np. CSV z giełdy krypto) polega na napisaniu
 * nowej implementacji i dopisaniu jej do rejestru. Żaden istniejący parser
 * ani warstwa importu nie wymaga wtedy zmian.
 */
export interface ImportParser {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly extensions: string[];
  /** Czy parser potrzebuje od użytkownika mapowania kolumn. */
  readonly requiresMapping: boolean;
  /** Pewność rozpoznania formatu w skali 0-1. Rejestr wybiera najwyższą. */
  detect(meta: ParserFileMeta, buffer: Buffer): Promise<number>;
  parse(buffer: Buffer, mapping?: ColumnMapping): Promise<ParseResult>;
}

/** Nazwa źródła używana przy zapisie aliasów symboli. */
export const parserAliasSource = (parserId: string): string => parserId.split('-')[0] ?? parserId;
