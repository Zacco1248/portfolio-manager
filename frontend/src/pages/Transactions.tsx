import { useState } from 'react';
import { TRANSACTION_TYPE_LABELS } from '@portfolio/shared';
import type { Transaction, TransactionType } from '@portfolio/shared';
import { TransactionForm } from '@/components/TransactionForm';
import { Card, DataTable, EmptyState, ErrorBanner, Modal, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatCurrency, formatDate, formatPln, formatQuantity, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { ALL_PORTFOLIOS, useApp, usePortfolioParam } from '@/state/app';

export function Transactions() {
  const portfolioId = usePortfolioParam();
  const { portfolios, accounts, selectedPortfolioId } = useApp();
  const [accountFilter, setAccountFilter] = useState<string>('');
  const { data, error, loading, reload } = useAsync(
    () => api.transactions.list({ portfolioId, limit: 500, ...(accountFilter ? { accountId: Number(accountFilter) } : {}) }),
    [portfolioId, accountFilter],
  );
  const [formOpen, setFormOpen] = useState(false);
  const { toast, show, dismiss } = useToast();

  // Transakcja do potwierdzenia usunięcia; `null` = modal zamknięty.
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const remove = async (tx: Transaction) => {
    setPendingDelete(null);
    try {
      const result = await api.transactions.remove(tx.id);
      reload();
      if (result.warnings.length > 0) {
        show(result.warnings[0]!, 'error');
        return;
      }
      // Usunięte transakcje trafiają do kosza, więc pomyłkę da się cofnąć —
      // ale trzeba o tym powiedzieć w chwili, gdy jest to potrzebne.
      show('Transakcja usunięta. Znajdziesz ją w koszu.', 'success');
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
        <div className="flex items-center gap-2">
          {accounts.length > 0 && (
            <select
              className="input h-8 w-auto py-0 text-2xs"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              aria-label="Filtr konta"
            >
              <option value="">Wszystkie konta</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setTrashOpen(true)}>
            Kosz
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            Dodaj transakcję
          </button>
        </div>
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
                'Konto',
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
                  <td className="table-cell text-2xs text-content-muted">{tx.accountName ?? '—'}</td>
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
                    <button
                      type="button"
                      className="btn btn-ghost px-2 py-0.5 text-2xs"
                      onClick={() => setPendingDelete(tx)}
                    >
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

      {pendingDelete && (
        <ConfirmDelete
          transaction={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
        />
      )}

      {trashOpen && (
        <TrashModal
          onClose={() => setTrashOpen(false)}
          onRestored={(message) => {
            reload();
            show(message, 'success');
          }}
          onError={(message) => show(message, 'error')}
        />
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

/**
 * Potwierdzenie usunięcia.
 *
 * Zamiast `window.confirm` pokazujemy, co dokładnie znika — przy liście
 * kilkuset wierszy sama nazwa operacji nie wystarcza, żeby mieć pewność,
 * że kliknęło się właściwy.
 */
function ConfirmDelete({
  transaction,
  onCancel,
  onConfirm,
}: {
  transaction: Transaction;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="Usunąć transakcję?" onClose={onCancel}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-content-muted">Operacja</dt>
        <dd>{TRANSACTION_TYPE_LABELS[transaction.type]}</dd>
        <dt className="text-content-muted">Data</dt>
        <dd className="tabular">{formatDate(transaction.tradeDate)}</dd>
        <dt className="text-content-muted">Instrument</dt>
        <dd>{transaction.instrument ? `${transaction.instrument.symbol} — ${transaction.instrument.name}` : 'Gotówka'}</dd>
        {transaction.qtyE8 !== 0 && (
          <>
            <dt className="text-content-muted">Liczba</dt>
            <dd className="tabular">{formatQuantity(transaction.qtyE8)}</dd>
          </>
        )}
        <dt className="text-content-muted">Przepływ</dt>
        <dd className={`tabular ${toneClass(transaction.amountPlnMinor)}`}>
          {formatPln(transaction.amountPlnMinor, { sign: true })}
        </dd>
        <dt className="text-content-muted">Portfel</dt>
        <dd>
          {transaction.portfolioName}
          {transaction.accountName ? ` · ${transaction.accountName}` : ''}
        </dd>
      </dl>

      <p className="mt-3 text-2xs text-content-muted">
        Zysk zrealizowany zostanie przeliczony od nowa. Transakcja trafi do kosza — będzie ją można przywrócić.
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Anuluj
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          Usuń
        </button>
      </div>
    </Modal>
  );
}

/** Kosz: przywracanie pomyłek i trwałe czyszczenie. */
function TrashModal({
  onClose,
  onRestored,
  onError,
}: {
  onClose: () => void;
  onRestored: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { data, error, loading, reload } = useAsync(() => api.transactions.deleted(), []);
  const [busy, setBusy] = useState<number | null>(null);

  const restore = async (id: number) => {
    setBusy(id);
    try {
      await api.transactions.restore(id);
      reload();
      onRestored('Transakcja przywrócona.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Nie udało się przywrócić');
    } finally {
      setBusy(null);
    }
  };

  const purge = async (id: number) => {
    setBusy(id);
    try {
      await api.transactions.purge(id);
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Kosz" onClose={onClose}>
      {loading && <Spinner />}
      {error && <ErrorBanner message={error} onRetry={reload} />}

      {data && data.length === 0 && (
        <p className="py-6 text-center text-sm text-content-muted">Kosz jest pusty.</p>
      )}

      {data && data.length > 0 && (
        <ul className="divide-y divide-surface-border">
          {data.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium">{TRANSACTION_TYPE_LABELS[entry.type]}</span>
                  <span className="ml-2 text-content-secondary">
                    {entry.instrument ? entry.instrument.symbol : 'Gotówka'}
                  </span>
                  <span className={`tabular ml-2 ${toneClass(entry.amountPlnMinor)}`}>
                    {formatPln(entry.amountPlnMinor, { sign: true })}
                  </span>
                </div>
                <div className="text-2xs text-content-muted">
                  {formatDate(entry.tradeDate)} · {entry.portfolioName}
                  {entry.accountName ? ` · ${entry.accountName}` : ''} · usunięto {formatDate(entry.deletedAt.slice(0, 10))}
                </div>
              </div>
              <button
                type="button"
                className="btn px-2 py-0.5 text-2xs"
                disabled={busy === entry.id}
                onClick={() => void restore(entry.id)}
              >
                Przywróć
              </button>
              <button
                type="button"
                className="btn btn-ghost px-2 py-0.5 text-2xs"
                disabled={busy === entry.id}
                onClick={() => void purge(entry.id)}
                title="Usuń trwale, bez możliwości odzyskania"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
