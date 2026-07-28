import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AllocationSlice, SnapshotPoint } from '@portfolio/shared';
import { RefreshBar } from '@/components/RefreshBar';
import { Card, EmptyState, ErrorBanner, KpiTile, Spinner, WarningList } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

/**
 * Paleta wykresów alokacji.
 *
 * Odcienie różnią się jasnością, nie tylko barwą — dzięki temu sektory da się
 * odróżnić także przy zaburzeniach rozpoznawania kolorów i na wydruku.
 */
const SLICE_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#94a3b8'];

export function Dashboard() {
  const portfolioId = usePortfolioParam();
  const { data, error, loading, reload } = useAsync(() => api.analytics.dashboard(portfolioId), [portfolioId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const { summary, allocation, history, topMovers, warnings } = data;
  const hasData = summary.valuePlnMinor !== 0 || summary.positionsCount > 0;

  if (!hasData) {
    return (
      <EmptyState
        title="Portfel jest pusty"
        description="Zaimportuj wyciąg z brokera albo dodaj pierwszą transakcję ręcznie."
        action={
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Link className="btn btn-primary" to="/import">
              Importuj plik
            </Link>
            <Link className="btn" to="/transakcje">
              Dodaj transakcję
            </Link>
            <Link className="btn btn-ghost" to="/pomoc">
              Jak to działa?
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <RefreshBar />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
        <KpiTile
          label="Wartość portfela"
          value={formatPln(summary.valuePlnMinor)}
          change={summary.dayChangeBp}
          changeLabel="dziś"
        />
        <KpiTile
          label="Wynik całkowity"
          value={formatPln(summary.totalReturnPlnMinor, { sign: true })}
          change={summary.totalReturnBp}
          hint={`Wpłacono ${formatPln(summary.investedPlnMinor)}`}
        />
        <KpiTile
          label="Niezrealizowany"
          value={formatPln(summary.unrealizedPlnMinor, { sign: true })}
          hint={`${summary.positionsCount} pozycji`}
        />
        <KpiTile
          label="Zrealizowany"
          value={formatPln(summary.realizedPlnMinor, { sign: true })}
          hint="Suma zamkniętych transakcji"
        />
        <KpiTile
          label="Gotówka"
          value={formatPln(summary.cashPlnMinor)}
          change={summary.weekChangeBp}
          changeLabel="tydzień"
        />
      </div>

      <WarningList warnings={warnings} />

      <EmergencyFundCard portfolioId={portfolioId} />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Wartość portfela w czasie" className="xl:col-span-2">
          <ValueChart history={history} />
        </Card>

        <Card title="Alokacja wg klas aktywów">
          <AllocationChart slices={allocation.assetClass} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Alokacja walutowa">
          <AllocationList slices={allocation.currency} />
        </Card>
        <Card title="Alokacja sektorowa">
          <AllocationList slices={allocation.sector} emptyHint="Uzupełnij sektory na instrumentach." />
        </Card>
        <Card title="Alokacja geograficzna">
          <AllocationList slices={allocation.geo} emptyHint="Uzupełnij kraje na instrumentach." />
        </Card>
      </div>

      <Card title="Największe zmiany dzienne">
        {topMovers.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Brak danych o zmianach dziennych.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {topMovers.map((mover) => (
              <li key={mover.instrument.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <Link to={`/instrument/${mover.instrument.id}`} className="min-w-0 flex-1 hover:text-accent">
                  <span className="text-sm font-medium">{mover.instrument.symbol}</span>
                  <span className="ml-2 truncate text-2xs text-content-muted">{mover.instrument.name}</span>
                </Link>
                <span className={`tabular text-sm ${toneClass(mover.dayChangeBp)}`}>
                  {formatPercent(mover.dayChangeBp, { sign: true })}
                </span>
                <span className={`tabular w-24 text-right text-sm ${toneClass(mover.dayChangePlnMinor)}`}>
                  {formatPln(mover.dayChangePlnMinor ?? 0, { sign: true })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Poduszka finansowa na pulpicie.
 *
 * Pokazujemy ją osobno od wyniku inwestycyjnego, bo pełni inną rolę: nie ma
 * zarabiać, tylko wystarczyć na określoną liczbę miesięcy wydatków.
 */
function EmergencyFundCard({ portfolioId }: { portfolioId: number | undefined }) {
  const { data } = useAsync(() => api.insights.get(portfolioId), [portfolioId]);
  const fund = data?.emergencyFund;

  if (!fund) return null;

  if (!fund.configured) {
    return (
      <div className="rounded-card border border-surface-border bg-surface-overlay px-4 py-3 text-2xs text-content-muted">
        Nie oznaczono żadnego portfela jako poduszki finansowej. Zrobisz to w{' '}
        <Link className="text-accent hover:underline" to="/ustawienia">
          Ustawieniach
        </Link>
        , a wtedy zostanie wyłączona z propozycji rebalansu i pokaże, na ile miesięcy wydatków wystarcza.
      </div>
    );
  }

  const complete = (fund.completionBp ?? 0) >= 10_000;

  return (
    <Card title="Poduszka finansowa">
      <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4">
        <div>
          <div className="text-2xs uppercase tracking-wide text-content-muted">Zgromadzone</div>
          <div className="tabular mt-0.5 text-lg font-semibold">{formatPln(fund.currentPlnMinor)}</div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wide text-content-muted">Cel</div>
          <div className="tabular mt-0.5 text-lg">
            {fund.targetPlnMinor > 0 ? formatPln(fund.targetPlnMinor) : '—'}
          </div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wide text-content-muted">Pokrycie</div>
          <div className={`tabular mt-0.5 text-lg font-semibold ${complete ? 'text-gain' : ''}`}>
            {fund.coveredMonths === null ? '—' : `${fund.coveredMonths} mies.`}
          </div>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-wide text-content-muted">Portfele</div>
          <div className="mt-0.5 truncate text-sm text-content-secondary">{fund.portfolioNames.join(', ')}</div>
        </div>
      </div>

      {fund.completionBp !== null && (
        <div className="px-4 pb-4">
          <div className="h-2 overflow-hidden rounded-full bg-surface-overlay">
            <div
              className={`h-full rounded-full ${complete ? 'bg-gain' : 'bg-accent'}`}
              style={{ width: `${Math.min(fund.completionBp / 100, 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-2xs text-content-muted">
            {fund.monthlyExpensesPlnMinor === 0
              ? 'Podaj miesięczne wydatki w Ustawieniach, żeby zobaczyć pokrycie w miesiącach.'
              : complete
                ? `Cel ${fund.targetMonths} miesięcy osiągnięty.`
                : `Do celu ${fund.targetMonths} miesięcy brakuje ${formatPln(Math.max(fund.targetPlnMinor - fund.currentPlnMinor, 0))}.`}
          </p>
        </div>
      )}
    </Card>
  );
}

function ValueChart({ history }: { history: SnapshotPoint[] }) {
  const series = useMemo(
    () =>
      history.map((point) => ({
        date: point.date,
        value: point.valuePlnMinor / 100,
        invested: point.investedPlnMinor / 100,
      })),
    [history],
  );

  if (series.length < 2) {
    return (
      <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
        Historia wartości pojawi się po pierwszym dziennym zapisie. Możesz też zaimportować ją z arkusza Inwestomatu.
      </p>
    );
  }

  return (
    <div className="h-64 px-2 pb-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity={0.35} />
              <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fontSize: 11, fill: 'rgb(var(--content-muted))' }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'rgb(var(--content-muted))' }}
            axisLine={false}
            tickLine={false}
            width={64}
            tickFormatter={(v: number) => new Intl.NumberFormat('pl-PL', { notation: 'compact' }).format(v)}
          />
          <Tooltip
            contentStyle={{
              background: 'rgb(var(--surface-overlay))',
              border: '1px solid rgb(var(--surface-border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(label: string) => formatDate(label)}
            formatter={(value: number, name) => [
              new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value),
              name === 'value' ? 'Wartość' : 'Wpłacony kapitał',
            ]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="rgb(var(--accent))"
            strokeWidth={2}
            fill="url(#valueFill)"
            name="value"
          />
          <Area
            type="monotone"
            dataKey="invested"
            stroke="rgb(var(--content-muted))"
            strokeWidth={1}
            strokeDasharray="4 3"
            fill="none"
            name="invested"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function AllocationChart({ slices }: { slices: AllocationSlice[] }) {
  if (slices.length === 0) {
    return <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Brak pozycji do pokazania.</p>;
  }

  const data = slices.map((slice) => ({ name: slice.label, value: slice.valuePlnMinor / 100, shareBp: slice.shareBp }));

  return (
    <div className="h-64 px-2 pb-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={1}>
            {data.map((_, index) => (
              <Cell key={index} fill={SLICE_COLORS[index % SLICE_COLORS.length]} stroke="none" />
            ))}
          </Pie>
          <Legend
            verticalAlign="bottom"
            height={48}
            formatter={(value: string, entry) => {
              const payload = entry.payload as unknown as { shareBp?: number } | undefined;
              return (
                <span className="text-2xs text-content-secondary">
                  {value} {payload?.shareBp !== undefined ? formatPercent(payload.shareBp, { digits: 1 }) : ''}
                </span>
              );
            }}
          />
          <Tooltip
            contentStyle={{
              background: 'rgb(var(--surface-overlay))',
              border: '1px solid rgb(var(--surface-border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value: number) =>
              new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value)
            }
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function AllocationList({ slices, emptyHint }: { slices: AllocationSlice[]; emptyHint?: string }) {
  if (slices.length === 0) {
    return <p className="px-4 pb-4 pt-2 text-sm text-content-muted">{emptyHint ?? 'Brak danych.'}</p>;
  }

  return (
    <ul className="space-y-1.5 p-4 pt-2">
      {slices.slice(0, 8).map((slice, index) => (
        <li key={slice.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">{slice.label}</span>
            <span className="tabular text-content-secondary">{formatPercent(slice.shareBp, { digits: 1 })}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(slice.shareBp / 100, 100)}%`,
                background: SLICE_COLORS[index % SLICE_COLORS.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
