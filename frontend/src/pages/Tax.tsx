import { useState } from 'react';
import type { TaxSection } from '@portfolio/shared';
import { TAX_REGIME_LABELS } from '@portfolio/shared';
import { Card, DataTable, ErrorBanner, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

export function Tax() {
  const portfolioId = usePortfolioParam();
  const years = useAsync(() => api.tax.years(), []);
  const [year, setYear] = useState<number | null>(null);
  const effectiveYear = year ?? years.data?.[0] ?? new Date().getFullYear();
  const report = useAsync(() => api.tax.report(effectiveYear, portfolioId), [effectiveYear, portfolioId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className="input h-8 w-32 py-0" value={effectiveYear} onChange={(e) => setYear(Number(e.target.value))}>
          {(years.data ?? [effectiveYear]).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <a className="btn" href={api.tax.csvUrl(effectiveYear, portfolioId)} download>
          Pobierz CSV
        </a>
      </div>

      {report.loading && <Spinner />}
      {report.error && <ErrorBanner message={report.error} onRetry={report.reload} />}

      {report.data && (
        <>
          {report.data.excludedPortfolios.length > 0 && (
            <div className="rounded-card border border-surface-border bg-surface-overlay px-4 py-3 text-sm">
              <p className="font-medium">Portfele wyłączone z zestawienia</p>
              <p className="mt-1 text-2xs text-content-muted">
                Zyski z tych rachunków są zwolnione z podatku od zysków kapitałowych, więc nie wchodzą do PIT-38:{' '}
                {report.data.excludedPortfolios
                  .map((p) => `${p.name} (${TAX_REGIME_LABELS[p.taxRegime]})`)
                  .join(', ')}
                .
              </p>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <SectionCard title="Papiery wartościowe" section={report.data.securities} />
            <SectionCard title="Kryptowaluty (rozliczane osobno)" section={report.data.crypto} />
          </div>

          <Card title="Dywidendy i podatek u źródła">
            <div className="grid grid-cols-3 gap-3 p-4 pt-2 text-sm">
              <Summary label="Brutto" value={formatPln(report.data.dividends.grossPlnMinor)} />
              <Summary label="Podatek u źródła" value={formatPln(report.data.dividends.withholdingTaxPlnMinor)} />
              <Summary label="Do dopłaty w PL" value={formatPln(report.data.dividends.duePlnMinor)} highlight />
            </div>

            {report.data.dividends.entries.length > 0 && (
              <DataTable
                headers={['Data', 'Instrument', 'Kraj', { label: 'Brutto', align: 'right' }, { label: 'Podatek u źródła', align: 'right' }]}
              >
                {report.data.dividends.entries.map((entry, index) => (
                  <tr key={`${entry.date}-${index}`}>
                    <td className="table-cell tabular">{formatDate(entry.date)}</td>
                    <td className="table-cell">{entry.symbol || '—'}</td>
                    <td className="table-cell text-content-secondary">{entry.country ?? '—'}</td>
                    <td className="table-cell tabular text-right">{formatPln(entry.grossPlnMinor)}</td>
                    <td className="table-cell tabular text-right text-content-secondary">
                      {formatPln(entry.withholdingPlnMinor)}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>

          <p className="rounded-card border border-warn/30 bg-warn/5 px-4 py-3 text-2xs text-warn">
            ⚠ {report.data.note}
          </p>
        </>
      )}
    </div>
  );
}

function SectionCard({ title, section }: { title: string; section: TaxSection }) {
  return (
    <Card title={title}>
      <div className="grid grid-cols-2 gap-3 p-4 pt-2 text-sm sm:grid-cols-4">
        <Summary label="Przychód" value={formatPln(section.revenuePlnMinor)} />
        <Summary label="Koszty" value={formatPln(section.costPlnMinor)} />
        <Summary label="Dochód" value={formatPln(section.gainPlnMinor, { sign: true })} tone={section.gainPlnMinor} />
        <Summary label="Podatek 19%" value={formatPln(section.taxPlnMinor)} highlight />
      </div>

      {section.lossCarryForward && (
        <div className="mx-4 mb-3 rounded-card border border-surface-border bg-surface-overlay px-3 py-2">
          <div className="grid grid-cols-2 gap-2 text-2xs sm:grid-cols-4">
            <Summary label="Strata dostępna" value={formatPln(section.lossCarryForward.availablePlnMinor)} />
            <Summary label="Odliczono" value={formatPln(section.lossCarryForward.appliedPlnMinor)} />
            <Summary
              label="Podstawa po odliczeniu"
              value={formatPln(section.lossCarryForward.taxableGainPlnMinor)}
              highlight
            />
            <Summary
              label="Zostaje na później"
              value={formatPln(section.lossCarryForward.carryToNextYearPlnMinor)}
            />
          </div>
          <p className="mt-2 text-2xs text-content-muted">{section.lossCarryForward.note}</p>
          {section.lossCarryForward.expiredPlnMinor > 0 && (
            <p className="mt-1 text-2xs text-warn">
              Przepadło z upływem pięciu lat: {formatPln(section.lossCarryForward.expiredPlnMinor)}.
            </p>
          )}
        </div>
      )}

      {section.entries.length === 0 ? (
        <p className="px-4 pb-4 text-2xs text-content-muted">Brak transakcji w tym roku.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <DataTable
            headers={[
              'Sprzedaż',
              'Nabycie',
              'Instrument',
              { label: 'Przychód', align: 'right' },
              { label: 'Koszt', align: 'right' },
              { label: 'Dochód', align: 'right' },
            ]}
          >
            {section.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="table-cell tabular">{formatDate(entry.saleDate)}</td>
                <td className="table-cell tabular text-content-secondary">{formatDate(entry.purchaseDate)}</td>
                <td className="table-cell">
                  <div className="font-medium">{entry.instrumentSymbol}</div>
                  <div className="text-2xs text-content-muted">{entry.portfolioName}</div>
                </td>
                <td className="table-cell tabular text-right">{formatPln(entry.taxProceedsPlnMinor)}</td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {formatPln(entry.taxCostPlnMinor)}
                </td>
                <td className={`table-cell tabular text-right ${toneClass(entry.taxGainPlnMinor)}`}>
                  {formatPln(entry.taxGainPlnMinor, { sign: true })}
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </Card>
  );
}

function Summary({ label, value, highlight = false, tone }: { label: string; value: string; highlight?: boolean; tone?: number }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-content-muted">{label}</div>
      <div className={`tabular mt-0.5 font-medium ${highlight ? 'text-accent' : tone !== undefined ? toneClass(tone) : ''}`}>
        {value}
      </div>
    </div>
  );
}
