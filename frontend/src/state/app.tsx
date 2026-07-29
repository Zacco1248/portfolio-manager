import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Account, Portfolio, SystemStatus } from '@portfolio/shared';
import { ApiError, api } from '@/lib/api';

/**
 * Stan globalny: sesja, lista portfeli i wybrany portfel.
 *
 * Wybór portfela jest kluczowy — użytkownik prowadzi kilka rachunków
 * o różnych reżimach podatkowych i musi móc szybko przełączać widok
 * między nimi a ujęciem zbiorczym.
 */

export const ALL_PORTFOLIOS = 0;

interface AppState {
  authenticated: boolean | null;
  portfolios: Portfolio[];
  /** Konta są globalne — nie zależą od wybranego portfela. */
  accounts: Account[];
  selectedPortfolioId: number;
  selectedPortfolio: Portfolio | null;
  status: SystemStatus | null;
  theme: 'dark' | 'light';
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectPortfolio: (id: number) => void;
  refreshPortfolios: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  toggleTheme: () => void;
}

const AppContext = createContext<AppState | null>(null);

const STORAGE_PORTFOLIO = 'pm.selectedPortfolio';
const STORAGE_THEME = 'pm.theme';

export function AppProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_PORTFOLIO);
    return stored ? Number(stored) : ALL_PORTFOLIOS;
  });
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem(STORAGE_THEME) as 'dark' | 'light') ?? 'dark',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(STORAGE_THEME, theme);
  }, [theme]);

  const refreshPortfolios = useCallback(async () => {
    const list = await api.portfolios.list();
    setPortfolios(list);
    // Portfel zapisany w localStorage mógł zostać usunięty albo zarchiwizowany.
    setSelectedPortfolioId((current) =>
      current !== ALL_PORTFOLIOS && !list.some((p) => p.id === current) ? ALL_PORTFOLIOS : current,
    );
  }, []);

  const refreshAccounts = useCallback(async () => {
    setAccounts(await api.accounts.list());
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatus(await api.status.get());
  }, []);

  useEffect(() => {
    void api.auth
      .me()
      .then(() => setAuthenticated(true))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setAuthenticated(false);
        else setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refreshPortfolios();
    void refreshAccounts();
    void refreshStatus();
  }, [authenticated, refreshPortfolios, refreshAccounts, refreshStatus]);

  const login = useCallback(async (password: string) => {
    await api.auth.login(password);
    setAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setAuthenticated(false);
    setPortfolios([]);
    setAccounts([]);
  }, []);

  const selectPortfolio = useCallback((id: number) => {
    setSelectedPortfolioId(id);
    localStorage.setItem(STORAGE_PORTFOLIO, String(id));
  }, []);

  const value = useMemo<AppState>(
    () => ({
      authenticated,
      portfolios,
      accounts,
      selectedPortfolioId,
      selectedPortfolio: portfolios.find((p) => p.id === selectedPortfolioId) ?? null,
      status,
      theme,
      login,
      logout,
      selectPortfolio,
      refreshPortfolios,
      refreshAccounts,
      refreshStatus,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    }),
    [
      authenticated,
      portfolios,
      accounts,
      selectedPortfolioId,
      status,
      theme,
      login,
      logout,
      selectPortfolio,
      refreshPortfolios,
      refreshAccounts,
      refreshStatus,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp musi być użyte wewnątrz AppProvider');
  return context;
}

/** Id portfela do przekazania do API — `undefined` oznacza widok zbiorczy. */
export function usePortfolioParam(): number | undefined {
  const { selectedPortfolioId } = useApp();
  return selectedPortfolioId === ALL_PORTFOLIOS ? undefined : selectedPortfolioId;
}
