#!/usr/bin/env python3
"""Build ChiSave's compact shelf-life table from USDA FoodKeeper data.

Source: USDA FSIS FoodKeeper dataset (public domain, CC0).
Fetched copy: data/foodkeeper-661.json (661 products, 25 categories) —
a community copy of the official FSIS feed, since fsis.usda.gov blocks
automated downloads. The official feed is:
  https://www.fsis.usda.gov/shared/data/EN/foodkeeper.json

Output: app/shelf-life.json — one compact record per product:
  { id, name, subtitle, keywords[], category, storage, min_days, max_days }

Rules:
- Primary storage is the one a corner store actually uses: fridge first,
  then pantry, then freezer (a store sells from fridge/pantry, not freezer).
- Times are "from date of purchase" (DOP_* fields), converted to days.
- min_days is the CONSERVATIVE end of the range: ChiSave estimates expiry
  as received_date + min_days, so markdowns trigger early rather than late.
- Products with no usable DOP time in any storage are skipped and counted.
- Metric "Months" = 30 days, "Weeks" = 7, "Days" = 1. Non-day metrics
  ("Indefinitely", "When Ripe", "Not Recommended") are skipped.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "foodkeeper-661.json"
DST = HERE.parent / "app" / "shelf-life.json"

METRIC_DAYS = {"Days": 1, "Day": 1, "Weeks": 7, "Week": 7,
                "Months": 30, "Month": 30, "Years": 365, "Year": 365}

# storage preference order for a retail store.
# Fridge first, then pantry. NO freezer: a store sells fresh stock, it does
# not freeze its milk to extend it — a freezer number would give a
# dangerously long estimate for a fresh item (e.g. milk picked up 90 days
# from its freezer time). Each storage tries the "from date of purchase"
# (DOP) fields first, then the plain fields.
STORAGES = [
    ("refrigerate", [("dop_refrigerate_min", "dop_refrigerate_max",
                      "dop_refrigerate_metric"),
                     ("refrigerate_min", "refrigerate_max",
                      "refrigerate_metric")]),
    ("pantry", [("dop_pantry_min", "dop_pantry_max", "dop_pantry_metric"),
                ("pantry_min", "pantry_max", "pantry_metric")]),
]


def to_days(value, metric):
    if value is None or metric not in METRIC_DAYS:
        return None
    return int(round(float(value) * METRIC_DAYS[metric]))


def main():
    data = json.loads(SRC.read_text())
    products = data["products"]
    out = []
    needs_printed = []
    skipped = []
    for p in products:
        record = None
        for storage, variants in STORAGES:
            for f_min, f_max, f_met in variants:
                lo = to_days(p.get(f_min), p.get(f_met))
                hi = to_days(p.get(f_max), p.get(f_met))
                if lo is not None:
                    record = {
                        "id": p["id"],
                        "name": p["name"],
                        "subtitle": p.get("name_subtitle"),
                        "keywords": [k.strip().lower() for k in
                                     (p.get("keywords") or "").split(",") if k.strip()],
                        "category": p["category_name"],
                        "subcategory": p.get("subcategory_name"),
                        "storage": storage,
                        "min_days": lo,
                        "max_days": hi if hi is not None else lo,
                    }
                    break
            if record:
                break
        if record:
            out.append(record)
        elif any("use-by" in str(p.get(f) or "") or "Use-By" in str(p.get(f) or "")
                 for f in ("refrigerate_metric", "dop_refrigerate_metric",
                           "pantry_metric", "dop_pantry_metric")):
            # FoodKeeper itself says: follow the printed package date.
            needs_printed.append(
                f"{p['name']} ({p.get('name_subtitle') or ''})".strip())
        else:
            skipped.append(p["name"])
    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_text(json.dumps(
        {"source": "USDA FSIS FoodKeeper (public domain, CC0), "
                   "via community copy of the official feed; "
                   "min_days is the conservative end of the range",
         "products": out,
         "needs_printed_date": sorted(set(needs_printed))}, indent=1))
    print(f"products in source: {len(products)}")
    print(f"products in table:  {len(out)}")
    print(f"needs printed date (no table estimate): {len(set(needs_printed))}")
    print(f"skipped (no usable date): {len(skipped)}")
    if skipped:
        print("skipped:", ", ".join(skipped[:20]))
    # sanity checks on staples a corner store actually sells
    by_name = {r["name"].lower(): r for r in out}
    for probe in ["milk", "butter", "eggs"]:
        hits = [r for r in out if probe in r["name"].lower()][:3]
        for h in hits:
            print(f"  {h['name']} ({h['subtitle'] or ''}): "
                  f"{h['min_days']}-{h['max_days']}d {h['storage']}")


if __name__ == "__main__":
    sys.exit(main())
