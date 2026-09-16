import { useMemo, useState } from 'react';
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
import { ACCOUNT_KIND_LABELS, AI_DISCLAIMER } from '@portfolio/shared';
import type { AiUnavailable, AllocationSlice, SnapshotPoint } from '@portfolio/shared';
import type { SessionFacts } from '@/lib/api';
import { RefreshBar } from '@/components/RefreshBar';
import { useIsNarrow } from '@/lib/useMedia';
import {
  AiDisclaimer,
  AiPending,
  AiUnavailableNotice,
  Card,
  DataTable,
  EmptyState,
  ErrorBanner,
  KpiTile,
  Spinner,
  WarningList,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';
import { AXIS_TICK, TOOLTIP_STYLE, useAxisDensity } from '@/lib/chart';

/**
 * Paleta wykresów alokacji.
 *
 * Odcienie różnią się jasnością, nie tylko barwą — dzięki temu sektory da się
 * odróżnić także przy zaburzeniach rozpoznawania kolorów i na wydruku.
 */
const SLICE_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#94a3b8'];

export function Dashboard() {
  // Na wąskim ekranie kwoty idą w formie skróconej — pełna nie mieści się
  // w kolumnie o szerokości pół telefonu.
  const narrow = useIsNarrow();
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

      {/*
        Pięć równych kafli w dwóch kolumnach dawało na telefonie ~175 px na
        kwotę, w której siedmiocyfrowa wartość się łamała — a na tablecie
        zostawiało piąty kafel samotnie w drugim rzędzie. Wartość portfela to
        liczba, po którą sięga się pierwszą, więc dostaje własny wiersz.
      */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile
          className="col-span-2 sm:col-span-1"
          label="Wartość portfela"
          value={formatPln(summary.valuePlnMinor, { compact: narrow })}
          change={summary.dayChangeBp}
          changeLabel="dziś"
        />
        <KpiTile
          label="Wynik całkowity"
          value={formatPln(summary.totalReturnPlnMinor, { sign: true, compact: narrow })}
          change={summary.totalReturnBp}
          hint={`Wpłacono ${formatPln(summary.investedPlnMinor)}`}
        />
        <KpiTile
          label="Niezrealizowany"
          value={formatPln(summary.unrealizedPlnMinor, { sign: true, compact: narrow })}
          hint={`${summary.positionsCount} pozycji`}
        />
        <KpiTile
          label="Zrealizowany"
          value={formatPln(summary.realizedPlnMinor, { sign: true, compact: narrow })}
          hint="Suma zamkniętych transakcji"
        />
        <KpiTile
          label="Gotówka"
          value={formatPln(summary.cashPlnMinor, { compact: narrow })}
          change={summary.weekChangeBp}
          changeLabel="tydzień"
        />
      </div>

      <WarningList warnings={warnings} />

      <EmergencyFundCard portfolioId={portfolioId} />

      <AccountsCard portfolioId={portfolioId} />

      <SessionSummaryCard portfolioId={portfolioId} />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Wartość portfela w czasie" className="xl:col-span-2">
          <ValueChart history={history} />
        </Card>

        <Card title="Alokacja wg klas aktywów">
          <AllocationChart slices={allocation.assetClass} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Sektory jako wykres — przy kilkunastu branżach udziały są czytelniejsze
            na kole niż na liście pasków. Waluty i geografia zostają listami:
            tam pozycji jest kilka i lista niesie tyle samo, zajmując mniej. */}
        <Card title="Alokacja sektorowa">
          <AllocationChart slices={allocation.sector} emptyHint="Uzupełnij sektory na instrumentach." />
        </Card>
        <Card title="Alokacja walutowa">
          <AllocationList slices={allocation.currency} />
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
              <li
                key={mover.instrument.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2"
              >
                <Link to={`/instrument/${mover.instrument.id}`} className="col-start-1 min-w-0 hover:text-accent">
                  <span className="text-sm font-medium">{mover.instrument.symbol}</span>
                  <span className="block truncate text-2xs text-content-muted">{mover.instrument.name}</span>
                </Link>
                <span
                  className={`tabular col-start-2 row-span-2 row-start-1 whitespace-nowrap text-right text-sm ${toneClass(
                    mover.dayChangePlnMinor,
                  )}`}
                >
                  {formatPln(mover.dayChangePlnMinor ?? 0, { sign: true })}
                  <span className={`block text-2xs ${toneClass(mover.dayChangeBp)}`}>
                    {formatPercent(mover.dayChangeBp, { sign: true })}
                  </span>
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

/**
 * Wynik w rozbiciu na konta — „ile na plus, ile na minus w danym miejscu".
 *
 * Osobne zapytanie zamiast rozdmuchiwania odpowiedzi pulpitu: karta ma się
 * w ogóle nie pojawiać, dopóki użytkownik nie zacznie przypisywać kont.
 */
function AccountsCard({ portfolioId }: { portfolioId: number | undefined }) {
  const { data } = useAsync(() => api.analytics.accounts(portfolioId), [portfolioId]);

  if (!data || data.accounts.length === 0) return null;

  // Jedno konto obejmujące wszystko nie niesie żadnej informacji ponad to,
  // co pokazują kafelki wyżej.
  if (data.accounts.length === 1 && data.accounts[0]?.accountId !== null) return null;

  return (
    <Card title="Konta">
      <DataTable
        headers={[
          'Konto',
          { label: 'Wpłacono netto', align: 'right' },
          { label: 'Gotówka', align: 'right' },
          { label: 'Wartość', align: 'right' },
          { label: 'Wynik', align: 'right' },
        ]}
      >
        {data.accounts.map((account) => (
          <tr key={account.accountId ?? 'none'} className="hover:bg-surface-overlay/50">
            <td className="table-cell">
              <span className={account.accountId === null ? 'text-content-muted' : 'font-medium'}>
                {account.name}
              </span>
              {account.kind && (
                <span className="ml-2 text-2xs text-content-muted">{ACCOUNT_KIND_LABELS[account.kind]}</span>
              )}
            </td>
            <td className="table-cell tabular text-right">{formatPln(account.contributedPlnMinor)}</td>
            <td className="table-cell tabular text-right">{formatPln(account.cashPlnMinor)}</td>
            <td className="table-cell tabular text-right font-medium">{formatPln(account.valuePlnMinor)}</td>
            <td className={`table-cell tabular text-right ${toneClass(account.resultPlnMinor)}`}>
              {formatPln(account.resultPlnMinor, { sign: true })}
            </td>
          </tr>
        ))}
        <tr className="border-t border-surface-border font-medium">
          <td className="table-cell">Razem</td>
          <td className="table-cell" />
          <td className="table-cell" />
          <td className="table-cell tabular text-right">{formatPln(data.totalValuePlnMinor)}</td>
          <td className={`table-cell tabular text-right ${toneClass(data.totalResultPlnMinor)}`}>
            {formatPln(data.totalResultPlnMinor, { sign: true })}
          </td>
        </tr>
      </DataTable>
      <p className="px-4 pb-4 pt-2 text-2xs text-content-muted">
        Wpłacono = wpłaty minus wypłaty na danym koncie; wynik = wartość bieżąca minus ta kwota. Papiery
        przeniesione między rachunkami liczą się tam, gdzie zostały kupione.
      </p>
    </Card>
  );
}

function ValueChart({ history }: { history: SnapshotPoint[] }) {
  const { minTickGap, yAxisWidth } = useAxisDensity();
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
    <div className="chart-box px-2 pb-2 pt-3">
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
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            minTickGap={minTickGap}
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
            tickFormatter={(v: number) => new Intl.NumberFormat('pl-PL', { notation: 'compact' }).format(v)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
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

function AllocationChart({ slices, emptyHint }: { slices: AllocationSlice[]; emptyHint?: string }) {
  const narrow = useIsNarrow();

  if (slices.length === 0) {
    return (
      <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
        {emptyHint ?? 'Brak pozycji do pokazania.'}
      </p>
    );
  }

  /*
   * Paleta ma osiem odcieni, więc przy większej liczbie kategorii kolory
   * zaczynają się powtarzać i wykres przestaje cokolwiek mówić. Ogon zbieramy
   * w jedną pozycję — udziały poniżej progu i tak są nieczytelne na kole.
   */
  const MAX_SLICES = 7;
  const sorted = [...slices].sort((a, b) => b.valuePlnMinor - a.valuePlnMinor);
  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const visible =
    tail.length === 0
      ? head
      : [
          ...head,
          {
            key: 'pozostale',
            label: `Pozostałe (${tail.length})`,
            valuePlnMinor: tail.reduce((sum, slice) => sum + slice.valuePlnMinor, 0),
            shareBp: tail.reduce((sum, slice) => sum + slice.shareBp, 0),
          },
        ];

  const data = visible.map((slice) => ({
    name: slice.label,
    value: slice.valuePlnMinor / 100,
    shareBp: slice.shareBp,
  }));

  return (
    <>
    <div className="chart-box px-2 pb-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={1}>
            {data.map((_, index) => (
              <Cell key={index} fill={SLICE_COLORS[index % SLICE_COLORS.length]} stroke="none" />
            ))}
          </Pie>
          {/*
            Legenda Rechartsa ma sztywne 48 px wewnątrz pudełka o stałych
            proporcjach. Osiem pozycji przy 11 px potrzebuje trzech wierszy,
            dostaje jeden i się ucina, a pierścień traci wysokość, której
            legenda i tak nie wykorzystuje. Na telefonie jej nie rysujemy —
            zastępuje ją lista z paskami pod spodem, czytelniejsza i tak.
          */}
          {!narrow && (
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
          )}
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number) =>
              new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(value)
            }
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
    {narrow && <AllocationList slices={visible} />}
    </>
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

/**
 * Podsumowanie ostatniej doby na spółkach z portfela.
 *
 * Karta pojawia się tylko wtedy, gdy funkcja AI jest włączona — poza tym
 * pulpit nie ma powodu odsyłać do ustawień. Wynik liczy się na żądanie,
 * bo kosztuje wywołanie modelu.
 */
function SessionSummaryCard({ portfolioId }: { portfolioId: number | undefined }) {
  const ai = useAsync(() => api.ai.status(), []);
  const [state, setState] = useState<{ busy: boolean; text: string | null; facts: SessionFacts | null }>({
    busy: false,
    text: null,
    facts: null,
  });
  /** Awaria transportu — model, który odmówił, ma osobny stan poniżej. */
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<AiUnavailable | null>(null);

  const feature = ai.data?.features.find((f) => f.key === 'sessionSummary');
  if (!feature?.available) return null;

  const run = async () => {
    setState({ busy: true, text: null, facts: null });
    setError(null);
    setUnavailable(null);
    try {
      const result = await api.assist.sessionSummary(portfolioId);
      // Funkcja bywa wyłączona mimo widocznego przycisku — stan mógł się
      // zmienić w innej karcie przeglądarki. Fakty pokazujemy tak czy inaczej.
      if (result.unavailable) {
        setState({ busy: false, text: null, facts: result.data });
        setUnavailable(result.unavailable);
        return;
      }
      setState({ busy: false, text: result.text, facts: result.data });
    } catch (err) {
      setState({ busy: false, text: null, facts: null });
      setError(err instanceof Error ? err.message : 'Nie udało się przygotować podsumowania');
    }
  };

  return (
    <Card
      title="Co się dziś działo"
      action={
        <button type="button" className="btn text-2xs" disabled={state.busy} onClick={() => void run()}>
          {state.busy ? 'Analizuję…' : 'Podsumuj ostatnią dobę'}
        </button>
      }
    >
      {!state.text && !state.busy && !error && !unavailable && (
        <p className="px-4 pb-4 pt-2 text-2xs text-content-muted">
          Zbiera zmiany dzienne spółek z portfela i wiadomości z ostatnich 24 godzin, po czym opisuje, co
          poruszyło portfelem najbardziej.
        </p>
      )}

      {state.busy && <AiPending label="Zbieram dane z ostatniej doby…" />}
      {error && <ErrorBanner message={error} onRetry={() => void run()} />}
      {unavailable && (
        <AiUnavailableNotice
          reason={unavailable}
          onRetry={() => void run()}
          note="Kafle poniżej powstają lokalnie i nie zależą od modelu."
        />
      )}

      {state.facts && (
        <div className="grid grid-cols-2 gap-3 px-4 pb-2 pt-2 sm:grid-cols-4">
          <KpiTile
            label="Zmiana portfela"
            value={formatPercent(state.facts.portfolioChangeBp, { sign: true })}
            hint="ważona udziałem"
          />
          <KpiTile label="Na plusie" value={String(state.facts.gainers)} hint={`z ${state.facts.positionsCount} pozycji`} />
          <KpiTile label="Na minusie" value={String(state.facts.losers)} />
          {state.facts.staleCount > 0 && (
            <KpiTile label="Nieaktualne ceny" value={String(state.facts.staleCount)} hint="pozycji" />
          )}
        </div>
      )}

      {state.text && (
        <div className="space-y-3 px-4 pb-4">
          <p className="whitespace-pre-line text-sm leading-relaxed">{state.text}</p>
          <AiDisclaimer text={AI_DISCLAIMER} />
        </div>
      )}
    </Card>
  );
}
