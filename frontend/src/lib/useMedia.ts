import { useEffect, useState } from 'react';

/**
 * Stan zapytania medialnego jako wartość Reacta.
 *
 * Potrzebne tam, gdzie sam CSS nie wystarcza — wykresy Recharts liczą układ
 * osi w JavaScripcie, więc gęstość etykiet i szerokość osi Y muszą być
 * liczbami, a nie klasami.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** Ekran telefonu — próg zgodny z `sm` w Tailwindzie. */
export function useIsNarrow(): boolean {
  return useMediaQuery('(max-width: 639px)');
}
