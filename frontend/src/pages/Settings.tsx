import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ACCOUNT_KIND_LABELS, ACCOUNT_KINDS, ALERT_KIND_LABELS, rollUp, TAX_REGIMES, TAX_REGIME_LABELS } from '@portfolio/shared';
import type { AccountKind, AlertKind, Portfolio, TaxRegime } from '@portfolio/shared';
import { Card, DataTable, ErrorBanner, Field, Modal, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate, formatDateTime, formatPln, relativeTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp } from '@/state/app';

/**
 * Zakładki ustawień.
 *
 * Strona miała jedenaście kart w jednej kolumnie — do zadań cyklicznych trzeba
 * było przewinąć wszystko, co po drodze. Podział idzie za tym, jak często się
 * z czegoś korzysta: portfele i konta na wierzchu, diagnostyka na końcu.
 */
const SETTINGS_TABS = [
  { id: 'portfele', label: 'Portfele i konta' },
  { id: 'ai', label: 'Funkcje AI' },
  { id: 'powiadomienia', label: 'Powiadomienia' },
  { id: 'zaawansowane', label: 'Zaawansowane' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

export function Settings() {
  const { portfolios, refreshPortfolios, status, refreshStatus } = useApp();
  /*
   * Zakładka siedzi w adresie, żeby dało się podesłać link wprost do sekcji
   * („ustaw klucz w /ustawienia?sekcja=ai") i żeby cofnięcie w przeglądarce
   * wracało tam, gdzie użytkownik był.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (SETTINGS_TABS.find((t) => t.id === searchParams.get('sekcja'))?.id ?? 'portfele') as SettingsTab;
  const setTab = (next: SettingsTab) => setSearchParams(next === 'portfele' ? {} : { sekcja: next });
  const settings = useAsync(() => api.settings.get(), []);
  const jobs = useAsync(() => api.status.jobs(), []);
  const { toast, show, dismiss } = useToast();
  const [busy, setBusy] = useState(false);

  const [newPortfolio, setNewPortfolio] = useState({ name: '', kind: '', taxRegime: 'taxable' as TaxRegime, broker: '' });
  const [portfolioToDelete, setPortfolioToDelete] = useState<Portfolio | null>(null);

  const notifications = (settings.data?.notifications ?? {}) as Record<string, boolean>;

  const addPortfolio = async () => {
    setBusy(true);
    try {
      await api.portfolios.create({
        name: newPortfolio.name,
        kind: newPortfolio.kind || undefined,
        taxRegime: newPortfolio.taxRegime,
        broker: newPortfolio.broker || undefined,
      });
      setNewPortfolio({ name: '', kind: '', taxRegime: 'taxable', broker: '' });
      await refreshPortfolios();
      show('Portfel dodany', 'success');
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Nie udało się dodać portfela', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleNotification = async (kind: string, enabled: boolean) => {
    await api.settings.update({ notifications: { ...notifications, [kind]: enabled } });
    settings.reload();
  };

  return (
    <div className="space-y-4">
      <SettingsTabs value={tab} onChange={setTab} />

      {tab === 'portfele' && (
        <>
        <Card title="Portfele">
          <div className="grid gap-3 p-4 pt-2 sm:grid-cols-5">
            <Field label="Nazwa">
              <input className="input" value={newPortfolio.name} onChange={(e) => setNewPortfolio({ ...newPortfolio, name: e.target.value })} placeholder="Główny" />
            </Field>
            <Field label="Etykieta">
              <input className="input" value={newPortfolio.kind} onChange={(e) => setNewPortfolio({ ...newPortfolio, kind: e.target.value })} placeholder="IKE" />
            </Field>
            <Field label="Reżim podatkowy">
              <select className="input" value={newPortfolio.taxRegime} onChange={(e) => setNewPortfolio({ ...newPortfolio, taxRegime: e.target.value as TaxRegime })}>
                {TAX_REGIMES.map((regime) => (
                  <option key={regime} value={regime}>{TAX_REGIME_LABELS[regime]}</option>
                ))}
              </select>
            </Field>
            <Field label="Broker">
              <input className="input" value={newPortfolio.broker} onChange={(e) => setNewPortfolio({ ...newPortfolio, broker: e.target.value })} placeholder="XTB" />
            </Field>
            <div className="flex items-end">
              <button type="button" className="btn btn-primary" onClick={() => void addPortfolio()} disabled={!newPortfolio.name || busy}>
                Dodaj portfel
              </button>
            </div>
          </div>
          <DataTable headers={['Nazwa', 'Etykieta', 'Reżim podatkowy', 'Poduszka', 'Broker', '']} minWidth={720}>
            {portfolios.map((portfolio) => (
              <tr key={portfolio.id}>
                <td className="table-cell font-medium">{portfolio.name}</td>
                <td className="table-cell text-content-secondary">{portfolio.kind ?? '—'}</td>
                <td className="table-cell">
                  <select
                    className="input h-7 w-auto py-0 text-2xs"
                    value={portfolio.taxRegime}
                    onChange={(e) =>
                      void api.portfolios
                        .update(portfolio.id, { taxRegime: e.target.value })
                        .then(refreshPortfolios)
                    }
                  >
                    {TAX_REGIMES.map((regime) => (
                      <option key={regime} value={regime}>{TAX_REGIME_LABELS[regime]}</option>
                    ))}
                  </select>
                </td>
                <td className="table-cell">
                  <label className="flex items-center gap-1.5 text-2xs text-content-muted">
                    <input
                      type="checkbox"
                      checked={portfolio.emergencyFund}
                      onChange={(e) =>
                        void api.portfolios
                          .update(portfolio.id, { emergencyFund: e.target.checked })
                          .then(refreshPortfolios)
                      }
                    />
                    poduszka
                  </label>
                </td>
                <td className="table-cell text-content-secondary">{portfolio.broker ?? '—'}</td>
                <td className="table-cell text-right">
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-0.5 text-2xs"
                    onClick={() =>
                      void api.portfolios
                        .update(portfolio.id, { archived: !portfolio.archived })
                        .then(refreshPortfolios)
                    }
                  >
                    {portfolio.archived ? 'Przywróć' : 'Archiwizuj'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-0.5 text-2xs text-loss"
                    onClick={() => setPortfolioToDelete(portfolio)}
                    title="Usuń portfel wraz z transakcjami"
                  >
                    Usuń
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
          <p className="px-4 pb-3 text-2xs text-content-muted">
            Reżim podatkowy decyduje o tym, czy portfel wchodzi do raportu PIT-38 — IKE i IKZE są z niego wyłączone.
            Portfel oznaczony jako poduszka jest pomijany w propozycjach rebalansu.
          </p>
        </Card>
        <AccountsCard onMessage={show} />
        </>
      )}

      {tab === 'ai' && (
        <>
        <AiSettingsCard onMessage={show} />
        </>
      )}

      {tab === 'powiadomienia' && (
        <>
        <Card title="Powiadomienia">
          {settings.loading && <Spinner />}
          {settings.error && <ErrorBanner message={settings.error} onRetry={settings.reload} />}
          {settings.data && (
            <>
              <ul className="grid gap-2 p-4 pt-2 sm:grid-cols-2 lg:grid-cols-3">
                {(Object.keys(ALERT_KIND_LABELS) as AlertKind[]).map((kind) => (
                  <li key={kind}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={notifications[kind] !== false}
                        onChange={(e) => void toggleNotification(kind, e.target.checked)}
                      />
                      {ALERT_KIND_LABELS[kind]}
                    </label>
                  </li>
                ))}
              </ul>
              <TelegramFields
                configured={status?.features.telegram ?? false}
                onMessage={show}
                onSaved={() => void refreshStatus()}
              />
            </>
          )}
        </Card>
        </>
      )}

      {tab === 'zaawansowane' && (
        <>
        <EmergencyFundSettings onMessage={show} />
        <Card title="Progi ostrzeżeń">
          {settings.data && (
            <div className="grid gap-3 p-4 pt-2 sm:grid-cols-3">
              <ThresholdInput
                label="Pojedyncza spółka powyżej %"
                settingKey="concentrationInstrumentBp"
                value={settings.data.concentrationInstrumentBp as number}
                onSaved={settings.reload}
              />
              <ThresholdInput
                label="Sektor powyżej %"
                settingKey="concentrationSectorBp"
                value={settings.data.concentrationSectorBp as number}
                onSaved={settings.reload}
              />
              <ThresholdInput
                label="Zmiana dzienna powyżej %"
                settingKey="dailyMoveThresholdBp"
                value={settings.data.dailyMoveThresholdBp as number}
                onSaved={settings.reload}
              />
            </div>
          )}
        </Card>
        <Card title="Kopia zapasowa i eksport">
          <div className="flex flex-wrap gap-2 p-4 pt-2">
            <a className="btn" href={api.exportUrls.json} download>
              Pełny eksport JSON
            </a>
            <a className="btn" href={api.exportUrls.transactionsCsv} download>
              Transakcje CSV
            </a>
            <button type="button" className="btn" onClick={() => void api.analytics.snapshot().then(() => show('Snapshot zapisany', 'success'))}>
              Zapisz snapshot portfela
            </button>
            <button type="button" className="btn" onClick={() => void api.analytics.refreshBenchmarks().then(() => show('Benchmarki odświeżone', 'success'))}>
              Odśwież benchmarki
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void api.corporate.refresh().then((r) => show(r.message, 'success'))}
            >
              Odśwież dane dywidendowe
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void api.corporate
                  .classify()
                  .then((r) =>
                    show(
                      r.updated === 0
                        ? 'Nic do uzupełnienia — wszystkie instrumenty mają klasę i sektor.'
                        : `Uzupełniono ${r.updated} instrumentów${r.changes.length > 0 ? ` (${r.changes.map((c) => `${c.symbol}: ${c.from}→${c.to}`).join(', ')})` : ''}`,
                      'success',
                    ),
                  )
                  .catch(() => show('Nie udało się rozpoznać instrumentów', 'error'))
              }
            >
              Rozpoznaj typy i sektory
            </button>
          </div>
        </Card>
        <DuplicatesCard onMessage={show} />
        <EtfHoldingsEditor onMessage={show} />
        <Card title="Stan systemu" action={<button type="button" className="btn btn-ghost text-2xs" onClick={() => void refreshStatus()}>Odśwież</button>}>
          {status && (
            <dl className="grid gap-2 p-4 pt-2 text-sm sm:grid-cols-3">
              <Info label="Wersja" value={status.version} />
              <Info label="Waluta bazowa" value={status.baseCurrency} />
              <Info label="Ostatnie ceny" value={relativeTime(status.lastPriceUpdate)} />
              <Info label="Ostatnie kursy NBP" value={status.lastFxUpdate ?? '—'} />
              <Info label="Ostatni snapshot" value={status.lastSnapshot ?? '—'} />
              <Info label="Analiza AI" value={status.features.ai ? 'włączona' : 'wyłączona'} />
            </dl>
          )}
          {status && status.providers.length > 0 && (
            <ul className="border-t border-surface-border px-4 py-3 text-2xs">
              {status.providers.map((provider) => (
                <li key={provider.id} className="flex items-center gap-2 py-0.5">
                  <span className={`h-2 w-2 rounded-full ${provider.healthy ? 'bg-gain' : 'bg-loss'}`} />
                  <span className="font-medium">{provider.id}</span>
                  <span className="text-content-muted">
                    {provider.healthy ? `ostatni sukces ${relativeTime(provider.lastSuccessAt)}` : provider.lastError}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {jobs.data && jobs.data.length > 0 && (
            <div className="max-h-64 overflow-y-auto border-t border-surface-border">
              <DataTable headers={['Zadanie', 'Start', 'Status', 'Komunikat']}>
                {jobs.data.slice(0, 20).map((job, index) => (
                  <tr key={index}>
                    <td className="table-cell text-2xs">{job.job}</td>
                    <td className="table-cell text-2xs tabular">{formatDateTime(job.startedAt)}</td>
                    <td className={`table-cell text-2xs ${job.status === 'error' ? 'text-loss' : 'text-content-secondary'}`}>
                      {job.status}
                    </td>
                    <td className="table-cell text-2xs text-content-muted">{job.message ?? ''}</td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </Card>
        </>
      )}


      {portfolioToDelete && (
        <DeletePortfolioModal
          portfolio={portfolioToDelete}
          onClose={() => setPortfolioToDelete(null)}
          onDeleted={(message) => {
            setPortfolioToDelete(null);
            void refreshPortfolios();
            show(message, 'success');
          }}
          onError={(message) => show(message, 'error')}
        />
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

function ThresholdInput({
  label,
  settingKey,
  value,
  onSaved,
}: {
  label: string;
  settingKey: string;
  value: number;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(String((value ?? 0) / 100));

  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button
          type="button"
          className="btn"
          onClick={() =>
            void api.settings
              .update({ [settingKey]: Math.round(Number(draft.replace(',', '.')) * 100) })
              .then(onSaved)
          }
        >
          Zapisz
        </button>
      </div>
    </Field>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-content-muted">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}


/**
 * Skład ETF-ów wprowadzany ręcznie.
 *
 * Emitenci publikują listy pozycji na swoich stronach, ale każdy w innym
 * formacie i bez otwartego API. Przyjmujemy wklejony tekst i wyciągamy z niego
 * pary ticker + waga — to wystarcza do wykrycia nakładania się funduszy.
 */
function EtfHoldingsEditor({ onMessage }: { onMessage: (message: string, tone: 'info' | 'error' | 'success') => void }) {
  const missing = useAsync(() => api.corporate.missingHoldings(), []);
  const instruments = useAsync(() => api.instruments.list(), []);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const current = useAsync(
    () => (selected ? api.corporate.holdings(Number(selected)) : Promise.resolve([])),
    [selected],
  );

  const etfs = (instruments.data ?? []).filter((i) => rollUp(i.assetClass) === 'etf');

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const result = await api.corporate.saveHoldings(Number(selected), text);
      setText('');
      current.reload();
      missing.reload();
      onMessage(`Zapisano ${result.saved} pozycji składu`, 'success');
    } catch {
      onMessage('Nie udało się zapisać składu', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Skład ETF-ów"
      action={
        missing.data && missing.data.length > 0 ? (
          <span className="text-2xs text-warn">Bez składu: {missing.data.map((e) => e.symbol).join(', ')}</span>
        ) : null
      }
    >
      {etfs.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
          Nie masz jeszcze instrumentów oznaczonych jako ETF. Klasę aktywów zmienisz na stronie instrumentu.
        </p>
      ) : (
        <>
          <div className="grid gap-3 p-4 pt-2 sm:grid-cols-3">
            <Field label="Fundusz">
              <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">— wybierz —</option>
                {etfs.map((etf) => (
                  <option key={etf.id} value={etf.id}>
                    {etf.symbol} · {etf.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="Wklej skład"
                hint="Jedna pozycja w wierszu: ticker i waga w procentach. Wklej wprost ze strony emitenta albo z pliku CSV."
              >
                <textarea
                  className="input h-24 font-mono text-2xs"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={'AAPL 7,12\nMSFT 6,45\nNVDA 5,90'}
                  disabled={!selected}
                />
              </Field>
            </div>
          </div>

          <div className="flex items-center gap-3 px-4 pb-4">
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!selected || !text || saving}>
              {saving ? 'Zapisuję…' : 'Zapisz skład'}
            </button>
            {current.data && current.data.length > 0 && (
              <span className="text-2xs text-content-muted">
                Zapisanych pozycji: {current.data.length}, największa waga{' '}
                {(current.data[0]!.weightBp / 100).toFixed(2)}%
              </span>
            )}
          </div>

          {current.data && current.data.length > 0 && (
            <ul className="flex flex-wrap gap-2 border-t border-surface-border px-4 py-3 text-2xs">
              {current.data.slice(0, 25).map((holding) => (
                <li key={holding.symbol} className="rounded bg-surface-overlay px-2 py-1">
                  {holding.symbol} {(holding.weightBp / 100).toFixed(2)}%
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}


/**
 * Konta — miejsca, w których fizycznie leżą aktywa.
 *
 * Wymiar niezależny od portfela: ten sam rachunek w XTB może obsługiwać
 * zwykły portfel i IKE, a jeden portfel może zbierać aktywa z kilku miejsc.
 * Konto nie wpływa na rozliczenie podatkowe — służy do odpowiedzi na pytanie
 * „ile mam i ile zarobiłem w danym miejscu".
 */
function AccountsCard({ onMessage }: { onMessage: (message: string, tone: 'info' | 'error' | 'success') => void }) {
  const { accounts, refreshAccounts } = useApp();
  const [form, setForm] = useState({ name: '', kind: 'broker' as AccountKind, institution: '', currency: 'PLN' });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api.accounts.create({
        name: form.name,
        kind: form.kind,
        currency: form.currency,
        ...(form.institution ? { institution: form.institution } : {}),
      });
      setForm({ name: '', kind: 'broker', institution: '', currency: 'PLN' });
      await refreshAccounts();
      onMessage('Konto dodane', 'success');
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Nie udało się dodać konta', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number, name: string) => {
    try {
      await api.accounts.remove(id);
      await refreshAccounts();
      onMessage(`Konto „${name}" usunięte`, 'success');
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Nie udało się usunąć konta', 'error');
    }
  };

  return (
    <Card title="Konta">
      <div className="grid gap-3 p-4 pt-2 sm:grid-cols-5">
        <Field label="Nazwa">
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="XTB"
          />
        </Field>
        <Field label="Rodzaj">
          <select
            className="input"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as AccountKind })}
          >
            {ACCOUNT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ACCOUNT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Instytucja" hint="Gdy nazwa potoczna nie wystarcza">
          <input
            className="input"
            value={form.institution}
            onChange={(e) => setForm({ ...form, institution: e.target.value })}
            placeholder="X-Trade Brokers DM SA"
          />
        </Field>
        <Field label="Waluta">
          <input
            className="input"
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase().slice(0, 3) })}
          />
        </Field>
        <div className="flex items-end">
          <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={!form.name || busy}>
            Dodaj konto
          </button>
        </div>
      </div>

      {accounts.length > 0 && (
        <DataTable headers={['Nazwa', 'Rodzaj', 'Instytucja', 'Waluta', { label: 'Transakcje', align: 'right' }, '']}>
          {accounts.map((account) => (
            <tr key={account.id}>
              <td className="table-cell font-medium">{account.name}</td>
              <td className="table-cell text-content-secondary">{ACCOUNT_KIND_LABELS[account.kind]}</td>
              <td className="table-cell text-content-secondary">{account.institution ?? '—'}</td>
              <td className="table-cell text-content-secondary">{account.currency}</td>
              <td className="table-cell tabular text-right text-content-secondary">{account.transactionCount ?? 0}</td>
              <td className="table-cell text-right">
                <button
                  type="button"
                  className="btn btn-ghost px-2 py-0.5 text-2xs"
                  onClick={() =>
                    void api.accounts
                      .update(account.id, { archived: !account.archived })
                      .then(refreshAccounts)
                  }
                >
                  {account.archived ? 'Przywróć' : 'Archiwizuj'}
                </button>
                {(account.transactionCount ?? 0) === 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-0.5 text-2xs"
                    onClick={() => void remove(account.id, account.name)}
                  >
                    Usuń
                  </button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      <p className="px-4 pb-3 text-2xs text-content-muted">
        Konto mówi, gdzie aktywa fizycznie leżą — niezależnie od portfela, który decyduje o rozliczeniu podatkowym.
        Rozbicie wyniku na konta zobaczysz na pulpicie. Konta z transakcjami można tylko archiwizować.
      </p>
    </Card>
  );
}

/**
 * Konfiguracja funkcji AI.
 *
 * Każda funkcja jest osobnym przełącznikiem i przy każdej widać, co dokładnie
 * trafia do dostawcy modelu. Domyślnie wszystkie są wyłączone — obecność
 * klucza w `.env` nie oznacza zgody na wysyłanie danych.
 */
function AiSettingsCard({ onMessage }: { onMessage: (message: string, tone: 'info' | 'error' | 'success') => void }) {
  const ai = useAsync(() => api.ai.status(), []);
  const [model, setModel] = useState<string | null>(null);
  const [test, setTest] = useState<{ busy: boolean; result: Awaited<ReturnType<typeof api.ai.test>> | null }>({
    busy: false,
    result: null,
  });

  /**
   * Test wysyła do dostawcy jedno stałe zdanie i pokazuje odpowiedź.
   *
   * Bez tego jedyną informacją zwrotną o źle wpisanym kluczu albo nieistniejącym
   * modelu byłby brak streszczeń w newsach — objaw odległy w czasie od przyczyny
   * i nie do odróżnienia od braku wiadomości.
   */
  const runTest = () => {
    setTest({ busy: true, result: null });
    void api.ai
      .test()
      .then((result) => setTest({ busy: false, result }))
      .catch(() => {
        setTest({ busy: false, result: null });
        onMessage('Nie udało się wykonać testu', 'error');
      });
  };

  if (!ai.data) return null;

  const status = ai.data;
  const suggestions = status.suggestedModels[status.provider] ?? [];
  const currentModel = model ?? status.model;

  const save = (body: Record<string, unknown>) => {
    void api.ai
      .update(body)
      .then(() => {
        setModel(null);
        ai.reload();
      })
      .catch(() => onMessage('Nie udało się zapisać ustawień AI', 'error'));
  };

  return (
    <Card
      title="Funkcje AI"
      action={
        <div className="flex items-center gap-3">
          <span className="text-2xs text-content-muted">
            Klucze: Anthropic {status.keys.anthropic ? '✓' : '—'}, OpenAI {status.keys.openai ? '✓' : '—'}
          </span>
          <button type="button" className="btn btn-ghost text-2xs" disabled={test.busy} onClick={runTest}>
            {test.busy ? 'Testuję…' : 'Testuj połączenie'}
          </button>
        </div>
      }
    >
      {status.usingFallbackProvider && (
        <p className="mx-4 mt-3 rounded-lg border border-surface-border bg-surface-overlay px-3 py-2 text-2xs text-content-secondary">
          W ustawieniach wybrano {status.chosenProvider === 'openai' ? 'OpenAI' : 'Anthropic'}, ale klucz jest
          tylko dla {status.provider === 'openai' ? 'OpenAI' : 'Anthropic'} — funkcje AI korzystają z tego
          drugiego. Zmień dostawcę albo dopisz brakujący klucz, żeby pozbyć się tej niespójności.
        </p>
      )}

      <ApiKeyFields status={status} onSaved={ai.reload} onMessage={onMessage} />

      {test.result && (
        <div
          className={`mx-4 mt-3 rounded-lg border px-3 py-2 text-2xs ${
            test.result.ok ? 'border-gain/40 bg-gain/10 text-gain' : 'border-warn/40 bg-warn/10 text-warn'
          }`}
        >
          <div className="font-medium">
            {test.result.ok ? '✓ ' : '✗ '}
            {test.result.message}
          </div>
          <div className="mt-0.5 text-content-muted">
            {test.result.provider} · {test.result.model}
            {test.result.reply ? ` · odpowiedź: „${test.result.reply}"` : ''}
          </div>
        </div>
      )}
      <div className="grid gap-3 p-4 pt-2 sm:grid-cols-2">
        <Field label="Dostawca">
          <select className="input" value={status.provider} onChange={(e) => save({ provider: e.target.value })}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT / Codex)</option>
          </select>
        </Field>

        <Field
          label="Model"
          hint={suggestions.find((m) => m.id === currentModel)?.hint ?? 'Możesz wpisać dowolny identyfikator modelu.'}
        >
          <div className="space-y-2">
            {/* Rozwijana lista z sugestiami plus pole na dowolny identyfikator —
                lista podpowiedzi przy zwykłym polu tekstowym bywa niewidoczna. */}
            <select
              className="input"
              value={suggestions.some((m) => m.id === currentModel) ? currentModel : '__wlasny'}
              onChange={(e) => {
                if (e.target.value === '__wlasny') setModel('');
                else save({ model: e.target.value });
              }}
            >
              {suggestions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.hint}
                </option>
              ))}
              <option value="__wlasny">Inny model (wpisz ręcznie)…</option>
            </select>

            {!suggestions.some((m) => m.id === currentModel) && (
              <div className="flex gap-2">
                <input
                  className="input"
                  value={currentModel}
                  placeholder="identyfikator modelu"
                  onChange={(e) => setModel(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!currentModel}
                  onClick={() => save({ model: currentModel })}
                >
                  Zapisz
                </button>
              </div>
            )}
          </div>
        </Field>
      </div>

      <ul className="divide-y divide-surface-border border-t border-surface-border">
        {status.features.map((feature) => (
          <li key={feature.key} className="px-4 py-3">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={feature.enabled}
                onChange={(e) => save({ features: { [feature.key]: e.target.checked } })}
              />
              <span className="min-w-0 flex-1">
                <span className="text-sm font-medium">{feature.label}</span>
                <span className="mt-0.5 block text-2xs text-content-secondary">{feature.description}</span>
                <span className="mt-1 block text-2xs text-content-muted">
                  <span className="font-medium">Wysyłane dane:</span> {feature.dataSent}
                </span>
                {feature.enabled && !feature.available && feature.reason && (
                  <span className="mt-1 block text-2xs text-warn">{feature.reason}</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <p className="border-t border-surface-border px-4 py-3 text-2xs text-content-muted">
        Wyłączenie funkcji oznacza, że aplikacja nie wysyła nic do dostawcy modelu. Wszystkie liczby — wycena,
        podatki, projekcja — powstają lokalnie i nie zależą od tych ustawień.
      </p>
    </Card>
  );
}

/** Parametry poduszki finansowej: miesięczne wydatki i docelowa liczba miesięcy. */
function EmergencyFundSettings({ onMessage }: { onMessage: (message: string, tone: 'info' | 'error' | 'success') => void }) {
  const settings = useAsync(() => api.settings.get(), []);
  const [expenses, setExpenses] = useState<string | null>(null);
  const [months, setMonths] = useState<string | null>(null);

  if (!settings.data) return null;

  const currentExpenses = expenses ?? String(((settings.data.monthlyExpensesPlnMinor as number) ?? 0) / 100);
  const currentMonths = months ?? String((settings.data.emergencyFundMonths as number) ?? 6);

  const save = () => {
    void api.settings
      .update({
        monthlyExpensesPlnMinor: Math.round(Number(currentExpenses.replace(',', '.')) * 100),
        emergencyFundMonths: Number(currentMonths),
      })
      .then(() => {
        setExpenses(null);
        setMonths(null);
        settings.reload();
        onMessage('Zapisano parametry poduszki', 'success');
      })
      .catch(() => onMessage('Nie udało się zapisać', 'error'));
  };

  return (
    <Card title="Poduszka finansowa">
      <div className="grid gap-3 p-4 pt-2 sm:grid-cols-3">
        <Field label="Miesięczne wydatki (zł)" hint="Podstawa do wyliczenia, na ile miesięcy starczy poduszka.">
          <input className="input" value={currentExpenses} onChange={(e) => setExpenses(e.target.value)} placeholder="4500" />
        </Field>
        <Field label="Docelowa liczba miesięcy" hint="Zwykle przyjmuje się od 3 do 12.">
          <input className="input" value={currentMonths} onChange={(e) => setMonths(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <button type="button" className="btn" onClick={save} disabled={expenses === null && months === null}>
            Zapisz
          </button>
        </div>
      </div>
      <p className="px-4 pb-4 text-2xs text-content-muted">
        Który portfel jest poduszką, zaznaczasz w tabeli powyżej. Taki portfel nie wchodzi do propozycji rebalansu.
      </p>
    </Card>
  );
}


/**
 * Wykrywanie zduplikowanych transakcji.
 *
 * Deduplikacja przy imporcie chroni przed wgraniem tego samego pliku dwa razy,
 * ale nie cofnie duplikatów już zapisanych — najczęstsza przyczyna zawyżonej
 * wartości portfela. Nic nie usuwamy automatycznie: dwie identyczne operacje
 * tego samego dnia bywają prawdziwe.
 */
function DuplicatesCard({ onMessage }: { onMessage: (message: string, tone: 'info' | 'error' | 'success') => void }) {
  const duplicates = useAsync(() => api.duplicates.find(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (!duplicates.data) return null;
  const { groups, totalExtraTransactions, totalExcessPlnMinor } = duplicates.data;

  if (groups.length === 0) {
    return (
      <Card title="Duplikaty transakcji">
        <p className="px-4 pb-4 pt-2 text-sm text-content-muted">
          Nie znaleziono zduplikowanych transakcji.
        </p>
      </Card>
    );
  }

  const remove = () => {
    if (!window.confirm(`Usunąć nadmiarowe kopie z ${selected.size} grup? W każdej zostanie najstarszy wpis.`)) return;
    void api.duplicates
      .resolve([...selected])
      .then((r) => {
        setSelected(new Set());
        duplicates.reload();
        onMessage(`Usunięto ${r.removed} zduplikowanych transakcji`, 'success');
      })
      .catch(() => onMessage('Nie udało się usunąć duplikatów', 'error'));
  };

  return (
    <Card
      title="Duplikaty transakcji"
      action={
        <span className="text-2xs text-warn">
          {totalExtraTransactions} nadmiarowych wpisów, wpływ {formatPln(totalExcessPlnMinor)}
        </span>
      }
    >
      <p className="px-4 pb-2 pt-2 text-2xs text-content-muted">
        Te operacje występują w bazie więcej niż raz. Zaznacz grupy, w których to faktycznie pomyłka — w każdej
        zostanie najstarszy wpis, reszta zostanie usunięta.
      </p>

      <div className="max-h-72 overflow-y-auto">
        <DataTable headers={['', 'Data', 'Portfel', 'Instrument', 'Typ', { label: 'Kwota', align: 'right' }, { label: 'Kopii', align: 'right' }]}>
          {groups.map((group) => (
            <tr key={group.key}>
              <td className="table-cell">
                <input
                  type="checkbox"
                  checked={selected.has(group.key)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                />
              </td>
              <td className="table-cell tabular">{formatDate(group.tradeDate)}</td>
              <td className="table-cell text-2xs text-content-muted">{group.portfolioName}</td>
              <td className="table-cell">{group.instrumentSymbol ?? 'gotówka'}</td>
              <td className="table-cell text-2xs">{group.type}</td>
              <td className="table-cell tabular text-right">{formatPln(group.amountPlnMinor)}</td>
              <td className="table-cell tabular text-right font-medium">{group.count}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <div className="flex items-center gap-3 border-t border-surface-border px-4 py-3">
        <button type="button" className="btn" onClick={remove} disabled={selected.size === 0}>
          Usuń nadmiarowe kopie
        </button>
        <button type="button" className="btn btn-ghost text-2xs" onClick={() => setSelected(new Set(groups.map((g) => g.key)))}>
          Zaznacz wszystkie
        </button>
      </div>
    </Card>
  );
}

/**
 * Pola kluczy API.
 *
 * Klucz zapisany tutaj ma pierwszeństwo przed `.env` i działa od razu — plik
 * jest czytany raz przy starcie procesu, więc wpisanie go tam wymagało
 * restartu. Do przeglądarki wraca wyłącznie maska; pełnej wartości serwer
 * nigdy nie odsyła.
 */
function ApiKeyFields({
  status,
  onSaved,
  onMessage,
}: {
  status: {
    keys: {
      anthropic: boolean;
      openai: boolean;
      anthropicMasked: string | null;
      openaiMasked: string | null;
      anthropicSource: 'settings' | 'env' | null;
      openaiSource: 'settings' | 'env' | null;
    };
  };
  onSaved: () => void;
  onMessage: (message: string, tone: 'info' | 'error' | 'success') => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const providers = [
    {
      id: 'anthropic' as const,
      label: 'Anthropic (Claude)',
      placeholder: 'sk-ant-…',
      present: status.keys.anthropic,
      masked: status.keys.anthropicMasked,
      source: status.keys.anthropicSource,
    },
    {
      id: 'openai' as const,
      label: 'OpenAI',
      placeholder: 'sk-…',
      present: status.keys.openai,
      masked: status.keys.openaiMasked,
      source: status.keys.openaiSource,
    },
  ];

  const save = async (provider: 'anthropic' | 'openai') => {
    setBusy(provider);
    try {
      const result = await api.ai.saveKey(provider, draft[provider] ?? '');
      setDraft((current) => ({ ...current, [provider]: '' }));
      onSaved();

      // Test po zapisie: literówka w kluczu inaczej ujawniłaby się dopiero
      // przy pierwszym użyciu funkcji AI, długo po jej popełnieniu.
      if (result.test) {
        onMessage(
          result.test.ok ? `Połączono — odpowiedź w ${result.test.latencyMs} ms.` : result.test.message,
          result.test.ok ? 'success' : 'error',
        );
      } else {
        onMessage('Klucz wyczyszczony.', 'info');
      }
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Nie udało się zapisać klucza', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3 border-b border-surface-border p-4 sm:grid-cols-2">
      {providers.map((provider) => (
        <Field
          key={provider.id}
          label={provider.label}
          hint={
            provider.present
              ? `Zapisany: ${provider.masked} (${provider.source === 'env' ? 'z pliku .env' : 'z ustawień'})`
              : 'Nie ustawiono'
          }
        >
          <div className="flex gap-2">
            <input
              type="password"
              className="input"
              autoComplete="off"
              placeholder={provider.present ? '•••••••• (wpisz, aby zmienić)' : provider.placeholder}
              value={draft[provider.id] ?? ''}
              onChange={(e) => setDraft((current) => ({ ...current, [provider.id]: e.target.value }))}
            />
            <button
              type="button"
              className="btn shrink-0"
              disabled={busy === provider.id}
              onClick={() => void save(provider.id)}
            >
              {busy === provider.id ? '…' : draft[provider.id] ? 'Zapisz' : 'Wyczyść'}
            </button>
          </div>
        </Field>
      ))}
    </div>
  );
}

/**
 * Dane bota Telegram.
 *
 * Wcześniej dało się je podać wyłącznie w `.env`, czyli z konsoli serwera
 * i z restartem — a to jedyna droga do powiadomień. Wartości zapisane tutaj
 * mają pierwszeństwo przed plikiem i działają od razu; do przeglądarki nigdy
 * nie wracają.
 */
function TelegramFields({
  configured,
  onMessage,
  onSaved,
}: {
  configured: boolean;
  onMessage: (message: string, tone: 'info' | 'error' | 'success') => void;
  onSaved: () => void;
}) {
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.settings.saveTelegram({
        ...(botToken ? { botToken } : {}),
        ...(chatId ? { chatId } : {}),
      });
      setBotToken('');
      setChatId('');
      onSaved();

      // Test od razu po zapisie: literówka w tokenie inaczej ujawniłaby się
      // dopiero przy pierwszym alercie, czyli długo po jej popełnieniu.
      if (result.test) {
        onMessage(result.test.message, result.test.ok ? 'success' : 'error');
      } else {
        onMessage('Zapisano. Uzupełnij oba pola, żeby włączyć powiadomienia.', 'info');
      }
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Nie udało się zapisać', 'error');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const result = await api.settings.testTelegram();
      onMessage(result.message, result.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-surface-border px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Token bota" hint="Dostaniesz go od @BotFather">
          <input
            type="password"
            className="input"
            autoComplete="off"
            placeholder={configured ? '•••••••• (wpisz, aby zmienić)' : '123456:ABC-DEF…'}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </Field>
        <Field label="Identyfikator czatu" hint="Napisz do @userinfobot, żeby go poznać">
          <input
            className="input"
            autoComplete="off"
            placeholder={configured ? '•••••••' : '123456789'}
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
        </Field>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!botToken && !chatId)}
            onClick={() => void save()}
          >
            Zapisz
          </button>
          <button type="button" className="btn" disabled={busy || !configured} onClick={() => void test()}>
            Testuj
          </button>
        </div>
      </div>

      <p className="mt-2 text-2xs text-content-muted">
        {configured
          ? 'Bot skonfigurowany — powiadomienia o alertach trafiają na Telegram.'
          : 'Bot wyłączony. Uzupełnij oba pola albo ustaw TELEGRAM_BOT_TOKEN i TELEGRAM_CHAT_ID w .env.'}
      </p>
    </div>
  );
}

/**
 * Usunięcie portfela wraz z całą jego historią.
 *
 * Operacja jest nieodwracalna i kasuje transakcje, rozliczenia FIFO, snapshoty
 * i cele alokacji — dlatego wymaga przepisania nazwy, a nie samego kliknięcia
 * „na pewno". Instrumenty zostają: są wspólne dla wszystkich portfeli i mają
 * własną historię notowań, którą szkoda byłoby pobierać od nowa.
 */
function DeletePortfolioModal({
  portfolio,
  onClose,
  onDeleted,
  onError,
}: {
  portfolio: Portfolio;
  onClose: () => void;
  onDeleted: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const result = await api.portfolios.remove(portfolio.id, portfolio.name);
      onDeleted(
        result.deletedTransactions
          ? `Portfel „${portfolio.name}" usunięty wraz z ${result.deletedTransactions} transakcjami.`
          : `Portfel „${portfolio.name}" usunięty.`,
      );
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Nie udało się usunąć portfela');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Usunąć portfel „${portfolio.name}"?`} onClose={onClose}>
      <p className="text-sm text-content-secondary">
        Znikną wszystkie transakcje tego portfela, rozliczenia zysków, zapisana historia wartości i cele
        alokacji. Tej operacji nie da się cofnąć — kosz obejmuje pojedyncze transakcje, nie całe portfele.
      </p>
      <p className="mt-2 text-2xs text-content-muted">
        Instrumenty i pobrane notowania zostają — są wspólne dla wszystkich portfeli.
      </p>

      <div className="mt-4">
        <Field label={`Wpisz „${portfolio.name}", żeby potwierdzić`}>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Anuluj
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || typed !== portfolio.name}
          onClick={() => void remove()}
        >
          {busy ? 'Usuwam…' : 'Usuń bezpowrotnie'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Pasek zakładek: przyciski na szerokim ekranie, lista rozwijana na wąskim.
 *
 * Cztery zakładki mieszczą się w rzędzie na desktopie, ale na telefonie
 * zawijałyby się do dwóch linii i zjadały miejsce nad treścią — tam select
 * niesie tę samą informację w jednym wierszu.
 */
function SettingsTabs({ value, onChange }: { value: SettingsTab; onChange: (tab: SettingsTab) => void }) {
  return (
    <>
      <div className="hidden gap-1 border-b border-surface-border sm:flex">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab.id === value
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-content-muted hover:text-content-primary'
            }`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <select
        className="input sm:hidden"
        value={value}
        onChange={(e) => onChange(e.target.value as SettingsTab)}
        aria-label="Sekcja ustawień"
      >
        {SETTINGS_TABS.map((tab) => (
          <option key={tab.id} value={tab.id}>
            {tab.label}
          </option>
        ))}
      </select>
    </>
  );
}
