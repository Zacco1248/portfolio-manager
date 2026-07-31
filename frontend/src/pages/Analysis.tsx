import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { XirrResult } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, KpiTile, Spinner, Toast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import type { StatsResponse } from '@/lib/api';
import { formatDate, formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';
import { AXIS_TICK, TOOLTIP_STYLE, useAxisDensity } from '@/lib/chart';

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
  const { minTickGap, yAxisWidth } = useAxisDensity();
  const [selected, setSelected] = useState<string[]>(['WIG20TR', 'SP500']);
  const [busy, setBusy] = useState(false);
  const { toast, show, dismiss } = useToast();

  const benchmarks = useAsync(() => api.analytics.benchmarks(), []);
  const stats = useAsync(() => api.analytics.stats(portfolioId), [portfolioId]);
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

    // Serie znormalizowane do 100 pokazujemy jako zmianę procentową od
    // początku okresu. Wykres w wartościach indeksu jest nieczytelny: 100 to
    // punkt odniesienia, a nie wartość, którą da się porównać z czymkolwiek.
    for (const point of analytics.data.portfolioIndexed) {
      ensureRow(point.date).Portfel = point.indexed / 100 - 100;
    }

    for (const series of analytics.data.benchmarks) {
      for (const point of series.points) {
        ensureRow(point.date)[series.label] = point.indexed / 100 - 100;
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
        title="Portfel na tle benchmarków (zmiana od początku okresu)"
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

        <p className="px-4 pb-2 text-2xs text-content-muted">
          Linia portfela to stopa zwrotu ważona czasem: pokazuje, ile zarobiłaby złotówka trzymana od początku
          okresu, niezależnie od tego, ile i kiedy dopłacałeś. Dlatego potrafi się rozjechać z XIRR powyżej —
          jeśli większość kapitału wpłaciłeś po spadku i odrobiłeś go razem z rynkiem, XIRR będzie wysoki,
          a ta linia niska. To nie sprzeczność, tylko dwie odpowiedzi na dwa różne pytania: „ile zarobiły
          moje pieniądze" i „jak radził sobie sam portfel".
        </p>

        {chartData.length < 2 ? (
          <p className="px-4 pb-4 text-sm text-content-muted">
            Porównanie wymaga historii wartości portfela. Powstaje ona z dziennych snapshotów — jeśli aplikacja
            działa krótko, zaimportuj historię z arkusza Inwestomatu albo poczekaj kilka dni.
          </p>
        ) : (
          <div className="chart-box-lg px-2 pb-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v: string) => formatDate(v)}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={minTickGap}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={yAxisWidth}
                  tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`}
                />
                <ReferenceLine y={0} stroke="rgb(var(--content-muted))" strokeDasharray="3 3" />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(label: string) => formatDate(label)}
                  formatter={(value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}
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

      {stats.data && <RiskCard stats={stats.data} />}
      {stats.data && <DrawdownCard risk={stats.data.risk} />}
      {stats.data && <ContributionCard contributions={stats.data.contributions} />}

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

/**
 * Ryzyko i struktura.
 *
 * XIRR mówi ile, ale nie mówi jak — dwa portfele z tym samym wynikiem rocznym
 * mogą się różnić tym, że jeden po drodze stracił połowę wartości. Te liczby
 * pokazują drugą stronę wyniku.
 */
function RiskCard({ stats }: { stats: StatsResponse }) {
  const { risk, concentration } = stats;
  const bp = (value: number | null, digits = 1) => (value === null ? '—' : formatPercent(value, { digits }));

  return (
    <Card title="Ryzyko i struktura">
      <div className="grid grid-cols-2 gap-3 p-4 pt-2 lg:grid-cols-4">
        <StatBox
          label="Zmienność roczna"
          value={bp(risk.volatilityBp)}
          hint={
            risk.volatilityBp === null
              ? `Potrzeba ok. 20 dni historii (mamy ${risk.observations})`
              : 'Odchylenie dziennych zwrotów w skali roku'
          }
        />
        <StatBox
          label="Największe obsunięcie"
          value={risk.maxDrawdownBp === null ? '—' : `−${(risk.maxDrawdownBp / 100).toFixed(1)}%`}
          hint={
            risk.maxDrawdownFrom
              ? `${formatDate(risk.maxDrawdownFrom)} → ${formatDate(risk.maxDrawdownTo ?? risk.maxDrawdownFrom)}`
              : 'Brak obsunięć w historii'
          }
        />
        <StatBox
          label="Obecnie od szczytu"
          value={risk.drawdownNowBp === null ? '—' : `−${(risk.drawdownNowBp / 100).toFixed(1)}%`}
          hint={risk.drawdownNowBp === 0 ? 'Portfel jest na szczycie' : 'Dystans do historycznego maksimum'}
        />
        <StatBox
          label="Dni na plusie"
          value={
            risk.positiveDays + risk.negativeDays === 0
              ? '—'
              : `${Math.round((risk.positiveDays / (risk.positiveDays + risk.negativeDays)) * 100)}%`
          }
          hint={`${risk.positiveDays} wzrostowych, ${risk.negativeDays} spadkowych`}
        />
        <StatBox
          label="Najlepszy miesiąc"
          value={risk.bestMonth ? formatPercent(risk.bestMonth.changeBp, { sign: true }) : '—'}
          hint={risk.bestMonth?.month ?? 'Za krótka historia'}
          tone={risk.bestMonth ? toneClass(risk.bestMonth.changeBp) : undefined}
        />
        <StatBox
          label="Najgorszy miesiąc"
          value={risk.worstMonth ? formatPercent(risk.worstMonth.changeBp, { sign: true }) : '—'}
          hint={risk.worstMonth?.month ?? 'Za krótka historia'}
          tone={risk.worstMonth ? toneClass(risk.worstMonth.changeBp) : undefined}
        />
        <StatBox
          label="Koncentracja (HHI)"
          value={concentration.hhi === 0 ? '—' : String(concentration.hhi)}
          hint={hhiLabel(concentration.hhi)}
        />
        <StatBox
          label="Trzy największe"
          value={formatPercent(concentration.top3ShareBp, { digits: 0 })}
          hint={`${concentration.positionCount} pozycji w portfelu`}
        />
      </div>

      {concentration.largest.length > 0 && (
        <div className="border-t border-surface-border px-4 py-3">
          <div className="text-2xs uppercase tracking-wide text-content-muted">Największe pozycje</div>
          <ul className="mt-2 space-y-1.5">
            {concentration.largest.map((entry) => (
              <li key={entry.symbol} className="flex items-center gap-3 text-2xs">
                <span className="w-28 shrink-0 truncate font-medium">{entry.symbol}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded bg-surface-overlay">
                  <span
                    className="block h-full rounded bg-accent"
                    style={{ width: `${Math.min(entry.shareBp / 100, 100)}%` }}
                  />
                </span>
                <span className="tabular w-12 shrink-0 text-right text-content-secondary">
                  {(entry.shareBp / 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
        {stats.note} Największe obsunięcie bywa głębsze niż najgorszy miesiąc — spadek rozłożony na kilka
        miesięcy sumuje się, choć żaden z nich z osobna nie był aż tak zły.
      </p>
    </Card>
  );
}

/**
 * Wykres obsunięcia od szczytu.
 *
 * Przebieg wartości portfela pokazuje, ile jest teraz. Ten wykres pokazuje coś
 * innego: jak głęboko i jak długo portfel bywał pod wodą. Zero to nowy szczyt,
 * a płaskie odcinki blisko dna mówią więcej o wytrzymałości potrzebnej do
 * trzymania tej strategii niż jakakolwiek roczna stopa zwrotu.
 *
 * Liczone na indeksie TWR, nie na saldzie — inaczej każda wypłata z konta
 * wyglądałaby jak krach.
 */
function DrawdownCard({ risk }: { risk: StatsResponse['risk'] }) {
  const { minTickGap, yAxisWidth } = useAxisDensity();
  const series = risk.drawdownSeries;

  if (series.length < 2) {
    return (
      <Card title="Obsunięcie od szczytu">
        <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
          Wykres powstaje z dziennych snapshotów wartości portfela. Mamy ich na razie {risk.observations} —
          zbierają się codziennie o 23:50, a wcześniejszą historię można wnieść importem arkusza Inwestomatu.
        </p>
      </Card>
    );
  }

  const deepest = Math.min(...series.map((point) => point.drawdownBp));

  return (
    <Card
      title="Obsunięcie od szczytu"
      action={
        <span className="text-2xs text-content-muted">
          Najgłębiej {(deepest / 100).toFixed(1)}%
          {risk.maxDrawdownFrom ? ` · ${formatDate(risk.maxDrawdownFrom)} → ${formatDate(risk.maxDrawdownTo ?? risk.maxDrawdownFrom)}` : ''}
        </span>
      }
    >
      <div className="chart-box px-2 pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={series.map((point) => ({ date: point.date, drawdown: point.drawdownBp / 100 }))}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="drawdown-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--loss))" stopOpacity={0.05} />
                <stop offset="100%" stopColor="rgb(var(--loss))" stopOpacity={0.35} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => formatDate(v)}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              minTickGap={minTickGap}
            />
            <YAxis
              domain={[(min: number) => Math.min(min * 1.1, -1), 0]}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={yAxisWidth}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="rgb(var(--content-muted))" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(label: string) => formatDate(label)}
              formatter={(value: number) => [`${value.toFixed(2)}%`, 'Poniżej szczytu']}
            />
            <Area
              type="monotone"
              dataKey="drawdown"
              stroke="rgb(var(--loss))"
              strokeWidth={1.6}
              fill="url(#drawdown-fill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
        Zero oznacza nowy szczyt wartości. Wykres liczony jest z indeksu ważonego czasem, więc wpłaty
        i wypłaty go nie zniekształcają — widać wyłącznie zmianę wyceny aktywów.
      </p>
    </Card>
  );
}

/** Opis wskaźnika koncentracji — sama liczba niewiele mówi. */
function hhiLabel(hhi: number): string {
  if (hhi === 0) return 'Brak pozycji';
  if (hhi < 1500) return 'Struktura rozproszona';
  if (hhi < 2500) return 'Umiarkowana koncentracja';
  return 'Wysoka koncentracja';
}

/**
 * Wkład pozycji w wynik.
 *
 * Odpowiada na pytanie, którego nie zadaje XIRR: czy zysk portfela pochodzi
 * z całej struktury, czy z jednej pozycji, która przykryła resztę.
 */
function ContributionCard({ contributions }: { contributions: StatsResponse['contributions'] }) {
  if (contributions.length === 0) return null;

  const winners = contributions.filter((c) => c.totalPlnMinor > 0).slice(0, 5);
  const losers = contributions
    .filter((c) => c.totalPlnMinor < 0)
    .slice(-5)
    .reverse();

  return (
    <Card title="Kto zarobił, kto stracił">
      <div className="grid gap-0 sm:grid-cols-2">
        <ContributionList title="Największy wkład" entries={winners} emptyText="Żadna pozycja nie jest na plusie" />
        <ContributionList
          title="Największe obciążenie"
          entries={losers}
          emptyText="Żadna pozycja nie jest na minusie"
          bordered
        />
      </div>
      <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
        Wynik pozycji to zysk niezrealizowany plus zrealizowany. Udział liczony wobec sumy wartości
        bezwzględnych, żeby przy wyniku bliskim zera procenty nie wystrzeliły.
      </p>
    </Card>
  );
}

function ContributionList({
  title,
  entries,
  emptyText,
  bordered = false,
}: {
  title: string;
  entries: StatsResponse['contributions'];
  emptyText: string;
  bordered?: boolean;
}) {
  return (
    <div className={bordered ? 'sm:border-l sm:border-surface-border' : ''}>
      <div className="px-4 pt-3 text-2xs uppercase tracking-wide text-content-muted">{title}</div>
      {entries.length === 0 ? (
        <p className="px-4 py-3 text-2xs text-content-muted">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {entries.map((entry) => (
            <li key={entry.instrumentId} className="flex items-baseline gap-3 px-4 py-2">
              <Link
                to={`/instrument/${entry.instrumentId}`}
                className="min-w-0 flex-1 truncate text-sm hover:text-accent"
              >
                <span className="font-medium">{entry.symbol || entry.name}</span>
                {entry.symbol && <span className="ml-2 text-2xs text-content-muted">{entry.name}</span>}
              </Link>
              <span className="tabular shrink-0 text-2xs text-content-muted">
                {(entry.shareOfResultBp / 100).toFixed(0)}%
              </span>
              <span className={`tabular shrink-0 text-sm font-medium ${toneClass(entry.totalPlnMinor)}`}>
                {formatPln(entry.totalPlnMinor, { sign: true })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatBox({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-overlay/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-content-muted">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular ${tone ?? ''}`}>{value}</div>
      <div className="mt-0.5 text-2xs text-content-muted">{hint}</div>
    </div>
  );
}

function statusLabel(xirr: XirrResult): string {
  if (xirr.converged) return 'policzone';
  if (xirr.cashflowCount < 2) return 'za mało przepływów';
  return 'brak rozwiązania';
}
