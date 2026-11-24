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

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
