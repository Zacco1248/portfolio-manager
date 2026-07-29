import { and, eq, like, or } from 'drizzle-orm';
import { equityClassFor } from '@portfolio/shared';
import type { AssetClass, AssetClassGroup } from '@portfolio/shared';
import { db } from '../db/index.js';
import { instrumentAliases, instruments } from '../db/schema.js';
import type { InstrumentRow } from '../db/schema.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { errorMessage } from '../lib/errors.js';

const log = createLogger('instruments');

/**
 * Każde źródło zapisuje ten sam papier inaczej:
 *   XTB          IUIT.UK    NOVOB.DK    INTC.US    XTB.PL
 *   Inwestomat   LON:IUIT   CPH:NOVO-B  NASDAQ:INTC  WSE:XTB
 *   Yahoo        IUIT.L     NOVO-B.CO   INTC       XTB.WA
 *
 * Bez wspólnego klucza dopasowania kolejny import stworzyłby duplikat
 * instrumentu i rozbił pozycję na dwie.
 */

/** Sufiks giełdy w eksportach XTB → nasz kod rynku. */
const XTB_SUFFIX_TO_MARKET: Record<string, string> = {
  PL: 'WSE',
  UK: 'LON',
  US: 'US',
  DE: 'FRA',
  DK: 'CPH',
  NL: 'AMS',
  FR: 'PAR',
  IT: 'MIL',
  ES: 'MAD',
  CH: 'SWX',
  SE: 'STO',
  NO: 'OSL',
  FI: 'HEL',
  PT: 'LIS',
  BE: 'BRU',
  AT: 'VIE',
  CZ: 'PRG',
  HU: 'BUD',
};

/** Warianty zapisu rynku sprowadzone do jednej postaci kanonicznej. */
const MARKET_ALIASES: Record<string, string> = {
  GPW: 'WSE',
  WSE: 'WSE',
  WAR: 'WSE',
  LSE: 'LON',
  LON: 'LON',
  NASDAQ: 'US',
  NYSE: 'US',
  NYSEARCA: 'US',
  AMEX: 'US',
  BATS: 'US',
  US: 'US',
  XETRA: 'FRA',
  FRA: 'FRA',
  GER: 'FRA',
  CPH: 'CPH',
  OMX: 'CPH',
};

export interface NormalizedSymbol {
  /** Postać zapisywana jako `instruments.symbol`. */
  canonical: string;
  market: string | null;
  ticker: string;
  /** Klucz dopasowania między źródłami — ignoruje myślniki i kropki w tickerze. */
  matchKey: string;
}

export function normalizeSymbol(raw: string, source: string): NormalizedSymbol {
  const trimmed = raw.trim().toUpperCase();

  let market: string | null = null;
  let ticker = trimmed;

  if (trimmed.includes(':')) {
    const idx = trimmed.indexOf(':');
    market = trimmed.slice(0, idx);
    ticker = trimmed.slice(idx + 1);
  } else if (source === 'xtb' && trimmed.includes('.')) {
    const idx = trimmed.lastIndexOf('.');
    const suffix = trimmed.slice(idx + 1);
    const mapped = XTB_SUFFIX_TO_MARKET[suffix];
    if (mapped) {
      market = mapped;
      ticker = trimmed.slice(0, idx);
    }
  }

  const canonicalMarket = market ? (MARKET_ALIASES[market] ?? market) : null;
  const strippedTicker = ticker.replace(/[-.\s]/g, '');

  return {
    canonical: canonicalMarket ? `${canonicalMarket}:${ticker}` : ticker,
    market: canonicalMarket,
    ticker,
    matchKey: canonicalMarket ? `${canonicalMarket}:${strippedTicker}` : strippedTicker,
  };
}

export interface ResolveInstrumentInput {
  rawSymbol: string;
  source: string;
  name?: string;
  assetClass: AssetClass;
  currency: string;
  isin?: string | null;
  sector?: string | null;
  country?: string | null;
}

/**
 * Znajduje instrument albo tworzy nowy, zapisując przy okazji aliasy, żeby
 * kolejny import z tego samego lub innego źródła trafił w ten sam rekord.
 */
export function resolveInstrument(input: ResolveInstrumentInput): InstrumentRow {
  const normalized = normalizeSymbol(input.rawSymbol, input.source);

  // 1. Dokładny alias dla tego źródła.
  const bySource = db
    .select()
    .from(instrumentAliases)
    .where(
      and(eq(instrumentAliases.source, input.source), eq(instrumentAliases.symbol, input.rawSymbol.toUpperCase())),
    )
    .get();
  if (bySource) {
    const row = db.select().from(instruments).where(eq(instruments.id, bySource.instrumentId)).get();
    if (row) return row;
  }

  // 2. Klucz dopasowania międzyźródłowego.
  const byMatch = db
    .select()
    .from(instrumentAliases)
    .where(and(eq(instrumentAliases.source, 'match'), eq(instrumentAliases.symbol, normalized.matchKey)))
    .get();
  if (byMatch) {
    const row = db.select().from(instruments).where(eq(instruments.id, byMatch.instrumentId)).get();
    if (row) {
      registerAlias(row.id, input.source, input.rawSymbol);
      return row;
    }
  }

  // 3. ISIN — najpewniejszy identyfikator, jeśli źródło go podało.
  if (input.isin) {
    const byIsin = db.select().from(instruments).where(eq(instruments.isin, input.isin)).get();
    if (byIsin) {
      registerAlias(byIsin.id, input.source, input.rawSymbol);
      registerAlias(byIsin.id, 'match', normalized.matchKey);
      return byIsin;
    }
  }

  // 4. Symbol kanoniczny — instrument mógł powstać ręcznie, bez aliasów.
  const bySymbol = db.select().from(instruments).where(eq(instruments.symbol, normalized.canonical)).get();
  if (bySymbol) {
    registerAlias(bySymbol.id, input.source, input.rawSymbol);
    registerAlias(bySymbol.id, 'match', normalized.matchKey);
    return bySymbol;
  }

  const created = db
    .insert(instruments)
    .values({
      symbol: normalized.canonical,
      name: input.name?.trim() || normalized.ticker,
      assetClass: input.assetClass,
      currency: input.currency.toUpperCase(),
      isin: input.isin ?? null,
      exchange: normalized.market,
      sector: input.sector ?? null,
      country: input.country ?? countryFromMarket(normalized.market),
    })
    .returning()
    .get();

  registerAlias(created.id, input.source, input.rawSymbol);
  registerAlias(created.id, 'match', normalized.matchKey);
  log.info(`Utworzono instrument ${created.symbol} (${created.name})`);
  return created;
}

