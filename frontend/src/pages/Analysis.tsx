import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { XirrResult } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, KpiTile, Spinner, Toast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatPercent, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

/** Kolory serii: portfel wyróżniony, benchmarki stonowane. */
const SERIES_COLORS = ['#fbbf24', '#a78bfa', '#34d399', '#f472b6'];

/**
 * Stopy zwrotu i porównanie z benchmarkami.
 *
 * XIRR jest tu miarą główną, bo przy comiesięcznych dopłatach zwykły procent
 * zysku nie mówi nic sensownego — pieniądze pracowały różnie długo.
 */
export function Analysis() {
  const portfolioId = usePortfolioParam();
  const [selected, setSelected] = useState<string[]>(['WIG20TR', 'SP500']);
  const [busy, setBusy] = useState(false);
  const { toast, show, dismiss } = useToast();

  const benchmarks = useAsync(() => api.analytics.benchmarks(), []);
  const analytics = useAsync(
    () => api.analytics.get({ portfolioId, benchmarks: selected.join(',') }),
    [portfolioId, selected.join(',')],
  );

  const chartData = useMemo(() => {
    if (!analytics.data) return [];

    // Scalamy serie po sumie dat, nie tylko po datach portfela. Historia
    // portfela zaczyna się od pierwszego snapshotu, więc opieranie osi na niej
    // ukryłoby benchmarki przy świeżej instalacji.
    const byDate = new Map<string, Record<string, number | string>>();

    const ensureRow = (date: string): Record<string, number | string> => {
      const existing = byDate.get(date);
      if (existing) return existing;
      const created: Record<string, number | string> = { date };
      byDate.set(date, created);
      return created;
    };

    for (const point of analytics.data.portfolioIndexed) {
      ensureRow(point.date).Portfel = point.indexed / 100;
    }

    for (const series of analytics.data.benchmarks) {
      for (const point of series.points) {
        ensureRow(point.date)[series.label] = point.indexed / 100;
      }
    }

    return [...byDate.values()].sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  }, [analytics.data]);

  const refreshBenchmarks = async () => {
    setBusy(true);
    try {
      const result = await api.analytics.refreshBenchmarks();
      analytics.reload();
      show(result.message, 'success');
    } catch {
      show('Nie udało się pobrać notowań benchmarków', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (analytics.loading) return <Spinner />;
  if (analytics.error) return <ErrorBanner message={analytics.error} onRetry={analytics.reload} />;
  if (!analytics.data) return null;

  const { portfolioXirr, positionXirr, benchmarks: series } = analytics.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="XIRR portfela"
          value={formatPercent(portfolioXirr.rateBp, { sign: true })}
          hint={
            portfolioXirr.converged
              ? `${portfolioXirr.cashflowCount} przepływów od ${formatDate(portfolioXirr.from)}`
              : 'Za mało danych do wyliczenia'
          }
        />
        {series.slice(0, 3).map((benchmark) => (
          <KpiTile
            key={benchmark.symbol}
            label={benchmark.label}
            value={formatPercent(benchmark.totalReturnBp, { sign: true })}
            hint="Zwrot w tym samym okresie"
          />
        ))}
      </div>

      <Card
        title="Portfel na tle benchmarków (start = 100)"
        action={
          <button type="button" className="btn btn-ghost text-2xs" onClick={() => void refreshBenchmarks()} disabled={busy}>
            {busy ? 'Pobieram…' : 'Odśwież benchmarki'}
          </button>
        }
      >
        <div className="flex flex-wrap gap-2 px-4 py-2">
          {(benchmarks.data ?? []).map((benchmark) => {
            const active = selected.includes(benchmark.key);
            return (
              <button
                key={benchmark.key}
                type="button"
                className={`badge border ${active ? 'border-accent bg-accent/15 text-accent' : 'border-surface-border text-content-muted'}`}
                onClick={() =>
                  setSelected((current) =>
                    current.includes(benchmark.key)
                      ? current.filter((k) => k !== benchmark.key)
                      : [...current, benchmark.key],
                  )
                }
              >
                {benchmark.label}
              </button>
            );
          })}
        </div>

        {chartData.length < 2 ? (
          <p className="px-4 pb-4 text-sm text-content-muted">
            Porównanie wymaga historii wartości portfela. Powstaje ona z dziennych snapshotów — jeśli aplikacja
            działa krótko, zaimportuj historię z arkusza Inwestomatu albo poczekaj kilka dni.
          </p>
        ) : (
          <div className="h-80 px-2 pb-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => formatDate(v)}
                  tick={{ fontSize: 11, fill: 'rgb(var(--content-muted))' }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={50}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 11, fill: 'rgb(var(--content-muted))' }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgb(var(--surface-overlay))',
                    border: '1px solid rgb(var(--surface-border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(label: string) => formatDate(label)}
                  formatter={(value: number) => value.toFixed(1)}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="Portfel"
                  stroke="rgb(var(--accent))"
                  strokeWidth={2.2}
                  dot={false}
                  connectNulls
                />
                {series.map((benchmark, index) => (
                  <Line
                    key={benchmark.symbol}
                    type="monotone"
                    dataKey={benchmark.label}
                    stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                    strokeWidth={1.2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="Stopa zwrotu per pozycja (XIRR)">
        {positionXirr.length === 0 ? (
          <EmptyState title="Brak danych" description="XIRR wymaga co najmniej dwóch przepływów w różnych dniach." />
        ) : (
          <DataTable
            headers={[
              'Instrument',
              { label: 'XIRR', align: 'right' },
              { label: 'Przepływów', align: 'right' },
              'Od',
              'Status',
            ]}
          >
            {positionXirr.map((entry) => (
              <tr key={entry.instrumentId} className="hover:bg-surface-overlay/50">
                <td className="table-cell">
                  <Link to={`/instrument/${entry.instrumentId}`} className="hover:text-accent">
                    <span className="font-medium">{entry.symbol}</span>
                    <span className="ml-2 text-2xs text-content-muted">{entry.name}</span>
                  </Link>
                </td>
                <td className={`table-cell tabular text-right font-medium ${toneClass(entry.xirr.rateBp)}`}>
                  {formatPercent(entry.xirr.rateBp, { sign: true })}
                </td>
                <td className="table-cell tabular text-right text-content-secondary">{entry.xirr.cashflowCount}</td>
                <td className="table-cell tabular text-content-secondary">{formatDate(entry.xirr.from)}</td>
                <td className="table-cell text-2xs text-content-muted">{statusLabel(entry.xirr)}</td>
              </tr>
            ))}
          </DataTable>
        )}
        <p className="px-4 py-3 text-2xs text-content-muted">
          XIRR to roczna stopa zwrotu uwzględniająca terminy przepływów. Przy regularnych dopłatach jest
          uczciwszą miarą niż zwykły procent zysku, bo kapitał wpłacony miesiąc temu pracował krócej niż ten
          sprzed roku.
        </p>
      </Card>

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

function statusLabel(xirr: XirrResult): string {
  if (xirr.converged) return 'policzone';
  if (xirr.cashflowCount < 2) return 'za mało przepływów';
  return 'brak rozwiązania';
}
