import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ASSET_CLASS_LABELS } from '@portfolio/shared';
import type { AssetClass } from '@portfolio/shared';
import { CandlestickChart } from '@/components/CandlestickChart';
import { Card, DataTable, ErrorBanner, Spinner } from '@/components/ui';
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
  const dividends = useAsync(() => api.corporate.dividendHistory(instrumentId), [instrumentId]);
  const [chartMode, setChartMode] = useState<'candles' | 'line'>('candles');

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
        {instrument.assetClass === 'metal' && (
          <label className="ml-auto flex items-center gap-2 text-2xs text-content-muted">
            Jednostka pozycji
            <select
              className="input h-7 w-auto py-0 text-2xs"
              value={instrument.unit ?? 'oz'}
              onChange={(e) => void api.instruments.update(instrumentId, { unit: e.target.value }).then(reload)}
            >
              <option value="oz">uncja trojańska</option>
              <option value="g">gram</option>
              <option value="kg">kilogram</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className={`btn text-2xs ${instrument.assetClass === 'metal' ? '' : 'ml-auto'}`}
          onClick={() => void api.instruments.backfill(instrumentId).then(reload)}
        >
          Uzupełnij historię notowań
        </button>
      </header>

      <ClassificationCard instrument={instrument} onSaved={reload} />

      <PriceMoveCard instrumentId={instrumentId} />

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

      <Card
        title="Notowania i średnie kroczące"
        action={
          <div className="flex gap-1">
            <button
              type="button"
              className={`badge border ${chartMode === 'candles' ? 'border-accent bg-accent/15 text-accent' : 'border-surface-border text-content-muted'}`}
              onClick={() => setChartMode('candles')}
            >
              świece
            </button>
            <button
              type="button"
              className={`badge border ${chartMode === 'line' ? 'border-accent bg-accent/15 text-accent' : 'border-surface-border text-content-muted'}`}
              onClick={() => setChartMode('line')}
            >
              linia
            </button>
          </div>
        }
      >
        {series.length < 2 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
            Za mało danych. Kliknij „Uzupełnij historię notowań”, żeby pobrać przebieg z ostatnich lat.
          </p>
        ) : chartMode === 'candles' ? (
          <CandlestickChart
            candles={data.candles}
            sma50={data.indicators.sma50}
            sma200={data.indicators.sma200}
          />
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

      <Card title="Historia wypłat dywidend">
        {!dividends.data || dividends.data.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
            Brak zapisanych wypłat. Pobierz je przyciskiem „Odśwież dane dywidendowe” w Ustawieniach.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            <DataTable headers={['Dzień ustalenia prawa', { label: 'Kwota na akcję', align: 'right' }]}>
              {dividends.data.map((entry) => (
                <tr key={entry.exDate}>
                  <td className="table-cell tabular">{formatDate(entry.exDate)}</td>
                  <td className="table-cell tabular text-right">
                    {(entry.amountE8 / 1e8).toFixed(4)} {entry.currency}
                  </td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Zestawienie ruchu kursu z wiadomościami z tego samego okresu.
 *
 * Świadomie ładowane na żądanie, nie przy wejściu na stronę: to jedyne miejsce
 * w aplikacji, gdzie treść wiadomości trafia do modelu, więc wywołanie ma być
 * decyzją użytkownika, a nie efektem ubocznym otwarcia zakładki.
 */
function PriceMoveCard({ instrumentId }: { instrumentId: number }) {
  const [state, setState] = useState<{
    busy: boolean;
    result: Awaited<ReturnType<typeof api.assist.priceMove>> | null;
  }>({ busy: false, result: null });

  const run = async () => {
    setState({ busy: true, result: null });
    try {
      setState({ busy: false, result: await api.assist.priceMove(instrumentId) });
    } catch {
      setState({ busy: false, result: null });
    }
  };

  return (
    <Card
      title="Dlaczego kurs się ruszył"
      action={
        <button type="button" className="btn btn-ghost text-2xs" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? 'Sprawdzam…' : 'Sprawdź'}
        </button>
      }
    >
      {!state.result ? (
        <p className="px-4 pb-4 pt-2 text-2xs text-content-muted">
          Zestawia zmianę kursu z ostatnich dwóch tygodni z wiadomościami z tego samego okresu.
          Wymaga włączonej funkcji „Wyjaśnianie ruchów cen" w Ustawieniach.
        </p>
      ) : (
        <>
          {state.result.data && (
            <div className="px-4 pb-2 pt-2">
              <div className="text-2xs text-content-muted">
                Zmiana przez {state.result.data.days} dni:{' '}
                <span className="font-medium text-content-secondary">
                  {state.result.data.changeBp === null
                    ? 'brak notowań'
                    : `${state.result.data.changeBp > 0 ? '+' : ''}${(state.result.data.changeBp / 100).toFixed(2)}%`}
                </span>
                {' · '}
                {state.result.data.headlines.length} wiadomości w tym okresie
              </div>
            </div>
          )}
          {state.result.text ? (
            <p className="whitespace-pre-wrap border-t border-surface-border px-4 py-3 text-sm leading-relaxed text-content-secondary">
              {state.result.text}
            </p>
          ) : (
            <p className="border-t border-surface-border px-4 py-3 text-2xs text-content-muted">
              {state.result.unavailableReason ?? 'Brak komentarza.'}
            </p>
          )}
          <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
            {state.result.disclaimer}
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Ręczna korekta klasyfikacji.
 *
 * Automat rozpoznaje sektor i kraj tylko dla instrumentów, które ma w bazie
 * dostawca notowań — obligacje, metale i część ETF-ów zostają nieprzypisane
 * i psują wykresy struktury. Tu można je uzupełnić raz a dobrze;
 * ponowna klasyfikacja nie nadpisuje wartości wpisanych ręcznie.
 */
function ClassificationCard({
  instrument,
  onSaved,
}: {
  instrument: { id: number; sector: string | null; country: string | null; assetClass: string; emergencyFund?: boolean };
  onSaved: () => void;
}) {
  const [sector, setSector] = useState(instrument.sector ?? '');
  const [country, setCountry] = useState(instrument.country ?? '');
  const [assetClass, setAssetClass] = useState(instrument.assetClass);
  const [status, setStatus] = useState<string | null>(null);

  const dirty =
    sector !== (instrument.sector ?? '') ||
    country !== (instrument.country ?? '') ||
    assetClass !== instrument.assetClass;

  const save = async () => {
    setStatus(null);
    try {
      await api.instruments.update(instrument.id, {
        sector: sector.trim() || null,
        country: country.trim() || null,
        assetClass,
      });
      setStatus('Zapisano');
      onSaved();
    } catch {
      setStatus('Nie udało się zapisać');
    }
  };

  return (
    <Card title="Klasyfikacja">
      <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
        <label className="flex-1 min-w-[10rem] text-2xs text-content-muted">
          Klasa aktywów
          <select className="input mt-1" value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
            {Object.entries(ASSET_CLASS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 min-w-[10rem] text-2xs text-content-muted">
          Sektor
          <input
            className="input mt-1"
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            list="sector-options"
            placeholder="np. Technologia"
          />
        </label>
        <label className="flex-1 min-w-[10rem] text-2xs text-content-muted">
          Kraj / region
          <input
            className="input mt-1"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            list="country-options"
            placeholder="np. Polska"
          />
        </label>
        <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>
          Zapisz
        </button>
        <label className="flex items-center gap-2 text-2xs text-content-secondary">
          <input
            type="checkbox"
            checked={instrument.emergencyFund === true}
            onChange={(e) =>
              void api.instruments
                .update(instrument.id, { emergencyFund: e.target.checked })
                .then(onSaved)
            }
          />
          Wlicza się do poduszki finansowej
        </label>
        {status && <span className="text-2xs text-content-muted">{status}</span>}
      </div>

      <datalist id="sector-options">
        {SECTOR_HINTS.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <datalist id="country-options">
        {COUNTRY_HINTS.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>

      <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
        Wartości wpisane ręcznie mają pierwszeństwo — automatyczna klasyfikacja ich nie nadpisze.
        Fundusz szeroko zdywersyfikowany opisz sektorem „Fundusz mieszany" i regionem, w który inwestuje.
      </p>
    </Card>
  );
}

/** Podpowiedzi zgodne z nazewnictwem używanym przez automat. */
const SECTOR_HINTS = [
  'Technologia',
  'Finanse',
  'Ochrona zdrowia',
  'Przemysł',
  'Energia',
  'Surowce',
  'Dobra konsumpcyjne',
  'Dobra podstawowe',
  'Nieruchomości',
  'Usługi komunalne',
  'Telekomunikacja',
  'Fundusz mieszany',
  'Obligacje skarbowe',
  'Metale szlachetne',
  'Kryptowaluty',
];

const COUNTRY_HINTS = [
  'Polska',
  'USA',
  'Rynki rozwinięte',
  'Rynki wschodzące',
  'Europa',
  'Niemcy',
  'Wielka Brytania',
  'Japonia',
  'Chiny',
  'Świat',
];

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
