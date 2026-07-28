import { useState } from 'react';
import { AiDisclaimer, Card, ErrorBanner, Field, Spinner } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatPercent, formatPln, toneClass } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { usePortfolioParam } from '@/state/app';

/**
 * Asystent oparty o model językowy.
 *
 * Każde narzędzie pokazuje najpierw liczby wyliczone lokalnie, a dopiero pod
 * nimi komentarz modelu. Przy wyłączonej funkcji AI liczby zostają — znika
 * wyłącznie warstwa opisowa, razem z informacją dlaczego.
 */
export function Assistant() {
  const portfolioId = usePortfolioParam();
  const status = useAsync(() => api.ai.status(), []);

  const enabled = (key: string): boolean =>
    status.data?.features.find((f) => f.key === key)?.available ?? false;

  return (
    <div className="space-y-4">
      <p className="text-2xs text-content-muted">
        Narzędzia korzystające z modelu językowego. Każde włączasz osobno w Ustawieniach i przy każdym widzisz,
        co dokładnie zostaje wysłane. Bez włączenia funkcji liczby nadal się liczą — lokalnie, jak wszędzie indziej.
      </p>

      <MonthlyCard portfolioId={portfolioId} enabled={enabled('monthlySummary')} />
      <PurchaseCard portfolioId={portfolioId} enabled={enabled('purchaseCheck')} />
      <TaxCard portfolioId={portfolioId} enabled={enabled('taxAssistant')} />
      <DocumentCard enabled={enabled('documentSummary')} />
    </div>
  );
}

/** Wspólna obsługa wywołania: stan ładowania, błąd, wynik. */
function useAssist<T>() {
  const [state, setState] = useState<{ busy: boolean; result: T | null; error: string | null }>({
    busy: false,
    result: null,
    error: null,
  });

  const run = async (call: () => Promise<T>) => {
    setState({ busy: true, result: null, error: null });
    try {
      setState({ busy: false, result: await call(), error: null });
    } catch (err) {
      setState({
        busy: false,
        result: null,
        error: err instanceof ApiError ? err.message : 'Nie udało się wykonać operacji',
      });
    }
  };

  return { ...state, run };
}

