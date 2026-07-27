import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { TAX_REGIME_LABELS } from '@portfolio/shared';
import { relativeTime } from '@/lib/format';
import { ALL_PORTFOLIOS, useApp } from '@/state/app';

const NAV = [
  { to: '/', label: 'Pulpit', end: true },
  { to: '/pozycje', label: 'Pozycje' },
  { to: '/transakcje', label: 'Transakcje' },
  { to: '/analiza', label: 'Analiza' },
  { to: '/rebalans', label: 'Rebalans' },
  { to: '/dywidendy', label: 'Dywidendy' },
  { to: '/obligacje', label: 'Obligacje' },
  { to: '/aktualnosci', label: 'Aktualności' },
  { to: '/alerty', label: 'Alerty' },
  { to: '/import', label: 'Import' },
  { to: '/podatki', label: 'Podatki' },
  { to: '/ustawienia', label: 'Ustawienia' },
  { to: '/pomoc', label: 'Pomoc' },
];

export function Layout() {
  const { portfolios, selectedPortfolioId, selectPortfolio, status, theme, toggleTheme, logout } = useApp();
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-surface-border bg-surface-raised/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 lg:hidden"
            onClick={() => setNavOpen((open) => !open)}
            aria-label="Menu"
          >
            ☰
          </button>

          <span className="text-sm font-semibold tracking-tight">Portfolio Manager</span>

          {/* Przełącznik portfela — użytkownik prowadzi kilka rachunków
              o różnych reżimach podatkowych, więc to najważniejsza kontrolka. */}
          <select
            className="input h-8 w-auto min-w-[11rem] py-0"
            value={selectedPortfolioId}
            onChange={(e) => selectPortfolio(Number(e.target.value))}
            aria-label="Wybór portfela"
          >
            <option value={ALL_PORTFOLIOS}>Wszystkie portfele</option>
            {portfolios.map((portfolio) => (
              <option key={portfolio.id} value={portfolio.id}>
                {portfolio.name}
                {portfolio.taxRegime !== 'taxable' ? ` · ${portfolio.taxRegime.toUpperCase()}` : ''}
              </option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-3 text-2xs text-content-muted">
            {status && (
              <>
                <span title="Ostatnia aktualizacja cen">Ceny: {relativeTime(status.lastPriceUpdate)}</span>
                {!status.features.ai && <span title="Brak ANTHROPIC_API_KEY">AI: wył.</span>}
                {!status.features.telegram && <span title="Brak konfiguracji Telegrama">Telegram: wył.</span>}
              </>
            )}
            <button type="button" className="btn btn-ghost px-2 py-1" onClick={toggleTheme} aria-label="Zmień motyw">
              {theme === 'dark' ? '☾' : '☀'}
            </button>
            <button type="button" className="btn btn-ghost px-2 py-1" onClick={() => void logout()}>
              Wyloguj
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          className={`${navOpen ? 'block' : 'hidden'} w-full shrink-0 border-b border-surface-border bg-surface-raised p-2 lg:block lg:w-48 lg:border-b-0 lg:border-r`}
        >
          <ul className="space-y-0.5">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-1.5 text-sm transition-colors ${
                      isActive
                        ? 'bg-accent/15 font-medium text-accent'
                        : 'text-content-secondary hover:bg-surface-overlay hover:text-content-primary'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>

          {selectedPortfolioId !== ALL_PORTFOLIOS && (
            <p className="mt-4 px-3 text-2xs text-content-muted">
              {TAX_REGIME_LABELS[portfolios.find((p) => p.id === selectedPortfolioId)?.taxRegime ?? 'taxable']}
            </p>
          )}
        </nav>

        <main className="min-w-0 flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
