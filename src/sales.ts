import type { DatabaseSync } from "node:sqlite";
import { type AttributionRule, attributeSale } from "./attribution.ts";

export type Clock = () => Date;
export type Outcome = "processed" | "duplicate" | "pending";
export type AttributionState = "unattributed" | "active" | "partially_reversed" | "reversed";

export type RefundView = {
  id: string;
  order_id: string;
  amount_cents: number;
  applied_cents: number | null;
  status: "pending" | "applied";
  // O estorno pediu mais do que restava da venda; só o que restava foi aplicado.
  capped: boolean;
  received_at: string;
  applied_at: string | null;
};

export type OrderView = {
  order: {
    id: string;
    total_cents: number;
    currency: string;
    financial_status: string;
    coupon_codes: string[];
    utm_content: string | null;
    received_at: string;
  };
  attribution: {
    creator_id: string | null;
    rule: AttributionRule;
    reason: string;
    state: AttributionState;
    gross_cents: number;
    refunded_cents: number;
    net_cents: number;
  };
  refunds: RefundView[];
  deliveries: Array<{ topic: "order" | "refund"; resource_id: string; outcome: string; received_at: string }>;
};

export class SalesError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;

  constructor(status: 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type OrderRow = {
  id: string;
  total_cents: number;
  currency: string;
  financial_status: string;
  coupon_codes_json: string;
  utm_content: string | null;
  creator_id: string | null;
  attribution_rule: AttributionRule;
  attribution_reason: string;
  received_at: string;
};
type RefundRow = Omit<RefundView, "capped">;

function resourceId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

// Valor chega como texto decimal, como na Shopify ("150.00"). Vira centavos sem passar por float.
function cents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function normalizeCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createSales(db: DatabaseSync, clock: Clock) {
  function creatorOf(kind: "coupon" | "utm", code: string): string | null {
    if (!code) return null;
    const row = db.prepare("SELECT creator_id FROM creator_codes WHERE kind = ? AND code = ?").get(kind, code) as
      | { creator_id: string }
      | undefined;
    return row?.creator_id ?? null;
  }

  function logDelivery(topic: "order" | "refund", id: string, orderId: string, outcome: string): void {
    db.prepare(
      "INSERT INTO webhook_deliveries (topic, resource_id, order_id, outcome, received_at) VALUES (?, ?, ?, ?, ?)",
    ).run(topic, id, orderId, outcome, clock().toISOString());
  }

  function refundView(row: RefundRow): RefundView {
    return { ...row, capped: row.applied_cents !== null && row.applied_cents < row.amount_cents };
  }

  function refundsOf(orderId: string): RefundRow[] {
    return db
      .prepare(
        "SELECT id, order_id, amount_cents, applied_cents, status, received_at, applied_at FROM refunds WHERE order_id = ? ORDER BY received_at, rowid",
      )
      .all(orderId) as RefundRow[];
  }

  // Aplica no máximo o que ainda resta da venda: a soma dos estornos nunca passa do total.
  function applyRefund(order: OrderRow, refundId: string, amountCents: number): void {
    const { refunded } = db
      .prepare("SELECT COALESCE(SUM(applied_cents), 0) AS refunded FROM refunds WHERE order_id = ? AND status = 'applied'")
      .get(order.id) as { refunded: number };
    const applied = Math.min(amountCents, order.total_cents - refunded);
    db.prepare("UPDATE refunds SET status = 'applied', applied_cents = ?, applied_at = ? WHERE id = ?").run(
      applied,
      clock().toISOString(),
      refundId,
    );
  }

  function orderView(orderId: string): OrderView {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
    if (!order) throw new SalesError(404, "order_not_found", "pedido não encontrado");
    const refunds = refundsOf(orderId).map(refundView);
    const refunded = refunds.reduce((sum, refund) => sum + (refund.applied_cents ?? 0), 0);
    const state: AttributionState = !order.creator_id
      ? "unattributed"
      : refunded === 0
        ? "active"
        : refunded < order.total_cents
          ? "partially_reversed"
          : "reversed";
    return {
      order: {
        id: order.id,
        total_cents: order.total_cents,
        currency: order.currency,
        financial_status: order.financial_status,
        coupon_codes: JSON.parse(order.coupon_codes_json) as string[],
        utm_content: order.utm_content,
        received_at: order.received_at,
      },
      attribution: {
        creator_id: order.creator_id,
        rule: order.attribution_rule,
        reason: order.attribution_reason,
        state,
        gross_cents: order.total_cents,
        refunded_cents: refunded,
        net_cents: order.total_cents - refunded,
      },
      refunds,
      deliveries: db
        .prepare(
          "SELECT topic, resource_id, outcome, received_at FROM webhook_deliveries WHERE order_id = ? ORDER BY seq",
        )
        .all(orderId) as OrderView["deliveries"],
    };
  }

  function registerCodes(creatorId: string, input: { coupons?: unknown; utm_contents?: unknown }): void {
    const entries = (["coupon", "utm"] as const).flatMap((kind) => {
      const raw = kind === "coupon" ? input.coupons : input.utm_contents;
      return (Array.isArray(raw) ? raw : []).map((code) => ({ kind, code: normalizeCode(code) }));
    });
    if (entries.length === 0 || entries.some((entry) => !entry.code)) {
      throw new SalesError(422, "codes_required", "informe coupons e/ou utm_contents com textos não vazios");
    }
    transaction(db, () => {
      for (const { kind, code } of entries) {
        const owner = creatorOf(kind, code);
        if (owner && owner !== creatorId) {
          throw new SalesError(409, "code_taken", `${kind} ${code} já pertence a ${owner}`);
        }
        db.prepare("INSERT OR IGNORE INTO creator_codes (kind, code, creator_id) VALUES (?, ?, ?)").run(kind, code, creatorId);
      }
    });
  }

  function ingestOrder(payload: Record<string, unknown>): { outcome: Outcome; order: OrderView } {
    const id = resourceId(payload.id);
    const totalCents = cents(payload.total_price);
    if (!id) throw new SalesError(422, "order_id_required", "id do pedido é obrigatório");
    if (totalCents === null) {
      throw new SalesError(422, "total_price_invalid", 'total_price deve ser texto decimal, como "150.00"');
    }
    const couponCodes = (Array.isArray(payload.discount_codes) ? payload.discount_codes : [])
      .map((entry) => normalizeCode((entry as { code?: unknown } | null)?.code))
      .filter((code) => code !== "");
    const utm = payload.utm && typeof payload.utm === "object" ? (payload.utm as Record<string, unknown>) : {};
    const utmContent = normalizeCode(utm.content);

    return transaction(db, () => {
      // O id do pedido é a chave de idempotência: a segunda entrega não soma nem reatribui.
      if (db.prepare("SELECT 1 FROM orders WHERE id = ?").get(id)) {
        logDelivery("order", id, id, "duplicate");
        return { outcome: "duplicate" as const, order: orderView(id) };
      }
      const couponCreatorId = couponCodes.map((code) => creatorOf("coupon", code)).find((creator) => creator) ?? null;
      const attribution = attributeSale({ couponCreatorId, utmCreatorId: creatorOf("utm", utmContent) });
      const order: OrderRow = {
        id,
        total_cents: totalCents,
        currency: typeof payload.currency === "string" ? payload.currency : "BRL",
        financial_status: typeof payload.financial_status === "string" ? payload.financial_status : "paid",
        coupon_codes_json: JSON.stringify(couponCodes),
        utm_content: utmContent || null,
        creator_id: attribution.creator_id,
        attribution_rule: attribution.rule,
        attribution_reason: attribution.reason,
        received_at: clock().toISOString(),
      };
      db.prepare(
        `INSERT INTO orders (id, total_cents, currency, financial_status, coupon_codes_json, utm_content,
           creator_id, attribution_rule, attribution_reason, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        order.id,
        order.total_cents,
        order.currency,
        order.financial_status,
        order.coupon_codes_json,
        order.utm_content,
        order.creator_id,
        order.attribution_rule,
        order.attribution_reason,
        order.received_at,
      );
      logDelivery("order", id, id, "processed");
      // Estornos que chegaram antes do pedido estavam pendentes: entram agora, na ordem de chegada.
      for (const refund of refundsOf(id).filter((row) => row.status === "pending")) {
        applyRefund(order, refund.id, refund.amount_cents);
      }
      return { outcome: "processed" as const, order: orderView(id) };
    });
  }

  function refundById(id: string): RefundView {
    const row = db
      .prepare("SELECT id, order_id, amount_cents, applied_cents, status, received_at, applied_at FROM refunds WHERE id = ?")
      .get(id) as RefundRow | undefined;
    if (!row) throw new SalesError(404, "refund_not_found", "estorno não encontrado");
    return refundView(row);
  }

  function ingestRefund(payload: Record<string, unknown>): { outcome: Outcome; refund: RefundView } {
    const id = resourceId(payload.id);
    const orderId = resourceId(payload.order_id);
    const amountCents = cents(payload.amount);
    if (!id) throw new SalesError(422, "refund_id_required", "id do estorno é obrigatório");
    if (!orderId) throw new SalesError(422, "order_id_required", "order_id é obrigatório");
    if (amountCents === null || amountCents === 0) {
      throw new SalesError(422, "amount_invalid", 'amount deve ser texto decimal maior que zero, como "50.00"');
    }

    return transaction(db, () => {
      // O id do estorno é a chave de idempotência: o mesmo estorno entregue de novo não abate duas vezes.
      if (db.prepare("SELECT 1 FROM refunds WHERE id = ?").get(id)) {
        logDelivery("refund", id, orderId, "duplicate");
        return { outcome: "duplicate" as const, refund: refundById(id) };
      }
      db.prepare(
        "INSERT INTO refunds (id, order_id, amount_cents, status, received_at) VALUES (?, ?, ?, 'pending', ?)",
      ).run(id, orderId, amountCents, clock().toISOString());
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
      if (!order) {
        logDelivery("refund", id, orderId, "pending");
        return { outcome: "pending" as const, refund: refundById(id) };
      }
      applyRefund(order, id, amountCents);
      logDelivery("refund", id, orderId, "processed");
      return { outcome: "processed" as const, refund: refundById(id) };
    });
  }

  function creatorSales(creatorId: string) {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS gross_cents,
           COALESCE((SELECT SUM(r.applied_cents) FROM refunds r JOIN orders o ON o.id = r.order_id
                     WHERE o.creator_id = ?1 AND r.status = 'applied'), 0) AS refunded_cents
         FROM orders WHERE creator_id = ?1`,
      )
      .get(creatorId) as { orders: number; gross_cents: number; refunded_cents: number };
    return { creator_id: creatorId, ...totals, net_cents: totals.gross_cents - totals.refunded_cents };
  }

  return { registerCodes, ingestOrder, ingestRefund, orderView, refundById, creatorSales };
}