/** Komentarz modelu albo powód jego braku — ten sam układ we wszystkich kartach. */
function ModelText({ text, reason, disclaimer }: { text: string | null; reason: string | null; disclaimer: string }) {
  if (!text) {
    return (
      <p className="border-t border-surface-border px-4 py-3 text-2xs text-content-muted">
        {reason ?? 'Brak komentarza.'} Liczby powyżej powstają lokalnie i nie zależą od AI.
      </p>
    );
  }

  return (
    <div className="border-t border-surface-border">
      <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-content-secondary">{text}</p>
      <div className="px-4 pb-3">
        <AiDisclaimer text={disclaimer} />
      </div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-overlay/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-content-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

// ── Podsumowanie miesiąca ────────────────────────────────────

function MonthlyCard({ portfolioId, enabled }: { portfolioId?: number; enabled: boolean }) {
  const [month, setMonth] = useState('');
  const assist = useAssist<Awaited<ReturnType<typeof api.assist.monthlySummary>>>();

  return (
    <Card
      title="Podsumowanie miesiąca"
      action={<FeatureBadge enabled={enabled} />}
    >
      <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
        <div className="w-40">
          <Field label="Miesiąc">
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={assist.busy}
          onClick={() => void assist.run(() => api.assist.monthlySummary({ portfolioId, month: month || undefined }))}
        >
          {assist.busy ? 'Liczę…' : 'Podsumuj'}
        </button>
        <span className="text-2xs text-content-muted">Puste pole = ostatni zamknięty miesiąc.</span>
      </div>

      {assist.error && <ErrorBanner message={assist.error} />}
      {assist.busy && <Spinner />}

      {assist.result && (
        <>
          <div className="grid grid-cols-2 gap-3 px-4 pb-3 lg:grid-cols-4">
            <Fact label="Miesiąc" value={assist.result.data.month} />
            <Fact
              label="Zmiana bez wpłat"
              value={assist.result.data.changeBp === null ? '—' : formatPercent(assist.result.data.changeBp, { sign: true })}
              tone={assist.result.data.changeBp === null ? undefined : toneClass(assist.result.data.changeBp)}
            />
            <Fact label="Dopłaty" value={formatPln(assist.result.data.contributedPlnMinor)} />
            <Fact label="Dywidendy" value={formatPln(assist.result.data.dividendsPlnMinor)} />
            <Fact
              label="Wynik zrealizowany"
              value={formatPln(assist.result.data.realizedPlnMinor, { sign: true })}
              tone={toneClass(assist.result.data.realizedPlnMinor)}
            />
            <Fact label="Transakcje" value={`${assist.result.data.buys} kupna, ${assist.result.data.sells} sprzedaży`} />
            <Fact
              label="Wartość na koniec"
              value={assist.result.data.valueEndPlnMinor === null ? '—' : formatPln(assist.result.data.valueEndPlnMinor)}
            />
            <Fact
              label="Największy ruch"
              value={
                assist.result.data.movers[0]
                  ? `${assist.result.data.movers[0].symbol} ${formatPercent(assist.result.data.movers[0].changeBp, { sign: true })}`
                  : '—'
              }
            />
          </div>
          <ModelText
            text={assist.result.text}
            reason={assist.result.unavailableReason}
            disclaimer={assist.result.disclaimer}
          />
        </>
      )}
    </Card>
  );
}

// ── Kontrola przed zakupem ───────────────────────────────────

function PurchaseCard({ portfolioId, enabled }: { portfolioId?: number; enabled: boolean }) {
  const [symbol, setSymbol] = useState('');
  const [amount, setAmount] = useState('');
  const assist = useAssist<Awaited<ReturnType<typeof api.assist.purchaseCheck>>>();

  return (
    <Card title="Kontrola przed zakupem" action={<FeatureBadge enabled={enabled} />}>
      <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
        <div className="w-44">
          <Field label="Instrument">
            <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="np. IUIT" />
          </Field>
        </div>
        <div className="w-36">
          <Field label="Kwota zakupu">
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" />
          </Field>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={assist.busy || !symbol || !amount}
          onClick={() => void assist.run(() => api.assist.purchaseCheck({ portfolioId, symbol, amount }))}
        >
          {assist.busy ? 'Liczę…' : 'Sprawdź wpływ'}
        </button>
      </div>

      {assist.error && <ErrorBanner message={assist.error} />}

      {assist.result && (
        <>
          <div className="grid grid-cols-2 gap-3 px-4 pb-3 lg:grid-cols-4">
            <Fact
              label="Udział pozycji"
              value={`${formatPercent(assist.result.data.shareBeforeBp, { digits: 1 })} → ${formatPercent(assist.result.data.shareAfterBp, { digits: 1 })}`}
            />
            <Fact
              label={`Klasa: ${assist.result.data.assetClass ?? 'nieznana'}`}
              value={`${formatPercent(assist.result.data.assetClassShareBeforeBp, { digits: 1 })} → ${formatPercent(assist.result.data.assetClassShareAfterBp, { digits: 1 })}`}
            />
            <Fact
              label={`Sektor: ${assist.result.data.sector ?? 'nieprzypisany'}`}
              value={formatPercent(assist.result.data.sectorShareAfterBp, { digits: 1 })}
            />
            <Fact
              label={`Region: ${assist.result.data.country ?? 'nieprzypisany'}`}
              value={formatPercent(assist.result.data.countryShareAfterBp, { digits: 1 })}
            />
          </div>

          {assist.result.data.warnings.length > 0 && (
            <ul className="space-y-1 px-4 pb-3">
              {assist.result.data.warnings.map((warning, index) => (
                <li key={index} className="text-2xs text-warn">
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <ModelText
            text={assist.result.text}
            reason={assist.result.unavailableReason}
            disclaimer={assist.result.disclaimer}
          />
        </>
      )}
    </Card>
  );
}

// ── Asystent podatkowy ───────────────────────────────────────

function TaxCard({ portfolioId, enabled }: { portfolioId?: number; enabled: boolean }) {
  const years = useAsync(() => api.tax.years(), []);
  const [year, setYear] = useState('');
  const [question, setQuestion] = useState('');
  const assist = useAssist<Awaited<ReturnType<typeof api.assist.tax>>>();

  const activeYear = year || String(years.data?.[0] ?? new Date().getFullYear() - 1);

  return (
    <Card title="Asystent podatkowy" action={<FeatureBadge enabled={enabled} />}>
      <div className="flex flex-wrap items-end gap-3 p-4 pt-2">
        <div className="w-28">
          <Field label="Rok">
            <select className="input" value={activeYear} onChange={(e) => setYear(e.target.value)}>
              {(years.data ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[16rem] flex-1">
          <Field label="Pytanie">
            <input
              className="input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="np. Skąd bierze się kwota do dopłaty od dywidend?"
            />
          </Field>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={assist.busy || question.trim().length < 3}
          onClick={() =>
            void assist.run(() => api.assist.tax({ portfolioId, year: Number(activeYear), question }))
          }
        >
          {assist.busy ? 'Myślę…' : 'Zapytaj'}
        </button>
      </div>

      {assist.error && <ErrorBanner message={assist.error} />}

      {assist.result && (
        <>
          <div className="grid grid-cols-2 gap-3 px-4 pb-3 lg:grid-cols-4">
            <Fact
              label="Papiery — dochód"
              value={formatPln(assist.result.data.securitiesGainPlnMinor, { sign: true })}
              tone={toneClass(assist.result.data.securitiesGainPlnMinor)}
            />
            <Fact label="Papiery — podatek" value={formatPln(assist.result.data.securitiesTaxPlnMinor)} />
            <Fact
              label="Krypto — dochód"
              value={formatPln(assist.result.data.cryptoGainPlnMinor, { sign: true })}
              tone={toneClass(assist.result.data.cryptoGainPlnMinor)}
            />
            <Fact label="Dywidendy — do dopłaty" value={formatPln(assist.result.data.dividendDuePlnMinor)} />
          </div>
          <ModelText
            text={assist.result.text}
            reason={assist.result.unavailableReason}
            disclaimer={assist.result.disclaimer}
          />
        </>
      )}
    </Card>
  );
}

// ── Streszczanie dokumentów ──────────────────────────────────

function DocumentCard({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState('');
  const assist = useAssist<Awaited<ReturnType<typeof api.assist.document>>>();

  return (
    <Card title="Streszczanie dokumentów" action={<FeatureBadge enabled={enabled} />}>
      <div className="space-y-3 p-4 pt-2">
        <Field label="Tekst raportu, komunikatu albo prospektu">
          <textarea
            className="input min-h-[8rem] font-mono text-2xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Wklej treść dokumentu. Nic z Twojego portfela nie zostaje tu dołączone."
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary"
            disabled={assist.busy || text.trim().length < 50}
            onClick={() => void assist.run(() => api.assist.document(text))}
          >
            {assist.busy ? 'Czytam…' : 'Streść'}
          </button>
          <span className="text-2xs text-content-muted">{text.length} znaków</span>
        </div>
      </div>

      {assist.error && <ErrorBanner message={assist.error} />}

      {assist.result && (
        <>
          {assist.result.data.truncated && (
            <p className="px-4 pb-2 text-2xs text-warn">
              Dokument był dłuższy niż limit — streszczenie obejmuje pierwsze {assist.result.data.characters} znaków.
            </p>
          )}
          <ModelText
            text={assist.result.text}
            reason={assist.result.unavailableReason}
            disclaimer={assist.result.disclaimer}
          />
        </>
      )}
    </Card>
  );
}

function FeatureBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`text-2xs ${enabled ? 'text-content-muted' : 'text-warn'}`}>
      {enabled ? 'Funkcja włączona' : 'Wyłączona — włącz w Ustawieniach'}
    </span>
  );
}
