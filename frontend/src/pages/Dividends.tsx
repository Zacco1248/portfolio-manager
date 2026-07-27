import { Card, DataTable, EmptyState, ErrorBanner, KpiTile, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCurrency, formatDate, formatPercent, formatPln } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

export function Dividends() {
  const portfolioId = usePortfolioParam();
  const { data, error, loading, reload } = useAsync(() => api.analytics.dividends(portfolioId), [portfolioId]);

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
    </div>
  );
}
