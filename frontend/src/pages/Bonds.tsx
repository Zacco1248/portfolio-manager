import { useState } from 'react';
import { BOND_KINDS, bondTermsFor, defaultBondSeries } from '@portfolio/shared';
import type { BondKind } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, Field, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate, formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp, usePortfolioParam } from '@/state/app';

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

  // Oznaczenie wynikające z rodzaju i daty zakupu — pokazujemy je jako
  // podpowiedź, żeby nie trzeba było przepisywać go z potwierdzenia zakupu.
  const suggestedSeries = defaultBondSeries(form.kind, form.purchaseDate);
  // Serie użyte wcześniej: przy dokupowaniu tej samej emisji wystarczy wybrać.
  const knownSeries = [...new Set((bonds.data ?? []).map((b) => b.series))].sort();

  const addBond = async () => {
    try {
      const defaults = bondTermsFor(form.kind);
      await api.bonds.create({
        portfolioId: form.portfolioId,
        series: form.series || defaultBondSeries(form.kind, form.purchaseDate),
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
          <Field label="Seria" hint={`Puste = ${suggestedSeries}`}>
            {/*
              Podpowiedź, nie wymuszenie: seria wynika z rodzaju i daty zakupu
              wg konwencji MF, ale bywają emisje nietypowe, więc pole zostaje
              edytowalne. `datalist` dokłada serie użyte wcześniej.
            */}
            <input
              className="input"
              list="serie-obligacji"
              placeholder={suggestedSeries}
              value={form.series}
              onChange={(e) => setForm({ ...form, series: e.target.value })}
            />
            <datalist id="serie-obligacji">
              {knownSeries.map((series) => (
                <option key={series} value={series} />
              ))}
            </datalist>
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
                { label: 'Zwrot', align: 'right' },
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
                    <td className={`table-cell tabular text-right ${toneClass(bond.accruedInterestMinor)}`}>
                      {formatPercent(
                        bond.nominalMinor * bond.count > 0
                          ? Math.round((bond.accruedInterestMinor / (bond.nominalMinor * bond.count)) * 10_000)
                          : null,
                        { sign: true },
                      )}
                    </td>
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
                      <td colSpan={9} className="bg-surface-base px-4 py-2">
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
        <CpiCoverage entries={cpi.data ?? []} />

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

/**
 * Pokrycie odczytami inflacji.
 *
 * Bez tego użytkownik nie miał jak odróżnić „obligacja liczona z prognozy, bo
 * brakuje danych" od „silnik liczy źle" — a to dwie zupełnie różne sprawy.
 * Odczyty wchodzą do bazy przy imporcie arkusza z GUS albo ręcznie niżej.
 */
function CpiCoverage({ entries }: { entries: { year: number; month: number }[] }) {
  if (entries.length === 0) {
    return (
      <p className="border-b border-surface-border px-4 pb-3 pt-2 text-2xs text-warn">
        Brak odczytów inflacji — wszystkie okresy po pierwszym roku liczą się z samej marży. Zaimportuj arkusz
        z danymi GUS albo dodaj odczyty ręcznie poniżej.
      </p>
    );
  }

  // Emitent ustala stopę na podstawie odczytu sprzed dwóch miesięcy, więc
  // dane sięgające miesiąca X pokrywają okresy zaczynające się do X+2.
  const sorted = [...entries].sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const fmt = (e: { year: number; month: number }) => `${e.year}-${String(e.month).padStart(2, '0')}`;

  const coveredUntil = new Date(Date.UTC(last.year, last.month + 1, 1));
  const covered = `${coveredUntil.getUTCFullYear()}-${String(coveredUntil.getUTCMonth() + 1).padStart(2, '0')}`;

  return (
    <p className="border-b border-surface-border px-4 pb-3 pt-2 text-2xs text-content-muted">
      {entries.length} odczytów od {fmt(first)} do {fmt(last)}. Okresy odsetkowe zaczynające się do {covered}{' '}
      liczone są z realnej inflacji; późniejsze — jako prognoza z ostatniej znanej wartości.
    </p>
  );
}
