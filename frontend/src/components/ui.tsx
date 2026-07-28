import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { RiskWarning } from '@portfolio/shared';
import { formatPercent, formatPln, toneClass } from '@/lib/format';

/** Wspólne elementy interfejsu. Gęsto, bez ozdobników, kolor tylko tam gdzie niesie znaczenie. */

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 px-4 pt-3">
          {title && <h2 className="text-2xs font-semibold uppercase tracking-wider text-content-muted">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function KpiTile({
  label,
  value,
  change,
  changeLabel,
  hint,
}: {
  label: string;
  value: string;
  change?: number | null;
  changeLabel?: string;
  hint?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-content-muted">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {change !== undefined && (
        <div className={`tabular mt-0.5 text-sm ${toneClass(change)}`}>
          {formatPercent(change ?? null, { sign: true })}
          {changeLabel && <span className="ml-1 text-2xs text-content-muted">{changeLabel}</span>}
        </div>
      )}
      {hint && <div className="mt-0.5 text-2xs text-content-muted">{hint}</div>}
    </div>
  );
}

export function MoneyCell({ minor, sign = false }: { minor: number; sign?: boolean }) {
  return <span className={`tabular ${sign ? toneClass(minor) : ''}`}>{formatPln(minor, { sign })}</span>;
}

export function PercentCell({ bp }: { bp: number | null }) {
  return <span className={`tabular ${toneClass(bp)}`}>{formatPercent(bp, { sign: true })}</span>;
}

export function Spinner({ label = 'Wczytywanie…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-content-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-surface-border border-t-accent" />
      {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center">
      <p className="text-sm font-medium text-content-secondary">{title}</p>
      {description && <p className="max-w-md text-2xs text-content-muted">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-card border border-loss/40 bg-loss/10 px-4 py-3">
      <p className="text-sm text-loss">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-ghost text-2xs" onClick={onRetry}>
          Spróbuj ponownie
        </button>
      )}
    </div>
  );
}

const SEVERITY_STYLE: Record<RiskWarning['severity'], string> = {
  info: 'border-surface-border bg-surface-overlay text-content-secondary',
  warning: 'border-warn/40 bg-warn/10 text-warn',
  critical: 'border-loss/40 bg-loss/10 text-loss',
};

export function WarningList({ warnings }: { warnings: RiskWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {warnings.map((warning, index) => (
        <li
          key={`${warning.kind}-${index}`}
          className={`rounded-card border px-3 py-2 text-sm ${SEVERITY_STYLE[warning.severity]}`}
        >
          <span className="font-medium">{warning.message}</span>
          {warning.detail && <span className="ml-1 opacity-80">{warning.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Zastrzeżenie przy treściach generowanych przez model — wymagane, nie ozdobne. */
export function AiDisclaimer({ text }: { text: string }) {
  return (
    <p className="rounded-card border border-warn/30 bg-warn/5 px-3 py-2 text-2xs text-warn">
      ⚠ {text}
    </p>
  );
}

export function Toast({ message, tone = 'info', onDismiss }: { message: string; tone?: 'info' | 'error' | 'success'; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const style =
    tone === 'error'
      ? 'border-loss/50 bg-loss/15 text-loss'
      : tone === 'success'
        ? 'border-gain/50 bg-gain/15 text-gain'
        : 'border-surface-border bg-surface-overlay text-content-primary';

  return (
    <div className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-card border px-4 py-3 text-sm shadow-lg ${style}`}>
      <div className="flex items-start gap-3">
        <span className="flex-1">{message}</span>
        <button type="button" className="text-2xs opacity-70 hover:opacity-100" onClick={onDismiss}>
          ✕
        </button>
      </div>
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' | 'success' } | null>(null);
  return {
    toast,
    show: (message: string, tone: 'info' | 'error' | 'success' = 'info') => setToast({ message, tone }),
    dismiss: () => setToast(null),
  };
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-8">
      <div className="card my-2 w-full max-w-2xl sm:my-0">
        <header className="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" className="btn btn-ghost px-2 py-1" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-content-muted">{hint}</span>}
    </label>
  );
}

/** Tabela z lepkim nagłówkiem i poziomym przewijaniem — kolumn bywa dużo. */
export function DataTable({
  headers,
  children,
  minWidth = 640,
}: {
  headers: (string | { label: string; align?: 'right' })[];
  children: ReactNode;
  /** Szerokość, poniżej której tabela przewija się poziomo zamiast ściskać kolumny. */
  minWidth?: number;
}) {
  return (
    // Przewijanie poziome zamknięte w kontenerze tabeli — strona nigdy nie
    // przewija się w bok, nawet gdy kolumn jest dużo.
    <div className="-mx-px overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth }}>
        <thead>
          <tr className="table-head border-b border-surface-border">
            {headers.map((header, index) => {
              const label = typeof header === 'string' ? header : header.label;
              const align = typeof header === 'string' ? undefined : header.align;
              return (
                <th key={index} className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">{children}</tbody>
      </table>
    </div>
  );
}


/**
 * Miejsce na treść od modelu językowego, dociąganą po wyrenderowaniu reszty.
 *
 * Wywołanie modelu trwa kilka do kilkunastu sekund. Zamiast wstrzymywać całą
 * stronę, pokazujemy w tym miejscu migający zarys tekstu — sygnał, że coś tu
 * będzie, bez blokowania liczb, które są już policzone.
 */
export function AiPending({ lines = 3, label = 'Model układa komentarz…' }: { lines?: number; label?: string }) {
  return (
    <div className="px-4 pb-3 pt-2" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="h-3 animate-pulse rounded bg-surface-overlay"
            // Ostatnia linia krótsza — akapit tekstu nie kończy się równo.
            style={{ width: index === lines - 1 ? '62%' : '100%', animationDelay: `${index * 120}ms` }}
          />
        ))}
      </div>
      <div className="mt-2 text-2xs text-content-muted">{label}</div>
    </div>
  );
}
