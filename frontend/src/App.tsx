import { Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Spinner } from '@/components/ui';
import { Alerts } from '@/pages/Alerts';
import { Bonds } from '@/pages/Bonds';
import { Dashboard } from '@/pages/Dashboard';
import { Dividends } from '@/pages/Dividends';
import { ImportPage } from '@/pages/Import';
import { InstrumentDetail } from '@/pages/InstrumentDetail';
import { Login } from '@/pages/Login';
import { News } from '@/pages/News';
import { Positions } from '@/pages/Positions';
import { Rebalance } from '@/pages/Rebalance';
import { Settings } from '@/pages/Settings';
import { Tax } from '@/pages/Tax';
import { Transactions } from '@/pages/Transactions';
import { useApp } from '@/state/app';

export function App() {
  const { authenticated } = useApp();

  // null oznacza, że nie wiemy jeszcze, czy sesja jest ważna — pokazanie
  // ekranu logowania w tym momencie mignęłoby zalogowanemu użytkownikowi.
  if (authenticated === null) return <Spinner label="Sprawdzam sesję…" />;
  if (!authenticated) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="pozycje" element={<Positions />} />
        <Route path="transakcje" element={<Transactions />} />
        <Route path="instrument/:id" element={<InstrumentDetail />} />
        <Route path="rebalans" element={<Rebalance />} />
        <Route path="dywidendy" element={<Dividends />} />
        <Route path="obligacje" element={<Bonds />} />
        <Route path="aktualnosci" element={<News />} />
        <Route path="alerty" element={<Alerts />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="podatki" element={<Tax />} />
        <Route path="ustawienia" element={<Settings />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
