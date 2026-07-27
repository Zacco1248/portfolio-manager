import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ASSET_CLASS_LABELS } from '@portfolio/shared';
import type { AssetClass, Position } from '@portfolio/shared';
import { Card, DataTable, EmptyState, ErrorBanner, PercentCell, Spinner, Toast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatPln, formatPrice, formatQuantity, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { ALL_PORTFOLIOS, useApp, usePortfolioParam } from '@/state/app';

type SortKey = 'value' | 'gain' | 'gainPct' | 'day' | 'share' | 'symbol';

export function Positions() {
  const portfolioId = usePortfolioParam();
  const { selectedPortfolioId } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.positions.list(portfolioId), [portfolioId]);
  const [sortKey, setSortKey] = useState<SortKey>('value');
  const [ascending, setAscending] = useState(false);
  const [filter, setFilter] = useState('');
  const [assetClass, setAssetClass] = useState<AssetClass | 'all'>('all');
  const [refreshing, setRefreshing] = useState(false);
  const { toast, show, dismiss } = useToast();

  const positions = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();

    const filtered = data.positions.filter((p) => {
      if (assetClass !== 'all' && p.instrument.assetClass !== assetClass) return false;
      if (!needle) return true;
      return (
        p.instrument.symbol.toLowerCase().includes(needle) || p.instrument.name.toLowerCase().includes(needle)
      );
    });

    const direction = ascending ? 1 : -1;
    return [...filtered].sort((a, b) => direction * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  }, [data, filter, assetClass, sortKey, ascending]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return null;

  const cash = data.cash.reduce((sum, c) => sum + c.cashPlnMinor, 0);
  const totalCost = positions.reduce((sum, p) => sum + p.costPlnMinor, 0);
  const totalValue = positions.reduce((sum, p) => sum + p.valuePlnMinor, 0);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setAscending((asc) => !asc);
    else {
      setSortKey(key);
      setAscending(key === 'symbol');
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.positions.refresh();
      reload();
      show('Ceny odświeżone', 'success');
    } catch {
      show('Nie udało się odświeżyć cen — sprawdź połączenie z internetem', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <input
          className="input h-8 w-56"
          placeholder="Filtruj po tickerze lub nazwie…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="input h-8 w-auto py-0"
          value={assetClass}
          onChange={(e) => setAssetClass(e.target.value as AssetClass | 'all')}
        >
          <option value="all">Wszystkie klasy</option>
          {Object.entries(ASSET_CLASS_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="btn ml-auto" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Odświeżam…' : 'Odśwież ceny'}
        </button>
      </div>

      <Card>
        {positions.length === 0 ? (
          <EmptyState title="Brak pozycji" description="Zmień filtr albo zaimportuj transakcje." />
        ) : (
          <DataTable
            headers={[
              { label: 'Instrument' },
              { label: 'Liczba', align: 'right' },
              { label: 'Śr. cena (PLN)', align: 'right' },
              { label: 'Cena', align: 'right' },
              { label: 'Koszt', align: 'right' },
              { label: 'Wartość', align: 'right' },
              { label: 'Wynik', align: 'right' },
              { label: '%', align: 'right' },
              { label: 'Dziś', align: 'right' },
              { label: 'Udział', align: 'right' },
            ]}
          >
            {positions.map((position) => (
              <tr key={`${position.portfolioId}-${position.instrument.id}`} className="hover:bg-surface-overlay/50">
                <td className="table-cell">
                  <Link to={`/instrument/${position.instrument.id}`} className="hover:text-accent">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{position.instrument.symbol}</span>
                      {position.priceStale && (
                        <span className="badge bg-warn/15 text-warn" title="Cena może być nieaktualna">
                          stara cena
                        </span>
                      )}
                    </div>
                    <div className="truncate text-2xs text-content-muted">
                      {position.instrument.name}
                      {selectedPortfolioId === ALL_PORTFOLIOS && ` · ${position.portfolioName}`}
                    </div>
                  </Link>
                </td>
                <td className="table-cell tabular text-right">{formatQuantity(position.qtyE8)}</td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {formatPrice(position.avgPriceE8, 'PLN')}
                </td>
                <td className="table-cell tabular text-right">
                  {formatPrice(position.priceE8, position.instrument.currency)}
                </td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {formatPln(position.costPlnMinor)}
                </td>
                <td className="table-cell tabular text-right font-medium">{formatPln(position.valuePlnMinor)}</td>
                <td className={`table-cell tabular text-right ${toneClass(position.unrealizedPlnMinor)}`}>
                  {formatPln(position.unrealizedPlnMinor, { sign: true })}
                </td>
                <td className="table-cell text-right">
                  <PercentCell bp={position.unrealizedBp} />
                </td>
                <td className="table-cell text-right">
                  <PercentCell bp={position.dayChangeBp} />
                </td>
                <td className="table-cell tabular text-right text-content-secondary">
                  {(position.sharePortfolioBp / 100).toFixed(1)}%
                </td>
              </tr>
            ))}

            <tr className="bg-surface-overlay/60 font-medium">
              <td className="table-cell">Razem ({positions.length})</td>
              <td className="table-cell" />
              <td className="table-cell" />
              <td className="table-cell" />
              <td className="table-cell tabular text-right">{formatPln(totalCost)}</td>
              <td className="table-cell tabular text-right">{formatPln(totalValue)}</td>
              <td className={`table-cell tabular text-right ${toneClass(totalValue - totalCost)}`}>
                {formatPln(totalValue - totalCost, { sign: true })}
              </td>
              <td className="table-cell" />
              <td className="table-cell" />
              <td className="table-cell" />
            </tr>
          </DataTable>
        )}
      </Card>

      <p className="text-2xs text-content-muted">
        Gotówka: <span className="tabular">{formatPln(cash)}</span>. Średnia cena nabycia jest podana w złotych —
        pozycja kupowana przy różnych kursach nie ma jednej ceny w walucie notowania.
      </p>

      <div className="flex gap-2">
        <button type="button" className="btn text-2xs" onClick={() => onSort('value')}>
          Sortuj: wartość
        </button>
        <button type="button" className="btn text-2xs" onClick={() => onSort('gainPct')}>
          Sortuj: wynik %
        </button>
        <button type="button" className="btn text-2xs" onClick={() => onSort('day')}>
          Sortuj: zmiana dzienna
        </button>
        <button type="button" className="btn text-2xs" onClick={() => onSort('symbol')}>
          Sortuj: ticker
        </button>
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={dismiss} />}
    </div>
  );
}

function sortValue(position: Position, key: SortKey): number {
  switch (key) {
    case 'value':
      return position.valuePlnMinor;
    case 'gain':
      return position.unrealizedPlnMinor;
    case 'gainPct':
      return position.unrealizedBp ?? 0;
    case 'day':
      return position.dayChangeBp ?? 0;
    case 'share':
      return position.sharePortfolioBp;
    case 'symbol':
      // Kolejność alfabetyczna jako liczba — wystarczy do stabilnego sortowania.
      return position.instrument.symbol.charCodeAt(0) * 1000 + (position.instrument.symbol.charCodeAt(1) || 0);
    default:
      return 0;
  }
}
