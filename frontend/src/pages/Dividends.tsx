import { useState } from 'react';
import { Card, DataTable, EmptyState, ErrorBanner, Field, KpiTile, Spinner, Toast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCurrency, formatDate, formatPercent, formatPln } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

export function Dividends() {
  const portfolioId = usePortfolioParam();
  const { data, error, loading, reload } = useAsync(() => api.analytics.dividends(portfolioId), [portfolioId]);
  const reports = useAsync(() => api.corporate.reportDates(), []);
  const instruments = useAsync(() => api.instruments.list(), []);
  const { toast, show, dismiss } = useToast();
  const [form, setForm] = useState({ instrumentId: '', date: '', label: 'Raport okresowy' });

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const currentYear = data.byYear[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Stopa dywidendy (12 mies.)"
          value={formatPercent(data.trailingYieldBp, { digits: 2 })}
          hint="Wypłaty netto do bieżącej wartości portfela"
        />
        <KpiTile label="Wypłat w bazie" value={String(data.entries.length)} />
        <KpiTile
          label={currentYear ? `Brutto ${currentYear.year}` : 'Brutto'}
          value={formatPln(currentYear?.grossPlnMinor ?? 0)}
        />
        <KpiTile
          label={currentYear ? `Netto ${currentYear.year}` : 'Netto'}
          value={formatPln(currentYear?.netPlnMinor ?? 0)}
          hint={currentYear ? `Podatek u źródła ${formatPln(currentYear.taxPlnMinor)}` : undefined}
        />
      </div>

      <Card title="Podsumowanie roczne">
        {data.byYear.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Brak wypłat dywidend.</p>
        ) : (
          <DataTable
            headers={['Rok', { label: 'Brutto', align: 'right' }, { label: 'Podatek u źródła', align: 'right' }, { label: 'Netto', align: 'right' }]}
          >
            {data.byYear.map((row) => (
              <tr key={row.year}>
                <td className="table-cell tabular font-medium">{row.year}</td>
                <td className="table-cell tabular text-right">{formatPln(row.grossPlnMinor)}</td>
                <td className="table-cell tabular text-right text-content-secondary">{formatPln(row.taxPlnMinor)}</td>
                <td className="table-cell tabular text-right font-medium">{formatPln(row.netPlnMinor)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      <Card title="Kalendarz — przewidywane wypłaty">
        {data.upcoming.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
            Brak prognoz. Pobierz historię wypłat przyciskiem „Odśwież dane dywidendowe” w Ustawieniach —
            terminy wyliczamy z rytmu poprzednich dywidend.
          </p>
        ) : (
          <>
            <DataTable headers={['Przewidywany dzień ustalenia prawa', 'Instrument', 'Podstawa prognozy']}>
              {data.upcoming.map((entry, index) => (
                <tr key={`${entry.instrument.id}-${index}`}>
                  <td className="table-cell tabular font-medium">{formatDate(entry.exDate)}</td>
                  <td className="table-cell">
                    <span className="font-medium">{entry.instrument.symbol}</span>
                    <span className="ml-2 text-2xs text-content-muted">{entry.instrument.name}</span>
                  </td>
                  <td className="table-cell text-2xs text-content-muted">{entry.note}</td>
                </tr>
              ))}
            </DataTable>
            <p className="px-4 py-2 text-2xs text-warn">
              ⚠ To są terminy prognozowane z rytmu poprzednich wypłat, a nie daty ogłoszone przez spółki.
              Darmowe źródła danych nie udostępniają przyszłych terminów.
            </p>
          </>
        )}
      </Card>

      <Card title="Terminy raportów okresowych">
        <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4">
          <Field label="Instrument">
            <select className="input" value={form.instrumentId} onChange={(e) => setForm({ ...form, instrumentId: e.target.value })}>
              <option value="">— wybierz —</option>
              {(instruments.data ?? []).filter((i) => i.assetClass !== 'cash').map((i) => (
                <option key={i.id} value={i.id}>{i.symbol}</option>
              ))}
            </select>
          </Field>
          <Field label="Data">
            <input type="date" className="input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Opis">
            <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              className="btn"
              disabled={!form.instrumentId || !form.date}
              onClick={() =>
                void api.corporate
                  .addReportDate({ instrumentId: Number(form.instrumentId), date: form.date, label: form.label })
                  .then(() => {
                    setForm({ instrumentId: '', date: '', label: 'Raport okresowy' });
                    reports.reload();
                    show('Termin zapisany', 'success');
                  })
                  .catch(() => show('Nie udało się zapisać terminu', 'error'))
              }
            >
              Dodaj termin
            </button>
          </div>
        </div>

        {reports.data && reports.data.length > 0 ? (
          <DataTable headers={['Data', 'Instrument', 'Opis', '']}>
            {reports.data.map((entry) => (
              <tr key={entry.id}>
                <td className="table-cell tabular">{formatDate(entry.date)}</td>
                <td className="table-cell font-medium">{entry.symbol}</td>
                <td className="table-cell text-content-secondary">{entry.label}</td>
                <td className="table-cell text-right">
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-0.5 text-2xs"
                    onClick={() => void api.corporate.removeReportDate(entry.id).then(reports.reload)}
                  >
                    Usuń
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <p className="px-4 pb-4 text-2xs text-content-muted">
            Terminy wprowadzasz ręcznie — nie ma darmowego API z harmonogramami raportów. Alert przypomni
            o zbliżającym się terminie, jeśli włączysz powiadomienie „Raport okresowy”.
          </p>
        )}
      </Card>

      <Card title="Historia wypłat">
        {data.entries.length === 0 ? (
          <EmptyState
            title="Brak dywidend"
            description="Dywidendy pojawią się po imporcie wyciągu albo po ręcznym dodaniu transakcji typu Dywidenda."
          />
        ) : (
          <DataTable
            headers={[
              'Data',
              'Instrument',
              'Portfel',
              { label: 'Brutto', align: 'right' },
              { label: 'Podatek', align: 'right' },
              { label: 'Netto PLN', align: 'right' },
            ]}
          >
            {data.entries.map((entry) => (
              <tr key={entry.transactionId}>
                <td className="table-cell tabular">{formatDate(entry.date)}</td>
                <td className="table-cell">
                  <div className="font-medium">{entry.instrument.symbol}</div>
                  <div className="text-2xs text-content-muted">{entry.instrument.name}</div>
                </td>
                <td className="table-cell text-2xs text-content-muted">{entry.portfolioName}</td>
                <td className="table-cell tabular text-right">{formatCurrency(entry.grossMinor, entry.currency)}</td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {entry.taxMinor === 0 ? '—' : formatCurrency(entry.taxMinor, entry.currency)}
                </td>
                <td className="table-cell tabular text-right font-medium">{formatPln(entry.netPlnMinor)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}
