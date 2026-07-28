import type {
  Alert,
  AlertEvent,
  AnalyticsResponse,
  BondHolding,
  DashboardResponse,
  DividendSummary,
  ImportCommitResponse,
  ImportParserInfo,
  ImportPreviewResponse,
  Instrument,
  NewsItem,
  Portfolio,
  Position,
  RebalanceResponse,
  SystemStatus,
  TaxReport,
  TechnicalResponse,
  Transaction,
} from '@portfolio/shared';

/**
 * Cienka warstwa nad fetchem. Cały stan sesji siedzi w ciasteczku HttpOnly,
 * więc nie ma tu żadnego zarządzania tokenami — wystarczy `credentials`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let code = 'error';
    let message = `Błąd ${response.status}`;
    let details: unknown;
    try {
      const body = (await response.json()) as { error?: string; message?: string; details?: unknown };
      code = body.error ?? code;
      message = body.message ?? message;
      details = body.details;
    } catch {
      // Odpowiedź bez JSON-a (np. 502 z proxy) — zostaje komunikat domyślny.
    }
    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length > 0 ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export interface PositionsResponse {
  positions: Position[];
  cash: { portfolioId: number; cashPlnMinor: number }[];
  totalValuePlnMinor: number;
}

export const api = {
  auth: {
    login: (password: string) => post<{ ok: boolean }>('/auth/login', { password }),
    logout: () => post<{ ok: boolean }>('/auth/logout'),
    me: () => get<{ authenticated: boolean }>('/auth/me'),
  },

  status: {
    get: () => get<SystemStatus>('/status'),
    jobs: () => get<{ job: string; startedAt: string; status: string; message: string | null }[]>('/status/jobs'),
  },

  portfolios: {
    list: () => get<Portfolio[]>('/portfolios'),
    create: (body: Record<string, unknown>) => post<Portfolio>('/portfolios', body),
    update: (id: number, body: Record<string, unknown>) => patch<Portfolio>(`/portfolios/${id}`, body),
    remove: (id: number) => del<{ ok: boolean }>(`/portfolios/${id}`),
  },

  instruments: {
    list: () => get<Instrument[]>('/instruments'),
    search: (q: string) =>
      get<{ symbol: string; name: string; exchange: string | null; assetClass: string; source: string }[]>(
        `/instruments/search${query({ q })}`,
      ),
    create: (body: Record<string, unknown>) => post<Instrument>('/instruments', body),
    update: (id: number, body: Record<string, unknown>) => patch<Instrument>(`/instruments/${id}`, body),
    backfill: (id: number) => post<{ ok: boolean; candles: number }>(`/instruments/${id}/backfill`),
  },

  transactions: {
    list: (params: { portfolioId?: number; instrumentId?: number; limit?: number }) =>
      get<Transaction[]>(`/transactions${query(params)}`),
    create: (body: Record<string, unknown>) =>
      post<{ transaction: Transaction; warnings: string[] }>('/transactions', body),
    update: (id: number, body: Record<string, unknown>) =>
      patch<{ transaction: Transaction; warnings: string[] }>(`/transactions/${id}`, body),
    remove: (id: number) => del<{ ok: boolean; warnings: string[] }>(`/transactions/${id}`),
  },

  positions: {
    list: (portfolioId?: number) => get<PositionsResponse>(`/positions${query({ portfolioId })}`),
    refresh: () =>
      post<{ ok: boolean; message?: string; prices?: { updated: number; skipped: number; failed: number } }>(
        '/positions/refresh',
      ),
  },

  analytics: {
    dashboard: (portfolioId?: number) => get<DashboardResponse>(`/analytics/dashboard${query({ portfolioId })}`),
    get: (params: { portfolioId?: number; from?: string; benchmarks?: string }) =>
      get<AnalyticsResponse>(`/analytics${query(params)}`),
    stats: (portfolioId?: number) => get<StatsResponse>(`/analytics/stats${query({ portfolioId })}`),
    benchmarks: () => get<{ key: string; label: string; symbol: string }[]>('/analytics/benchmarks'),
    refreshBenchmarks: () => post<{ ok: boolean; message: string }>('/analytics/benchmarks/refresh'),
    technical: (instrumentId: number) =>
      get<TechnicalResponse & { state: { rsi: number | null; rsiZone: string | null; trend: string | null } }>(
        `/analytics/technical${query({ instrumentId })}`,
      ),
    dividends: (portfolioId?: number) => get<DividendSummary>(`/analytics/dividends${query({ portfolioId })}`),
    snapshot: () => post<{ ok: boolean; message: string }>('/analytics/snapshot'),
  },

  rebalance: {
    get: (params: { portfolioId?: number; contribution?: string; dimension?: string }) =>
      get<RebalanceResponse>(`/rebalance${query(params)}`),
    targets: (portfolioId?: number) =>
      get<{ targets: { id: number; portfolioId: number | null; dimension: string; key: string; targetBp: number; toleranceBp: number }[]; sumBp: number }>(
        `/targets${query({ portfolioId })}`,
      ),
    saveTarget: (body: Record<string, unknown>) => put<unknown>('/targets', body),
    removeTarget: (id: number) => del<{ ok: boolean }>(`/targets/${id}`),
  },

  alerts: {
    list: () => get<Alert[]>('/alerts'),
    create: (body: Record<string, unknown>) => post<Alert>('/alerts', body),
    update: (id: number, body: Record<string, unknown>) => patch<Alert>(`/alerts/${id}`, body),
    remove: (id: number) => del<{ ok: boolean }>(`/alerts/${id}`),
    events: () => get<AlertEvent[]>('/alerts/events'),
    check: () => post<{ ok: boolean; message: string }>('/alerts/check'),
  },

  news: {
    list: (params: { instrumentId?: number; importance?: string; sentiment?: string }) =>
      get<{ items: NewsItem[]; disclaimer: string }>(`/news${query(params)}`),
    refresh: () => post<{ ok: boolean; fetched: string; analyzed: string }>('/news/refresh'),
    watchlist: () => get<Instrument[]>('/watchlist'),
    watch: (instrumentId: number) => post<{ ok: boolean }>('/watchlist', { instrumentId }),
    unwatch: (instrumentId: number) => del<{ ok: boolean }>(`/watchlist/${instrumentId}`),
  },

  bonds: {
    list: (portfolioId?: number) => get<BondHolding[]>(`/bonds${query({ portfolioId })}`),
    create: (body: Record<string, unknown>) => post<unknown>('/bonds', body),
    remove: (id: number) => del<{ ok: boolean }>(`/bonds/${id}`),
    cpi: () => get<{ year: number; month: number; cpiYoyBp: number }[]>('/cpi'),
    saveCpi: (entries: { year: number; month: number; cpiYoyPercent: string }[]) => put<unknown>('/cpi', entries),
  },

  imports: {
    parsers: () => get<{ parsers: ImportParserInfo[]; mappableFields: string[] }>('/imports/parsers'),
    preview: (file: File, portfolioId: number, parserId?: string, mapping?: Record<string, string | null>) => {
      const form = new FormData();
      form.append('file', file);
      form.append('portfolioId', String(portfolioId));
      if (parserId) form.append('parserId', parserId);
      if (mapping) form.append('mapping', JSON.stringify(mapping));
      return request<ImportPreviewResponse>('/imports/preview', { method: 'POST', body: form });
    },
    commit: (batchId: number, acceptedRowIds: string[]) =>
      post<ImportCommitResponse>('/imports/commit', { batchId, acceptedRowIds }),
    inspect: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<import('@/components/MappingWizard').InspectResult>('/imports/inspect', {
        method: 'POST',
        body: form,
      });
    },
    batches: () =>
      get<{ id: number; parserId: string; filename: string; status: string; createdAt: string }[]>(
        '/imports/batches',
      ),
  },

  assist: {
    monthlySummary: (body: { portfolioId?: number; month?: string }) =>
      post<AssistResult<MonthlyFacts>>('/assist/monthly-summary', body),
    priceMove: (instrumentId: number) =>
      post<AssistResult<PriceMoveFacts | null>>('/assist/price-move', { instrumentId }),
    purchaseCheck: (body: { portfolioId?: number; symbol: string; amount: string }) =>
      post<AssistResult<PurchaseCheckFacts>>('/assist/purchase-check', body),
    document: (text: string) =>
      post<AssistResult<{ characters: number; truncated: boolean }>>('/assist/document', { text }),
    tax: (body: { portfolioId?: number; year: number; question: string }) =>
      post<AssistResult<TaxAssistantFacts>>('/assist/tax', body),
    importMapping: (headers: string[], samples: string[][]) =>
      post<AssistResult<{ headers: string[]; sampleCount: number }>>('/assist/import-mapping', { headers, samples }),
  },

  tax: {
    years: () => get<number[]>('/tax/years'),
    report: (year: number, portfolioId?: number) => get<TaxReport>(`/tax${query({ year, portfolioId })}`),
    csvUrl: (year: number, portfolioId?: number) => `/api/tax/csv${query({ year, portfolioId })}`,
  },

  settings: {
    get: () => get<Record<string, unknown>>('/settings'),
    update: (body: Record<string, unknown>) => patch<Record<string, unknown>>('/settings', body),
    testTelegram: () => post<{ ok: boolean; message: string }>('/telegram/test'),
  },

  insights: {
    get: (portfolioId?: number) =>
      get<{
        insights: { kind: string; title: string; detail: string; valuePlnMinor: number | null }[];
        projection: {
          points: { year: number; valuePlnMinor: number; contributedPlnMinor: number }[];
          monthlyContributionPlnMinor: number;
          assumedAnnualReturnBp: number;
          returnSource: 'xirr' | 'default';
          note: string;
        };
        emergencyFund: {
          configured: boolean;
          currentPlnMinor: number;
          targetPlnMinor: number;
          monthlyExpensesPlnMinor: number;
          targetMonths: number;
          coveredMonths: number | null;
          completionBp: number | null;
          portfolioNames: string[];
        };
        narrative: string | null;
      }>(`/insights${query({ portfolioId })}`),
  },

  suggestions: {
    get: (portfolioId?: number) =>
      get<{
        context: {
          gaps: { key: string; label: string; currentSharePercent: number; targetSharePercent: number; gapPercent: number }[];
          overweight: { key: string; label: string; currentSharePercent: number; targetSharePercent: number }[];
          sectors: { name: string; sharePercent: number }[];
          regions: { name: string; sharePercent: number }[];
          missingAssetClasses: string[];
          concentrated: { symbol: string; sharePercent: number }[];
        };
        suggestions: { kind: string; title: string; rationale: string }[];
        unavailableReason: string | null;
        disclaimer: string;
      }>(`/suggestions${query({ portfolioId })}`),
  },

  ai: {
    status: () =>
      get<{
        provider: string;
        model: string;
        features: { key: string; label: string; description: string; dataSent: string; enabled: boolean; available: boolean; reason: string | null }[];
        keys: { anthropic: boolean; openai: boolean };
        suggestedModels: Record<string, { id: string; label: string; hint: string }[]>;
      }>('/ai'),
    update: (body: Record<string, unknown>) => patch<unknown>('/ai', body),
    test: () =>
      post<{
        ok: boolean;
        provider: string;
        model: string;
        latencyMs: number | null;
        message: string;
        reply: string | null;
      }>('/ai/test', {}),
  },

  duplicates: {
    find: () =>
      get<{
        groups: { key: string; portfolioName: string; instrumentSymbol: string | null; tradeDate: string; type: string; amountPlnMinor: number; count: number; excessPlnMinor: number }[];
        totalExtraTransactions: number;
        totalExcessPlnMinor: number;
      }>('/duplicates'),
    resolve: (keys: string[]) => post<{ ok: boolean; removed: number }>('/duplicates/resolve', { keys }),
  },

  corporate: {
    refresh: () => post<{ ok: boolean; message: string }>('/corporate-actions/refresh'),
    dividendHistory: (instrumentId: number) =>
      get<{ exDate: string; amountE8: number; currency: string }[]>(
        `/corporate-actions/dividends/${instrumentId}`,
      ),
    reportDates: () =>
      get<{ id: number; instrumentId: number; symbol: string; name: string; date: string; label: string; note: string | null }[]>(
        '/report-dates',
      ),
    addReportDate: (body: { instrumentId: number; date: string; label: string; note?: string }) =>
      post<unknown>('/report-dates', body),
    removeReportDate: (id: number) => del<{ ok: boolean }>(`/report-dates/${id}`),
    missingHoldings: () => get<{ id: number; symbol: string; name: string }[]>('/holdings/missing'),
    holdings: (instrumentId: number) =>
      get<{ symbol: string; weightBp: number }[]>(`/holdings/${instrumentId}`),
    classify: (force = false) =>
      post<{ checked: number; updated: number; changes: { symbol: string; from: string; to: string }[] }>(
        '/instruments/classify',
        { force },
      ),
    saveHoldings: (instrumentId: number, text: string) =>
      put<{ ok: boolean; saved: number; holdings: { symbol: string; weightBp: number }[] }>(
        `/holdings/${instrumentId}`,
        { text },
      ),
  },

  exportUrls: {
    json: '/api/export/json',
    transactionsCsv: '/api/export/transactions.csv',
  },
};

/** Miary ryzyka i struktury — odpowiada `/analytics/stats`. */
export interface StatsResponse {
  risk: {
    volatilityBp: number | null;
    maxDrawdownBp: number | null;
    maxDrawdownFrom: string | null;
    maxDrawdownTo: string | null;
    drawdownNowBp: number | null;
    bestMonth: { month: string; changeBp: number } | null;
    worstMonth: { month: string; changeBp: number } | null;
    positiveDays: number;
    negativeDays: number;
    observations: number;
    drawdownSeries: { date: string; drawdownBp: number }[];
  };
  concentration: {
    hhi: number;
    top3ShareBp: number;
    largest: { symbol: string; name: string; shareBp: number }[];
    positionCount: number;
  };
  contributions: {
    instrumentId: number;
    symbol: string;
    name: string;
    unrealizedPlnMinor: number;
    realizedPlnMinor: number;
    totalPlnMinor: number;
    shareOfResultBp: number;
  }[];
  note: string;
}

