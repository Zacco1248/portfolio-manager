import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { TAX_REGIME_LABELS } from '@portfolio/shared';
import { relativeTime } from '@/lib/format';
import { ALL_PORTFOLIOS, useApp } from '@/state/app';

const NAV = [
  { to: '/', label: 'Pulpit', end: true },
  { to: '/pozycje', label: 'Pozycje' },
  { to: '/transakcje', label: 'Transakcje' },
  { to: '/analiza', label: 'Analiza' },
  { to: '/postepy', label: 'Postępy' },
  { to: '/spolki', label: 'Spółki' },
  { to: '/asystent', label: 'Asystent' },
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

  /*
   * Otwarte menu przykrywa całą treść, więc musi się zachowywać jak okno
   * modalne: Escape zamyka, a tło pod spodem nie przewija się pod palcem.
   * Sprzątanie w `return` przywraca scroll także wtedy, gdy menu zamknie
   * się przez nawigację, a nie przez kliknięcie.
   */
  useEffect(() => {
    if (!navOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-surface-border bg-surface-raised/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 lg:hidden"
            onClick={() => setNavOpen((open) => !open)}
            aria-label={navOpen ? 'Zamknij menu' : 'Otwórz menu'}
            aria-expanded={navOpen}
            aria-controls="menu-glowne"
          >
            {navOpen ? '✕' : '☰'}
          </button>

          <span className="text-sm font-semibold tracking-tight">Portfolio Manager</span>

          {/* Przełącznik portfela — użytkownik prowadzi kilka rachunków
              o różnych reżimach podatkowych, więc to najważniejsza kontrolka. */}
          <select
            className="input h-8 w-auto min-w-0 max-w-[12rem] flex-1 py-0 sm:min-w-[11rem] sm:flex-none"
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

          <div className="ml-auto flex items-center gap-2 text-2xs text-content-muted sm:gap-3">
            {status && (
              // Znaczniki stanu są dodatkiem — na wąskim ekranie ustępują miejsca
              // przełącznikowi portfela i przyciskom.
              <span className="hidden md:inline" title="Ostatnia aktualizacja cen">
                Ceny: {relativeTime(status.lastPriceUpdate)}
              </span>
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

      {/*
        Poniżej `lg` nawigacja jest nakładką, nie elementem przepływu.
        Wcześniej wchodziła w układ kolumnowy i po otwarciu spychała treść
        o wysokość szesnastu pozycji menu — na telefonie strona wyglądała
        na pustą, bo `main` lądował poza ekranem.
      */}
      <div className="flex flex-1 flex-col lg:flex-row">
        {navOpen && (
          <button
            type="button"
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            aria-label="Zamknij menu"
            onClick={() => setNavOpen(false)}
          />
        )}

        <nav
          id="menu-glowne"
          className={`${
            navOpen ? 'fixed' : 'hidden'
          } inset-y-0 left-0 z-40 w-64 shrink-0 overflow-y-auto border-r border-surface-border bg-surface-raised p-2 lg:static lg:z-auto lg:block lg:w-48 lg:overflow-visible`}
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
