import { and, desc, eq, gte } from 'drizzle-orm';
import { ALERT_KIND_LABELS, changeBp, formatMinor } from '@portfolio/shared';
import type { AlertKind, Position } from '@portfolio/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { alertEvents, alerts, bondHoldings, instruments, newsItems, portfolios, reportDates } from '../db/schema.js';
import { addDays, nowIso, today } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import { activePortfolioIds, buildPositions } from './positions.js';
import { getLatestPrice } from './prices.js';
import { buildPlan } from './rebalance.js';
import { loadTargets } from './targets.js';
import { getSetting } from './settings.js';
import { escapeHtml, sendTelegramMessage } from './telegram.js';

const log = createLogger('alerts');

/**
 * Kontrola alertów i wysyłka powiadomień.
 *
 * Każdy wykryty warunek zapisuje się jako zdarzenie w bazie niezależnie od
 * tego, czy udało się wysłać powiadomienie — dzięki temu historia alertów
 * jest kompletna także bez skonfigurowanego Telegrama.
 */

interface TriggeredAlert {
  alertId: number | null;
  kind: AlertKind;
  message: string;
  payload: Record<string, unknown>;
}

/** Czy alert nie jest jeszcze w okresie wyciszenia. */
function isCooledDown(lastTriggeredAt: string | null, cooldownMinutes: number): boolean {
  if (!lastTriggeredAt) return true;
  const elapsedMinutes = (Date.now() - Date.parse(lastTriggeredAt)) / 60_000;
  return elapsedMinutes >= cooldownMinutes;
}

export async function evaluateAlerts(): Promise<string> {
  const triggered: TriggeredAlert[] = [];
  const portfolioIds = activePortfolioIds();
  const { positions, cashByPortfolio } = buildPositions(portfolioIds);
  const positionByInstrument = new Map(positions.map((p) => [p.instrument.id, p]));

  const definitions = db.select().from(alerts).where(eq(alerts.enabled, true)).all();

  for (const alert of definitions) {
    if (!isCooledDown(alert.lastTriggeredAt, alert.cooldownMinutes)) continue;

    const condition = alert.condition ?? {};
    let hit: TriggeredAlert | null = null;

    switch (alert.kind as AlertKind) {
      case 'price':
        hit = checkPrice(alert.id, alert.instrumentId, condition);
        break;
      case 'daily_move':
        hit = checkDailyMove(alert.id, alert.instrumentId, condition, positions);
        break;
      case 'report_date':
        hit = checkReportDate(alert.id, alert.instrumentId, condition);
        break;
      case 'news':
        hit = checkNews(alert.id, alert.instrumentId);
        break;
      default:
        break;
    }

    if (hit) {
      triggered.push(hit);
      db.update(alerts).set({ lastTriggeredAt: nowIso() }).where(eq(alerts.id, alert.id)).run();
    }
  }

  // Alerty globalne nie mają definicji w tabeli — wynikają z ustawień i danych.
  triggered.push(...checkAllocationDrift(portfolioIds, positions, cashByPortfolio));
  triggered.push(...checkBondMaturity());

  if (triggered.length === 0) return 'brak nowych alertów';

  let delivered = 0;
  for (const item of triggered) {
    const event = db
      .insert(alertEvents)
      .values({
        alertId: item.alertId,
        kind: item.kind,
        message: item.message,
        payload: item.payload,
        delivered: false,
      })
      .returning()
      .get();

    if (!isKindEnabled(item.kind)) continue;

    const result = await sendTelegramMessage(
      `<b>${escapeHtml(ALERT_KIND_LABELS[item.kind])}</b>\n${escapeHtml(item.message)}`,
    );

    db.update(alertEvents)
      .set({ delivered: result.delivered, deliveryError: result.error })
      .where(eq(alertEvents.id, event.id))
      .run();

    if (result.delivered) delivered += 1;
  }

  log.info(`Wykryto ${triggered.length} alertów, wysłano ${delivered}`);
  return `wykryto ${triggered.length}, wysłano ${delivered}`;
}

