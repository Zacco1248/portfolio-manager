import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { AiDisclaimer, AiPending, Card, ErrorBanner, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

const KIND_STYLE: Record<string, { icon: string; className: string }> = {
  achievement: { icon: '✓', className: 'border-gain/40 bg-gain/5' },
  milestone: { icon: '◆', className: 'border-accent/40 bg-accent/5' },
  habit: { icon: '↻', className: 'border-surface-border bg-surface-overlay' },
  projection: { icon: '→', className: 'border-surface-border bg-surface-overlay' },
  attention: { icon: '!', className: 'border-warn/40 bg-warn/5' },
};

/**
 * Podsumowanie osiągnięć i projekcja.
 *
 * Wszystkie liczby są wyliczane lokalnie z danych użytkownika. Komentarz od
 * modelu językowego jest opcjonalną warstwą na wierzchu i pojawia się dopiero
 * po świadomym włączeniu tej funkcji w ustawieniach.
 */
export function Insights() {
  const portfolioId = usePortfolioParam();
  const { data, error, loading, reload } = useAsync(() => api.insights.get(portfolioId), [portfolioId]);

  // Komentarz modelu leci osobno i nie wstrzymuje liczb — patrz AiPending.
  const narrative = useAsync(() => api.insights.narrative(portfolioId), [portfolioId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const { insights, projection, emergencyFund } = data;
  const last = projection.points.at(-1);
  const growth = last ? last.valuePlnMinor - last.contributedPlnMinor : 0;

  const chartData = projection.points.map((point) => ({
    label: `${point.year} r.`,
    Wartość: point.valuePlnMinor / 100,
    'Sam kapitał': point.contributedPlnMinor / 100,
  }));

  return (
    <div className="space-y-4">
      {(narrative.loading || narrative.data?.narrative) && (
        <Card title="Komentarz">
          {narrative.loading ? (
            <AiPending />
          ) : (
            <>
              <p className="whitespace-pre-line px-4 pb-3 pt-2 text-sm text-content-secondary">
                {narrative.data?.narrative}
              </p>
              <div className="px-4 pb-4">
                <AiDisclaimer text="Komentarz wygenerowany automatycznie. Nie stanowi rekomendacji ani doradztwa inwestycyjnego." />
              </div>
            </>
          )}
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {insights.map((insight, index) => {
          const style = KIND_STYLE[insight.kind] ?? KIND_STYLE.habit!;
          return (
            <article key={index} className={`rounded-card border px-4 py-3 ${style.className}`}>
              <div className="flex items-baseline gap-2">
                <span className="text-sm">{style.icon}</span>
                <h3 className="text-sm font-medium">{insight.title}</h3>
              </div>
              <p className="mt-1 text-2xs text-content-secondary">{insight.detail}</p>
              {insight.valuePlnMinor !== null && (
                <p className={`tabular mt-1.5 text-lg font-semibold ${toneClass(insight.valuePlnMinor)}`}>
                  {formatPln(insight.valuePlnMinor, { sign: insight.kind !== 'milestone' })}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <Card title="Gdzie będziesz za 5 lat przy tym tempie">
        <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4">
          <Stat label="Miesięczna wpłata" value={formatPln(projection.monthlyContributionPlnMinor)} />
          <Stat
            label="Założona stopa zwrotu"
            value={formatPercent(projection.assumedAnnualReturnBp)}
            hint={projection.returnSource === 'xirr' ? 'z Twojego XIRR' : 'wartość domyślna'}
          />
          <Stat label="Wartość za 5 lat" value={last ? formatPln(last.valuePlnMinor) : '—'} highlight />
          <Stat label="W tym z procentu składanego" value={formatPln(growth)} />
        </div>

        {chartData.length > 0 && (
          <div className="h-64 px-2 pb-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'rgb(var(--content-muted))' }}
                  axisLine={false}
                  tickLine={false}
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
                  formatter={(value: number) =>
                    new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 }).format(
                      value,
                    )
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area
                  type="monotone"
                  dataKey="Wartość"
                  stroke="rgb(var(--accent))"
                  fill="rgb(var(--accent))"
                  fillOpacity={0.18}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="Sam kapitał"
                  stroke="rgb(var(--content-muted))"
                  fill="none"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        <p className="px-4 pb-4 text-2xs text-content-muted">{projection.note}</p>
      </Card>

      <Card title="Poduszka finansowa">
        {!emergencyFund.configured ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
            Żaden portfel nie jest oznaczony jako poduszka finansowa. Zaznacz go w{' '}
            <Link className="text-accent hover:underline" to="/ustawienia">
              Ustawieniach
            </Link>{' '}
            i podaj miesięczne wydatki — wtedy zobaczysz, na ile miesięcy wystarcza, a rebalans przestanie
            traktować te środki jak kapitał inwestycyjny.
          </p>
        ) : (
          <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4">
            <Stat label="Zgromadzone" value={formatPln(emergencyFund.currentPlnMinor)} highlight />
            <Stat
              label="Cel"
              value={emergencyFund.targetPlnMinor > 0 ? formatPln(emergencyFund.targetPlnMinor) : '—'}
              hint={`${emergencyFund.targetMonths} mies. wydatków`}
            />
            <Stat
              label="Pokrycie"
              value={emergencyFund.coveredMonths === null ? '—' : `${emergencyFund.coveredMonths} mies.`}
            />
            <Stat label="Realizacja celu" value={formatPercent(emergencyFund.completionBp)} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  highlight = false,
}: {
  label: string;
  value: string;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-content-muted">{label}</div>
      <div className={`tabular mt-0.5 text-lg font-semibold ${highlight ? 'text-accent' : ''}`}>{value}</div>
      {hint && <div className="text-2xs text-content-muted">{hint}</div>}
    </div>
  );
}
