import { Card } from '@/components/ui';
import type { ResearchSnapshot } from '@/lib/api';
import { formatDate, formatPercent, toneClass } from '@/lib/format';

/**
 * Rekomendacje analityków odczytane z prasy giełdowej.
 *
 * Ten sam komponent na karcie instrumentu i w wyszukiwarce spółek — nie ma
 * powodu, żeby te same dane wyglądały w dwóch miejscach inaczej.
 */
export function RatingsCard({ ratings }: { ratings: ResearchSnapshot['ratings'] }) {
  return (
    <Card
      title="Rekomendacje analityków"
      action={
        <span className="text-2xs text-content-muted">
          {ratings.entries.length} z ostatnich {ratings.monthsCovered} miesięcy
        </span>
      }
    >
      {ratings.entries.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-2xs text-content-muted">
          Nie znaleziono rekomendacji w prasie giełdowej dla tego waloru. Dotyczy to zwykle ETF-ów, obligacji
          i spółek zagranicznych — polskie serwisy piszą o nich rzadziej.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 px-4 pb-3 pt-2 sm:grid-cols-4">
            <Tile label="Konsensus" value={consensusLabel(ratings.scoreAvg)} hint={countsLabel(ratings.counts)} />
            <Tile
              label="Mediana ceny docelowej"
              value={
                ratings.medianTargetE8 === null
                  ? '—'
                  : `${(ratings.medianTargetE8 / 1e8).toFixed(2)} ${ratings.targetCurrency ?? ''}`.trim()
              }
              hint={
                ratings.medianTargetE8 === null
                  ? 'polskie serwisy rzadko podają kwotę w nagłówku'
                  : `z ${ratings.entries.filter((e) => e.targetPriceE8).length} wycen`
              }
            />
            <Tile
              label="Potencjał"
              value={ratings.upsideBp === null ? '—' : formatPercent(ratings.upsideBp, { sign: true, digits: 1 })}
              tone={ratings.upsideBp === null ? undefined : toneClass(ratings.upsideBp)}
              hint="Wobec bieżącego kursu"
            />
            <Tile
              label="Zmiany zaleceń"
              value={`${ratings.upgrades} ↑ / ${ratings.downgrades} ↓`}
              hint="Podwyższenia i obniżki"
            />
          </div>

          <ul className="divide-y divide-surface-border border-t border-surface-border">
            {ratings.entries.slice(0, 8).map((entry, index) => (
              <li key={index} className="px-4 py-2 text-2xs">
                {/* Metadane w jednym wierszu, tytuł pod spodem — na wąskim ekranie
                    obcinanie w jednej linii zostawiało z nagłówka dwa słowa. */}
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="tabular text-content-muted">{formatDate(entry.date)}</span>
                  {entry.rating && <span className={`badge ${ratingClass(entry.rating)}`}>{entry.rating}</span>}
                  {entry.broker && <span className="font-medium">{entry.broker}</span>}
                  {entry.targetPriceE8 && (
                    <span className="tabular font-medium text-content-secondary">
                      cel {(entry.targetPriceE8 / 1e8).toFixed(2)} {entry.targetCurrency ?? 'PLN'}
                      {entry.direction === 'up' && ' ↑'}
                      {entry.direction === 'down' && ' ↓'}
                    </span>
                  )}
                </div>
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-0.5 block break-words text-content-muted hover:text-accent"
                >
                  {entry.title}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="border-t border-surface-border px-4 py-2 text-2xs text-content-muted">
        Zapis tego, co napisała prasa giełdowa — nie stanowisko aplikacji. Odczytywane automatycznie
        z nagłówków, więc pojedynczy wpis może być niepełny; przy każdym jest odnośnik do źródła.
      </p>
    </Card>
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

/** Opis konsensusu. Sama liczba w skali od −2 do 2 nic nie znaczy dla czytelnika. */
function consensusLabel(score: number | null): string {
  if (score === null) return '—';
  if (score >= 1.5) return 'zdecydowanie kupuj';
  if (score >= 0.5) return 'kupuj';
  if (score > -0.5) return 'trzymaj';
  if (score > -1.5) return 'redukuj';
  return 'sprzedaj';
}

function countsLabel(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([rating, count]) => `${rating} ${count}`);
  return parts.length > 0 ? parts.join(', ') : 'brak zaleceń';
}

function ratingClass(rating: string): string {
  if (rating === 'kupuj' || rating === 'akumuluj') return 'bg-gain/15 text-gain';
  if (rating === 'sprzedaj' || rating === 'redukuj') return 'bg-loss/15 text-loss';
  return 'bg-surface-overlay text-content-muted';
}
