import { useState } from 'react';
import { AiDisclaimer, Card, EmptyState, ErrorBanner, Field, Spinner, Toast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp } from '@/state/app';

const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'bg-gain/15 text-gain',
  neutral: 'bg-surface-overlay text-content-secondary',
  negative: 'bg-loss/15 text-loss',
};

const SENTIMENT_LABEL: Record<string, string> = {
  positive: 'pozytywny',
  neutral: 'neutralny',
  negative: 'negatywny',
};

export function News() {
  const { status } = useApp();
  const [importance, setImportance] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast, show, dismiss } = useToast();

  const news = useAsync(
    () => api.news.list({ importance: importance || undefined, sentiment: sentiment || undefined }),
    [importance, sentiment],
  );
  const watchlist = useAsync(() => api.news.watchlist(), []);
  const instruments = useAsync(() => api.instruments.list(), []);
  const [watchPick, setWatchPick] = useState('');

  const refresh = async () => {
    setBusy(true);
    try {
      const result = await api.news.refresh();
      news.reload();
      show(`${result.fetched}; ${result.analyzed}`, 'success');
    } catch {
      show('Nie udało się pobrać wiadomości', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input h-8 w-auto py-0" value={importance} onChange={(e) => setImportance(e.target.value)}>
          <option value="">Waga: wszystkie</option>
          <option value="signal">Tylko istotne</option>
          <option value="noise">Tylko szum</option>
        </select>
        <select className="input h-8 w-auto py-0" value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
          <option value="">Sentyment: wszystkie</option>
          <option value="positive">Pozytywny</option>
          <option value="neutral">Neutralny</option>
          <option value="negative">Negatywny</option>
        </select>
        <button type="button" className="btn ml-auto" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Pobieram…' : 'Odśwież wiadomości'}
        </button>
      </div>

      {status && !status.features.ai && (
        <p className="rounded-card border border-surface-border bg-surface-overlay px-4 py-3 text-2xs text-content-muted">
          Analiza AI jest wyłączona — brak <code>ANTHROPIC_API_KEY</code> w pliku <code>.env</code>. Wiadomości
          pokazują się jako surowe nagłówki z linkami do źródeł. Filtry po sentymencie i wadze zadziałają dopiero
          po włączeniu analizy.
        </p>
      )}

      <Card
        title="Obserwowane spółki"
        action={
          <span className="text-2xs text-content-muted">
            Spółki z portfela są monitorowane automatycznie — tutaj dodajesz pozostałe.
          </span>
        }
      >
        <div className="flex flex-wrap items-end gap-2 p-4 pt-2">
          <div className="w-64">
            <Field label="Dodaj instrument">
              <select className="input" value={watchPick} onChange={(e) => setWatchPick(e.target.value)}>
                <option value="">— wybierz —</option>
                {(instruments.data ?? [])
                  .filter((i) => i.assetClass !== 'cash')
                  .map((instrument) => (
                    <option key={instrument.id} value={instrument.id}>
                      {instrument.symbol} · {instrument.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <button
            type="button"
            className="btn"
            disabled={!watchPick}
            onClick={() =>
              void api.news
                .watch(Number(watchPick))
                .then(() => {
                  setWatchPick('');
                  watchlist.reload();
                  show('Dodano do obserwowanych', 'success');
                })
                .catch(() => show('Nie udało się dodać', 'error'))
            }
          >
            Obserwuj
          </button>
        </div>

        {watchlist.data && watchlist.data.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-t border-surface-border px-4 py-3">
            {watchlist.data.map((instrument) => (
              <li key={instrument.id} className="flex items-center gap-1.5 rounded bg-surface-overlay px-2 py-1 text-2xs">
                <span className="font-medium">{instrument.symbol}</span>
                <span className="text-content-muted">{instrument.name}</span>
                <button
                  type="button"
                  className="text-content-muted hover:text-loss"
                  aria-label={`Przestań obserwować ${instrument.symbol}`}
                  onClick={() => void api.news.unwatch(instrument.id).then(watchlist.reload)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {news.loading && <Spinner />}
      {news.error && <ErrorBanner message={news.error} onRetry={news.reload} />}

      {news.data && (
        <>
          {news.data.items.some((item) => item.aiSummaryPl) && <AiDisclaimer text={news.data.disclaimer} />}

          {news.data.items.length === 0 ? (
            <EmptyState
              title="Brak wiadomości"
              description="Kliknij „Odśwież wiadomości”, żeby pobrać nagłówki dla spółek z portfela i watchlisty."
            />
          ) : (
            <ul className="space-y-2">
              {news.data.items.map((item) => (
                <li key={item.id}>
                  <Card>
                    <article className="p-4">
                      <header className="flex flex-wrap items-center gap-2">
                        {item.instrumentSymbol && (
                          <span className="badge bg-accent/15 text-accent">{item.instrumentSymbol}</span>
                        )}
                        {item.sentiment && (
                          <span className={`badge ${SENTIMENT_STYLE[item.sentiment]}`}>
                            {SENTIMENT_LABEL[item.sentiment]}
                          </span>
                        )}
                        {item.importance === 'signal' && <span className="badge bg-warn/15 text-warn">istotne</span>}
                        <span className="ml-auto text-2xs text-content-muted">
                          {item.source} · {relativeTime(item.publishedAt)}
                        </span>
                      </header>

                      <h3 className="mt-2 text-sm font-medium">
                        <a href={item.url} target="_blank" rel="noreferrer noopener" className="hover:text-accent">
                          {item.title}
                        </a>
                      </h3>

                      {item.aiSummaryPl && (
                        <div className="mt-1.5">
                          <p className="text-sm text-content-secondary">{item.aiSummaryPl}</p>
                          {item.aiGenerated && (
                            <span className="mt-1 inline-block text-2xs text-content-muted">
                              Streszczone i przetłumaczone przez AI
                            </span>
                          )}
                        </div>
                      )}

                      {item.aiSignal && (item.aiSignal.hold.length > 0 || item.aiSignal.reduce.length > 0) && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <Arguments title="Argumenty za trzymaniem" items={item.aiSignal.hold} tone="gain" />
                          <Arguments title="Argumenty za redukcją" items={item.aiSignal.reduce} tone="loss" />
                        </div>
                      )}
                    </article>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

function Arguments({ title, items, tone }: { title: string; items: string[]; tone: 'gain' | 'loss' }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className={`text-2xs font-semibold uppercase tracking-wide ${tone === 'gain' ? 'text-gain' : 'text-loss'}`}>
        {title}
      </p>
      <ul className="mt-1 space-y-0.5 text-2xs text-content-secondary">
        {items.map((item, index) => (
          <li key={index}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}
