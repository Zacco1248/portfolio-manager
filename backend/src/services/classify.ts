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

/**
 * Giełda → kraj notowania.
 *
 * Rynek nie zawsze pokrywa się z ekspozycją — ETF na S&P 500 notowany w Londynie
 * jest tu „Wielka Brytania" tylko do momentu, aż użytkownik poprawi wpis ręcznie
 * albo dołoży skład funduszu. Dla akcji pojedynczych spółek trafność jest wysoka,
 * a bez tego mapowania 100% portfela byłoby „nieprzypisane".
 */
const EXCHANGE_COUNTRIES: Record<string, string> = {
  WSE: 'Polska',
  GPW: 'Polska',
  WAR: 'Polska',
  WA: 'Polska',
  NYSE: 'USA',
  NASDAQ: 'USA',
  NYSEARCA: 'USA',
  AMEX: 'USA',
  BATS: 'USA',
  US: 'USA',
  LON: 'Wielka Brytania',
  LSE: 'Wielka Brytania',
  L: 'Wielka Brytania',
  XETR: 'Niemcy',
  ETR: 'Niemcy',
  GER: 'Niemcy',
  DE: 'Niemcy',
  FRA: 'Niemcy',
  AMS: 'Holandia',
  AS: 'Holandia',
  EPA: 'Francja',
  PA: 'Francja',
  MIL: 'Włochy',
  MI: 'Włochy',
  SWX: 'Szwajcaria',
  TYO: 'Japonia',
  T: 'Japonia',
};

/** Klasy aktywów, dla których sektor i kraj wynikają z samej klasy. */
const CLASS_DEFAULTS: Partial<Record<AssetClass, { sector: string; country?: string }>> = {
  bond: { sector: 'Obligacje skarbowe', country: 'Polska' },
  metal: { sector: 'Metale szlachetne', country: 'Świat' },
  crypto: { sector: 'Kryptowaluty', country: 'Świat' },
};

/**
 * Klasyfikacja wyprowadzona z danych, które już mamy w bazie.
 *
 * Odpytywanie dostawcy nie pokrywa wszystkiego: obligacje detaliczne i metale
 * nie mają tam wpisów, a kraju nie zwraca żaden z używanych endpointów. Bez tej
 * warstwy wykresy struktury pokazują niemal wyłącznie „nieprzypisane".
 */
/**
 * Region ekspozycji funduszu odczytany z nazwy.
 *
 * Kraj notowania to dla ETF-a informacja myląca: fundusz na amerykańskie
 * spółki notowany w Londynie nie jest ekspozycją na Wielką Brytanię. Nazwy
 * funduszy są jednak silnie skonwencjonalizowane i indeks widnieje w nich
 * wprost, więc da się z nich odczytać to, co naprawdę interesuje inwestora.
 *
 * Kolejność ma znaczenie — „MSCI World ex USA" musi trafić przed „USA".
 */
const FUND_REGIONS: { match: RegExp; region: string }[] = [
  { match: /\bex[- ]?(us|usa)\b/i, region: 'Rynki rozwinięte bez USA' },
  { match: /emerging|\bem\b|wschodząc/i, region: 'Rynki wschodzące' },
  { match: /\bacwi\b|all[- ]?country|all[- ]?world|\bglobal\b|\bworld\b|\bftse all\b/i, region: 'Świat' },
  { match: /s&?p ?500|\bnasdaq\b|\bus\b|\busa\b|united states|russell|dow jones|\bs&p\b/i, region: 'USA' },
  { match: /\bwig\b|\bmwig\b|\bswig\b|polish|poland|polska/i, region: 'Polska' },
  { match: /euro ?stoxx|\bstoxx\b|\beurope\b|europa|\bemu\b|\beuro\b/i, region: 'Europa' },
  { match: /\bdax\b|german/i, region: 'Niemcy' },
  { match: /\bftse 100\b|\buk\b|united kingdom/i, region: 'Wielka Brytania' },
  { match: /\bjapan\b|\btopix\b|\bnikkei\b|japon/i, region: 'Japonia' },
  { match: /\bchina\b|\bchiny\b|\bhang seng\b/i, region: 'Chiny' },
  { match: /\bindia\b|\bindie\b/i, region: 'Indie' },
  { match: /pacific|asia|azja/i, region: 'Azja i Pacyfik' },
];

export function fundRegion(name: string): string | null {
  return FUND_REGIONS.find((entry) => entry.match.test(name))?.region ?? null;
}

export function localClassification(instrument: {
  symbol: string;
  name?: string;
  exchange: string | null;
  assetClass: string;
}): { sector: string | null; country: string | null } {
  const defaults = CLASS_DEFAULTS[instrument.assetClass as AssetClass];

  // Dla funduszu liczy się to, w co inwestuje, a nie gdzie jest notowany.
  if (instrument.assetClass === 'etf') {
    const region = fundRegion(`${instrument.name ?? ''} ${instrument.symbol}`);
    if (region) return { sector: 'Fundusze (wiele sektorów)', country: region };
  }

  const codes = [
    instrument.exchange,
    instrument.symbol.includes(':') ? instrument.symbol.split(':')[0] : null,
    instrument.symbol.includes('.') ? instrument.symbol.split('.').pop() ?? null : null,
  ]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map((c) => c.toUpperCase());

  const country = codes.map((c) => EXCHANGE_COUNTRIES[c]).find(Boolean) ?? defaults?.country ?? null;

  return { sector: defaults?.sector ?? null, country };
}

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
  const rows = db.select().from(instruments).all();

  const result: ClassifyResult = { checked: 0, updated: 0, changes: [] };

  for (const row of rows) {
    if (row.assetClass === 'cash') continue;

    // Najpierw to, co wynika z samej bazy — działa offline i obejmuje
    // obligacje oraz metale, których dostawca notowań w ogóle nie zna.
    const local = localClassification(row);
    const localPatch: Partial<InstrumentRow> = {};
    if (!row.sector && local.sector) localPatch.sector = local.sector;
    if (!row.country && local.country) localPatch.country = local.country;

    // Funduszom przypisanym wcześniej do kraju notowania podmieniamy kraj na
    // region ekspozycji — inaczej ETF na S&P 500 zostałby „Irlandią".
    if (row.assetClass === 'etf' && row.country && local.country && row.country !== local.country) {
      const wasExchangeGuess = Object.values(EXCHANGE_COUNTRIES).includes(row.country);
      if (wasExchangeGuess) localPatch.country = local.country;
    }
    if (Object.keys(localPatch).length > 0) {
      db.update(instruments).set(localPatch).where(eq(instruments.id, row.id)).run();
      result.updated += 1;
      Object.assign(row, localPatch);
    }

    // Dostawca dokłada sektor i typ instrumentu, ale nie ma wpisów dla
    // obligacji detalicznych — nie ma po co go o nie pytać.
    if (row.assetClass === 'bond') continue;

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
