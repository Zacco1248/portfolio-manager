import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Spinner } from '@/components/ui';
import { Dashboard } from '@/pages/Dashboard';
import { Login } from '@/pages/Login';
import { useApp } from '@/state/app';

/**
 * Pulpit i logowanie ładują się od razu — to pierwsze, co użytkownik widzi.
 * Reszta widoków jest doładowywana na żądanie: same wykresy Recharts ważą
 * większość bundla, a przez tailnet na telefonie to zauważalna różnica.
 */
const Alerts = lazy(() => import('@/pages/Alerts').then((m) => ({ default: m.Alerts })));
const Analysis = lazy(() => import('@/pages/Analysis').then((m) => ({ default: m.Analysis })));
const Bonds = lazy(() => import('@/pages/Bonds').then((m) => ({ default: m.Bonds })));
const Dividends = lazy(() => import('@/pages/Dividends').then((m) => ({ default: m.Dividends })));
const Help = lazy(() => import('@/pages/Help').then((m) => ({ default: m.Help })));
const ImportPage = lazy(() => import('@/pages/Import').then((m) => ({ default: m.ImportPage })));
const InstrumentDetail = lazy(() =>
  import('@/pages/InstrumentDetail').then((m) => ({ default: m.InstrumentDetail })),
);
const News = lazy(() => import('@/pages/News').then((m) => ({ default: m.News })));
const Positions = lazy(() => import('@/pages/Positions').then((m) => ({ default: m.Positions })));
const Rebalance = lazy(() => import('@/pages/Rebalance').then((m) => ({ default: m.Rebalance })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const Tax = lazy(() => import('@/pages/Tax').then((m) => ({ default: m.Tax })));
const Transactions = lazy(() => import('@/pages/Transactions').then((m) => ({ default: m.Transactions })));

export function App() {
  const { authenticated } = useApp();

  // null oznacza, że nie wiemy jeszcze, czy sesja jest ważna — pokazanie
  // ekranu logowania w tym momencie mignęłoby zalogowanemu użytkownikowi.
  if (authenticated === null) return <Spinner label="Sprawdzam sesję…" />;
  if (!authenticated) return <Login />;

  return (
    <Routes>
      <Route
        element={
          <Suspense fallback={<Spinner />}>
            <Layout />
          </Suspense>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pozycje" element={<Positions />} />
        <Route path="transakcje" element={<Transactions />} />
        <Route path="instrument/:id" element={<InstrumentDetail />} />
        <Route path="analiza" element={<Analysis />} />
        <Route path="rebalans" element={<Rebalance />} />
        <Route path="dywidendy" element={<Dividends />} />
        <Route path="obligacje" element={<Bonds />} />
        <Route path="aktualnosci" element={<News />} />
        <Route path="alerty" element={<Alerts />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="podatki" element={<Tax />} />
        <Route path="ustawienia" element={<Settings />} />
        <Route path="pomoc" element={<Help />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
