import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RatingsCard } from '@/components/RatingsCard';
import { AiDisclaimer, AiPending, Card, ErrorBanner, Field, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import type { ResearchSnapshot } from '@/lib/api';
import { formatCost, formatDate, formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

/**
 * Wyszukiwarka i karta spółki.
 *
 * Zbiera w jednym miejscu to, co dotąd wymagało obejścia kilku zakładek:
 * notowania, wskaźniki, rekomendacje prasy i wiadomości — plus ocenę
 * dopasowania do portfela, jeśli funkcja AI jest włączona.
 */
export function Research() {
  const portfolioId = usePortfolioParam();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.assist.search>> | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      const found = await api.assist.search(query);
      setResults(found);
      // Jedno trafienie to zwykle to, o które chodziło — otwieramy od razu.
      if (found.length === 1 && found[0]?.id) setSelected(found[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Wyszukiwanie nie powiodło się');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Szukaj spółki">
        <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
          <div className="min-w-[16rem] flex-1">
            <Field label="Symbol albo nazwa">
              <input
                className="input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && query.trim().length >= 2) void search();
                }}
                placeholder="np. Orlen, XTB, CSPX"
              />
            </Field>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={searching || query.trim().length < 2}
            onClick={() => void search()}
          >
            {searching ? 'Szukam…' : 'Szukaj'}
          </button>
        </div>

        {error && <ErrorBanner message={error} />}

        {results && results.length === 0 && (
          <p className="px-4 pb-4 text-2xs text-content-muted">
            Nic nie znaleziono. Spróbuj samego tickera albo pełnej nazwy spółki.
          </p>
        )}

        {results && results.length > 0 && (
          <ul className="divide-y divide-surface-border border-t border-surface-border">
            {results.map((item) => (
              <li key={`${item.symbol}-${item.id ?? 'nowy'}`} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.symbol}</div>
                  <div className="truncate text-2xs text-content-muted">
                    {item.name}
                    {item.exchange ? ` · ${item.exchange}` : ''}
                  </div>
                </div>
                {item.id === null ? (
                  <span className="text-2xs text-content-muted">spoza bazy — dodaj jako instrument</span>
                ) : (
                  <button
                    type="button"
                    className={`btn text-2xs ${selected === item.id ? 'btn-primary' : ''}`}
                    onClick={() => setSelected(item.id)}
                  >
                    Pokaż
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected !== null && <ResearchCard instrumentId={selected} portfolioId={portfolioId} />}
    </div>
  );
}

function ResearchCard({ instrumentId, portfolioId }: { instrumentId: number; portfolioId?: number }) {
  // Pierwsze wejście na kartę potrafi trwać: dociąga historię notowań
  // i rekomendacje, jeśli ich jeszcze nie ma.
  const research = useAsync(() => api.assist.research(instrumentId, portfolioId), [instrumentId, portfolioId]);
  const [fit, setFit] = useState<{ busy: boolean; result: Awaited<ReturnType<typeof api.assist.fit>> | null }>({
    busy: false,
    result: null,
  });

  if (research.loading) return <Spinner label="Zbieram dane o spółce…" />;
  if (research.error) return <ErrorBanner message={research.error} onRetry={research.reload} />;
  if (!research.data) return null;

  const snapshot = research.data;
  const { instrument, technical, ratings } = snapshot;

  const runFit = () => {
    setFit({ busy: true, result: null });
    void api.assist
      .fit(instrumentId, portfolioId)
      .then((result) => setFit({ busy: false, result }))
      .catch(() => setFit({ busy: false, result: null }));
  };

  return (
    <>
      <Card
        title={`${instrument.symbol} — ${instrument.name}`}
        action={
          <Link to={`/instrument/${instrument.id}`} className="text-2xs text-content-muted hover:text-accent">
            Pełna karta instrumentu →
          </Link>
        }
      >
        <div className="flex flex-wrap items-baseline gap-4 px-4 pb-2 pt-2">
          <div>
            <div className="text-lg font-semibold tabular">
              {snapshot.priceE8 === null ? '—' : `${(snapshot.priceE8 / 1e8).toFixed(2)} ${instrument.currency}`}
            </div>
            <div className="text-2xs text-content-muted">
              {instrument.sector ?? 'sektor nieprzypisany'} · {instrument.country ?? 'region nieprzypisany'}
            </div>
          </div>
          {snapshot.holding?.held && (
            <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-2xs text-accent">
              W portfelu: {formatPercent(snapshot.holding.shareBp, { digits: 1 })} ·{' '}
              {formatPln(snapshot.holding.valuePlnMinor)}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-5">
          {snapshot.changes.map((change) => (
            <Tile
              key={change.days}
              label={changeLabel(change.days)}
              value={change.changeBp === null ? '—' : formatPercent(change.changeBp, { sign: true, digits: 1 })}
              tone={change.changeBp === null ? undefined : toneClass(change.changeBp)}
            />
          ))}
        </div>
      </Card>

      <Card title="Analiza techniczna">
        <div className="grid grid-cols-2 gap-2 p-4 pt-2 sm:grid-cols-4">
          <Tile
            label="RSI (14)"
            value={technical.rsi === null ? '—' : technical.rsi.toFixed(1)}
            hint={zoneLabel(technical.rsiZone)}
          />
          <Tile label="Układ średnich" value={trendLabel(technical.trend)} hint="SMA 50 wobec SMA 200" />
          <Tile
            label="Wstęgi Bollingera"
            value={technical.bollingerPercent === null ? '—' : `${technical.bollingerPercent.toFixed(0)}%`}
            hint="0% = dolna wstęga, 100% = górna"
          />
          <Tile
            label="Zmienność (ATR)"
            value={technical.atrPercent === null ? '—' : `${technical.atrPercent.toFixed(2)}%`}
            hint="Średni zakres dzienny"
          />
          <Tile
            label="Stochastyczny %K"
            value={technical.stochasticK === null ? '—' : technical.stochasticK.toFixed(0)}
            hint={zoneLabel(technical.stochasticZone)}
          />
          <Tile
            label="Momentum (20 sesji)"
            value={technical.momentum20 === null ? '—' : `${technical.momentum20 > 0 ? '+' : ''}${technical.momentum20.toFixed(1)}%`}
            tone={technical.momentum20 === null ? undefined : toneClass(technical.momentum20)}
          />
          <Tile
            label="Od rocznego maksimum"
            value={technical.fromYearHighPercent === null ? '—' : `${technical.fromYearHighPercent.toFixed(1)}%`}
          />
          <Tile
            label="Od rocznego minimum"
            value={technical.fromYearLowPercent === null ? '—' : `+${technical.fromYearLowPercent.toFixed(1)}%`}
          />
        </div>

        {snapshot.signals.length > 0 && (
          <ul className="space-y-1 border-t border-surface-border px-4 py-3">
            {snapshot.signals.map((signal, index) => (
              <li key={index} className="flex flex-wrap gap-x-2 text-2xs">
                <span className="tabular shrink-0 text-content-muted">{formatDate(signal.date)}</span>
                <span className="min-w-0 flex-1 break-words text-content-secondary">
                  <span className="font-medium">{signal.label}</span> — {signal.detail}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
          Wskaźniki opisują to, co już się wydarzyło. Nie są prognozą ani rekomendacją.
        </p>
      </Card>

      <RatingsCard ratings={ratings} />

      {snapshot.news.length > 0 && (
        <Card title="Ostatnie wiadomości">
          <ul className="divide-y divide-surface-border">
            {snapshot.news.map((item, index) => (
              <li key={index} className="flex flex-wrap gap-x-2 px-4 py-2 text-2xs">
                <span className="tabular shrink-0 text-content-muted">{formatDate(item.publishedAt)}</span>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 break-words text-content-secondary hover:text-accent"
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Czy pasuje do portfela"
        action={
          <button type="button" className="btn btn-ghost text-2xs" disabled={fit.busy} onClick={runFit}>
            {fit.busy ? 'Analizuję…' : 'Oceń dopasowanie'}
          </button>
        }
      >
        {fit.busy && <AiPending lines={5} label="Model zestawia walor z Twoim portfelem…" />}

        {!fit.busy && !fit.result && (
          <p className="px-4 pb-4 pt-2 text-2xs text-content-muted">
            Zestawia dane tego waloru ze strukturą Twojego portfela: co poprawia, gdzie zwiększa koncentrację,
            czego w tych danych brakuje. Wymaga włączonej funkcji „Dopasowanie do portfela" w Ustawieniach.
            Nie mówi „kup" ani „nie kupuj".
          </p>
        )}

        {!fit.busy && fit.result && (
          <>
            {fit.result.text ? (
              <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-content-secondary">
                {fit.result.text}
              </p>
            ) : (
              <p className="px-4 py-3 text-2xs text-content-muted">
                {fit.result.unavailableReason ?? 'Brak oceny.'}
              </p>
            )}
            <div className="flex items-center justify-between px-4 pb-3">
              <AiDisclaimer text={fit.result.disclaimer} />
              {fit.result.usage && (
                <span className="ml-3 shrink-0 text-2xs text-content-muted">
                  {formatCost(fit.result.usage.costMicroUsd)}
                </span>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-overlay/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-content-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular ${tone ?? ''}`}>{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-content-muted">{hint}</div>}
    </div>
  );
}

function changeLabel(days: number): string {
  if (days === 1) return 'Ostatnia sesja';
  if (days === 365) return 'Rok';
  return `${days} dni`;
}

function zoneLabel(zone: string | null): string {
  if (zone === 'overbought') return 'strefa wykupienia';
  if (zone === 'oversold') return 'strefa wyprzedania';
  return zone === null ? 'brak danych' : 'strefa neutralna';
}

function trendLabel(trend: string | null): string {
  if (trend === 'bullish') return 'wzrostowy';
  if (trend === 'bearish') return 'spadkowy';
  return '—';
}



