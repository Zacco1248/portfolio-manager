import { eq } from 'drizzle-orm';
import type { AssetClass } from '@portfolio/shared';
import { db } from '../db/index.js';
import { instruments } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { toYahooSymbol } from '../providers/yahoo.js';
import { toProviderInstrument } from './prices.js';

const log = createLogger('classify');

/**
 * Uzupełnianie metadanych instrumentu: klasa aktywów, sektor i kraj.
 *
 * Importy tego nie dostarczają — wyciąg XTB nie rozróżnia akcji od ETF-a,
 * a arkusz Inwestomatu ma tylko szeroką kategorię. Bez tych danych rozjeżdża
 * się kilka rzeczy naraz: alokacja sektorowa świeci pustką, wykrywanie
 * nakładania się ETF-ów nie ma czego szukać, a rebalans nie potrafi rozdzielić
 * akcji polskich od zagranicznych.
 *
 * Oba źródła są dostępne bez uwierzytelniania: typ instrumentu podaje endpoint
 * wykresów, a sektor wyszukiwarka.
 */

interface ChartMetaResponse {
  chart: {
    result: { meta: { instrumentType?: string; currency?: string | null; longName?: string; shortName?: string } }[] | null;
  };
}

interface SearchResponse {
  quotes?: { symbol?: string; quoteType?: string; sector?: string; industry?: string; longname?: string }[];
}

/** Typ instrumentu u dostawcy → nasza klasa aktywów. */
function assetClassFrom(instrumentType: string | undefined): AssetClass | null {
  switch (instrumentType?.toUpperCase()) {
    case 'ETF':
    case 'MUTUALFUND':
      return 'etf';
    case 'EQUITY':
      return 'stock';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    case 'FUTURE':
    case 'COMMODITY':
      return 'metal';
    default:
      return null;
  }
}

/**
 * Nazwy sektorów po polsku. Alokacja sektorowa jest elementem interfejsu,
 * więc angielskie etykiety obok polskich psułyby spójność.
 */
const SECTOR_LABELS: Record<string, string> = {
  'basic materials': 'Surowce',
  'communication services': 'Usługi komunikacyjne',
  'consumer cyclical': 'Dobra cykliczne',
  'consumer defensive': 'Dobra podstawowe',
  energy: 'Energetyka',
  'financial services': 'Finanse',
  financial: 'Finanse',
  healthcare: 'Ochrona zdrowia',
  industrials: 'Przemysł',
  'real estate': 'Nieruchomości',
  technology: 'Technologia',
  utilities: 'Usługi komunalne',
};

export function translateSector(sector: string | undefined | null): string | null {
  if (!sector) return null;
  return SECTOR_LABELS[sector.toLowerCase().trim()] ?? sector;
}

/**
 * Fundusze nie mają jednego sektora — ich ekspozycja rozkłada się na wiele.
 * Zamiast wpisywać mylącą wartość, oznaczamy je osobną kategorią, żeby
 * w alokacji sektorowej było widać, jaka część portfela w ogóle nie da się
 * przypisać do pojedynczej branży.
 */
const FUND_SECTOR = 'Fundusze (wiele sektorów)';

export interface Classification {
  assetClass: AssetClass | null;
  sector: string | null;
  name: string | null;
}

export async function classifyInstrument(instrument: InstrumentRow): Promise<Classification> {
  const symbol = toYahooSymbol(toProviderInstrument(instrument));
  if (!symbol) return { assetClass: null, sector: null, name: null };

  const headers = { Accept: 'application/json' };
  let assetClass: AssetClass | null = null;
  let name: string | null = null;

  try {
    const chart = await fetchJson<ChartMetaResponse>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
      { headers, retries: 1, minIntervalMs: 400 },
    );
    const meta = chart.chart.result?.[0]?.meta;
    // Rekord bez waluty to atrapa dla nieznanego tickera — nie klasyfikujemy z niej.
    if (meta && meta.currency) {
      assetClass = assetClassFrom(meta.instrumentType);
      name = meta.longName ?? meta.shortName ?? null;
    }
  } catch (err) {
    log.debug(`Typ instrumentu ${symbol} nieosiągalny: ${errorMessage(err)}`);
  }

  let sector: string | null = null;
  try {
    const search = await fetchJson<SearchResponse>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=5&newsCount=0`,
      { headers, retries: 1, minIntervalMs: 400 },
    );
    const match = search.quotes?.find((q) => q.symbol?.toUpperCase() === symbol.toUpperCase());
    if (match) {
      assetClass ??= assetClassFrom(match.quoteType);
      sector = translateSector(match.sector);
      name ??= match.longname ?? null;
    }
  } catch (err) {
    log.debug(`Sektor ${symbol} nieosiągalny: ${errorMessage(err)}`);
  }

  if (sector === null && (assetClass ?? instrument.assetClass) === 'etf') sector = FUND_SECTOR;

  return { assetClass, sector, name };
}

export interface ClassifyResult {
  checked: number;
  updated: number;
  changes: { symbol: string; from: string; to: string }[];
}

/**
 * Uzupełnia metadane brakujących instrumentów.
 *
 * Nie nadpisuje wartości ustawionych ręcznie: klasę aktywów zmieniamy tylko
 * wtedy, gdy dostawca ma pewną odpowiedź, a sektor wyłącznie gdy jest pusty.
 */
export async function classifyAll(options: { force?: boolean } = {}): Promise<ClassifyResult> {
  const rows = db
    .select()
    .from(instruments)
    .all()
    .filter((row) => row.assetClass !== 'cash' && row.assetClass !== 'bond');

  const result: ClassifyResult = { checked: 0, updated: 0, changes: [] };

  for (const row of rows) {
    const needsSector = !row.sector;
    const needsClass = row.assetClass === 'stock' || options.force === true;
    if (!needsSector && !needsClass) continue;

    result.checked += 1;
    const classification = await classifyInstrument(row);

    const patch: Partial<InstrumentRow> = {};

    if (classification.assetClass && classification.assetClass !== row.assetClass) {
      patch.assetClass = classification.assetClass;
      result.changes.push({
        symbol: row.symbol,
        from: row.assetClass,
        to: classification.assetClass,
      });
    }

    if (needsSector && classification.sector) patch.sector = classification.sector;

    // Importy XTB nie mają nazw instrumentów — uzupełniamy z dostawcy.
    if (classification.name && (row.name === row.symbol.split(':').pop() || row.name === row.symbol)) {
      patch.name = classification.name;
    }

    if (Object.keys(patch).length > 0) {
      db.update(instruments).set(patch).where(eq(instruments.id, row.id)).run();
      result.updated += 1;
    }
  }

  log.info(`Klasyfikacja: sprawdzono ${result.checked}, zaktualizowano ${result.updated}`);
  return result;
}
