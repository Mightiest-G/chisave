-- ChiSave sync service schema (Cloudflare D1).
-- Apply once: wrangler d1 execute chisave-sync --file=server/schema.sql

CREATE TABLE IF NOT EXISTS kinds (
  store_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- inventory | regulars | activity | learning | meta | last_deal_send
  data TEXT NOT NULL,          -- JSON
  updated_at INTEGER NOT NULL, -- ms since epoch; newest wins per kind
  PRIMARY KEY (store_id, kind)
);

CREATE TABLE IF NOT EXISTS store_secrets (
  store_id TEXT PRIMARY KEY,
  secret TEXT NOT NULL         -- pilot-grade: stored as-is; hash before real multi-store use
);
