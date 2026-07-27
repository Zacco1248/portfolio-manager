import { useState } from 'react';
import type { ImportPreviewResponse, ImportRowPreview } from '@portfolio/shared';
import { MappingWizard } from '@/components/MappingWizard';
import type { InspectResult } from '@/components/MappingWizard';
import { Card, DataTable, ErrorBanner, Field, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp, usePortfolioParam } from '@/state/app';

const STATUS_LABEL: Record<ImportRowPreview['status'], { label: string; className: string }> = {
  new: { label: 'nowa', className: 'bg-gain/15 text-gain' },
  duplicate: { label: 'duplikat', className: 'bg-surface-overlay text-content-muted' },
  conflict: { label: 'konflikt', className: 'bg-warn/15 text-warn' },
  error: { label: 'błąd', className: 'bg-loss/15 text-loss' },
};

/**
 * Import przebiega dwuetapowo. Podgląd nie zapisuje żadnych transakcji —
 * dopiero zatwierdzenie zaznaczonych wierszy tworzy wpisy. Wiersze rozpoznane
 * jako duplikat lub konflikt są domyślnie odznaczone.
 */
export function ImportPage() {
  const { portfolios } = useApp();
  const defaultPortfolio = usePortfolioParam() ?? portfolios[0]?.id;
  const parsers = useAsync(() => api.imports.parsers(), []);

  const [portfolioId, setPortfolioId] = useState<number | undefined>(defaultPortfolio);
  const [parserId, setParserId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const { toast, show, dismiss } = useToast();

  /**
   * Dla plików CSV najpierw pokazujemy kreator mapowania — bez wskazania,
   * która kolumna jest datą, a która rodzajem operacji, parser generyczny
   * nie ma z czym pracować.
   */
  const needsWizard = (): boolean => {
    if (!file) return false;
    if (parserId && parserId !== 'generic-csv') return false;
    return /\.(csv|tsv|txt)$/i.test(file.name);
  };

  const startImport = async () => {
    if (!file || !portfolioId) return;
    if (needsWizard() && !inspect) {
      setBusy(true);
      setError(null);
      try {
        setInspect(await api.imports.inspect(file));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Nie udało się odczytać nagłówków pliku');
      } finally {
        setBusy(false);
      }
      return;
    }
    await runPreview();
  };

  const runPreview = async (mapping?: Record<string, string | null>) => {
    if (!file || !portfolioId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.imports.preview(file, portfolioId, parserId || undefined, mapping);
      setPreview(result);
      // Domyślnie zaznaczamy wyłącznie wiersze bezsporne — duplikaty
      // i konflikty wymagają świadomej decyzji użytkownika.
      setSelected(new Set(result.rows.filter((r) => r.status === 'new').map((r) => r.rowId)));
      setInspect(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nie udało się odczytać pliku');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.imports.commit(preview.batchId, [...selected]);
      show(
        `Zaimportowano ${result.imported}, pominięto ${result.skipped}${result.errors.length > 0 ? `, błędów ${result.errors.length}` : ''}`,
        result.errors.length > 0 ? 'error' : 'success',
      );
      setPreview(null);
      setFile(null);
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Import nie powiódł się', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (rowId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <Card title="Wczytaj plik">
        <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4">
          <Field label="Portfel docelowy">
            <select className="input" value={portfolioId ?? ''} onChange={(e) => setPortfolioId(Number(e.target.value))}>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Parser" hint="Puste = rozpoznanie automatyczne">
            <select className="input" value={parserId} onChange={(e) => setParserId(e.target.value)}>
              <option value="">Wykryj automatycznie</option>
              {(parsers.data?.parsers ?? []).map((parser) => (
                <option key={parser.id} value={parser.id}>
                  {parser.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="sm:col-span-2">
            <Field label="Plik">
              <input
                type="file"
                className="input file:mr-3 file:rounded file:border-0 file:bg-surface-overlay file:px-2 file:py-1 file:text-sm"
                accept=".mhtml,.mht,.html,.xlsx,.xlsm,.csv,.tsv,.txt"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 pb-4">
          <button type="button" className="btn btn-primary" onClick={() => void startImport()} disabled={!file || !portfolioId || busy}>
            {busy ? 'Analizuję…' : needsWizard() && !inspect ? 'Dalej: mapowanie kolumn' : 'Pokaż podgląd'}
          </button>
          {(preview || inspect) && (
            <button type="button" className="btn" onClick={() => { setPreview(null); setInspect(null); setFile(null); }}>
              Wyczyść
            </button>
          )}
        </div>

        {parsers.data && (
          <ul className="space-y-1 border-t border-surface-border px-4 py-3 text-2xs text-content-muted">
            {parsers.data.parsers.map((parser) => (
              <li key={parser.id}>
                <span className="font-medium text-content-secondary">{parser.name}</span> — {parser.description}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && <ErrorBanner message={error} />}

      {inspect && (
        <Card title="Mapowanie kolumn">
          <div className="p-4 pt-2">
            <MappingWizard
              inspect={inspect}
              busy={busy}
              onCancel={() => setInspect(null)}
              onApply={(mapping) => void runPreview(mapping)}
            />
          </div>
        </Card>
      )}

      {busy && !preview && !inspect && <Spinner label="Czytam plik…" />}

      {preview && (
        <Card
          title={`Podgląd: ${preview.filename}`}
          action={
            <div className="flex items-center gap-3 text-2xs">
              <span className="text-gain">{preview.stats.new} nowych</span>
              <span className="text-content-muted">{preview.stats.duplicate} duplikatów</span>
              <span className="text-warn">{preview.stats.conflict} konfliktów</span>
              {preview.stats.error > 0 && <span className="text-loss">{preview.stats.error} błędów</span>}
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-2xs">
            <button type="button" className="btn text-2xs" onClick={() => setSelected(new Set(preview.rows.filter((r) => r.status !== 'error').map((r) => r.rowId)))}>
              Zaznacz wszystkie
            </button>
            <button type="button" className="btn text-2xs" onClick={() => setSelected(new Set())}>
              Odznacz wszystkie
            </button>
            <button type="button" className="btn text-2xs" onClick={() => setSelected(new Set(preview.rows.filter((r) => r.status === 'new').map((r) => r.rowId)))}>
              Tylko nowe
            </button>
            <span className="ml-auto text-content-muted">Zaznaczono {selected.size} z {preview.rows.length}</span>
          </div>

          <div className="max-h-[28rem] overflow-y-auto">
            <DataTable headers={['', 'Data', 'Typ', 'Instrument', { label: 'Liczba', align: 'right' }, { label: 'Cena', align: 'right' }, 'Status', 'Uwagi']}>
              {preview.rows.map((row) => (
                <tr key={row.rowId} className={row.status === 'error' ? 'opacity-60' : ''}>
                  <td className="table-cell">
                    <input
                      type="checkbox"
                      checked={selected.has(row.rowId)}
                      disabled={row.status === 'error'}
                      onChange={() => toggle(row.rowId)}
                    />
                  </td>
                  <td className="table-cell tabular">{formatDate(row.tradeDate)}</td>
                  <td className="table-cell">{row.type}</td>
                  <td className="table-cell">{row.symbol ?? '—'}</td>
                  <td className="table-cell tabular text-right">{row.quantity === '0' ? '—' : row.quantity}</td>
                  <td className="table-cell tabular text-right">
                    {row.price === '0' ? row.amount : row.price} {row.currency}
                  </td>
                  <td className="table-cell">
                    <span className={`badge ${STATUS_LABEL[row.status].className}`}>{STATUS_LABEL[row.status].label}</span>
                  </td>
                  <td className="table-cell max-w-md whitespace-normal text-2xs text-content-muted">{row.message ?? ''}</td>
                </tr>
              ))}
            </DataTable>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-surface-border px-4 py-3">
            <button type="button" className="btn btn-primary" onClick={() => void commit()} disabled={busy || selected.size === 0}>
              {busy ? 'Zapisuję…' : `Zaimportuj ${selected.size} transakcji`}
            </button>
          </div>
        </Card>
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}