export function registerAlias(instrumentId: number, source: string, symbol: string): void {
  db.insert(instrumentAliases)
    .values({ instrumentId, source, symbol: symbol.toUpperCase() })
    .onConflictDoNothing()
    .run();
}

/** Domyślna geografia wyprowadzona z rynku notowania — użytkownik może nadpisać. */
function countryFromMarket(market: string | null): string | null {
  switch (market) {
    case 'WSE':
      return 'Polska';
    case 'US':
      return 'USA';
    case 'LON':
      return 'Wielka Brytania';
    case 'FRA':
      return 'Niemcy';
    case 'CPH':
      return 'Dania';
    case 'AMS':
      return 'Holandia';
    case 'PAR':
      return 'Francja';
    case 'MIL':
      return 'Włochy';
    case 'STO':
      return 'Szwecja';
    case 'OSL':
      return 'Norwegia';
    case 'SWX':
      return 'Szwajcaria';
    default:
      return null;
  }
}

export function findInstruments(query: string, assetClass?: AssetClass): InstrumentRow[] {
  const pattern = `%${query.trim().toUpperCase()}%`;
  const conditions = or(like(instruments.symbol, pattern), like(instruments.name, pattern));
  const rows = db
    .select()
    .from(instruments)
    .where(assetClass ? and(conditions, eq(instruments.assetClass, assetClass)) : conditions)
    .limit(25)
    .all();
  return rows;
}

export interface SymbolSuggestion {
  symbol: string;
  name: string;
  exchange: string | null;
  assetClass: AssetClass;
  currency: string | null;
  source: 'local' | 'yahoo';
}

interface YahooSearchResponse {
  quotes?: {
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchange?: string;
    exchDisp?: string;
    quoteType?: string;
    typeDisp?: string;
  }[];
}

/**
 * Autouzupełnianie tickera. Najpierw instrumenty już znane lokalnie, potem
 * wyszukiwarka Yahoo. Brak sieci nie może zepsuć formularza — w takiej
 * sytuacji zwracamy same wyniki lokalne.
 */
export async function suggestSymbols(query: string, assetClass?: AssetClass): Promise<SymbolSuggestion[]> {
  const local: SymbolSuggestion[] = findInstruments(query, assetClass).map((row) => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    assetClass: row.assetClass as AssetClass,
    currency: row.currency,
    source: 'local',
  }));

  try {
    const data = await fetchJson<YahooSearchResponse>(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`,
      { headers: { Accept: 'application/json' }, retries: 1, minIntervalMs: 400 },
    );

    const remote: SymbolSuggestion[] = (data.quotes ?? [])
      .filter((q) => q.symbol)
      .map((q) => ({
        symbol: q.symbol!,
        name: q.longname ?? q.shortname ?? q.symbol!,
        exchange: q.exchDisp ?? q.exchange ?? null,
        // Dostawca zna tylko oś akcje/fundusz — oś krajową domykamy sami
        // z symbolu i rynku (papier z GPW przychodzi z sufiksem `.WA`).
        assetClass: closeEquityAxis(assetClassFromQuoteType(q.quoteType), {
          symbol: q.symbol!,
          exchange: q.exchDisp ?? q.exchange ?? null,
          currency: '',
        }),
        currency: null,
        source: 'yahoo' as const,
      }))
      .filter((s) => !assetClass || s.assetClass === assetClass);

    const seen = new Set(local.map((s) => s.symbol.toUpperCase()));
    return [...local, ...remote.filter((r) => !seen.has(r.symbol.toUpperCase()))];
  } catch (err) {
    log.debug(`Podpowiedzi Yahoo niedostępne: ${errorMessage(err)}`);
    return local;
  }
}

/**
 * Typ z wyszukiwarki dostawcy → GRUPA klasy aktywów. Oś krajową domyka
 * `equityClassFor` u wołającego, na podstawie rynku notowania.
 */
/** Grupa → liść: dokłada oś krajową tam, gdzie ma ona sens. */
function closeEquityAxis(
  group: AssetClassGroup,
  instrument: { symbol: string; exchange: string | null; currency: string },
): AssetClass {
  if (group === 'stock' || group === 'etf') return equityClassFor(group, instrument);
  return group as AssetClass;
}

function assetClassFromQuoteType(quoteType: string | undefined): AssetClassGroup {
  switch (quoteType?.toUpperCase()) {
    case 'ETF':
      return 'etf';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    case 'FUTURE':
    case 'COMMODITY':
      return 'metal';
    case 'CURRENCY':
      return 'cash';
    default:
      return 'stock';
  }
}
