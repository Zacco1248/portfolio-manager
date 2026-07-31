import { Bar, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Candle } from '@portfolio/shared';
import { formatDate } from '@/lib/format';
import { AXIS_TICK, TOOLTIP_STYLE, useAxisDensity } from '@/lib/chart';

/**
 * Wykres świecowy.
 *
 * Recharts nie ma świec, więc składamy je z dwóch nałożonych serii słupkowych:
 * cienki słupek od minimum do maksimum (knot) i gruby od otwarcia do zamknięcia
 * (korpus). Obie są typu `Bar` z bazą przesuniętą tak, żeby słupek zaczynał się
 * nad zerem — stąd pary [dół, góra] zamiast pojedynczych wartości.
 */

interface CandleDatum {
  date: string;
  wick: [number, number];
  body: [number, number];
  bullish: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  sma50: number | null;
  sma200: number | null;
}

export function CandlestickChart({
  candles,
  sma50,
  sma200,
}: {
  candles: Candle[];
  sma50: (number | null)[];
  sma200: (number | null)[];
}) {
  const { minTickGap, yAxisWidth } = useAxisDensity();
  const data: CandleDatum[] = candles.map((candle, index) => {
    const open = candle.openE8 / 1e8;
    const close = candle.closeE8 / 1e8;
    const high = candle.highE8 / 1e8;
    const low = candle.lowE8 / 1e8;

    return {
      date: candle.date,
      wick: [low, high],
      // Świeca doji ma zerową wysokość korpusu i byłaby niewidoczna — dajemy
      // jej minimalną grubość, żeby dzień bez zmiany ceny nie zniknął z wykresu.
      body: open === close ? [open, open + (high - low) * 0.002 || open] : [Math.min(open, close), Math.max(open, close)],
      bullish: close >= open,
      open,
      high,
      low,
      close,
      sma50: sma50[index] === null || sma50[index] === undefined ? null : sma50[index]! / 1e8,
      sma200: sma200[index] === null || sma200[index] === undefined ? null : sma200[index]! / 1e8,
    };
  });

  if (data.length === 0) {
    return <p className="px-4 pb-4 pt-2 text-sm text-content-muted">Brak notowań do pokazania.</p>;
  }

  const low = Math.min(...data.map((d) => d.low));
  const high = Math.max(...data.map((d) => d.high));
  const padding = (high - low) * 0.05;

  return (
    <div className="chart-box-lg px-2 pb-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            minTickGap={minTickGap}
          />
          <YAxis
            domain={[low - padding, high + padding]}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
            // Bez formatowania Recharts wypisuje pełną precyzję zmiennoprzecinkową
            // („85.498236"), co przy wąskiej osi zlewa się w nieczytelny ciąg cyfr.
            tickFormatter={(value: number) => value.toFixed(value >= 100 ? 0 : 2)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(label: string) => formatDate(label)}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const datum = payload[0]?.payload as CandleDatum | undefined;
              if (!datum) return null;
              return (
                <div className="rounded-md border border-surface-border bg-surface-overlay px-3 py-2 text-2xs">
                  <div className="mb-1 font-medium">{formatDate(String(label))}</div>
                  <div className="tabular grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span className="text-content-muted">Otwarcie</span>
                    <span className="text-right">{datum.open.toFixed(2)}</span>
                    <span className="text-content-muted">Maksimum</span>
                    <span className="text-right">{datum.high.toFixed(2)}</span>
                    <span className="text-content-muted">Minimum</span>
                    <span className="text-right">{datum.low.toFixed(2)}</span>
                    <span className="text-content-muted">Zamknięcie</span>
                    <span className={`text-right ${datum.bullish ? 'text-gain' : 'text-loss'}`}>
                      {datum.close.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            }}
          />

          {/* Knot: cienki słupek od minimum do maksimum. */}
          <Bar dataKey="wick" barSize={1} isAnimationActive={false}>
            {data.map((datum, index) => (
              <Cell key={index} fill={datum.bullish ? 'rgb(var(--gain))' : 'rgb(var(--loss))'} />
            ))}
          </Bar>

          {/* Korpus: od otwarcia do zamknięcia. */}
          <Bar dataKey="body" barSize={Math.max(2, Math.min(9, Math.floor(600 / data.length)))} isAnimationActive={false}>
            {data.map((datum, index) => (
              <Cell key={index} fill={datum.bullish ? 'rgb(var(--gain))' : 'rgb(var(--loss))'} />
            ))}
          </Bar>

          <Line type="monotone" dataKey="sma50" stroke="#fbbf24" dot={false} strokeWidth={1} connectNulls name="SMA 50" />
          <Line type="monotone" dataKey="sma200" stroke="#a78bfa" dot={false} strokeWidth={1} connectNulls name="SMA 200" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
