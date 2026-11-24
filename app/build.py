#!/usr/bin/env python3
"""Build ChiSave's single-file web app.

Reads app/src.html, inlines:
  - engine/forecast.js (with `export ` stripped, so it runs as a plain script)
  - app/shelf-life.json (as window.__SHELF_LIFE__)
and writes app/index.html — one file that works anywhere, no server needed.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

src = (HERE / "src.html").read_text()
engine = (ROOT / "engine" / "forecast.js").read_text()
engine = re.sub(r"^export ", "", engine, flags=re.M)
engine = re.sub(r"export \{[^}]*\};?\s*$", "", engine, flags=re.M)

shelf = json.loads((HERE / "shelf-life.json").read_text())
shelf_js = "window.__SHELF_LIFE__ = " + json.dumps(shelf) + ";"

out = src.replace("/*__ENGINE__*/", engine)
out = out.replace("/*__SHELF_LIFE__*/", shelf_js)
(HERE / "index.html").write_text(out)
print(f"wrote app/index.html ({len(out):,} bytes)")

# Stamp the service worker with this build's time, so installed apps
# always notice the new version (see sw.js). The regex replaces the
# previous stamp, so builds stay idempotent.
sw_path = HERE / "sw.js"
sw = sw_path.read_text()
stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
sw_new = re.sub(r"chisave-\d{12}", f"chisave-{stamp}", sw)
if sw_new != sw:
    sw_path.write_text(sw_new)
print(f"service worker stamped chisave-{stamp}")

# GitHub Pages copy: publish from /docs on the main branch, so the live
# site is the same files the app folder holds. Re-run this script after
# any change to src.html, manifest.json, sw.js or the icons.
import shutil
docs = ROOT / "docs"
docs.mkdir(exist_ok=True)
for name in ["index.html", "manifest.json", "sw.js",
             "icon-192.png", "icon-512.png", "icon-maskable-512.png"]:
    shutil.copy2(HERE / name, docs / name)
(docs / ".nojekyll").write_text("")
print(f"copied site files to docs/ ({len(list(docs.iterdir()))} files)")
