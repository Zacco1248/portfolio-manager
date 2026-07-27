import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Suggestion {
  symbol: string;
  name: string;
  exchange: string | null;
  assetClass: string;
  source: string;
}

/**
 * Autouzupełnianie tickera.
 *
 * Podpowiedzi łączą instrumenty już znane lokalnie z wynikami wyszukiwarki
 * dostawcy. Brak sieci nie może zepsuć formularza — wtedy zostają same wyniki
 * lokalne, a wpisany ręcznie tekst i tak jest przyjmowany.
 */
export function SymbolSearch({
  value,
  onChange,
  onPick,
  placeholder = 'np. CDR, XTB, AAPL…',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick?: (suggestion: Suggestion) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Odpytujemy dopiero po chwili bezczynności — wyszukiwarka dostawcy ma limity.
  useEffect(() => {
    const query = value.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api.instruments
        .search(query)
        .then((results) => {
          if (!cancelled) {
            setSuggestions(results.slice(0, 12));
            setHighlighted(0);
          }
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const visible = useMemo(() => open && suggestions.length > 0, [open, suggestions.length]);

  const pick = (suggestion: Suggestion) => {
    onChange(suggestion.symbol);
    onPick?.(suggestion);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!visible) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      const choice = suggestions[highlighted];
      if (choice) {
        event.preventDefault();
        pick(choice);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {loading && (
        <span className="absolute right-2 top-2 h-3 w-3 animate-spin rounded-full border-2 border-surface-border border-t-accent" />
      )}

      {visible && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-surface-border bg-surface-raised shadow-lg">
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.source}-${suggestion.symbol}`}>
              <button
                type="button"
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${
                  index === highlighted ? 'bg-accent/15' : 'hover:bg-surface-overlay'
                }`}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => pick(suggestion)}
              >
                <span className="font-medium">{suggestion.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-content-muted">{suggestion.name}</span>
                <span className="shrink-0 text-2xs text-content-muted">
                  {suggestion.exchange ?? ''}
                  {suggestion.source === 'local' ? ' · w bazie' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
