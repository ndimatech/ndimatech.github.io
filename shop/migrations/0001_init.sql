-- NdimaTech shop: orders for digital products, webhook de-duplication, email log.

CREATE TABLE orders (
  id TEXT PRIMARY KEY,               -- random UUID, also the buyer's order reference
  product TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | amount_mismatch
  checkout_id TEXT,
  payment_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  token_hash TEXT,                   -- SHA-256 of the download token; the token itself is never stored
  token_expires_at INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  emailed_at INTEGER,
  resends INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_checkout ON orders (checkout_id);
CREATE UNIQUE INDEX orders_token ON orders (token_hash);
CREATE INDEX orders_status_created ON orders (status, created_at);

CREATE TABLE processed_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL               -- processing | done
);

CREATE TABLE email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
