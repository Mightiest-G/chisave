// Headless check for the built ChiSave app (jsdom). Run from the repo root:
//   node verify/verify.js
// Checks the demo baseline, the four money flows, OCR parsing, persistence,
// and that the update bar stays hidden when there is no service worker.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: "https://mightiest-g.github.io/chisave/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;
const $ = (id) => document.getElementById(id);
const txt = (id) => $(id).textContent.trim();
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

// baseline demo numbers (seeded relative to today)
check("risk $241.88", txt("statRisk").includes("241.88"), txt("statRisk"));
check("recover $130.40", txt("statRecover").includes("130.40"), txt("statRecover"));
check("7 markdowns", txt("statMarkdown") === "7", txt("statMarkdown"));
check("1 expired", txt("statExpired") === "1", txt("statExpired"));
check("update bar hidden (no service worker)", $("updateBar").style.display === "none");

// tick first markdown as applied -> $54 saved in the weekly report, count 7 -> 6
const tick = document.querySelector("[data-apply]");
check("markdown tick exists", !!tick);
if (tick) { tick.checked = true; tick.dispatchEvent(new window.Event("change", { bubbles: true })); }
check("report recovered $54.00", document.body.textContent.includes("$54.00"));
check("markdown count now 6", txt("statMarkdown") === "6", txt("statMarkdown"));

// OCR date parsing (top-level function in the app script lands on window)
if (typeof window.parsePrintedDate === "function") {
  check("OCR 11/25/2026", window.parsePrintedDate("11/25/2026") === "2026-11-25");
  check("OCR NOV 25 2026", window.parsePrintedDate("NOV 25 2026") === "2026-11-25");
  check("OCR garbage -> null", window.parsePrintedDate("hello world") === null);
} else {
  console.log("SKIP  parsePrintedDate not on window");
}

// persistence keys
const keys = Object.keys(window.localStorage);
check("localStorage has app keys", keys.some((k) => k.startsWith("chisave." )), keys.join(","));

