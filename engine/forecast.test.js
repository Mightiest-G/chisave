import test from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween, velocity, forecastItem, forecastInventory,
  valueAtRisk, recoverableValue,
} from "./forecast.js";

const TODAY = "2026-11-23";
const sales = (perDay, days = 14) =>
  Array.from({ length: days }, (_, i) => ({
    date: `2026-11-${String(10 + i).padStart(2, "0")}`, qty: perDay,
  }));

test("daysBetween counts calendar days", () => {
  assert.equal(daysBetween("2026-11-23", "2026-11-26"), 3);
  assert.equal(daysBetween("2026-11-23", "2026-11-23"), 0);
  assert.equal(daysBetween("2026-11-23", "2026-11-22"), -1);
});

test("velocity averages over the window", () => {
  assert.equal(velocity(sales(2)), 2);
  assert.equal(velocity([]), 0);
  assert.equal(velocity(sales(1, 7), 7), 1);
});

test("velocity uses days actually covered for new items", () => {
  // 3 days of sales at 6/day, ending today: velocity is 6, not 18/14.
  const short = [
    { date: "2026-11-21", qty: 6 },
    { date: "2026-11-22", qty: 6 },
    { date: "2026-11-23", qty: 6 },
  ];
  assert.equal(velocity(short, 14, TODAY), 6);
  // Sales older than the window do not count.
  const stale = [
    { date: "2026-11-01", qty: 100 },
    { date: "2026-11-23", qty: 2 },
  ];
  assert.equal(velocity(stale, 14, TODAY), 2);
});

test("fast seller needs no markdown", () => {
  const f = forecastItem({
    onHand: 10, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(5),
  }, TODAY);
  assert.equal(f.status, "ok");
  assert.equal(f.predictedLeftover, 0);
});

test("slow seller 2 days out gets 25% off", () => {
  const f = forecastItem({
    onHand: 20, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY);
  assert.equal(f.status, "markdown");
  assert.equal(f.markdownPct, 25);
  assert.equal(f.markdownPrice, 3.00);
  assert.equal(f.predictedLeftover, 16);
});

test("1 day out gets 50% off", () => {
  const f = forecastItem({
    onHand: 10, price: 5.00, expiryISO: "2026-11-24",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY);
  assert.equal(f.markdownPct, 50);
  assert.equal(f.markdownPrice, 2.50);
});

test("3 days out gets 10% off", () => {
  const f = forecastItem({
    onHand: 30, price: 3.00, expiryISO: "2026-11-26",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY);
  assert.equal(f.markdownPct, 10);
});

test("estimate dates lose a safety day", () => {
  // Printed: 3 days left -> 10%. Estimate: same date counts as 2 -> 25%.
  const base = {
    onHand: 20, price: 4.00, expiryISO: "2026-11-26",
    isUseBy: false, sales: sales(2),
  };
  assert.equal(forecastItem({ ...base, dateSource: "printed" }, TODAY).markdownPct, 10);
  assert.equal(forecastItem({ ...base, dateSource: "estimate" }, TODAY).markdownPct, 25);
});

test("past date is expired, never discounted", () => {
  const f = forecastItem({
    onHand: 5, price: 4.00, expiryISO: "2026-11-22",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY);
  assert.equal(f.status, "expired");
  assert.equal(f.markdownPct, 0);
});

test("past USE-BY date is a hard stop", () => {
  const f = forecastItem({
    onHand: 5, price: 4.00, expiryISO: "2026-11-22",
    isUseBy: true, dateSource: "printed", sales: sales(2),
  }, TODAY);
  assert.equal(f.status, "useby-stop");
  assert.equal(f.markdownPct, 0);
});

test("learning: wasted last time starts one rung deeper", () => {
  // 2 days out is normally 25%; after a wasted markdown it starts at 50%.
  const f = forecastItem({
    onHand: 20, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 25, lastOutcome: "wasted" });
  assert.equal(f.markdownPct, 50);
  assert.equal(f.learned, true);
  assert.match(f.reason, /didn't clear/);
});

test("learning: cleared easily at 10% starts one rung gentler", () => {
  const f = forecastItem({
    onHand: 20, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 10, lastOutcome: "cleared" });
  assert.equal(f.markdownPct, 10);
  assert.equal(f.learned, true);
});

test("learning: only cleared at 50% starts deeper", () => {
  const f = forecastItem({
    onHand: 20, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 50, lastOutcome: "cleared" });
  assert.equal(f.markdownPct, 50);
});

test("learning: cleared at 25% keeps the standard ladder", () => {
  const f = forecastItem({
    onHand: 20, price: 4.00, expiryISO: "2026-11-25",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 25, lastOutcome: "cleared" });
  assert.equal(f.markdownPct, 25);
  assert.equal(f.learned, false);
});

test("learning: shift never goes past the ends of the ladder", () => {
  // 1 day out is already 50%; a wasted history can't push it past 50%.
  const deep = forecastItem({
    onHand: 10, price: 5.00, expiryISO: "2026-11-24",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 50, lastOutcome: "wasted" });
  assert.equal(deep.markdownPct, 50);
  // 3 days out is 10%; an easy clear can't push it below 10%.
  const shallow = forecastItem({
    onHand: 30, price: 3.00, expiryISO: "2026-11-26",
    isUseBy: false, dateSource: "printed", sales: sales(2),
  }, TODAY, { lastPct: 10, lastOutcome: "cleared" });
  assert.equal(shallow.markdownPct, 10);
});

test("learning: forecastInventory applies per-product learning", () => {
  const rows = forecastInventory([
    { name: "waster", onHand: 20, price: 4, expiryISO: "2026-11-25",
      isUseBy: false, dateSource: "printed", sales: sales(2) },
    { name: "easy", onHand: 20, price: 4, expiryISO: "2026-11-25",
      isUseBy: false, dateSource: "printed", sales: sales(2) },
  ], TODAY, {
    waster: { lastPct: 25, lastOutcome: "wasted" },
    easy: { lastPct: 10, lastOutcome: "cleared" },
  });
  assert.equal(rows.find((r) => r.name === "waster").forecast.markdownPct, 50);
  assert.equal(rows.find((r) => r.name === "easy").forecast.markdownPct, 10);
});

test("inventory sorts markdowns first, value math adds up", () => {
  const rows = forecastInventory([
    { name: "fast", onHand: 10, price: 4, expiryISO: "2026-11-25",
      isUseBy: false, dateSource: "printed", sales: sales(5) },
    { name: "slow", onHand: 20, price: 4, expiryISO: "2026-11-25",
      isUseBy: false, dateSource: "printed", sales: sales(2) },
  ], TODAY);
  assert.equal(rows[0].name, "slow");
  assert.equal(rows[1].name, "fast");
  assert.equal(valueAtRisk(rows), 64);
  assert.equal(recoverableValue(rows), 48);
});
