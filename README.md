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

## What v1 does NOT have yet

- **Square/Clover live link** — sales come in by CSV export or by hand each
  evening. A live Square connection needs the store's Square account
  (OAuth) — the CSV path is the pilot route.
- **Bulk text sending** — deals go out one tap at a time from the clerk's
  own phone (free). `server/twilio-send.js` is the ready-to-deploy worker
  for sending to everyone at once; it needs a Twilio account (~$1.15/mo
  for a number, ~$0.008 per text) and the URL pasted in Settings.
- **Camera date reading** — the photo + OCR path exists (Tesseract.js,
  best effort, clerk always confirms). It is a backup: most items never
  need it, because the USDA estimate covers them.
- No customer app, no machine learning, no electronic shelf labels, no
  wholesaler integration, no multi-device sync (data lives on the one
  phone/tablet for the pilot).

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
- `server/` — `twilio-send.js`, the optional bulk-text worker (see header).

## Run it / install it

**Right now it is a web app, not a store download.** Open `app/index.html`
in a browser and it works. It is packaged as a PWA, so once it is on a
web address it installs like an app:

- `manifest.json` + `sw.js` + icons are in `app/` — the install button
  appears in Settings when the browser offers it, and the app then works
  offline from the home screen.
- A service worker only runs over **https** (or localhost), never from a
  plain file — so installing needs the app hosted on a real address.
  Free options: Cloudflare Pages (the Legacilion account) or GitHub Pages.
  That hosting step is not done yet.
- The Play Store route (a real download like Redunator's APK) would wrap
  this same web app — it needs a $25 Play developer account + ID check,
  the step Redunator deliberately skipped for now. The PWA install skips
  all of that and is the right route for a pilot.

Open `app/index.html` in a browser (or serve the `app/` folder). Demo data
is seeded on first run; everything saves in the browser. No account, no
server, no cost.

## Status

- v1 MVP: receiving scan + online expiry estimate + forecast + markdown list
- Next: pilot in 2–3 Square stores, 4–6 weeks, free — measure recovered
  margin against a control week, then price ($49–$99/mo target).
