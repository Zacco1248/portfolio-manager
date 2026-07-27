import { useState } from 'react';
import { TRANSACTION_TYPE_LABELS } from '@portfolio/shared';
import type { TransactionType } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, Field, Modal, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatCurrency, formatDate, formatPln, formatQuantity, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { ALL_PORTFOLIOS, useApp, usePortfolioParam } from '@/state/app';

export function Transactions() {
  const portfolioId = usePortfolioParam();
  const { portfolios, selectedPortfolioId } = useApp();
  const { data, error, loading, reload } = useAsync(
    () => api.transactions.list({ portfolioId, limit: 500 }),
    [portfolioId],
  );
  const [formOpen, setFormOpen] = useState(false);
  const { toast, show, dismiss } = useToast();

  const remove = async (id: number) => {
    if (!window.confirm('Usunąć tę transakcję? Zysk zrealizowany zostanie przeliczony od nowa.')) return;
    try {
      const result = await api.transactions.remove(id);
      reload();
      show(result.warnings.length > 0 ? result.warnings[0]! : 'Transakcja usunięta', result.warnings.length > 0 ? 'error' : 'success');
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Nie udało się usunąć', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-content-muted">
          Kwota w PLN to faktyczny przepływ gotówki. Podstawa podatkowa liczona jest osobno, po kursie NBP z dnia
          poprzedzającego transakcję.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
          Dodaj transakcję
        </button>
      </div>

      {loading && <Spinner />}
      {error && <ErrorBanner message={error} onRetry={reload} />}

      {data && (
        <Card>
          {data.length === 0 ? (
            <EmptyState title="Brak transakcji" description="Dodaj pierwszą ręcznie albo zaimportuj wyciąg." />
          ) : (
            <DataTable
              headers={[
                'Data',
                'Typ',
                'Instrument',
                { label: 'Liczba', align: 'right' },
                { label: 'Cena', align: 'right' },
                { label: 'Kurs', align: 'right' },
                { label: 'Przepływ PLN', align: 'right' },
                '',
              ]}
            >
              {data.map((tx) => (
                <tr key={tx.id} className="hover:bg-surface-overlay/50">
                  <td className="table-cell tabular">{formatDate(tx.tradeDate)}</td>
                  <td className="table-cell">
                    <span className="badge bg-surface-overlay text-content-secondary">
                      {TRANSACTION_TYPE_LABELS[tx.type]}
                    </span>
                  </td>
                  <td className="table-cell">
                    {tx.instrument ? (
                      <>
                        <span className="font-medium">{tx.instrument.symbol}</span>
                        <span className="ml-2 text-2xs text-content-muted">
                          {selectedPortfolioId === ALL_PORTFOLIOS ? tx.portfolioName : tx.instrument.name}
                        </span>
                      </>
                    ) : (
                      <span className="text-content-muted">
                        {selectedPortfolioId === ALL_PORTFOLIOS ? tx.portfolioName : 'Gotówka'}
                      </span>
                    )}
                  </td>
                  <td className="table-cell tabular text-right">
                    {tx.qtyE8 === 0 ? '—' : formatQuantity(tx.qtyE8)}
                  </td>
                  <td className="table-cell tabular text-right">
                    {tx.priceE8 === 0
                      ? formatCurrency(tx.grossMinor, tx.currency)
                      : formatCurrency(Math.round(tx.priceE8 / 1_000_000), tx.currency)}
                  </td>
                  <td className="table-cell tabular text-right text-2xs text-content-muted">
                    {tx.currency === 'PLN' ? '—' : (tx.settlementFxRateE6 ?? tx.fxRateE6) / 1_000_000}
                  </td>
                  <td className={`table-cell tabular text-right ${toneClass(tx.amountPlnMinor)}`}>
                    {formatPln(tx.amountPlnMinor, { sign: true })}
                  </td>
                  <td className="table-cell text-right">
                    <button type="button" className="btn btn-ghost px-2 py-0.5 text-2xs" onClick={() => void remove(tx.id)}>
                      Usuń
                    </button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      )}

      {formOpen && (
        <TransactionForm
          defaultPortfolioId={portfolioId ?? portfolios[0]?.id ?? 1}
          onClose={() => setFormOpen(false)}
          onSaved={(warnings) => {
            setFormOpen(false);
            reload();
            show(warnings.length > 0 ? warnings[0]! : 'Transakcja zapisana', warnings.length > 0 ? 'error' : 'success');
          }}
        />
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

const NEEDS_INSTRUMENT: TransactionType[] = ['buy', 'sell', 'dividend', 'interest', 'fee', 'tax', 'split'];
const NEEDS_QUANTITY: TransactionType[] = ['buy', 'sell'];

function TransactionForm({
  defaultPortfolioId,
  onClose,
  onSaved,
}: {
  defaultPortfolioId: number;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const { portfolios } = useApp();
  const instruments = useAsync(() => api.instruments.list(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    portfolioId: defaultPortfolioId,
    type: 'buy' as TransactionType,
    instrumentId: '',
    tradeDate: new Date().toISOString().slice(0, 10),
    quantity: '',
    price: '',
    grossAmount: '',
    fee: '',
    tax: '',
    currency: 'PLN',
    fxRate: '',
    note: '',
  });

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        portfolioId: form.portfolioId,
        type: form.type,
        tradeDate: form.tradeDate,
        currency: form.currency,
      };
      if (NEEDS_INSTRUMENT.includes(form.type) && form.instrumentId) payload.instrumentId = Number(form.instrumentId);
      if (NEEDS_QUANTITY.includes(form.type)) {
        payload.quantity = form.quantity;
        payload.price = form.price;
      } else {
        payload.grossAmount = form.grossAmount;
      }
      if (form.fee) payload.fee = form.fee;
      if (form.tax) payload.tax = form.tax;
      if (form.fxRate) payload.fxRate = form.fxRate;
      if (form.note) payload.note = form.note;

      const result = await api.transactions.create(payload);
      onSaved(result.warnings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nie udało się zapisać transakcji');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Nowa transakcja" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Portfel">
            <select className="input" value={form.portfolioId} onChange={(e) => set({ portfolioId: Number(e.target.value) })}>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Typ">
            <select className="input" value={form.type} onChange={(e) => set({ type: e.target.value as TransactionType })}>
              {Object.entries(TRANSACTION_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Data">
            <input type="date" className="input" value={form.tradeDate} onChange={(e) => set({ tradeDate: e.target.value })} required />
          </Field>
        </div>

        {NEEDS_INSTRUMENT.includes(form.type) && (
          <Field label="Instrument">
            <select className="input" value={form.instrumentId} onChange={(e) => {
              const selected = instruments.data?.find((i) => String(i.id) === e.target.value);
              set({ instrumentId: e.target.value, currency: selected?.currency ?? form.currency });
            }}>
              <option value="">— wybierz —</option>
              {(instruments.data ?? []).map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.symbol} · {instrument.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          {NEEDS_QUANTITY.includes(form.type) ? (
            <>
              <Field label="Liczba">
                <input className="input" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} placeholder="0,2301" required />
              </Field>
              <Field label="Cena (w walucie instrumentu)">
                <input className="input" value={form.price} onChange={(e) => set({ price: e.target.value })} placeholder="346,50" required />
              </Field>
            </>
          ) : (
            <Field label="Kwota brutto">
              <input className="input" value={form.grossAmount} onChange={(e) => set({ grossAmount: e.target.value })} placeholder="100,00" required />
            </Field>
          )}

          <Field label="Waluta">
            <input className="input uppercase" value={form.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} maxLength={3} required />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Prowizja">
            <input className="input" value={form.fee} onChange={(e) => set({ fee: e.target.value })} placeholder="0,00" />
          </Field>
          <Field label="Podatek u źródła">
            <input className="input" value={form.tax} onChange={(e) => set({ tax: e.target.value })} placeholder="0,00" />
          </Field>
          <Field label="Kurs brokera" hint="Zostaw puste, żeby użyć kursu NBP z D-1.">
            <input className="input" value={form.fxRate} onChange={(e) => set({ fxRate: e.target.value })} placeholder="0,5774" disabled={form.currency === 'PLN'} />
          </Field>
        </div>

        <Field label="Notatka">
          <input className="input" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>

        {error && <p className="rounded-md border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Zapisuję…' : 'Zapisz'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
