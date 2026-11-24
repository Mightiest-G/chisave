// ChiSave sync service — Cloudflare Worker + D1.
//
// One small backend that unlocks three things:
//   1. Same stock on two phones — the store's phones share inventory,
//      regulars, activity and learning through POST /sync.
//   2. Deals that send themselves at 9am — the worker's hourly check sends
//      the day's deals to every regular by text (Twilio).
//   3. A public deals page — GET /deals?store=<id> shows today's markdowns,
//      so the store can post the link on Facebook instead of texting.
//
// Sync rules (pilot-grade, say so plainly): last-write-wins PER LIST. The
// first phone to connect claims the store with a secret code it makes up;
// every other phone joins with the same code. The secret is stored as-is
// in D1 — before real multi-store use, hash it and add per-store auth.
//
// The forecast engine below is a COPY of engine/forecast.js (the app's
// copy). Keep the two in step: same ladder, same safety day, same learning.
//
// Deploy (needs a Cloudflare account — NOT deployed yet):
//   1. wrangler login (or CLOUDFLARE_API_TOKEN in the terminal)
//   2. wrangler d1 create chisave-sync
//      -> paste the database_id it prints into wrangler.toml
//   3. wrangler d1 execute chisave-sync --file=server/schema.sql
//   4. wrangler deploy
//   5. Paste the worker URL into ChiSave Settings ("Sync service web address").
//   For the 9am texts, also set the Twilio secrets (same values as the
//   twilio-send worker):
//     wrangler secret put TWILIO_ACCOUNT_SID
//     wrangler secret put TWILIO_AUTH_TOKEN
//     wrangler secret put TWILIO_FROM
//   Without them the worker still syncs and serves the deals page; it just
//   never sends a text.

// ---- forecast engine (copy of engine/forecast.js) ----
const MARKDOWN_LADDER = [
  { daysLeft: 3, pct: 10 },
  { daysLeft: 2, pct: 25 },
  { daysLeft: 1, pct: 50 },
];
function normName(name) {
  return String(name || "").toLowerCase().split(",")[0].trim();
}
function daysBetween(aISO, bISO) {
  const ms = Date.parse(bISO + "T00:00:00Z") - Date.parse(aISO + "T00:00:00Z");
  return Math.round(ms / 86400000);
}
function velocity(sales, windowDays = 14, todayISO) {
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
function learnShift(learning) {
  if (!learning) return 0;
  if (learning.lastOutcome === "wasted") return 1;
  if (learning.lastOutcome === "cleared") {
    if (learning.lastPct >= 50) return 1;
    if (learning.lastPct <= 10) return -1;
  }
  return 0;
}
function forecastItem(item, todayISO, learning) {
  const rawDays = daysBetween(todayISO, item.expiryISO);
  const margin = item.dateSource === "estimate" ? 1 : 0;
  const daysLeft = rawDays - margin;
  if (rawDays <= 0) {
    return {
      status: item.isUseBy ? "useby-stop" : "expired",
      daysLeft: rawDays, effectiveDaysLeft: daysLeft,
      predictedLeftover: item.onHand, markdownPct: 0, markdownPrice: item.price,
    };
  }
  const vel = velocity(item.sales, 14, todayISO);
  const predictedLeftover = Math.max(0, item.onHand - vel * Math.max(0, daysLeft));
  if (predictedLeftover <= 0 || daysLeft > 3) {
    return { status: "ok", daysLeft: rawDays, effectiveDaysLeft: daysLeft, predictedLeftover, markdownPct: 0, markdownPrice: item.price };
  }
  let baseIdx = MARKDOWN_LADDER.length - 1;
  for (let i = 0; i < MARKDOWN_LADDER.length; i++) {
    if (MARKDOWN_LADDER[i].daysLeft >= daysLeft) baseIdx = i;
  }
  const idx = Math.min(MARKDOWN_LADDER.length - 1, Math.max(0, baseIdx + learnShift(learning)));
  const pct = MARKDOWN_LADDER[idx].pct;
  return {
    status: "markdown", daysLeft: rawDays, effectiveDaysLeft: daysLeft,
    predictedLeftover, markdownPct: pct,
    markdownPrice: +(item.price * (1 - pct / 100)).toFixed(2),
  };
}
function forecastInventory(items, todayISO, learningMap) {
  return items
    .map((item) => ({
      ...item,
      forecast: forecastItem(item, todayISO,
        learningMap ? learningMap[normName(item.name)] || null : null),
    }))
    .sort((a, b) => {
      const rank = (s) => ({ markdown: 0, expired: 1, "useby-stop": 1, ok: 2 })[s];
      return rank(a.forecast.status) - rank(b.forecast.status)
        || a.forecast.daysLeft - b.forecast.daysLeft;
    });
}

// ---- Chicago time (the worker runs on UTC; the store runs on Chicago time) ----
// `now` is a test seam: the scheduled handler passes the real clock.
function chicagoParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: +get("hour") % 24 };
}

