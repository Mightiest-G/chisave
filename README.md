# ChiSave

**The problem:** a small Chicago grocer buys fresh food — produce, meat, dairy,
bakery — that only lasts days. Whatever doesn't sell by its date goes in the
trash, and the store already paid for it. On a 1–3% net margin, that waste is
profit straight in the bin. US grocery stores threw away about **$26.9
billion** of unsold food in 2024 (ReFED), and nearly half of retail surplus
is date-related.

**What ChiSave does:** predicts which fresh items won't sell before they
expire, marks them down early while they can still sell, and texts the
store's nearby regulars a "today only" deal — so the food gets bought
instead of thrown away.

## How it works (v1)

1. **Clerk scans a barcode once when a case arrives.** That is the only
   human action. No typing dates.
2. **The internet fills in the expiry.** The app identifies the product
   (Open Food Facts, free) and looks up how long that kind of food lasts
   (USDA FoodKeeper data, free, built into the app). Expiry = delivery day
   + shelf life. The estimate uses the **cautious end** of the range, so
   markdowns trigger early rather than late.
3. **Some foods can't be estimated.** Fluid milk, sour cream, almond milk
   and 26 others are flagged by FoodKeeper itself as "follow the printed
   package date." For those, the app asks the clerk to point the phone
   camera at the package instead. The camera is the exception, not the
   daily job.
4. **Forecast (rules, not AI, in v1).** How fast an item sells (units/day
   over the last 7–14 days) × days left until expiry = how much will be
   left over. That sets the markdown: 10% off at 3 days out, 25% at 2 days,
   50% at 1 day.
5. **The clerk approves every markdown.** Each morning the app hands over
   a list. Nothing changes a price by itself in v1.
6. **Text the regulars.** A "today only" text to the store's own customer
   list. Texts, not an app — regulars won't download one.

## Honesty rules

- The expiry date is an **estimate**, never the printed date, unless the
  camera read it or the supplier sent it. The app says so on every item.
- Estimates use the conservative end of the shelf-life range.
- A "USE by" date is a **hard stop**: the app never discounts past it, and
  never suggests selling food past it.
- National waste figures ($26.9B etc.) describe the country, not one store.
  Any savings claim for a store comes from that store's own measured pilot,
  never from national numbers.
- Illinois does not ban selling past sell-by / best-by dates (eggs
  excepted), but the app never pushes food past a safety date or food that
  is actually spoiled.

## What v2 adds (2026-11-24)

- **Markdowns that learn** — the app remembers what each product did last
  time it was marked down. Marked down and still wasted? Next time it
  starts one rung deeper. Cleared easily at 10%? Next time it starts
  gentler. Only cleared at 50%? Starts deeper. The reason on the markdown
  list says so in plain words. Learning lives on the phone
  (`chisave.learning.v1`).
- **Order less / order more** — in the weekly report, from the last 30 days
  of real history: a product is "order less" when at least 4 came in and a
  quarter or more went to waste; "order more" when it sold out before its
  date at least twice.
- **Scan in a whole delivery** — keep the camera open and scan case after
  case; each scan looks the product up, sets its date, and adds it
  (scanning the same thing twice just adds more). A typed barcode works
  the same way when there is no camera.
- **Square register link (built, needs a store to switch on)** — one
  sign-in in Settings, then "Sync sales from Square" pulls the last 2
  days of orders into the sales log on its own. Needs the helper worker
  (`server/square-oauth.js`, Cloudflare) + a Square developer app for the
  OAuth client ID/secret. The token lives on the store's phone only.
- **Send to all by text service** — one tap sends today's deals to every
  regular. The worker (`server/twilio-send.js`) now takes the whole list
  in one call and falls back to one call each if it is the old version.
  Still needs a Twilio account (~$1.15/mo for a number, ~$0.008/text).
  Fully automatic 9am sending is NOT built — it needs the regulars list
  on a server, a step after the pilot.
- **Printable shelf labels** — "Print shelf labels" on the markdown list
  prints one label per item (was → now, % off, "today only").

## What v3 adds (2026-11-24)

- **One-tap "Close the day"** — Square sync first if the register is
  connected, then the typed sales, then a summary (units sold today,
  tomorrow's markdowns and what they're worth). The evening routine in one tap.
- **Tomorrow's markdowns** — the same forecast run one day ahead, always on
  screen under today's list, so the morning is never a surprise.
- **Price book** — the last price for each product is remembered
  (`chisave.prices.v1`), so scanned and invoice items never land at $0.
  The add-stock form prefills it too.
