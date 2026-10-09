import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creator_codes (
  kind TEXT NOT NULL CHECK (kind IN ('coupon', 'utm')),
  code TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  PRIMARY KEY (kind, code)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  currency TEXT NOT NULL,
  financial_status TEXT NOT NULL,
  coupon_codes_json TEXT NOT NULL,
  utm_content TEXT,
  creator_id TEXT,
  attribution_rule TEXT NOT NULL,
  attribution_reason TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- order_id sem chave estrangeira de propósito: o estorno pode chegar antes do pedido.
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  applied_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
  received_at TEXT NOT NULL,
  applied_at TEXT
);

-- Toda entrega de webhook fica registrada, inclusive as repetidas.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL CHECK (topic IN ('order', 'refund')),
  resource_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
