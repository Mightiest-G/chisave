/**
 * ChiSave forecast engine — pure functions, no I/O.
 *
 * Rules (from the Chicago-stores research, 2026-11-23):
 *  - sell-through velocity = units sold per day over the recent window
 *  - predicted leftover = on hand - velocity * days left to expiry
 *  - markdown ladder: 10% at 3 days out, 25% at 2 days, 50% at 1 day
 *  - a USE-BY date is a hard stop: never discount past it, never sell past it
 *  - estimates (from the USDA table, not a printed date) lose one extra day
 *    of safety margin, because the date itself is uncertain
 *
 * All dates are ISO yyyy-mm-dd. "Today" is passed in so tests are stable.
 */

export const MARKDOWN_LADDER = [
  { daysLeft: 3, pct: 10 },
  { daysLeft: 2, pct: 25 },
  { daysLeft: 1, pct: 50 },
];

/** Days between two ISO dates (b - a). */
export function daysBetween(aISO, bISO) {
  const ms = Date.parse(bISO + "T00:00:00Z") - Date.parse(aISO + "T00:00:00Z");
  return Math.round(ms / 86400000);
}

/** Units per day over the sales window.
 * `sales` is [{date, qty}]. With todayISO given, only sales inside the
 * window count, and the divisor is the number of days actually covered —
 * a new item with 3 days of history is judged on those 3 days, not
 * diluted across 14. Without todayISO, divides by windowDays. */
export function velocity(sales, windowDays = 14, todayISO) {
  if (!sales || sales.length === 0) return 0;
  let rows = sales;
  let days = windowDays;
  if (todayISO) {
    rows = sales.filter((r) => {
      const back = daysBetween(r.date, todayISO);
      return back >= 0 && back < windowDays;
    });
    if (rows.length === 0) return 0;
    const earliest = rows.reduce((a, b) => (a.date < b.date ? a : b)).date;
    days = Math.min(windowDays, daysBetween(earliest, todayISO) + 1);
  }
  const total = rows.reduce((s, r) => s + (r.qty || 0), 0);
  return total / Math.max(1, days);
}

/**
 * One item's forecast.
 * item: { onHand, price, expiryISO, isUseBy, dateSource: 'printed'|'estimate'|'supplier', sales }
 * Returns { status, daysLeft, effectiveDaysLeft, predictedLeftover, markdownPct,
 *           markdownPrice, reason }.
 * status: 'ok' | 'markdown' | 'expired' | 'useby-stop'
 */
export function forecastItem(item, todayISO) {
  const rawDays = daysBetween(todayISO, item.expiryISO);
  // Estimates lose a day: the date itself is uncertain, so act early.
  const margin = item.dateSource === "estimate" ? 1 : 0;
  const daysLeft = rawDays - margin;

  if (rawDays <= 0) {
    return {
      status: item.isUseBy ? "useby-stop" : "expired",
      daysLeft: rawDays, effectiveDaysLeft: daysLeft,
      predictedLeftover: item.onHand, markdownPct: 0, markdownPrice: item.price,
      reason: item.isUseBy
        ? "Past its USE-BY date — pull it, never sell or discount it."
        : "Past its date — pull it or return it, do not discount it.",
    };
  }

  const vel = velocity(item.sales, 14, todayISO);
  const predictedLeftover = Math.max(
    0, item.onHand - vel * Math.max(0, daysLeft));

  if (predictedLeftover <= 0 || daysLeft > 3) {
    return {
      status: "ok", daysLeft: rawDays, effectiveDaysLeft: daysLeft,
      predictedLeftover, markdownPct: 0, markdownPrice: item.price,
      reason: predictedLeftover <= 0
        ? "Selling fast enough to clear before the date."
        : "More than 3 days left — too early to mark down.",
    };
  }

  // Tightest rung that still covers the days left: 2 days out is the 25%
  // rung, not the 10% rung (which is for 3 days out).
  const rung = MARKDOWN_LADDER.filter((r) => daysLeft <= r.daysLeft).pop()
    || MARKDOWN_LADDER[MARKDOWN_LADDER.length - 1];
  const pct = rung.pct;
  return {
    status: "markdown", daysLeft: rawDays, effectiveDaysLeft: daysLeft,
    predictedLeftover, markdownPct: pct,
    markdownPrice: +(item.price * (1 - pct / 100)).toFixed(2),
    reason: `About ${Math.ceil(predictedLeftover)} unit(s) will be left over. `
      + `${pct}% off clears more of it before the date.`,
  };
}

/** Run the forecast over a whole inventory. Returns items sorted: markdowns first. */
export function forecastInventory(items, todayISO) {
  return items
    .map((item) => ({ ...item, forecast: forecastItem(item, todayISO) }))
    .sort((a, b) => {
      const rank = (s) => ({ markdown: 0, expired: 1, "useby-stop": 1, ok: 2 })[s];
      return rank(a.forecast.status) - rank(b.forecast.status)
        || a.forecast.daysLeft - b.forecast.daysLeft;
    });
}

/** Money at risk: value of units predicted to be left over at full price. */
export function valueAtRisk(rows) {
  return +rows.reduce(
    (s, r) => s + r.forecast.predictedLeftover * r.price, 0).toFixed(2);
}

/** Money the markdown list could recover if the marked-down units sell. */
export function recoverableValue(rows) {
  return +rows
    .filter((r) => r.forecast.status === "markdown")
    .reduce((s, r) => s + r.forecast.predictedLeftover
      * r.forecast.markdownPrice, 0).toFixed(2);
}