function isKindEnabled(kind: AlertKind): boolean {
  const notifications = getSetting<Record<string, boolean>>('notifications', {});
  return notifications[kind] !== false;
}

/**
 * Alert cenowy czyta notowanie wprost z cache'u cen, a nie z listy pozycji.
 *
 * Instrument z watchlisty nie ma pozycji w portfelu — opieranie się na
 * `buildPositions` sprawiało, że alert dla obserwowanej, ale jeszcze
 * niekupionej spółki nigdy się nie odpalał.
 */
function checkPrice(
  alertId: number,
  instrumentId: number | null,
  condition: Record<string, unknown>,
): TriggeredAlert | null {
  if (!instrumentId) return null;

  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return null;

  const latest = getLatestPrice(instrumentId, instrument.currency);
  if (!latest) return null;

  const above = typeof condition.above === 'number' ? condition.above : null;
  const below = typeof condition.below === 'number' ? condition.below : null;
  const price = latest.priceE8 / 1e8;

  if (above !== null && price >= above) {
    return {
      alertId,
      kind: 'price',
      message: `${instrument.symbol}: cena ${price.toFixed(2)} ${latest.currency} przekroczyła próg ${above}.`,
      payload: { instrumentId, price, threshold: above, direction: 'above' },
    };
  }
  if (below !== null && price <= below) {
    return {
      alertId,
      kind: 'price',
      message: `${instrument.symbol}: cena ${price.toFixed(2)} ${latest.currency} spadła poniżej progu ${below}.`,
      payload: { instrumentId, price, threshold: below, direction: 'below' },
    };
  }
  return null;
}

function checkDailyMove(
  alertId: number,
  instrumentId: number | null,
  condition: Record<string, unknown>,
  positions: Position[],
): TriggeredAlert | null {
  const thresholdBp =
    typeof condition.thresholdBp === 'number'
      ? condition.thresholdBp
      : getSetting<number>('dailyMoveThresholdBp', 500);

  const candidates = instrumentId ? positions.filter((p) => p.instrument.id === instrumentId) : positions;

  for (const position of candidates) {
    if (position.dayChangeBp === null) continue;
    if (Math.abs(position.dayChangeBp) < thresholdBp) continue;

    const direction = position.dayChangeBp > 0 ? 'wzrosła' : 'spadła';
    return {
      alertId,
      kind: 'daily_move',
      message:
        `${position.instrument.symbol}: pozycja ${direction} dziś o ` +
        `${(Math.abs(position.dayChangeBp) / 100).toFixed(2)}% ` +
        `(${formatMinor(position.dayChangePlnMinor ?? 0)} zł).`,
      payload: { instrumentId: position.instrument.id, dayChangeBp: position.dayChangeBp },
    };
  }
  return null;
}

function checkReportDate(
  alertId: number,
  instrumentId: number | null,
  condition: Record<string, unknown>,
): TriggeredAlert | null {
  const daysAhead = typeof condition.daysAhead === 'number' ? condition.daysAhead : 7;
  const from = today(config.timezone);
  const to = addDays(from, daysAhead);

  const rows = db
    .select()
    .from(reportDates)
    .where(and(gte(reportDates.date, from), instrumentId ? eq(reportDates.instrumentId, instrumentId) : undefined))
    .all()
    .filter((r) => r.date <= to);

  const upcoming = rows[0];
  if (!upcoming) return null;

  const instrument = db.select().from(instruments).where(eq(instruments.id, upcoming.instrumentId)).get();
  return {
    alertId,
    kind: 'report_date',
    message: `${instrument?.symbol ?? 'Instrument'}: ${upcoming.label} zaplanowany na ${upcoming.date}.`,
    payload: { instrumentId: upcoming.instrumentId, date: upcoming.date },
  };
}

