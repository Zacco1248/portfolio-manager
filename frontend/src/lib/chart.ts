import { useIsNarrow } from '@/lib/useMedia';

/**
 * Wspólne ustawienia wykresów Recharts.
 *
 * Każdy ekran powtarzał ten sam styl tooltipa i te same kolory osi, przez co
 * poprawka wyglądu wymagała siedmiu edycji. Tutaj jest jedno miejsce — i przy
 * okazji jedno miejsce na dostrojenie wykresów do wąskiego ekranu.
 */

export const TOOLTIP_STYLE = {
  background: 'rgb(var(--surface-overlay))',
  border: '1px solid rgb(var(--surface-border))',
  borderRadius: 8,
  fontSize: 12,
} as const;

export const AXIS_TICK = { fontSize: 11, fill: 'rgb(var(--content-muted))' } as const;

export const GRID_STROKE = 'rgb(var(--surface-border))';

/** Formatuje kwotę na osi skrótowo (12,3 tys.), żeby oś Y nie zjadała szerokości. */
export const compactNumber = (value: number) =>
  new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/**
 * Gęstość osi zależna od szerokości ekranu.
 *
 * Recharts liczy układ osi w JavaScripcie, więc responsywności nie da się tu
 * załatwić klasą CSS. Na telefonie etykiety dat nachodziły na siebie, a oś Y
 * o stałej szerokości 64 px zabierała jedną piątą wykresu.
 */
export function useAxisDensity() {
  const narrow = useIsNarrow();
  return {
    narrow,
    /** Minimalny odstęp między etykietami osi X — na wąskim ekranie większy. */
    minTickGap: narrow ? 56 : 40,
    /** Szerokość osi Y; skrócone liczby mieszczą się w mniejszym polu. */
    yAxisWidth: narrow ? 44 : 64,
  };
}
