import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { assetClassLabel } from '@portfolio/shared';
import type { AssetClass, TechnicalResponse } from '@portfolio/shared';
import { CandlestickChart } from '@/components/CandlestickChart';
import { RatingsCard } from '@/components/RatingsCard';
import { AiUnavailableNotice, AssetClassSelect, Card, DataTable, ErrorBanner, InfoHint, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import type { PriceMoveFacts, SavedAnalysis } from '@/lib/api';
import { formatCost, formatDate, formatPercent, formatPln, formatQuantity, relativeTime, toneClass } from '@/lib/format';
import { TransactionForm } from '@/components/TransactionForm';
import { useAsync } from '@/lib/useAsync';
import { ALL_PORTFOLIOS, useApp } from '@/state/app';
import { AXIS_TICK, TOOLTIP_STYLE, useAxisDensity } from '@/lib/chart';

/**
 * Analiza techniczna pojedynczego instrumentu.
 *
 * Sygnały są listą zaobserwowanych zdarzeń z datami — świadomie nie
 * przekładają się na żadne zalecenie transakcyjne.
 */
export function InstrumentDetail() {
  const { id } = useParams();
  const { minTickGap, yAxisWidth } = useAxisDensity();
  const instrumentId = Number(id);
  const { data, error, loading, reload } = useAsync(() => api.analytics.technical(instrumentId), [instrumentId]);
  const dividends = useAsync(() => api.corporate.dividendHistory(instrumentId), [instrumentId]);
  const [chartMode, setChartMode] = useState<'candles' | 'line'>('candles');
  const [addOpen, setAddOpen] = useState(false);
  const { portfolios, selectedPortfolioId } = useApp();

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

  const { instrument, state, signals, price, holding } = data;

  return (
    <div className="space-y-4">
      {/*
        Nagłówek prowadzi od tożsamości papieru do jego ceny, a dopiero potem
        do narzędzi. Wcześniej ceny tu w ogóle nie było — trzeba jej było
        szukać w tabeli pozycji, mimo że to pierwsza rzecz, po którą się tu
        wchodzi. Na wąskim ekranie bloki układają się jeden pod drugim,
        na szerokim cena ląduje po prawej stronie nazwy.
      */}
      <header className="card px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-lg font-semibold">{instrument.symbol}</h1>
              <span className="badge bg-surface-overlay text-content-secondary">
                {assetClassLabel(instrument.assetClass)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-sm text-content-secondary">{instrument.name}</p>
            <p className="mt-0.5 text-2xs text-content-muted">
              {[instrument.exchange, instrument.currency, instrument.sector, instrument.country]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          <PriceHeadline price={price} state={state} />
        </div>

        {holding && <HoldingStrip holding={holding} currency={instrument.currency} />}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
          {instrument.assetClass === 'metal' && (
            <label className="flex items-center gap-2 text-2xs text-content-muted">
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
            className="btn text-2xs"
            onClick={() => void api.instruments.backfill(instrumentId).then(reload)}
          >
            Uzupełnij historię notowań
          </button>
          {/* Skrót do transakcji z poziomu papieru — bez niego trzeba było
              przejść do innej zakładki i wyszukać go tam od nowa. */}
          <button type="button" className="btn btn-primary ml-auto text-2xs" onClick={() => setAddOpen(true)}>
            Dodaj transakcję
          </button>
        </div>
      </header>

      {/*
        Kolejność sekcji idzie od tego, po co się tu wchodzi, do tego, co się
        robi rzadko. Wcześniej edycja sektora i komentarz modelu stały przed
        wykresem — czyli ustawienia zasłaniały treść.
      */}
      <StaleDataNotice asOf={state.asOf} />

      {/*
        Kafelki opisują stan waloru, a nie stan naszej bazy danych. „Świec
        w historii" i „Sygnałów" mówiły o tym drugim — liczba pobranych świec
        nie jest informacją o spółce, a liczba sygnałów i tak jest widoczna
        w sekcji niżej. W ich miejsce wchodzą wskaźniki, które faktycznie
        coś rozstrzygają.
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="RSI (14)"
          value={state.rsi === null ? '—' : state.rsi.toFixed(1)}
          tone={rsiTone(state.rsiZone)}
          hint={zoneHint(state.rsiZone)}
          info="Wskaźnik siły względnej z 14 sesji, w skali 0–100. Powyżej 70 mówi się o wykupieniu, poniżej 30 o wyprzedaniu — w silnym trendzie skrajne wartości potrafią jednak utrzymywać się tygodniami."
        />
        <StatTile
          label="Układ średnich"
          value={state.trend === 'bullish' ? 'SMA50 > SMA200' : state.trend === 'bearish' ? 'SMA50 < SMA200' : '—'}
          tone={state.trend === 'bullish' ? 'gain' : state.trend === 'bearish' ? 'loss' : 'neutral'}
          hint={state.trend === 'bullish' ? 'trend wzrostowy' : state.trend === 'bearish' ? 'trend spadkowy' : undefined}
          info="Położenie średniej z 50 sesji względem średniej z 200. Wskaźnik opóźniony — potwierdza trend, który już trwa, zamiast go zapowiadać."
        />
        <StatTile
          label="Zmienność (ATR)"
          value={state.atrPercent === null ? '—' : `${state.atrPercent.toFixed(2)}%`}
          tone="neutral"
          hint="typowy ruch dzienny"
          info="Średni rzeczywisty zakres z 14 sesji jako procent ceny. Nie wskazuje kierunku — służy do oceny, czy dany ruch jest duży jak na ten konkretny walor."
        />
        <StatTile
          label="Od minimum roku"
          value={state.fromYearLowPercent === null ? '—' : `+${state.fromYearLowPercent.toFixed(1)}%`}
          tone="neutral"
          hint={state.fromYearHighPercent === null ? undefined : `od szczytu ${state.fromYearHighPercent.toFixed(1)}%`}
          info="Położenie kursu w rocznym zakresie wahań. Pokazuje, czy walor jest bliżej dołka, czy szczytu ostatnich dwunastu miesięcy."
        />
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
          <div className="chart-box-lg px-2 pb-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--surface-border))" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
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
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
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

      <InstrumentRatings instrumentId={instrumentId} />

      <PriceMoveCard instrumentId={instrumentId} />

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

      {/* Klasyfikacja to ustawienie, nie treść — zmienia się raz, przy
          zakładaniu instrumentu, więc siedzi na końcu strony. */}
      <ClassificationCard instrument={instrument} onSaved={reload} />

      {addOpen && (
        <TransactionForm
          defaultPortfolioId={selectedPortfolioId === ALL_PORTFOLIOS ? (portfolios[0]?.id ?? 1) : selectedPortfolioId}
          defaultInstrumentId={instrumentId}
          defaultCurrency={instrument.currency}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Rekomendacje analityków dla tego instrumentu.
 *
 * Ładowane osobno, bo pierwsze wejście potrafi dociągnąć je z sieci, a reszta
 * karty jest gotowa od razu.
 */
function InstrumentRatings({ instrumentId }: { instrumentId: number }) {
  const ratings = useAsync(() => api.assist.ratings(instrumentId), [instrumentId]);

  if (ratings.loading || !ratings.data) return null;
  return <RatingsCard ratings={ratings.data} />;
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
    /** Awaria transportu — inna sprawa niż model, który odpowiedział odmową. */
    error: string | null;
  }>({ busy: false, result: null, error: null });
  const [days, setDays] = useState<number>(14);

  const history = useAsync(
    () => api.assist.history({ kind: 'price_move', instrumentId, limit: 10 }),
    [instrumentId],
  );

  const run = async () => {
    setState({ busy: true, result: null, error: null });
    try {
      const result = await api.assist.priceMove(instrumentId, days);
      setState({ busy: false, result, error: null });
      history.reload();
    } catch (err) {
      // Wcześniej ten catch był pusty i karta wracała do stanu wyjściowego —
      // nieodróżnialnie od sytuacji, w której nikt nic nie kliknął.
      setState({
        busy: false,
        result: null,
        error: err instanceof ApiError ? err.message : 'Nie udało się pobrać analizy.',
      });
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
      {state.error && (
        <div className="px-4 pb-3 pt-2">
          <ErrorBanner message={state.error} onRetry={() => void run()} />
        </div>
      )}

      {!state.result && !state.error && (
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
          {facts && facts.context.length > 0 && <ContextList entries={facts.context} />}

          {state.result.text ? (
            <p className="whitespace-pre-wrap border-t border-surface-border px-4 py-3 text-sm leading-relaxed text-content-secondary">
              {state.result.text}
            </p>
          ) : state.result.unavailable ? (
            <div className="border-t border-surface-border">
              <AiUnavailableNotice reason={state.result.unavailable} onRetry={() => void run()} />
            </div>
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
            <li key={index} className="flex flex-wrap gap-x-2 text-2xs">
              <span className="tabular shrink-0 text-content-muted">{formatDate(headline.publishedAt)}</span>
              <span className="min-w-0 flex-1 break-words text-content-secondary">
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
 * Otoczenie branżowe i regulacyjne.
 *
 * Osobno od wiadomości o spółce, bo to inny rodzaj przesłanki: te teksty nie
 * wymieniają spółki, a mimo to mogą tłumaczyć ruch kursu. Zwinięte domyślnie,
 * żeby nie przykrywały właściwej listy.
 */
function ContextList({ entries }: { entries: PriceMoveFacts['context'] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        className="text-2xs text-content-muted hover:text-accent"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? '▾' : '▸'} Otoczenie branżowe i decyzje władz ({entries.length})
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {entries.map((entry, index) => (
            <li key={index} className="flex flex-wrap gap-x-2 text-2xs">
              <span className="tabular shrink-0 text-content-muted">{formatDate(entry.publishedAt)}</span>
              <span className="min-w-0 flex-1 break-words text-content-secondary">
                {entry.policy && <span className="mr-1 text-warn">[władze]</span>}
                {entry.title}
                <span className="ml-1 text-content-muted">({entry.source})</span>
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
          <AssetClassSelect className="input mt-1" value={assetClass} onChange={setAssetClass} />
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

function StatTile({
  label,
  value,
  tone,
  hint,
  info,
}: {
  label: string;
  value: string;
  tone: 'gain' | 'loss' | 'warn' | 'neutral';
  /** Krótkie doprecyzowanie pod wartością. */
  hint?: string;
  /** Wyjaśnienie wskaźnika pod ikoną „i". */
  info?: string;
}) {
  const toneClass =
    tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : '';
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center text-2xs font-medium uppercase tracking-wider text-content-muted">
        {label}
        {info && <InfoHint text={info} />}
      </div>
      {/* Wartość mniejsza niż w nagłówku ceny — te liczby są dopowiedzeniem,
          nie główną odpowiedzią, a jednakowa wielkość zacierałaby hierarchię. */}
      <div className={`tabular mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-2xs text-content-muted">{hint}</div>}
    </div>
  );
}

/** Krótki opis strefy RSI — pełne wyjaśnienie siedzi pod ikoną „i". */
function zoneHint(zone: string | null): string | undefined {
  if (zone === 'overbought') return 'strefa wykupienia';
  if (zone === 'oversold') return 'strefa wyprzedania';
  return undefined;
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

/**
 * Ostrzeżenie o wskaźnikach liczonych ze starych notowań.
 *
 * Wskaźnik sprzed roku wygląda dokładnie tak samo jak dzisiejszy — bez daty
 * odczytu nie da się ich odróżnić, a decyzja podjęta na takim RSI byłaby
 * oparta na nieaktualnym obrazie rynku.
 */
function StaleDataNotice({ asOf }: { asOf: string | null }) {
  if (!asOf) return null;

  const ageDays = Math.floor((Date.now() - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
  // Weekend plus dzień świąteczny mieści się w czterech dniach.
  if (ageDays <= 4) return null;

  return (
    <div className="rounded-card border border-warn/40 bg-warn/10 px-3 py-2 text-2xs text-warn">
      Wskaźniki liczone z notowań z {formatDate(asOf)} — {ageDays} dni temu. Użyj „Uzupełnij historię notowań",
      żeby je odświeżyć.
    </div>
  );
}

/**
 * Cena bieżąca — najważniejsza liczba na tej stronie.
 *
 * Duża, wyrównana do prawej na szerokim ekranie, pod nazwą na wąskim.
 * Obok niej zmiana dzienna w obu ujęciach (kwotowo i procentowo), bo jedno
 * bez drugiego zmusza do liczenia w głowie: 2% na papierze po 5 zł to co
 * innego niż 2% na papierze po 500 zł.
 */
function PriceHeadline({
  price,
  state,
}: {
  price: TechnicalResponse['price'];
  state: { fromYearHighPercent: number | null; fromYearLowPercent: number | null };
}) {
  if (!price) {
    return (
      <div className="text-right">
        <div className="text-2xl font-semibold text-content-muted">—</div>
        <div className="text-2xs text-content-muted">Brak notowania</div>
      </div>
    );
  }

  const value = price.priceE8 / 1e8;
  const change = price.changeE8 === null ? null : price.changeE8 / 1e8;

  return (
    <div className="text-left sm:text-right">
      <div className="tabular text-2xl font-semibold leading-none">
        {value.toFixed(value < 10 ? 4 : 2)}
        <span className="ml-1.5 text-sm font-normal text-content-muted">{price.currency}</span>
      </div>

      <div className={`tabular mt-1 text-sm ${toneClass(price.changeBp)}`}>
        {change !== null && (
          <>
            {change > 0 ? '+' : ''}
            {change.toFixed(Math.abs(change) < 10 ? 4 : 2)}
          </>
        )}
        {price.changeBp !== null && (
          <span className={change !== null ? 'ml-2' : ''}>{formatPercent(price.changeBp, { sign: true })}</span>
        )}
        {change === null && price.changeBp === null && <span className="text-content-muted">bez zmiany odniesienia</span>}
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 text-2xs text-content-muted sm:justify-end">
        <span>{price.stale ? 'notowanie nieaktualne' : relativeTime(price.ts)}</span>
        {state.fromYearHighPercent !== null && (
          <span>
            od szczytu roku {state.fromYearHighPercent.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Pasek pozycji — pokazywany tylko wtedy, gdy papier jest w portfelu.
 *
 * Odpowiada na pytanie „ile mam i jak na tym wychodzę", zanim użytkownik
 * zejdzie do wskaźników technicznych. Na wąskim ekranie dwie kolumny,
 * na szerokim cztery — układ pozostaje czytelny w obu.
 */
function HoldingStrip({
  holding,
  currency,
}: {
  holding: NonNullable<TechnicalResponse['holding']>;
  currency: string;
}) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-surface-border pt-3 sm:grid-cols-4">
      <div>
        <dt className="text-2xs uppercase tracking-wide text-content-muted">Posiadam</dt>
        <dd className="tabular mt-0.5 text-sm font-medium">{formatQuantity(holding.qtyE8)}</dd>
      </div>
      <div>
        <dt className="text-2xs uppercase tracking-wide text-content-muted">Średnia cena</dt>
        <dd className="tabular mt-0.5 text-sm">
          {(holding.avgPriceE8 / 1e8).toFixed(2)}
          <span className="ml-1 text-2xs text-content-muted">{currency}</span>
        </dd>
      </div>
      <div>
        <dt className="text-2xs uppercase tracking-wide text-content-muted">Wartość</dt>
        <dd className="tabular mt-0.5 text-sm">{formatPln(holding.valuePlnMinor)}</dd>
      </div>
      <div>
        <dt className="text-2xs uppercase tracking-wide text-content-muted">Wynik</dt>
        <dd className={`tabular mt-0.5 text-sm font-medium ${toneClass(holding.unrealizedPlnMinor)}`}>
          {formatPln(holding.unrealizedPlnMinor, { sign: true })}
          <span className="ml-1.5 text-2xs">{formatPercent(holding.unrealizedBp, { sign: true })}</span>
        </dd>
      </div>
    </dl>
  );
}