/**
 * Odpowiedź asystenta: fakty policzone lokalnie plus opcjonalny komentarz
 * modelu. `text` jest puste, gdy funkcja jest wyłączona — wtedy powód siedzi
 * w `unavailableReason`, a dane i tak przychodzą.
 */
export interface AssistResult<T> {
  data: T;
  text: string | null;
  unavailableReason: string | null;
  disclaimer: string;
}

export interface MonthlyFacts {
  month: string;
  valueStartPlnMinor: number | null;
  valueEndPlnMinor: number | null;
  contributedPlnMinor: number;
  changeBp: number | null;
  buys: number;
  sells: number;
  dividendsPlnMinor: number;
  realizedPlnMinor: number;
  movers: { symbol: string; name: string; changeBp: number }[];
}

export interface PriceMoveFacts {
  symbol: string;
  name: string;
  changeBp: number | null;
  days: number;
  headlines: { title: string; publishedAt: string; summary: string | null }[];
}

export interface PurchaseCheckFacts {
  symbol: string;
  amountPlnMinor: number;
  known: boolean;
  assetClass: string | null;
  sector: string | null;
  country: string | null;
  shareBeforeBp: number;
  shareAfterBp: number;
  assetClassShareBeforeBp: number;
  assetClassShareAfterBp: number;
  sectorShareAfterBp: number;
  countryShareAfterBp: number;
  portfolioValuePlnMinor: number;
  warnings: string[];
}

export interface TaxAssistantFacts {
  year: number;
  securitiesGainPlnMinor: number;
  securitiesTaxPlnMinor: number;
  cryptoGainPlnMinor: number;
  cryptoTaxPlnMinor: number;
  dividendGrossPlnMinor: number;
  dividendWithholdingPlnMinor: number;
  dividendDuePlnMinor: number;
  excludedPortfolios: string[];
}
