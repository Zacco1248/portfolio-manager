import { useCallback, useEffect, useState } from 'react';
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