function checkNews(alertId: number, instrumentId: number | null): TriggeredAlert | null {
  const since = addDays(today(config.timezone), -1);
  const rows = db
    .select()
    .from(newsItems)
    .where(
      and(
        eq(newsItems.importance, 'signal'),
        gte(newsItems.publishedAt, since),
        instrumentId ? eq(newsItems.instrumentId, instrumentId) : undefined,
      ),
    )
    .orderBy(desc(newsItems.publishedAt))
    .limit(1)
    .all();

  const item = rows[0];
  if (!item) return null;

  return {
    alertId,
    kind: 'news',
    message: `${item.title}\n${item.aiSummaryPl ?? ''}\n${item.url}`.trim(),
    payload: { newsId: item.id, instrumentId: item.instrumentId },
  };
}

/**
 * Odchylenie alokacji sprawdzamy globalnie, bez definicji w tabeli alertów —
 * cele i tolerancje są już zapisane w `target_allocations`.
 */
function checkAllocationDrift(
  portfolioIds: number[],
  positions: Position[],
  cashByPortfolio: Map<number, number>,
): TriggeredAlert[] {
  if (!isKindEnabled('allocation_drift')) return [];

  const targets = loadTargets(portfolioIds.length === 1 ? portfolioIds[0]! : null, 'asset_class');
  if (targets.length === 0) return [];

  const cash = [...cashByPortfolio.values()].reduce((sum, v) => sum + v, 0);
  const plan = buildPlan(
    { positions, cashPlnMinor: cash, targets, dimension: 'asset_class', contributionPlnMinor: 0 },
    'full',
  );

  const breached = plan.actions.filter((a) => !a.withinTolerance);
  if (breached.length === 0) return [];

  // Jedno zbiorcze powiadomienie zamiast osobnego dla każdej klasy aktywów.
  const lines = breached.map(
    (a) =>
      `• ${a.label}: ${(a.currentShareBp / 100).toFixed(1)}% wobec celu ${(a.targetShareBp / 100).toFixed(1)}%`,
  );

  return [
    {
      alertId: null,
      kind: 'allocation_drift',
      message: `Alokacja odbiega od celu:\n${lines.join('\n')}`,
      payload: { breached: breached.map((a) => a.key) },
    },
  ];
}

/**
 * Zbliżający się wykup obligacji detalicznej.
 *
 * Termin jest znany z góry z parametrów emisji, więc nie wymaga żadnego
 * zewnętrznego źródła — wystarczy przypomnieć zawczasu, żeby zdążyć
 * zdecydować o zamianie na nową emisję.
 */
const BOND_MATURITY_NOTICE_DAYS = 30;

function checkBondMaturity(): TriggeredAlert[] {
  if (!isKindEnabled('report_date')) return [];

  const day = today(config.timezone);
  const horizon = addDays(day, BOND_MATURITY_NOTICE_DAYS);
  const portfolioNames = new Map(db.select().from(portfolios).all().map((p) => [p.id, p.name]));

  return db
    .select()
    .from(bondHoldings)
    .all()
    .filter((bond) => bond.redeemedAt === null && bond.maturityDate >= day && bond.maturityDate <= horizon)
    .map((bond) => ({
      alertId: null,
      kind: 'report_date' as AlertKind,
      message:
        `Obligacje ${bond.series} (${portfolioNames.get(bond.portfolioId) ?? 'portfel'}) ` +
        `zapadają ${bond.maturityDate}. Zdecyduj o wykupie albo zamianie na nową emisję.`,
      payload: { bondId: bond.id, maturityDate: bond.maturityDate },
    }));
}

/** Ostatnie zdarzenia — feed w interfejsie. */
export function recentAlertEvents(limit = 50) {
  return db.select().from(alertEvents).orderBy(desc(alertEvents.triggeredAt)).limit(limit).all();
}

export function changeBpFor(now: number, base: number): number | null {
  return changeBp(now, base);
}
