import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ASSET_CLASS_LABELS } from '@portfolio/shared';
import type { AssetClass } from '@portfolio/shared';
import { Card, ErrorBanner, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

/**
 * Analiza techniczna pojedynczego instrumentu.
 *
 * Sygnały są listą zaobserwowanych zdarzeń z datami — świadomie nie
 * przekładają się na żadne zalecenie transakcyjne.
 */
export function InstrumentDetail() {
  const { id } = useParams();
  const instrumentId = Number(id);
  const { data, error, loading, reload } = useAsync(() => api.analytics.technical(instrumentId), [instrumentId]);

  const series = useMemo(() => {
    if (!data) return [];
    return data.candles.map((candle, index) => ({
      date: candle.date,
      close: candle.closeE8 / 1e8,
      sma50: nullableDiv(data.indicators.sma50[index]),
      sma200: nullableDiv(data.indicators.sma200[index]),
      rsi: data.indicators.rsi14[index] ?? null,
    }));
  }, [data]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const { instrument, state, signals } = data;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">{instrument.symbol}</h1>
        <span className="text-sm text-content-secondary">{instrument.name}</span>
        <span className="badge bg-surface-overlay text-content-secondary">
          {ASSET_CLASS_LABELS[instrument.assetClass as AssetClass]}
        </span>
        <span className="text-2xs text-content-muted">
          {instrument.exchange ?? '—'} · {instrument.currency}
          {instrument.sector ? ` · ${instrument.sector}` : ''}
        </span>
        <button type="button" className="btn ml-auto text-2xs" onClick={() => void api.instruments.backfill(instrumentId).then(reload)}>
          Uzupełnij historię notowań
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="RSI (14)" value={state.rsi === null ? '—' : state.rsi.toFixed(1)} tone={rsiTone(state.rsiZone)} />
        <StatTile
          label="Układ średnich"
          value={state.trend === 'bullish' ? 'SMA50 > SMA200' : state.trend === 'bearish' ? 'SMA50 < SMA200' : '—'}
          tone={state.trend === 'bullish' ? 'gain' : state.trend === 'bearish' ? 'loss' : 'neutral'}
        />
        <StatTile label="Świec w historii" value={String(data.candles.length)} tone="neutral" />
        <StatTile label="Sygnałów" value={String(signals.length)} tone="neutral" />
      </div>

      <Card title="Notowania i średnie kroczące">
        {series.length < 2 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
            Za mało danych. Kliknij „Uzupełnij historię notowań”, żeby pobrać przebieg z ostatnich lat.
          </p>
        ) : (
          <div className="h-72 px-2 pb-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
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
                  width={56}
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgb(var(--surface-overlay))',
                    border: '1px solid rgb(var(--surface-border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(label: string) => formatDate(label)}
                />
                <Line type="monotone" dataKey="close" stroke="rgb(var(--accent))" dot={false} strokeWidth={1.6} name="Kurs" />
                <Line type="monotone" dataKey="sma50" stroke="#fbbf24" dot={false} strokeWidth={1} name="SMA 50" />
                <Line type="monotone" dataKey="sma200" stroke="#a78bfa" dot={false} strokeWidth={1} name="SMA 200" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="Sygnały techniczne">
        {signals.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Brak wykrytych przecięć w dostępnej historii.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {signals.slice(0, 25).map((signal, index) => (
              <li key={`${signal.date}-${index}`} className="flex items-baseline gap-3 px-4 py-2">
                <span className="tabular w-24 shrink-0 text-2xs text-content-muted">{formatDate(signal.date)}</span>
                <span className={`text-sm font-medium ${signalTone(signal.kind)}`}>{signal.label}</span>
                <span className="text-2xs text-content-muted">{signal.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 pb-3 pt-1 text-2xs text-content-muted">
          Lista zdarzeń technicznych ma charakter informacyjny. Nie stanowi rekomendacji ani doradztwa inwestycyjnego.
        </p>
      </Card>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone: 'gain' | 'loss' | 'warn' | 'neutral' }) {
  const toneClass =
    tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : '';
  return (
    <div className="card px-4 py-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-content-muted">{label}</div>
      <div className={`tabular mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function rsiTone(zone: string | null): 'gain' | 'loss' | 'warn' | 'neutral' {
  if (zone === 'overbought') return 'warn';
  if (zone === 'oversold') return 'warn';
  return 'neutral';
}

function signalTone(kind: string): string {
  if (kind === 'golden_cross' || kind === 'macd_bullish' || kind === 'rsi_oversold') return 'text-gain';
  if (kind === 'death_cross' || kind === 'macd_bearish' || kind === 'rsi_overbought') return 'text-loss';
  return '';
}

function nullableDiv(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value / 1e8;
}
