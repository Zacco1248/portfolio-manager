import { useState } from 'react';
import { Field } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * Kreator mapowania kolumn dla plików CSV bez dedykowanego parsera.
 *
 * Backend proponuje wstępne mapowanie po nazwach nagłówków; tutaj użytkownik
 * je poprawia. Bez wskazania daty i rodzaju operacji import nie ma sensu,
 * więc te dwa pola są wymagane.
 */

const FIELD_LABELS: Record<string, string> = {
  date: 'Data transakcji',
  type: 'Rodzaj operacji',
  symbol: 'Ticker / symbol',
  name: 'Nazwa instrumentu',
  currency: 'Waluta',
  quantity: 'Liczba sztuk',
  price: 'Cena jednostkowa',
  amount: 'Kwota',
  fee: 'Prowizja',
  tax: 'Podatek',
  fxRate: 'Kurs waluty',
  note: 'Notatka',
};

const REQUIRED = ['date', 'type'];

export interface InspectResult {
  delimiter: string;
  headers: string[];
  sampleRows: string[][];
  suggestedMapping: Record<string, string | null>;
  mappableFields: string[];
}

export function MappingWizard({
  inspect,
  onApply,
  onCancel,
  busy = false,
}: {
  inspect: InspectResult;
  onApply: (mapping: Record<string, string | null>) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [mapping, setMapping] = useState<Record<string, string | null>>(inspect.suggestedMapping);
  const [hint, setHint] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  /**
   * Podpowiedź mapowania z modelu.
   *
   * Model odpowiada w konwencji nagłówek → pole, formularz trzyma odwrotną,
   * więc mapowanie trzeba odwrócić. Nadpisujemy tylko pola nieuzupełnione —
   * ręczny wybór użytkownika ma pierwszeństwo przed podpowiedzią.
   */
  const suggest = async () => {
    setHint({ busy: true, message: null });
    try {
      const result = await api.assist.importMapping(inspect.headers, inspect.sampleRows.slice(0, 5));
      const proposed = parseMappingJson(result.text);

      if (!proposed) {
        setHint({ busy: false, message: result.unavailableReason ?? 'Model nie zwrócił mapowania.' });
        return;
      }

      let applied = 0;
      setMapping((current) => {
        const next = { ...current };
        for (const [header, field] of Object.entries(proposed)) {
          if (!inspect.mappableFields.includes(field)) continue;
          if (next[field]) continue;
          next[field] = header;
          applied += 1;
        }
        return next;
      });

      setHint({
        busy: false,
        message: applied > 0 ? `Uzupełniono ${applied} pól — sprawdź przed zatwierdzeniem.` : 'Nic nowego do uzupełnienia.',
      });
    } catch {
      setHint({ busy: false, message: 'Nie udało się pobrać podpowiedzi.' });
    }
  };

  const missing = REQUIRED.filter((field) => !mapping[field]);
  const delimiterLabel =
    inspect.delimiter === '\t' ? 'tabulator' : inspect.delimiter === ';' ? 'średnik' : inspect.delimiter;

  return (
    <div className="space-y-3">
      <p className="text-2xs text-content-muted">
        Wykryto {inspect.headers.length} kolumn, separator: <code>{delimiterLabel}</code>. Przypisz kolumny do pól —
        wstępne dopasowanie zrobiliśmy po nazwach nagłówków.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost text-2xs" disabled={hint.busy} onClick={() => void suggest()}>
          {hint.busy ? 'Pytam model…' : 'Podpowiedz mapowanie (AI)'}
        </button>
        {hint.message && <span className="text-2xs text-content-muted">{hint.message}</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {inspect.mappableFields.map((field) => (
          <Field
            key={field}
            label={`${FIELD_LABELS[field] ?? field}${REQUIRED.includes(field) ? ' *' : ''}`}
          >
            <select
              className={`input ${REQUIRED.includes(field) && !mapping[field] ? 'border-warn' : ''}`}
              value={mapping[field] ?? ''}
              onChange={(e) => setMapping((current) => ({ ...current, [field]: e.target.value || null }))}
            >
              <option value="">— pomiń —</option>
              {inspect.headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>

      {inspect.sampleRows.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-surface-border">
          <table className="w-full text-2xs">
            <thead className="bg-surface-overlay text-content-muted">
              <tr>
                {inspect.headers.map((header) => (
                  <th key={header} className="whitespace-nowrap px-2 py-1 text-left font-medium">
                    {header}
                    {mappedTo(mapping, header) && (
                      <span className="ml-1 text-accent">→ {FIELD_LABELS[mappedTo(mapping, header)!]}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {inspect.sampleRows.map((row, index) => (
                <tr key={index}>
                  {inspect.headers.map((_, column) => (
                    <td key={column} className="whitespace-nowrap px-2 py-1 text-content-secondary">
                      {row[column] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {missing.length > 0 && (
        <p className="text-2xs text-warn">
          Wskaż jeszcze: {missing.map((f) => FIELD_LABELS[f]).join(', ')}.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Anuluj
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onApply(mapping)}
          disabled={missing.length > 0 || busy}
        >
          {busy ? 'Analizuję…' : 'Zastosuj mapowanie'}
        </button>
      </div>
    </div>
  );
}

/** Które pole korzysta z danej kolumny — do podpisu w podglądzie. */
function mappedTo(mapping: Record<string, string | null>, header: string): string | null {
  const entry = Object.entries(mapping).find(([, column]) => column === header);
  return entry?.[0] ?? null;
}


/**
 * Wyciąga mapowanie nagłówek → pole z odpowiedzi modelu.
 *
 * Model bywa rozmowny mimo instrukcji, więc szukamy obiektu JSON w tekście
 * zamiast zakładać, że cała odpowiedź nim jest.
 */
export function parseMappingJson(text: string | null): Record<string, string> | null {
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const mapping = (parsed as { mapping?: unknown }).mapping;
    if (typeof mapping !== 'object' || mapping === null) return null;

    const out: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping as Record<string, unknown>)) {
      if (typeof field === 'string' && field.length > 0) out[header] = field;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
