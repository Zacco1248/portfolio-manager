import { useState } from 'react';
import { ALERT_KIND_LABELS } from '@portfolio/shared';
import type { AlertKind } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, Field, Spinner, Toast, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useApp } from '@/state/app';

export function Alerts() {
  const { status } = useApp();
  const alerts = useAsync(() => api.alerts.list(), []);
  const events = useAsync(() => api.alerts.events(), []);
  const instruments = useAsync(() => api.instruments.list(), []);
  const { toast, show, dismiss } = useToast();
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({ kind: 'price' as AlertKind, instrumentId: '', above: '', below: '', thresholdPercent: '' });

  const create = async () => {
    setBusy(true);
    try {
      const condition: Record<string, unknown> = {};
      if (form.kind === 'price') {
        if (form.above) condition.above = Number(form.above.replace(',', '.'));
        if (form.below) condition.below = Number(form.below.replace(',', '.'));
      }
      if (form.kind === 'daily_move' && form.thresholdPercent) {
        condition.thresholdBp = Math.round(Number(form.thresholdPercent.replace(',', '.')) * 100);
      }

      await api.alerts.create({
        kind: form.kind,
        instrumentId: form.instrumentId ? Number(form.instrumentId) : null,
        condition,
      });
      setForm({ kind: 'price', instrumentId: '', above: '', below: '', thresholdPercent: '' });
      alerts.reload();
      show('Alert dodany', 'success');
    } catch (err) {
      show(err instanceof ApiError ? err.message : 'Nie udało się dodać alertu', 'error');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      const result = await api.alerts.check();
      events.reload();
      alerts.reload();
      show(result.message, 'success');
    } catch {
      show('Sprawdzenie alertów nie powiodło się', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {status && !status.features.telegram && (
        <p className="rounded-card border border-surface-border bg-surface-overlay px-4 py-3 text-2xs text-content-muted">
          Telegram jest wyłączony — brak <code>TELEGRAM_BOT_TOKEN</code> lub <code>TELEGRAM_CHAT_ID</code>. Alerty nadal
          są wykrywane i zapisywane, ale zobaczysz je tylko tutaj.
        </p>
      )}

      <Card title="Nowy alert">
        <div className="grid gap-3 p-4 pt-2 sm:grid-cols-5">
          <Field label="Rodzaj">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AlertKind })}>
              {(['price', 'daily_move', 'report_date', 'news'] as AlertKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {ALERT_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Instrument" hint="Puste = wszystkie">
            <select className="input" value={form.instrumentId} onChange={(e) => setForm({ ...form, instrumentId: e.target.value })}>
              <option value="">Wszystkie</option>
              {(instruments.data ?? []).map((instrument) => (
                <option key={instrument.id} value={instrument.id}>
                  {instrument.symbol}
                </option>
              ))}
            </select>
          </Field>

          {form.kind === 'price' && (
            <>
              <Field label="Powyżej">
                <input className="input" value={form.above} onChange={(e) => setForm({ ...form, above: e.target.value })} placeholder="150" />
              </Field>
              <Field label="Poniżej">
                <input className="input" value={form.below} onChange={(e) => setForm({ ...form, below: e.target.value })} placeholder="90" />
              </Field>
            </>
          )}

          {form.kind === 'daily_move' && (
            <Field label="Próg zmiany %">
              <input
                className="input"
                value={form.thresholdPercent}
                onChange={(e) => setForm({ ...form, thresholdPercent: e.target.value })}
                placeholder="5"
              />
            </Field>
          )}

          <div className="flex items-end gap-2">
            <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
              Dodaj
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="Zdefiniowane alerty"
        action={
          <button type="button" className="btn btn-ghost text-2xs" onClick={() => void check()} disabled={busy}>
            Sprawdź teraz
          </button>
        }
      >
        {alerts.loading && <Spinner />}
        {alerts.error && <ErrorBanner message={alerts.error} onRetry={alerts.reload} />}
        {alerts.data && alerts.data.length === 0 && (
          <EmptyState title="Brak alertów" description="Odchylenie alokacji jest kontrolowane automatycznie na podstawie celów rebalansu." />
        )}
        {alerts.data && alerts.data.length > 0 && (
          <DataTable headers={['Rodzaj', 'Instrument', 'Warunek', 'Ostatnio', 'Aktywny', '']}>
            {alerts.data.map((alert) => (
              <tr key={alert.id}>
                <td className="table-cell">{ALERT_KIND_LABELS[alert.kind]}</td>
                <td className="table-cell">{alert.instrumentSymbol ?? 'wszystkie'}</td>
                <td className="table-cell text-2xs text-content-muted">{JSON.stringify(alert.condition)}</td>
                <td className="table-cell text-2xs text-content-muted">{relativeTime(alert.lastTriggeredAt)}</td>
                <td className="table-cell">
                  <input
                    type="checkbox"
                    checked={alert.enabled}
                    onChange={() => void api.alerts.update(alert.id, { enabled: !alert.enabled }).then(alerts.reload)}
                  />
                </td>
                <td className="table-cell text-right">
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-0.5 text-2xs"
                    onClick={() => void api.alerts.remove(alert.id).then(alerts.reload)}
                  >
                    Usuń
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      <Card title="Historia zdarzeń">
        {events.data && events.data.length === 0 ? (
          <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Nic jeszcze się nie wydarzyło.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {(events.data ?? []).map((event) => (
              <li key={event.id} className="px-4 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="badge bg-surface-overlay text-content-secondary">
                    {ALERT_KIND_LABELS[event.kind]}
                  </span>
                  <span className="ml-auto text-2xs text-content-muted">{formatDateTime(event.triggeredAt)}</span>
                  {!event.delivered && <span className="badge bg-warn/15 text-warn">niewysłane</span>}
                </div>
                <p className="mt-1 whitespace-pre-line text-sm">{event.message}</p>
                {event.deliveryError && <p className="mt-0.5 text-2xs text-loss">{event.deliveryError}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}
