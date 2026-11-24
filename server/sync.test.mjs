// Unit tests for the ChiSave sync worker. Run from the repo root:
//   node --test server/sync.test.mjs
// D1 is mocked with in-memory maps; Twilio is mocked by stubbing fetch.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "./chisave-sync.js";

function mockDb() {
  const kinds = new Map(); // "store|kind" -> { data, updated_at }
  const secrets = new Map();
  return {
    kinds, secrets,
    prepare(sql) {
      const bound = (...params) => ({
        async first() {
          if (sql.includes("FROM store_secrets")) {
            const s = secrets.get(params[0]);
            return s ? { secret: s } : null;
          }
          if (sql.includes("FROM kinds")) {
            const k = kinds.get(params[0] + "|" + params[1]);
            return k ? { data: k.data, updated_at: k.updated_at } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM store_secrets")) {
            return { results: [...secrets.keys()].map((store_id) => ({ store_id })) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INTO store_secrets")) secrets.set(params[0], params[1]);
          else if (sql.includes("INTO kinds")) {
            kinds.set(params[0] + "|" + params[1], { data: params[2], updated_at: params[3] });
          }
        },
      });
      // D1 lets some queries run without .bind() (e.g. SELECT with no params).
      return { bind: bound, ...bound() };
    },
  };
}

const item = (name, onHand, expiryISO, perDay = 2) => ({
  id: "t1", name, onHand, price: 4.00, receivedISO: "2026-11-24",
  expiryISO, isUseBy: false, dateSource: "printed",
  sales: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-11-${String(10 + i).padStart(2, "0")}`, qty: perDay,
  })),
});

async function sync(env, storeId, secret, state) {
  const req = new Request("https://sync.test/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
    body: JSON.stringify({ storeId, state }),
  });
  return worker.fetch(req, env);
}

test("sync: first phone claims the store, newest list wins per kind", async () => {
  const env = { DB: mockDb() };
  const s1 = { inventory: { data: [item("Milk", 10, "2026-11-25")], updatedAt: 100 } };
  const r1 = await sync(env, "store-a", "code-1", s1);
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.state.inventory.data[0].name, "Milk");

  // Older inventory from another phone does not overwrite the newer one.
  const s2 = { inventory: { data: [item("Milk", 99, "2026-11-25")], updatedAt: 50 } };
  const b2 = await (await sync(env, "store-a", "code-1", s2)).json();
  assert.equal(b2.state.inventory.data[0].onHand, 10);

  // Newer inventory does overwrite.
  const s3 = { inventory: { data: [item("Milk", 5, "2026-11-25")], updatedAt: 200 } };
  const b3 = await (await sync(env, "store-a", "code-1", s3)).json();
  assert.equal(b3.state.inventory.data[0].onHand, 5);
});

test("sync: wrong code is rejected", async () => {
  const env = { DB: mockDb() };
  await sync(env, "store-b", "code-1", { inventory: { data: [], updatedAt: 1 } });
  const r = await sync(env, "store-b", "code-2", { inventory: { data: [], updatedAt: 2 } });
  assert.equal(r.status, 401);
});

test("sync: missing store or secret is rejected", async () => {
  const env = { DB: mockDb() };
  const r = await sync(env, "", "", {});
  assert.equal(r.status, 400);
});

test("deals page: shows today's markdowns for the store", async () => {
  const env = { DB: mockDb() };
  const today = __test.chicagoParts().date;
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  await sync(env, "store-c", "code-1", {
    inventory: { data: [item("Chicken thighs", 20, tomorrow)], updatedAt: 10 },
    meta: { data: { storeName: "Test Mart" }, updatedAt: 10 },
  });
  const res = await worker.fetch(new Request("https://sync.test/deals?store=store-c"), env);
  const html = await res.text();
  assert.match(html, /Test Mart/);
  assert.match(html, /Chicken thighs/);
  assert.match(html, /50% off/);
});

test("deals page: empty store says nothing is marked down", async () => {
  const env = { DB: mockDb() };
  const res = await worker.fetch(new Request("https://sync.test/deals?store=nobody"), env);
  const html = await res.text();
  assert.match(html, /Nothing marked down today/);
});

test("scheduled: at 9am Chicago it texts the deals once, then stops for the day", async () => {
  const env = {
    DB: mockDb(),
    TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+17735550000",
  };
  const today = __test.chicagoParts().date;
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  await sync(env, "store-d", "code-1", {
    inventory: { data: [item("Chicken thighs", 20, tomorrow)], updatedAt: 10 },
    regulars: { data: [{ name: "Ana", phone: "+17735550001" }], updatedAt: 10 },
    meta: { data: { storeName: "Test Mart" }, updatedAt: 10 },
  });
  // Find a clock reading 9am Chicago time (DST-safe: scan forward from now).
  let nine = null;
  for (let k = 0; k < 24; k++) {
    const cand = new Date(Date.now() + k * 3600e3);
    if (__test.chicagoParts(cand).hour === 9) { nine = cand; break; }
  }
  assert.ok(nine, "no 9am found in the next 24h");
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: String(opts.body) });
    return { ok: true };
  };
  try {
    await __test.handleScheduled(env, nine);
    assert.equal(calls.length, 1, "one text to the one regular");
    const sent = decodeURIComponent(calls[0].body.replace(/\+/g, " "));
    assert.match(sent, /Chicken thighs/);
    assert.match(sent, /Test Mart/);
    // Second run the same day sends nothing (marker recorded).
    await __test.handleScheduled(env, nine);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("scheduled: without Twilio configured it sends nothing", async () => {
  const env = { DB: mockDb() };
  await sync(env, "store-e", "code-1", {
    inventory: { data: [item("Chicken thighs", 20, "2026-11-25")], updatedAt: 10 },
    regulars: { data: [{ name: "Ana", phone: "+17735550001" }], updatedAt: 10 },
  });
  let nine = null;
  for (let k = 0; k < 24; k++) {
    const cand = new Date(Date.now() + k * 3600e3);
    if (__test.chicagoParts(cand).hour === 9) { nine = cand; break; }
  }
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls.push(1); return { ok: true }; };
  try {
    await __test.handleScheduled(env, nine);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
