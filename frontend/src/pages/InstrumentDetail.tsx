import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ASSET_CLASS_LABELS } from '@portfolio/shared';
import type { AssetClass } from '@portfolio/shared';
import { CandlestickChart } from '@/components/CandlestickChart';
import { Card, DataTable, ErrorBanner, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import type { PriceMoveFacts, SavedAnalysis } from '@/lib/api';
import { formatCost, formatDate, toneClass } from '@/lib/format';
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
  const [days, setDays] = useState<number>(14);

  const history = useAsync(
    () => api.assist.history({ kind: 'price_move', instrumentId, limit: 10 }),
    [instrumentId],
  );

  const run = async () => {
    setState({ busy: true, result: null });
    try {
      const result = await api.assist.priceMove(instrumentId, days);
      setState({ busy: false, result });
      history.reload();
    } catch {
      setState({ busy: false, result: null });
    }
  };

  const facts = state.result?.data ?? null;

  return (
    <Card
      title="Dlaczego kurs się ruszył"
      action={
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-surface-border p-0.5">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                className={`rounded px-2 py-0.5 text-2xs ${
                  days === option.days ? 'bg-accent/15 text-accent' : 'text-content-muted hover:text-content-secondary'
                }`}
                onClick={() => setDays(option.days)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost text-2xs" disabled={state.busy} onClick={() => void run()}>
            {state.busy ? 'Sprawdzam…' : 'Sprawdź teraz'}
          </button>
        </div>
      }
    >
      {!state.result && (
        <p className="px-4 pb-3 pt-2 text-2xs text-content-muted">
          Zestawia zmianę kursu z wybranego okresu z wiadomościami z tego samego czasu.
          Wymaga włączonej funkcji „Wyjaśnianie ruchów cen" w Ustawieniach. Każde sprawdzenie zostaje
          zapisane niżej wraz z datą i szacowanym kosztem.
        </p>
      )}

      {state.result && (
        <>
          {facts && (
            <div className="px-4 pb-2 pt-2 text-2xs text-content-muted">
              {windowLabel(facts.days)}:{' '}
              <span className={`font-medium ${facts.changeBp === null ? '' : toneClass(facts.changeBp)}`}>
                {facts.changeBp === null
                  ? 'brak notowań'
                  : `${facts.changeBp > 0 ? '+' : ''}${(facts.changeBp / 100).toFixed(2)}%`}
              </span>
              {facts.priceSource === 'dostawca' && (
                <span className="ml-1" title="Lokalna historia była pusta — kurs odczytany wprost od dostawcy">
                  (prosto od dostawcy)
                </span>
              )}
              {' · '}
              {facts.headlines.length} wiadomości o tej spółce
              {facts.newsInWindow > 0 && ` z ${facts.newsInWindow} zebranych w tym okresie`}
              {state.result.usage && ` · koszt ${formatCost(state.result.usage.costMicroUsd)}`}
            </div>
          )}

          {facts && facts.headlines.length === 0 && (
            <p className="px-4 pb-2 text-2xs text-warn">
              Nie znaleziono wiadomości dotyczących tej spółki.{' '}
              {facts.newsInWindow === 0
                ? 'W bazie nie ma żadnych wiadomości z tego okresu — sprawdź, czy pobieranie newsów działa (Aktualności → Odśwież).'
                : 'W bazie są wiadomości z tego okresu, ale żadna nie wspomina tej spółki w tytule.'}
            </p>
          )}

          {facts && facts.headlines.length > 0 && <HeadlineList headlines={facts.headlines} />}

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

      {(history.data?.length ?? 0) > 0 && (
        <div className="border-t border-surface-border">
          <div className="px-4 pt-3 text-2xs uppercase tracking-wide text-content-muted">
            Wcześniejsze sprawdzenia
          </div>
          <ul className="divide-y divide-surface-border">
            {(history.data ?? []).map((entry) => (
              <SavedAnalysisRow key={entry.id} entry={entry} onDeleted={history.reload} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Nagłówki, na których model oparł odpowiedź — bez nich nie da się jej zweryfikować. */
function HeadlineList({ headlines }: { headlines: PriceMoveFacts['headlines'] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        className="text-2xs text-content-muted hover:text-accent"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? '▾' : '▸'} Nagłówki wzięte pod uwagę ({headlines.length})
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {headlines.map((headline, index) => (
            <li key={index} className="flex gap-2 text-2xs">
              <span className="tabular w-20 shrink-0 text-content-muted">{formatDate(headline.publishedAt)}</span>
              <span className="text-content-secondary">
                {headline.title}
                <span className="ml-1 text-content-muted">
                  ({headline.source}
                  {headline.linked ? '' : ', dopasowana po nazwie'})
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Zapisana analiza. Zwinięta do jednej linii z datą — po kilku sprawdzeniach
 * lista rozwiniętych akapitów byłaby nie do przejrzenia.
 */
function SavedAnalysisRow({ entry, onDeleted }: { entry: SavedAnalysis; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const change = typeof entry.facts?.changeBp === 'number' ? (entry.facts.changeBp as number) : null;

  return (
    <li className="px-4 py-2">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          className="flex-1 truncate text-left text-2xs hover:text-accent"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="tabular text-content-muted">{formatDate(entry.createdAt)}</span>
          {typeof entry.facts?.days === 'number' && (
            <span className="ml-2 text-content-muted">{windowLabel(entry.facts.days as number)}</span>
          )}
          {change !== null && (
            <span className={`ml-2 tabular font-medium ${toneClass(change)}`}>
              {change > 0 ? '+' : ''}
              {(change / 100).toFixed(1)}%
            </span>
          )}
          <span className="ml-2 text-content-muted">{entry.model}</span>
          <span className="ml-2 text-content-muted">{formatCost(entry.costMicroUsd)}</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost px-2 py-0.5 text-2xs"
          onClick={() => void api.assist.removeHistory(entry.id).then(onDeleted)}
        >
          Usuń
        </button>
      </div>
      {open && (
        <p className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-content-secondary">{entry.text}</p>
      )}
    </li>
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


/** Dostępne okna analizy. Krótsze niż doba nie mają sensu przy notowaniach dziennych. */
const WINDOW_OPTIONS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7 dni' },
  { days: 14, label: '14 dni' },
  { days: 30, label: '30 dni' },
];

/** Opis okna. Jeden dzień to w praktyce zmiana z ostatniej sesji, nie doba zegarowa. */
function windowLabel(days: number): string {
  return days === 1 ? 'Zmiana z ostatniej sesji' : `Zmiana przez ${days} dni`;
}
