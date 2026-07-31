import { useState } from 'react';
import { TRANSACTION_TYPE_LABELS } from '@portfolio/shared';
import type { TransactionType } from '@portfolio/shared';
import { SymbolSearch } from '@/components/SymbolSearch';
import { Field, Modal } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useApp } from '@/state/app';

/** Klucz localStorage z ostatnio użytym kontem, per portfel. */
const STORAGE_LAST_ACCOUNT = 'pm.lastAccount';

const NEEDS_INSTRUMENT: TransactionType[] = ['buy', 'sell', 'dividend', 'interest', 'fee', 'tax', 'split'];
const NEEDS_QUANTITY: TransactionType[] = ['buy', 'sell'];

/**
 * Formularz nowej transakcji.
 *
 * Wydzielony z listy transakcji, żeby dało się go otworzyć również ze strony
 * instrumentu — wcześniej dodanie transakcji do papieru, na który się właśnie
 * patrzy, wymagało przejścia do innej zakładki i wyszukania go od nowa.
 */
export function TransactionForm({
  defaultPortfolioId,
  defaultInstrumentId,
  defaultCurrency,
  onClose,
  onSaved,
}: {
  defaultPortfolioId: number;
  /** Instrument wybrany z góry — wtedy pole wyszukiwania jest zbędne. */
  defaultInstrumentId?: number;
  defaultCurrency?: string;
  onClose: () => void;
  onSaved: (warnings: string[]) => void;
}) {
  const { portfolios, accounts } = useApp();
  const instruments = useAsync(() => api.instruments.list(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    portfolioId: defaultPortfolioId,
    // Konto ostatnio użyte w tym portfelu — przy comiesięcznych dopłatach
    // to prawie zawsze właściwa odpowiedź.
    accountId: localStorage.getItem(`${STORAGE_LAST_ACCOUNT}.${defaultPortfolioId}`) ?? '',
    type: 'buy' as TransactionType,
    instrumentId: defaultInstrumentId ? String(defaultInstrumentId) : '',
    tradeDate: new Date().toISOString().slice(0, 10),
    quantity: '',
    price: '',
    grossAmount: '',
    fee: '',
    tax: '',
    currency: defaultCurrency ?? 'PLN',
    fxRate: '',
    note: '',
  });
  // Instrument spoza bazy zakładamy w locie na podstawie podpowiedzi z API.
  const [newInstrument, setNewInstrument] = useState<{ symbol: string; name: string; assetClass: string } | null>(
    null,
  );

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
      if (form.accountId) payload.accountId = Number(form.accountId);

      let instrumentId = form.instrumentId ? Number(form.instrumentId) : null;

      // Wyszukany, ale jeszcze nieistniejący instrument zakładamy przed zapisem
      // transakcji — inaczej użytkownik musiałby robić to w osobnym kroku.
      if (instrumentId === null && newInstrument) {
        const created = await api.instruments.create({
          symbol: newInstrument.symbol,
          name: newInstrument.name,
          assetClass: newInstrument.assetClass,
          currency: form.currency,
          // Notowania metali są kwotowane za uncję trojańską; jednostkę
          // pozycji można zmienić później na stronie instrumentu.
          ...(newInstrument.assetClass === 'metal' ? { unit: 'oz' } : {}),
        });
        instrumentId = created.id;
      }

      if (NEEDS_INSTRUMENT.includes(form.type) && instrumentId !== null) payload.instrumentId = instrumentId;
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
      localStorage.setItem(`${STORAGE_LAST_ACCOUNT}.${form.portfolioId}`, form.accountId);
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Portfel">
            <select
              className="input"
              value={form.portfolioId}
              onChange={(e) => {
                const portfolioId = Number(e.target.value);
                set({
                  portfolioId,
                  accountId: localStorage.getItem(`${STORAGE_LAST_ACCOUNT}.${portfolioId}`) ?? '',
                });
              }}
            >
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Konto" hint="Gdzie fizycznie leżą aktywa. Niezależne od portfela.">
            <select className="input" value={form.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              <option value="">— nieprzypisane —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
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

        {/*
          Instrument podany z góry (wejście ze strony papieru) nie potrzebuje
          wybierania — pokazujemy tylko, czego dotyczy transakcja.
        */}
        {NEEDS_INSTRUMENT.includes(form.type) && defaultInstrumentId !== undefined && (
          <p className="rounded-card border border-surface-border bg-surface-overlay px-3 py-2 text-2xs text-content-secondary">
            Instrument:{' '}
            <span className="font-medium">
              {instruments.data?.find((i) => i.id === defaultInstrumentId)?.symbol ?? '—'}
            </span>{' '}
            {instruments.data?.find((i) => i.id === defaultInstrumentId)?.name}
          </p>
        )}

        {NEEDS_INSTRUMENT.includes(form.type) && defaultInstrumentId === undefined && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Instrument z bazy">
              <select
                className="input"
                value={form.instrumentId}
                onChange={(e) => {
                  const selected = instruments.data?.find((i) => String(i.id) === e.target.value);
                  set({ instrumentId: e.target.value, currency: selected?.currency ?? form.currency });
                  if (e.target.value) setNewInstrument(null);
                }}
              >
                <option value="">— wybierz —</option>
                {(instruments.data ?? []).map((instrument) => (
                  <option key={instrument.id} value={instrument.id}>
                    {instrument.symbol} · {instrument.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="…albo wyszukaj nowy" hint="Podpowiedzi z bazy i z wyszukiwarki dostawcy notowań.">
              <SymbolSearch
                value={newInstrument?.symbol ?? ''}
                onChange={(symbol) =>
                  setNewInstrument(symbol ? { symbol, name: newInstrument?.name ?? symbol, assetClass: 'stock_foreign' } : null)
                }
                onPick={(suggestion) => {
                  setNewInstrument({
                    symbol: suggestion.symbol,
                    name: suggestion.name,
                    assetClass: suggestion.assetClass,
                  });
                  set({ instrumentId: '' });
                }}
              />
            </Field>
          </div>
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