// ---- storage helpers ----
const KINDS = ["inventory", "regulars", "activity", "learning", "meta"];
async function readKind(env, storeId, kind) {
  const row = await env.DB.prepare(
    "SELECT data, updated_at FROM kinds WHERE store_id = ? AND kind = ?")
    .bind(storeId, kind).first();
  return row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
}
async function writeKind(env, storeId, kind, data, updatedAt) {
  await env.DB.prepare(
    `INSERT INTO kinds (store_id, kind, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(store_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(storeId, kind, JSON.stringify(data), updatedAt).run();
}
async function loadStore(env, storeId) {
  const out = {};
  for (const kind of KINDS) out[kind] = await readKind(env, storeId, kind);
  return out;
}
function todaysDeals(store) {
  const inventory = store.inventory ? store.inventory.data : null;
  if (!inventory) return { storeName: "our store", deals: [] };
  const learning = store.learning ? store.learning.data : {};
  const storeName = (store.meta && store.meta.data && store.meta.data.storeName) || "our store";
  const today = chicagoParts().date;
  const deals = forecastInventory(inventory, today, learning)
    .filter((r) => r.forecast.status === "markdown" && !r.applied)
    .map((r) => ({
      name: r.name, pct: r.forecast.markdownPct,
      was: r.price, now: r.forecast.markdownPrice,
    }));
  return { storeName, deals };
}
function dealText(storeName, deals) {
  const lines = deals.map((d) => `• ${d.name} ${d.pct}% off (was $${d.was.toFixed(2)}, now $${d.now.toFixed(2)})`);
  return `Today only at ${storeName} — fresh food, marked down before its date:\n`
    + lines.join("\n") + "\nWhile it lasts, today only.";
}
async function sendSms(env, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  return res.ok;
}

// ---- routes ----
async function handleSync(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const storeId = String(body.storeId || "").trim();
  if (!storeId || !secret) return new Response("missing store/secret", { status: 400 });
  const row = await env.DB.prepare(
    "SELECT secret FROM store_secrets WHERE store_id = ?").bind(storeId).first();
  if (!row) {
    // First phone to connect claims the store with its secret.
    await env.DB.prepare(
      "INSERT INTO store_secrets (store_id, secret) VALUES (?, ?)").bind(storeId, secret).run();
  } else if (row.secret !== secret) {
    return new Response("wrong sync code", { status: 401 });
  }
  const merged = {};
  for (const kind of KINDS) {
    const incoming = body.state && body.state[kind];
    const stored = await readKind(env, storeId, kind);
    let keep = stored;
    if (incoming && (!keep || (incoming.updatedAt || 0) >= keep.updatedAt)) {
      keep = { data: incoming.data, updatedAt: incoming.updatedAt || Date.now() };
      await writeKind(env, storeId, kind, keep.data, keep.updatedAt);
    }
    if (keep) merged[kind] = keep;
  }
  return new Response(JSON.stringify({ state: merged }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleDeals(request, env) {
  const storeId = new URL(request.url).searchParams.get("store") || "";
  const store = await loadStore(env, storeId);
  const { storeName, deals } = todaysDeals(store);
  const today = chicagoParts().date;
  const rows = deals.length
    ? deals.map((d) => `<li><b>${d.name}</b> — ${d.pct}% off, <s>$${d.was.toFixed(2)}</s> <b>$${d.now.toFixed(2)}</b></li>`).join("")
    : `<li>Nothing marked down today — everything is selling through fine.</li>`;
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Today's deals — ${storeName}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px">`
    + `<h1>Today's deals — ${storeName}</h1><p>Fresh food, marked down before its date. ${today}, today only, while it lasts.</p><ul>${rows}</ul>`
    + `<p><small>ChiSave — deals update every morning.</small></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleScheduled(env, now = new Date()) {
  // Runs every hour; only acts at 9am Chicago time, once a day per store.
  if (chicagoParts(now).hour !== 9) return;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) return;
  const today = chicagoParts(now).date;
  const stores = await env.DB.prepare("SELECT store_id FROM store_secrets").all();
  for (const { store_id } of stores.results || []) {
    const marker = await readKind(env, store_id, "last_deal_send");
    if (marker && marker.data.date === today) continue;
    const store = await loadStore(env, store_id);
    const { storeName, deals } = todaysDeals(store);
    const regulars = store.regulars ? store.regulars.data : [];
    if (deals.length && regulars.length) {
      const text = dealText(storeName, deals);
      for (const reg of regulars) {
        if (reg.phone) await sendSms(env, reg.phone, text);
      }
    }
    await writeKind(env, store_id, "last_deal_send", { date: today, sent: deals.length }, Date.now());
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") return handleSync(request, env);
    if (request.method === "GET" && url.pathname === "/deals") return handleDeals(request, env);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("chisave sync: ok — POST /sync, GET /deals?store=<id>");
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};

// Test seam: pure helpers + the scheduled handler with an injectable clock.
export const __test = { chicagoParts, todaysDeals, dealText, handleScheduled };
