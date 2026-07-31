import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

/**
 * Pobieranie danych z obsługą stanu ładowania i błędu.
 *
 * Świadomie bez biblioteki do zarządzania zapytaniami: aplikacja ma jednego
 * użytkownika i kilkanaście ekranów, więc pełny cache byłby narzutem bez
 * odpowiadającej mu korzyści.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    run()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Nie udało się pobrać danych');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [run, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/**
 * Wariant dla zapytań, które mają ruszyć dopiero po kliknięciu.
 *
 * Wywołania modelu kosztują i trwają, więc uruchamianie ich przy każdym
 * wejściu na stronę oznaczało rachunek za treść, której nikt nie przeczytał —
 * i czekanie na komentarz, gdy chciało się tylko zerknąć na liczby.
 *
 * `reset` przydaje się przy zmianie portfela: poprzedni wynik dotyczy już
 * czegoś innego i nie powinien wisieć na ekranie.
 */
export function useOnDemand<T>(
  loader: () => Promise<T>,
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  started: boolean;
  run: () => void;
  reset: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(() => {
    setStarted(true);
    setLoading(true);
    setError(null);

    loaderRef.current()
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Nie udało się pobrać danych');
      })
      .finally(() => setLoading(false));
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setStarted(false);
  }, []);

  return { data, error, loading, started, run, reset };
}