- **Offline barcode memory** — barcodes already looked up come back from
  the phone's own memory (`chisave.barcodes.v1`); repeat scans work
  without internet.
- **Shelf count fix** — plus/minus buttons on every shelf item. A wrong
  count quietly breaks the forecast, and counts always drift.
- **Invoice photo receiving** — photograph a delivery invoice; the app
  matches lines to foods it knows, guesses quantities, and the clerk
  checks each line before adding. Best effort, never silent.
- **Sync service (built, needs deploying)** — `server/chisave-sync.js`
  (Cloudflare Worker + D1, `server/schema.sql`, `wrangler.toml`). One
  backend for three things: same stock on two phones (last-write-wins per
  list; first phone claims the store with a secret code), a public deals
  page (`/deals?store=<id>`), and the 9am deal texts sent by the worker
  itself (hourly check, Chicago time, once a day, Twilio). The app side
  is in Settings ("Sync service web address" + "Store sync code") and
  syncs on open. **NOT live yet** — deploying needs a Cloudflare API
  token (the dashboard sign-in was Turnstile-blocked for the browser on
  2026-11-23); the 9am texts also need the Twilio secrets on the worker.
  Worker tests: `node --test server/sync.test.mjs` (7/7, D1 + Twilio mocked).

## What v3 does NOT have yet

- **Live sync / live Square / live Twilio connections** — all three are
  built and tested against fake data, but no real account has been
  connected, so no live API call has ever run.
- **Camera date reading** — the photo + OCR path exists (Tesseract.js,
  best effort, clerk always confirms). It is a backup: most items never
  need it, because the USDA estimate covers them.
- No customer app, no machine learning, no electronic shelf labels, no
  wholesaler integration. Multi-device sync is built (see above) but not
  deployed.

## Repo layout

- `app/` — the store web app (single file, works on a phone). `shelf-life.json`
  is the compact USDA FoodKeeper table built by `data/build_shelf_life.py`.
  `src.html` is the source; `build.py` inlines the engine + table into
  `index.html`. Edit `src.html`, then run `python3 app/build.py`.
- `engine/` — the forecast + markdown rules as pure functions, with tests
  (`node --test`).
- `data/` — `foodkeeper-661.json` (USDA FoodKeeper, public domain, CC0) and
  the build script. The official feed is
  https://www.fsis.usda.gov/shared/data/EN/foodkeeper.json
- `server/` — `twilio-send.js` (bulk-text worker), `square-oauth.js`
  (Square register-link helper), `chisave-sync.js` + `schema.sql` (the
  sync service), all optional; see their headers. `wrangler.toml` at the
  repo root is for the sync worker.

## Run it / install it

**Right now it is a web app, not a store download.** Open `app/index.html`
in a browser and it works. It is packaged as a PWA, so once it is on a
web address it installs like an app:

- `manifest.json` + `sw.js` + icons are in `app/` — the install button
  appears in Settings when the browser offers it, and the app then works
  offline from the home screen.
- A service worker only runs over **https** (or localhost), never from a
  plain file — so installing needs the app hosted on a real address.
  **LIVE since 2026-11-23: https://mightiest-g.github.io/chisave/**
  (GitHub Pages, repo Mightiest-G/chisave, published from `docs/`).
  To update the live site: edit `app/src.html` (or manifest/icons/sw.js),
  rerun `python3 app/build.py`, commit, push — Pages rebuilds in ~1 min.
- The Play Store route (a real download like Redunator's APK) would wrap
  this same web app — it needs a $25 Play developer account + ID check,
  the step Redunator deliberately skipped for now. The PWA install skips
  all of that and is the right route for a pilot.

## Updates — automatic, no store review

Every `python3 app/build.py` stamps a new version into `sw.js`, so each
push is a new version. An installed app picks it up on its own:

- Closed app / next open: the new version is already there.
- App open when a new version lands: a green bar appears at the top —
  "A new version of ChiSave is ready — Reload to update." Tap it and the
  new version loads. The store never has to reinstall or check for updates.

That is the PWA equivalent of Redunator's in-app updater, minus the APK
download — the update is just the new web files, fetched in the background.

Open `app/index.html` in a browser (or serve the `app/` folder). Demo data
is seeded on first run; everything saves in the browser. No account, no
server, no cost.

## Status

- v1 MVP: receiving scan + online expiry estimate + forecast + markdown list
- Next: pilot in 2–3 Square stores, 4–6 weeks, free — measure recovered
  margin against a control week, then price ($49–$99/mo target).
