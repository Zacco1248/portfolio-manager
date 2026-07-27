import { useState } from 'react';
import { BOND_KINDS } from '@portfolio/shared';
import type { BondKind } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, Field, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate, formatPercent, formatPln } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp, usePortfolioParam } from '@/state/app';

/** Domyślne parametry emisji dla najpopularniejszych serii detalicznych. */
const KIND_DEFAULTS: Record<string, { termMonths: number; capitalization: 'annual' | 'none' }> = {
  EDO: { termMonths: 120, capitalization: 'annual' },
  COI: { termMonths: 48, capitalization: 'none' },
  TOS: { termMonths: 36, capitalization: 'annual' },
  ROR: { termMonths: 12, capitalization: 'none' },
  DOR: { termMonths: 24, capitalization: 'none' },
  ROS: { termMonths: 72, capitalization: 'annual' },
  ROD: { termMonths: 144, capitalization: 'annual' },
  OTS: { termMonths: 3, capitalization: 'none' },
};

export function Bonds() {
  const portfolioId = usePortfolioParam();
  const { portfolios } = useApp();
  const bonds = useAsync(() => api.bonds.list(portfolioId), [portfolioId]);
  const cpi = useAsync(() => api.bonds.cpi(), []);
  const { toast, show, dismiss } = useToast();
  const [expanded, setExpanded] = useState<number | null>(null);

  const [form, setForm] = useState({
    portfolioId: portfolioId ?? portfolios[0]?.id ?? 1,
    series: '',
    kind: 'EDO' as BondKind,
    purchaseDate: new Date().toISOString().slice(0, 10),
    count: '10',
    nominalAmount: '100',
    firstYearRatePercent: '',
    marginPercent: '1.50',
  });

  const [cpiForm, setCpiForm] = useState({ year: String(new Date().getFullYear()), month: '1', value: '' });

  const addBond = async () => {
    try {
      const defaults = KIND_DEFAULTS[form.kind] ?? { termMonths: 120, capitalization: 'annual' as const };
      await api.bonds.create({
        portfolioId: form.portfolioId,
        series: form.series || form.kind,
        kind: form.kind,
        purchaseDate: form.purchaseDate,
        count: Number(form.count),
        nominalAmount: form.nominalAmount,
        firstYearRatePercent: form.firstYearRatePercent,
        marginPercent: form.marginPercent,
        termMonths: defaults.termMonths,
        capitalization: defaults.capitalization,
        earlyRedemptionFee: '0',
      });
      setForm({ ...form, series: '', firstYearRatePercent: '' });
      bonds.reload();
      show('Obligacja dodana', 'success');
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Nie udało się dodać obligacji', 'error');
    }
  };

  const addCpi = async () => {
    try {
      await api.bonds.saveCpi([
        { year: Number(cpiForm.year), month: Number(cpiForm.month), cpiYoyPercent: cpiForm.value },
      ]);
      setCpiForm({ ...cpiForm, value: '' });
      cpi.reload();
      bonds.reload();
      show('Odczyt inflacji zapisany', 'success');
    } catch {
      show('Nie udało się zapisać odczytu', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Dodaj zakup obligacji">
        <div className="grid gap-3 p-4 pt-2 sm:grid-cols-4 lg:grid-cols-7">
          <Field label="Portfel">
            <select className="input" value={form.portfolioId} onChange={(e) => setForm({ ...form, portfolioId: Number(e.target.value) })}>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Rodzaj">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as BondKind })}>
              {BOND_KINDS.map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </Field>
          <Field label="Seria" hint="np. EDO0536">
            <input className="input" value={form.series} onChange={(e) => setForm({ ...form, series: e.target.value })} />
          </Field>
          <Field label="Data zakupu">
            <input type="date" className="input" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
          </Field>
          <Field label="Liczba">
            <input className="input" value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} />
          </Field>
          <Field label="Oproc. 1. rok %">
            <input className="input" value={form.firstYearRatePercent} onChange={(e) => setForm({ ...form, firstYearRatePercent: e.target.value })} placeholder="7,00" />
          </Field>
          <Field label="Marża %">
            <input className="input" value={form.marginPercent} onChange={(e) => setForm({ ...form, marginPercent: e.target.value })} />
          </Field>
        </div>
        <div className="px-4 pb-4">
          <button type="button" className="btn btn-primary" onClick={() => void addBond()} disabled={!form.firstYearRatePercent}>
            Dodaj
          </button>
          <span className="ml-3 text-2xs text-content-muted">
            Parametry emisji zapisujemy przy zakupie — każda transza ma własne stawki.
          </span>
        </div>
      </Card>

      {bonds.loading && <Spinner />}
      {bonds.error && <ErrorBanner message={bonds.error} onRetry={bonds.reload} />}

      {bonds.data && (
        <Card title="Posiadane obligacje">
          {bonds.data.length === 0 ? (
            <EmptyState title="Brak obligacji" description="Dodaj zakup powyżej, żeby aplikacja naliczała odsetki." />
          ) : (
            <DataTable
              headers={[
                'Seria',
                'Zakup',
                'Wykup',
                { label: 'Liczba', align: 'right' },
                { label: 'Oproc. bieżące', align: 'right' },
                { label: 'Odsetki', align: 'right' },
                { label: 'Wartość', align: 'right' },
                '',
              ]}
            >
              {bonds.data.map((bond) => (
                <>
                  <tr key={bond.id} className="hover:bg-surface-overlay/50">
                    <td className="table-cell">
                      <span className="font-medium">{bond.series}</span>
                      <span className="ml-2 text-2xs text-content-muted">{bond.kind}</span>
                    </td>
                    <td className="table-cell tabular">{formatDate(bond.purchaseDate)}</td>
                    <td className="table-cell tabular text-content-secondary">{formatDate(bond.maturityDate)}</td>
                    <td className="table-cell tabular text-right">{bond.count}</td>
                    <td className="table-cell tabular text-right">{formatPercent(bond.currentPeriodRateBp, { digits: 2 })}</td>
                    <td className="table-cell tabular text-right text-gain">{formatPln(bond.accruedInterestMinor)}</td>
                    <td className="table-cell tabular text-right font-medium">{formatPln(bond.currentValueMinor)}</td>
                    <td className="table-cell text-right">
                      <button type="button" className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={() => setExpanded(expanded === bond.id ? null : bond.id)}>
                        {expanded === bond.id ? 'Zwiń' : 'Okresy'}
                      </button>
                      <button type="button" className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={() => void api.bonds.remove(bond.id).then(bonds.reload)}>
                        Usuń
                      </button>
                    </td>
                  </tr>
                  {expanded === bond.id && (
                    <tr key={`${bond.id}-periods`}>
                      <td colSpan={8} className="bg-surface-base px-4 py-2">
                        <table className="w-full text-2xs">
                          <thead className="text-content-muted">
                            <tr>
                              <th className="py-1 text-left">Okres</th>
                              <th className="py-1 text-left">Od</th>
                              <th className="py-1 text-left">Do</th>
                              <th className="py-1 text-right">Oprocentowanie</th>
                              <th className="py-1 text-right">Kapitał</th>
                              <th className="py-1 text-right">Odsetki</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bond.periods.map((period) => (
                              <tr key={period.index} className={period.projected ? 'text-content-muted' : ''}>
                                <td className="py-1">{period.index}</td>
                                <td className="py-1 tabular">{formatDate(period.from)}</td>
                                <td className="py-1 tabular">{formatDate(period.to)}</td>
                                <td className="py-1 tabular text-right">
                                  {formatPercent(period.rateBp, { digits: 2 })}
                                  {period.projected && <span className="ml-1 text-warn">prognoza</span>}
                                </td>
                                <td className="py-1 tabular text-right">{formatPln(period.openingCapitalMinor)}</td>
                                <td className="py-1 tabular text-right">{formatPln(period.interestMinor)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </DataTable>
          )}
        </Card>
      )}

      <Card title="Odczyty inflacji (GUS)">
        <div className="flex flex-wrap items-end gap-2 p-4 pt-2">
          <div className="w-24">
            <Field label="Rok">
              <input className="input" value={cpiForm.year} onChange={(e) => setCpiForm({ ...cpiForm, year: e.target.value })} />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Miesiąc">
              <input className="input" value={cpiForm.month} onChange={(e) => setCpiForm({ ...cpiForm, month: e.target.value })} />
            </Field>
          </div>
          <div className="w-32">
            <Field label="Inflacja r/r %">
              <input className="input" value={cpiForm.value} onChange={(e) => setCpiForm({ ...cpiForm, value: e.target.value })} placeholder="4,20" />
            </Field>
          </div>
          <button type="button" className="btn" onClick={() => void addCpi()} disabled={!cpiForm.value}>
            Zapisz
          </button>
          <span className="text-2xs text-content-muted">
            Bez odczytu inflacji kolejne okresy są liczone jako prognoza na podstawie ostatniej znanej wartości.
          </span>
        </div>

        {cpi.data && cpi.data.length > 0 && (
          <ul className="flex flex-wrap gap-2 border-t border-surface-border px-4 py-3 text-2xs">
            {cpi.data.slice(0, 24).map((entry) => (
              <li key={`${entry.year}-${entry.month}`} className="rounded bg-surface-overlay px-2 py-1">
                {entry.year}-{String(entry.month).padStart(2, '0')}: {formatPercent(entry.cpiYoyBp, { digits: 1 })}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}
