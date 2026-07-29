import { eq } from 'drizzle-orm';
import { equityClassFor, toGroupKey } from '@portfolio/shared';
import type { AssetClass, AssetClassGroup } from '@portfolio/shared';
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

/**
 * Typ instrumentu u dostawcy → GRUPA klasy aktywów.
 *
 * Świadomie grupa, nie liść: dostawca rozstrzyga wyłącznie oś akcje/fundusz.
 * O tym, czy papier jest krajowy, decyduje `equityClassFor` na podstawie
 * rynku notowania — tej wiedzy Yahoo nam nie poda.
 */
function assetClassFrom(instrumentType: string | undefined): AssetClassGroup | null {
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
const CLASS_DEFAULTS: Partial<Record<AssetClassGroup, { sector: string; country?: string }>> = {
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

/**
 * Ekspozycja popularnych ETF-ów UCITS rozpoznawana po samym tickerze.
 *
 * Regexy na nazwie zawodzą wtedy, gdy nazwy nie ma: import z wyciągu brokera
 * potrafi zostawić samo „IUIT", a wtedy jedyną przesłanką zostawał rynek
 * notowania — i fundusz na amerykański sektor technologiczny lądował
 * w „Wielkiej Brytanii", bo jest notowany w Londynie.
 *
 * Lista jest pomocnicza, nie kompletna: obejmuje fundusze najczęściej
 * kupowane z Polski. Nietrafiony ticker spada do rozpoznawania po nazwie,
 * a ostatecznie do kraju notowania — tak jak wcześniej.
 */
const ETF_EXPOSURE: Record<string, { region: string; sector?: string }> = {
  // S&P 500 i szeroki rynek USA
  VUAA: { region: 'USA' },
  VUSA: { region: 'USA' },
  CSPX: { region: 'USA' },
  SXR8: { region: 'USA' },
  IUSA: { region: 'USA' },
  VOO: { region: 'USA' },
  SPY: { region: 'USA' },
  // Nasdaq 100
  CNDX: { region: 'USA' },
  EQQQ: { region: 'USA' },
  QQQ: { region: 'USA' },
  // Sektorowe na rynek amerykański
  IUIT: { region: 'USA', sector: 'Technologia' },
  IITU: { region: 'USA', sector: 'Technologia' },
  IUHC: { region: 'USA', sector: 'Ochrona zdrowia' },
  IUFS: { region: 'USA', sector: 'Finanse' },
  // Świat
  SWDA: { region: 'Świat' },
  IWDA: { region: 'Świat' },
  EUNL: { region: 'Świat' },
  VWCE: { region: 'Świat' },
  VWRA: { region: 'Świat' },
  VWRL: { region: 'Świat' },
  ISAC: { region: 'Świat' },
  IUSQ: { region: 'Świat' },
  ACWI: { region: 'Świat' },
  // Rynki wschodzące
  EIMI: { region: 'Rynki wschodzące' },
  EMIM: { region: 'Rynki wschodzące' },
  IEMA: { region: 'Rynki wschodzące' },
  VFEM: { region: 'Rynki wschodzące' },
  VFEA: { region: 'Rynki wschodzące' },
  // Europa
  MEUD: { region: 'Europa' },
  CEUU: { region: 'Europa' },
  EXSA: { region: 'Europa' },
  IMEU: { region: 'Europa' },
  // Polska
  ETFBW20TR: { region: 'Polska' },
  ETFBM40TR: { region: 'Polska' },
  ETFBS80TR: { region: 'Polska' },
  BETAW20LV: { region: 'Polska' },
};

/** Sam ticker, bez prefiksu rynku i sufiksu giełdy: `LON:IUIT` → `IUIT`. */
function bareTicker(symbol: string): string {
  return (symbol.split(':').pop() ?? symbol).split('.')[0]!.toUpperCase();
}

/** Ekspozycja funduszu rozpoznana po tickerze — pewniejsza niż zgadywanie z nazwy. */
export function etfExposure(symbol: string): { region: string; sector?: string } | null {
  return ETF_EXPOSURE[bareTicker(symbol)] ?? null;
}

export function fundRegion(name: string): string | null {
  return FUND_REGIONS.find((entry) => entry.match.test(name))?.region ?? null;
}

export function localClassification(instrument: {
  symbol: string;
  name?: string;
  exchange: string | null;
  assetClass: string;
}): { sector: string | null; country: string | null } {
  const group = toGroupKey(instrument.assetClass);
  const defaults = CLASS_DEFAULTS[group as AssetClassGroup];

  // Dla funduszu liczy się to, w co inwestuje, a nie gdzie jest notowany.
  if (group === 'etf') {
    // Najpierw ticker: rozpoznanie jest pewne i działa nawet wtedy, gdy import
    // nie przyniósł nazwy funduszu.
    const known = etfExposure(instrument.symbol);
    if (known) return { sector: known.sector ?? FUND_SECTOR, country: known.region };

    const region = fundRegion(`${instrument.name ?? ''} ${instrument.symbol}`);
    if (region) return { sector: FUND_SECTOR, country: region };
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
  /** Grupa, nie liść — oś krajowa jest nasza, nie dostawcy. */
  assetClass: AssetClassGroup | null;
  sector: string | null;
  name: string | null;
}

export async function classifyInstrument(instrument: InstrumentRow): Promise<Classification> {
  const symbol = toYahooSymbol(toProviderInstrument(instrument));
  if (!symbol) return { assetClass: null, sector: null, name: null };

  const headers = { Accept: 'application/json' };
  let assetClass: AssetClassGroup | null = null;
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

  if (sector === null && (assetClass ?? toGroupKey(instrument.assetClass)) === 'etf') sector = FUND_SECTOR;

  return { assetClass, sector, name };
}

/**
 * Łączy odpowiedź dostawcy z tym, co wiemy o rynku notowania.
 *
 * Dostawca zwraca grupę („to jest ETF"), my domykamy ją osią krajową
 * („notowany w Londynie, więc zagraniczny"). Grupy jednoelementowe
 * (krypto, metale) są zarazem liśćmi i przechodzą wprost.
 */
function mergeClass(row: InstrumentRow, provider: AssetClassGroup | null): AssetClass | null {
  if (provider === null) return null;
  if (provider === 'stock' || provider === 'etf') return equityClassFor(provider, row);
  return provider as AssetClass;
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
    if (toGroupKey(row.assetClass) === 'etf' && row.country && local.country && row.country !== local.country) {
      const wasExchangeGuess = Object.values(EXCHANGE_COUNTRIES).includes(row.country);
      if (wasExchangeGuess) localPatch.country = local.country;
    }

    /*
     * Fundusz sektorowy o rozpoznanym tickerze dostaje swój sektor zamiast
     * zbiorczej kategorii „Fundusze (wiele sektorów)". To wiedza pewniejsza
     * niż zapisany wcześniej domysł, więc nadpisujemy — ale tylko wtedy, gdy
     * dotychczasowa wartość była właśnie tą zbiorczą etykietą.
     */
    const exposure = toGroupKey(row.assetClass) === 'etf' ? etfExposure(row.symbol) : null;
    if (exposure?.sector && (!row.sector || row.sector === FUND_SECTOR)) {
      localPatch.sector = exposure.sector;
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
    /*
     * Reklasyfikacja dotyczy papierów, które trafiły do bazy jako akcje —
     * to jedyna droga, żeby ETF zaimportowany z arkusza jako „Akcje
     * zagraniczne" został poprawiony na fundusz. Porównanie musi iść po
     * grupie: po rozbiciu klas żaden instrument nie ma już wartości 'stock'.
     */
    const needsClass = toGroupKey(row.assetClass) === 'stock' || options.force === true;
    if (!needsSector && !needsClass) continue;

    result.checked += 1;
    const classification = await classifyInstrument(row);

    const patch: Partial<InstrumentRow> = {};

    /*
     * Dostawca rozstrzyga tylko oś akcje/fundusz. Oś krajowa jest nasza —
     * wynika z rynku notowania. Płaskie nadpisanie wpisałoby do bazy wartość
     * grupową ('etf'), której schemat nie dopuszcza.
     */
    const merged = mergeClass(row, classification.assetClass);
    if (merged && merged !== row.assetClass) {
      patch.assetClass = merged;
      result.changes.push({ symbol: row.symbol, from: row.assetClass, to: merged });
    }

    if (needsSector && classification.sector) patch.sector = classification.sector;

    /*
     * Papier, który dopiero teraz okazał się funduszem, dostał wcześniej kraj
     * notowania — bo przy klasyfikacji lokalnej uchodził jeszcze za akcję.
     * Przeliczamy go od razu, zamiast czekać na kolejne uruchomienie: inaczej
     * ETF na S&P 500 kupiony w Londynie zostawał „Wielką Brytanią" aż do
     * drugiego przebiegu.
     */
    if (patch.assetClass && toGroupKey(patch.assetClass) === 'etf') {
      const asFund = localClassification({ ...row, assetClass: patch.assetClass, name: patch.name ?? row.name });
      if (asFund.country && asFund.country !== row.country) patch.country = asFund.country;
      if (asFund.sector) patch.sector = asFund.sector;
    }

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