// ---- new checks: learning, order advice, batch scan, batch text, labels, Square ----
(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const load = (seed = {}, url = "https://mightiest-g.github.io/chisave/") =>
    new JSDOM(html, {
      url, runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(window) {
        for (const [k, v] of Object.entries(seed)) {
          window.localStorage.setItem(k, JSON.stringify(v));
        }
      },
    });

  // learning is recorded when an expired item is pulled
  {
    const d = load();
    const w = d.window;
    w.confirm = () => true;
    const pull = w.document.querySelector("[data-pull]");
    check("pull button exists", !!pull);
    if (pull) pull.dispatchEvent(new w.Event("click", { bubbles: true }));
    const learned = JSON.parse(w.localStorage.getItem("chisave.learning.v1") || "{}");
    check("learning recorded on pull", learned["sour cream"] && learned["sour cream"].lastOutcome === "wasted", JSON.stringify(learned));
  }

  // order advice from seeded 30-day history
  {
    const seed = {
      "chisave.activity.v1": [
        ...Array.from({ length: 10 }, () => ({ date: today, kind: "received", label: "Chicken thighs", amount: 0, count: 1 })),
        ...Array.from({ length: 3 }, () => ({ date: today, kind: "wasted", label: "Chicken thighs — pulled expired", amount: 1, count: 1 })),
        ...Array.from({ length: 2 }, () => ({ date: today, kind: "soldout", label: "Bananas, bunch", amount: 0, count: 1 })),
      ],
    };
    const d = load(seed);
    const t = d.window.document.getElementById("orderAdvice").textContent;
    check("order less: chicken thighs (3 of 10 wasted)", t.includes("Chicken thighs") && t.includes("Order less"), t.trim().slice(0, 120));
    check("order more: bananas (sold out twice)", t.includes("Bananas, bunch") && t.includes("Order more"), t.trim().slice(0, 120));
  }

  // batch scan: same barcode twice merges into one row, onHand 2
  {
    const d = load();
    const w = d.window;
    await w.scanSessionAdd("036800123456", { name: "Test Beans", cats: [] });
    await w.scanSessionAdd("036800123456", { name: "Test Beans", cats: [] });
    const inv = JSON.parse(w.localStorage.getItem("chisave.inventory.v1"));
    const beans = inv.find((x) => x.name === "Test Beans");
    check("scan session adds item", !!beans, inv.map((x) => x.name).join(", "));
    check("scan session merges repeat scan", beans && beans.onHand === 2, beans && String(beans.onHand));
    check("scan session list shows it", w.document.getElementById("sessList").textContent.includes("Test Beans"));
  }

  // batch text: one call with the whole list; old worker -> one call each
  {
    const d = load({
      "chisave.regulars.v1": [{ name: "Ana", phone: "+17735550001" }, { name: "Bo", phone: "+17735550002" }],
      "chisave.settings.v1": { storeName: "Test Mart", smsUrl: "https://example.workers.dev/send" },
    });
    const w = d.window;
    const calls = [];
    w.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ sent: 2, failed: 0 }) };
    };
    let lastAlert = "";
    w.alert = (m) => { lastAlert = m; };
    const btn = w.document.getElementById("sendAllBtn");
    check("send-all button renders", !!btn);
    if (btn) { btn.dispatchEvent(new w.Event("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 50)); }
    check("batch send: one call, list of 2 phones", calls.length === 1 && Array.isArray(calls[0].body.to) && calls[0].body.to.length === 2, JSON.stringify(calls));
    check("batch send alert says 2 sent", lastAlert.includes("2 sent"), lastAlert);
    calls.length = 0;
    w.fetch = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      const b = JSON.parse(opts.body);
      if (Array.isArray(b.to)) return { ok: false, status: 400 };
      return { ok: true };
    };
    if (btn) { btn.dispatchEvent(new w.Event("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 50)); }
    check("batch fallback: 1 list call + 2 singles", calls.length === 3 && calls.slice(1).every((b) => typeof b.to === "string"), JSON.stringify(calls));
  }

  // printable shelf labels: 7 cards, print called
  {
    const d = load();
    const w = d.window;
    let printed = false;
    w.print = () => { printed = true; };
    w.document.getElementById("printLabelsBtn").dispatchEvent(new w.Event("click", { bubbles: true }));
    const cards = w.document.querySelectorAll("#labelsPrint .label-card");
    check("labels: 7 label cards", cards.length === 7, String(cards.length));
    check("labels: print called", printed);
    check("labels: price + today only", cards.length > 0 && cards[0].textContent.includes("TODAY ONLY") && cards[0].textContent.includes("$"));
  }

  // Square sync: fake orders cut on-hand and log the sale
  {
    const d = load({
      "chisave.square.v1": { token: "tok-test", locationId: "LOC1", connectedAt: today },
      "chisave.settings.v1": { storeName: "Test Mart", smsUrl: "", squareAuthUrl: "https://example.workers.dev" },
    });
    const w = d.window;
    w.fetch = async (url) => {
      if (String(url).startsWith("https://connect.squareup.com")) {
        return { ok: true, json: async () => ({ orders: [{ created_at: today + "T10:00:00Z", line_items: [{ name: "Ground beef 80/20, 1 lb", quantity: "3" }] }] }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    w.alert = () => {};
    check("square status connected", w.document.getElementById("squareStatus").textContent.includes("connected"));
    const btn = w.document.getElementById("squareSyncBtn");
    check("square sync button visible", !!btn && btn.style.display !== "none");
    if (btn) { btn.dispatchEvent(new w.Event("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); }
    const inv = JSON.parse(w.localStorage.getItem("chisave.inventory.v1"));
    const beef = inv.find((x) => x.name.startsWith("Ground beef"));
    check("square sync cut on-hand 18 -> 15", beef && beef.onHand === 15, beef && String(beef.onHand));
    check("square sync logged today's sale", beef && beef.sales.some((s) => s.date === today && s.qty === 3));
    check("square sync message", w.document.getElementById("squareMsg").textContent.includes("Synced"));
  }

  // Square token return via the web address hash
  {
    const d = load({}, "https://mightiest-g.github.io/chisave/#square_token=tok123&square_location=LOC9&state=");
    const w = d.window;
    const sq = JSON.parse(w.localStorage.getItem("chisave.square.v1") || "{}");
    check("square hash return saves token", sq.token === "tok123" && sq.locationId === "LOC9", JSON.stringify(sq));
    check("square hash cleared from address", !w.location.hash.includes("square_token"));
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
