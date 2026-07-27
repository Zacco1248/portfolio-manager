import { useState } from 'react';
import { ALLOCATION_DIMENSION_LABELS, ASSET_CLASS_LABELS } from '@portfolio/shared';
import type { AllocationDimension, RebalancePlan } from '@portfolio/shared';
import { Card, DataTable, ErrorBanner, Field, Spinner, Toast, WarningList, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

export function Rebalance() {
  const portfolioId = usePortfolioParam();
  const [contribution, setContribution] = useState('');
  const [dimension, setDimension] = useState<AllocationDimension>('asset_class');
  const [applied, setApplied] = useState({ contribution: '', dimension: 'asset_class' as AllocationDimension });
  const { toast, show, dismiss } = useToast();

  const plans = useAsync(
    () => api.rebalance.get({ portfolioId, contribution: applied.contribution || undefined, dimension: applied.dimension }),
    [portfolioId, applied],
  );
  const targets = useAsync(() => api.rebalance.targets(portfolioId), [portfolioId]);

  return (
    <div className="space-y-4">
      <Card title="Parametry">
        <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
          <div className="w-40">
            <Field label="Planowana dopłata">
              <input
                className="input"
                value={contribution}
                onChange={(e) => setContribution(e.target.value)}
                placeholder="np. 1000"
              />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Wymiar">
              <select className="input" value={dimension} onChange={(e) => setDimension(e.target.value as AllocationDimension)}>
                {Object.entries(ALLOCATION_DIMENSION_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setApplied({ contribution, dimension })}>
            Przelicz
          </button>
        </div>
      </Card>

      {plans.loading && <Spinner />}
      {plans.error && <ErrorBanner message={plans.error} onRetry={plans.reload} />}

      {plans.data && (
        <>
          <WarningList warnings={plans.data.warnings} />
          <div className="grid gap-4 xl:grid-cols-2">
            <PlanCard title="Tylko dokupowanie" plan={plans.data.buyOnly} highlight />
            <PlanCard title="Pełny rebalans" plan={plans.data.full} />
          </div>
        </>
      )}

      <TargetsEditor
        targets={targets.data?.targets ?? []}
        sumBp={targets.data?.sumBp ?? 0}
        portfolioId={portfolioId ?? null}
        onChange={() => {
          targets.reload();
          plans.reload();
        }}
        onError={(message) => show(message, 'error')}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

function PlanCard({ title, plan, highlight = false }: { title: string; plan: RebalancePlan; highlight?: boolean }) {
  return (
    <Card
      title={title}
      className={highlight ? 'ring-1 ring-accent/30' : ''}
      action={
        <span className="text-2xs text-content-muted">
          Odchylenie {formatPercent(plan.driftBeforeBp, { digits: 1 })} → {formatPercent(plan.driftAfterBp, { digits: 1 })}
        </span>
      }
    >
      {plan.actions.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-content-muted">{plan.note}</p>
      ) : (
        <>
          <DataTable
            headers={[
              'Pozycja',
              { label: 'Teraz', align: 'right' },
              { label: 'Cel', align: 'right' },
              { label: 'Odchylenie', align: 'right' },
              { label: 'Kwota', align: 'right' },
            ]}
          >
            {plan.actions.map((action) => (
              <tr key={action.key} className={action.withinTolerance ? 'opacity-60' : ''}>
                <td className="table-cell">
                  <div className="font-medium">{action.label}</div>
                  <div className="text-2xs text-content-muted">{action.suggestion}</div>
                </td>
                <td className="table-cell tabular text-right">{formatPercent(action.currentShareBp, { digits: 1 })}</td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {formatPercent(action.targetShareBp, { digits: 1 })}
                  <span className="ml-1 text-2xs text-content-muted">±{(action.toleranceBp / 100).toFixed(0)}</span>
                </td>
                <td className={`table-cell tabular text-right ${action.withinTolerance ? '' : toneClass(action.driftBp)}`}>
                  {formatPercent(action.driftBp, { sign: true, digits: 1 })}
                </td>
                <td className={`table-cell tabular text-right font-medium ${toneClass(action.deltaPlnMinor)}`}>
                  {action.deltaPlnMinor === 0 ? '—' : formatPln(action.deltaPlnMinor, { sign: true })}
                </td>
              </tr>
            ))}
          </DataTable>
          <p className="px-4 py-2 text-2xs text-content-muted">{plan.note}</p>
        </>
      )}
    </Card>
  );
}

function TargetsEditor({
  targets,
  sumBp,
  portfolioId,
  onChange,
  onError,
}: {
  targets: { id: number; key: string; dimension: string; targetBp: number; toleranceBp: number; portfolioId: number | null }[];
  sumBp: number;
  portfolioId: number | null;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const [key, setKey] = useState('stock');
  const [target, setTarget] = useState('');
  const [tolerance, setTolerance] = useState('5');

  const save = async () => {
    try {
      await api.rebalance.saveTarget({
        portfolioId,
        dimension: 'asset_class',
        key,
        targetPercent: target,
        tolerancePercent: tolerance,
      });
      setTarget('');
      onChange();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Nie udało się zapisać celu');
    }
  };

  const assetTargets = targets.filter((t) => t.dimension === 'asset_class');

  return (
    <Card
      title="Alokacja docelowa"
      action={
        <span className={`text-2xs ${sumBp === 10_000 ? 'text-content-muted' : 'text-warn'}`}>
          Suma celów: {formatPercent(sumBp, { digits: 1 })}
          {sumBp !== 10_000 && ' — powinna wynosić 100%'}
        </span>
      }
    >
      <div className="flex flex-wrap items-end gap-2 p-4 pt-2">
        <div className="w-40">
          <Field label="Klasa aktywów">
            <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
              {Object.entries(ASSET_CLASS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="w-28">
          <Field label="Cel %">
            <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="60" />
          </Field>
        </div>
        <div className="w-28">
          <Field label="Tolerancja %">
            <input className="input" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </Field>
        </div>
        <button type="button" className="btn" onClick={() => void save()} disabled={!target}>
          Zapisz cel
        </button>
      </div>

      {assetTargets.length > 0 && (
        <ul className="divide-y divide-surface-border border-t border-surface-border">
          {assetTargets.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1">{ASSET_CLASS_LABELS[entry.key as keyof typeof ASSET_CLASS_LABELS] ?? entry.key}</span>
              <span className="tabular">{formatPercent(entry.targetBp, { digits: 1 })}</span>
              <span className="tabular text-2xs text-content-muted">±{(entry.toleranceBp / 100).toFixed(0)}%</span>
              <span className="text-2xs text-content-muted">{entry.portfolioId === null ? 'wszystkie portfele' : 'ten portfel'}</span>
              <button
                type="button"
                className="btn btn-ghost px-2 py-0.5 text-2xs"
                onClick={() => void api.rebalance.removeTarget(entry.id).then(onChange)}
              >
                Usuń
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
