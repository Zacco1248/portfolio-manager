import { useState } from 'react';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useApp } from '@/state/app';

/**
 * Pasek odświeżania danych.
 *
 * Każda akcja pokazuje własny stan i wynik obok przycisku, zamiast znikającego
 * powiadomienia — po kliknięciu widać, czy coś się faktycznie pobrało i ile.
 * Bez tego jedynym sygnałem była zmiana liczb, której przy braku nowych danych
 * po prostu nie ma.
 */

type Status = 'idle' | 'running' | 'done' | 'error';

interface ActionState {
  status: Status;
  message: string | null;
}

const INITIAL: ActionState = { status: 'idle', message: null };

export function RefreshBar() {
  const { status, refreshStatus } = useApp();
  const [prices, setPrices] = useState<ActionState>(INITIAL);
  const [benchmarks, setBenchmarks] = useState<ActionState>(INITIAL);
  const [news, setNews] = useState<ActionState>(INITIAL);

  const run = async (
    setState: (state: ActionState) => void,
    action: () => Promise<string>,
  ): Promise<void> => {
    setState({ status: 'running', message: null });
    try {
      const message = await action();
      setState({ status: 'done', message });
      void refreshStatus();
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Nie udało się' });
    }
  };

  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      <RefreshAction
        label="Ceny"
        state={prices}
        onRun={() =>
          run(setPrices, async () => {
            const result = await api.positions.refresh();
            return (
              result.message ??
              `zaktualizowano ${result.prices?.updated ?? 0}, bez danych ${result.prices?.skipped ?? 0}`
            );
          })
        }
      />

      <RefreshAction
        label="Benchmarki"
        state={benchmarks}
        onRun={() => run(setBenchmarks, async () => (await api.analytics.refreshBenchmarks()).message)}
      />

      <RefreshAction
        label="Wiadomości"
        state={news}
        onRun={() =>
          run(setNews, async () => {
            const result = await api.news.refresh();
            return `${result.fetched}; ${result.analyzed}`;
          })
        }
      />

      <span className="ml-auto text-2xs text-content-muted">
        Ceny: {relativeTime(status?.lastPriceUpdate)}
        {status?.lastSnapshot ? ` · snapshot: ${status.lastSnapshot}` : ''}
      </span>
    </div>
  );
}

function RefreshAction({
  label,
  state,
  onRun,
}: {
  label: string;
  state: ActionState;
  onRun: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button type="button" className="btn text-2xs" onClick={onRun} disabled={state.status === 'running'}>
        {state.status === 'running' ? `${label}…` : `Odśwież: ${label.toLowerCase()}`}
      </button>

      {state.message && (
        <span
          className={`min-w-0 truncate text-2xs ${state.status === 'error' ? 'text-loss' : 'text-gain'}`}
          title={state.message}
        >
          {state.status === 'error' ? '✕' : '✓'} {state.message}
        </span>
      )}
    </div>
  );
}
