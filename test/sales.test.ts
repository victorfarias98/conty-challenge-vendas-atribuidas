import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { attributeSale } from "../src/attribution.ts";
import { openDatabase } from "../src/db.ts";
import type { OrderView, RefundView } from "../src/sales.ts";

type App = ReturnType<typeof createApp>;
type OrderResult = { outcome: string; order: OrderView };
type RefundResult = { outcome: string; refund: RefundView };
type CreatorSales = { orders: number; gross_cents: number; refunded_cents: number; net_cents: number };

let app: App;
let now: Date;

async function send(method: "POST" | "PUT", path: string, body: unknown): Promise<Response> {
  return app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 5001,
    total_price: "150.00",
    currency: "BRL",
    financial_status: "paid",
    discount_codes: [{ code: "ANA10" }],
    utm: { source: "conty", medium: "creator", campaign: "verao", content: "ana" },
    ...overrides,
  };
}

async function order(overrides: Record<string, unknown> = {}): Promise<OrderResult> {
  return (await (await send("POST", "/webhooks/orders", orderPayload(overrides))).json()) as OrderResult;
}

async function refund(id: number, amount: string, orderId = 5001): Promise<Response> {
  return send("POST", "/webhooks/refunds", { id, order_id: orderId, amount });
}

async function orderView(id = 5001): Promise<OrderView> {
  return (await (await app.request(`/orders/${id}`)).json()) as OrderView;
}

async function salesOf(creatorId: string): Promise<CreatorSales> {
  return (await (await app.request(`/creators/${creatorId}/sales`)).json()) as CreatorSales;
}

beforeEach(async () => {
  now = new Date("2026-03-10T15:00:00.000Z");
  app = createApp(openDatabase(), () => now);
  await send("PUT", "/creators/crt_ana/codes", { coupons: ["ANA10"], utm_contents: ["ana"] });
  await send("PUT", "/creators/crt_bruno/codes", { coupons: ["BRUNO10"], utm_contents: ["bruno"] });
});

describe("regra de atribuição", () => {
  it("dá a venda ao criador do cupom quando cupom e UTM apontam para criadores diferentes", () => {
    const result = attributeSale({ couponCreatorId: "crt_ana", utmCreatorId: "crt_bruno" });
    expect(result).toMatchObject({ creator_id: "crt_ana", rule: "coupon_over_utm" });
    expect(result.reason).toContain("crt_bruno");
  });

  it("usa a UTM quando não há cupom de criador", () => {
    expect(attributeSale({ couponCreatorId: null, utmCreatorId: "crt_bruno" })).toMatchObject({
      creator_id: "crt_bruno",
      rule: "utm",
    });
  });

  it("não atribui quando nem cupom nem UTM são de criador", () => {
    expect(attributeSale({ couponCreatorId: null, utmCreatorId: null })).toMatchObject({ creator_id: null, rule: "none" });
  });

  it("aplica o desempate no pedido que chega por webhook e grava o motivo", async () => {
    const { order: view } = await order({ utm: { content: "bruno" } });
    expect(view.attribution).toMatchObject({ creator_id: "crt_ana", rule: "coupon_over_utm", state: "active" });
    expect((await salesOf("crt_ana")).net_cents).toBe(15000);
    expect((await salesOf("crt_bruno")).orders).toBe(0);
  });

  it("ignora cupom que não é de criador e cai na UTM", async () => {
    const { order: view } = await order({ discount_codes: [{ code: "FRETEGRATIS" }], utm: { content: "BRUNO" } });
    expect(view.attribution).toMatchObject({ creator_id: "crt_bruno", rule: "utm" });
  });

  it("guarda o pedido sem criador como não atribuído, com o motivo", async () => {
    const { order: view } = await order({ discount_codes: [], utm: {} });
    expect(view.attribution).toMatchObject({ creator_id: null, rule: "none", state: "unattributed" });
    expect(view.attribution.reason).not.toBe("");
  });
});

describe("pedido duplicado", () => {
  it("não soma a venda de novo quando o webhook chega duas vezes", async () => {
    const first = await send("POST", "/webhooks/orders", orderPayload());
    const second = await send("POST", "/webhooks/orders", orderPayload());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await second.json()) as OrderResult).outcome).toBe("duplicate");
    expect(await salesOf("crt_ana")).toMatchObject({ orders: 1, gross_cents: 15000, net_cents: 15000 });
  });

  it("não reatribui nem muda o valor se a segunda entrega vier diferente", async () => {
    await order();
    await order({ total_price: "999.00", discount_codes: [{ code: "BRUNO10" }] });
    const view = await orderView();
    expect(view.order.total_cents).toBe(15000);
    expect(view.attribution.creator_id).toBe("crt_ana");
    expect(view.deliveries.map((delivery) => delivery.outcome)).toEqual(["processed", "duplicate"]);
  });

  it("recusa pedido sem id ou com valor que não é decimal", async () => {
    expect((await send("POST", "/webhooks/orders", orderPayload({ id: undefined }))).status).toBe(422);
    expect((await send("POST", "/webhooks/orders", orderPayload({ total_price: 150 }))).status).toBe(422);
    expect((await send("POST", "/webhooks/orders", orderPayload({ total_price: "-1.00" }))).status).toBe(422);
  });
});

describe("estorno", () => {
  it("estorno total zera a atribuição sem apagar o histórico", async () => {
    await order();
    now = new Date("2026-03-14T15:00:00.000Z");
    const res = await refund(9001, "150.00");

    expect(res.status).toBe(201);
    const view = await orderView();
    expect(view.attribution).toMatchObject({
      creator_id: "crt_ana",
      state: "reversed",
      gross_cents: 15000,
      refunded_cents: 15000,
      net_cents: 0,
    });
    expect(view.refunds).toMatchObject([{ id: "9001", applied_cents: 15000, applied_at: "2026-03-14T15:00:00.000Z" }]);
    expect(await salesOf("crt_ana")).toMatchObject({ orders: 1, gross_cents: 15000, net_cents: 0 });
  });

  it("estorno parcial reverte só a parte estornada", async () => {
    await order();
    await refund(9001, "50.00");
    const view = await orderView();
    expect(view.attribution).toMatchObject({ state: "partially_reversed", refunded_cents: 5000, net_cents: 10000 });
    expect((await salesOf("crt_ana")).net_cents).toBe(10000);
  });

  it("o mesmo estorno entregue de novo não abate duas vezes", async () => {
    await order();
    const first = await refund(9001, "50.00");
    const second = await refund(9001, "50.00");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await second.json()) as RefundResult).outcome).toBe("duplicate");
    const view = await orderView();
    expect(view.attribution.refunded_cents).toBe(5000);
    expect(view.refunds).toHaveLength(1);
    expect(view.deliveries.map((delivery) => [delivery.topic, delivery.outcome])).toEqual([
      ["order", "processed"],
      ["refund", "processed"],
      ["refund", "duplicate"],
    ]);
  });

  it("a soma dos estornos nunca passa do valor da venda", async () => {
    await order();
    await refund(9001, "100.00");
    const res = await refund(9002, "100.00");

    expect(((await res.json()) as RefundResult).refund).toMatchObject({ amount_cents: 10000, applied_cents: 5000, capped: true });
    const view = await orderView();
    expect(view.attribution).toMatchObject({ refunded_cents: 15000, net_cents: 0, state: "reversed" });

    await refund(9003, "10.00");
    expect((await orderView()).attribution.refunded_cents).toBe(15000);
    expect((await salesOf("crt_ana")).net_cents).toBe(0);
  });

  it("estorno que chega antes do pedido fica pendente e é aplicado quando o pedido chega", async () => {
    const early = await refund(9001, "50.00");
    expect(early.status).toBe(202);
    expect(((await early.json()) as RefundResult).refund).toMatchObject({ status: "pending", applied_cents: null });
    expect((await app.request("/orders/5001")).status).toBe(404);
    expect(((await (await app.request("/refunds/9001")).json()) as RefundView).status).toBe("pending");

    now = new Date("2026-03-11T15:00:00.000Z");
    const { order: view } = await order();

    expect(view.attribution).toMatchObject({ creator_id: "crt_ana", refunded_cents: 5000, net_cents: 10000 });
    expect(view.refunds).toMatchObject([
      { id: "9001", status: "applied", applied_cents: 5000, received_at: "2026-03-10T15:00:00.000Z", applied_at: "2026-03-11T15:00:00.000Z" },
    ]);
    expect(view.deliveries.map((delivery) => [delivery.topic, delivery.outcome])).toEqual([
      ["refund", "pending"],
      ["order", "processed"],
    ]);
  });

  it("estorno antecipado repetido continua contando uma vez só", async () => {
    await refund(9001, "50.00");
    await refund(9001, "50.00");
    const { order: view } = await order();
    expect(view.attribution.refunded_cents).toBe(5000);
  });

  it("estornos antecipados que somam mais que a venda são limitados ao total", async () => {
    await refund(9001, "100.00");
    await refund(9002, "100.00");
    const { order: view } = await order();
    expect(view.attribution).toMatchObject({ refunded_cents: 15000, net_cents: 0 });
    expect(view.refunds.map((entry) => entry.applied_cents)).toEqual([10000, 5000]);
  });

  it("recusa estorno sem pedido, sem id ou com valor zero", async () => {
    expect((await send("POST", "/webhooks/refunds", { id: 1, amount: "5.00" })).status).toBe(422);
    expect((await send("POST", "/webhooks/refunds", { order_id: 5001, amount: "5.00" })).status).toBe(422);
    expect((await send("POST", "/webhooks/refunds", { id: 1, order_id: 5001, amount: "0.00" })).status).toBe(422);
  });
});

describe("códigos do criador", () => {
  it("não deixa o mesmo cupom pertencer a dois criadores", async () => {
    const res = await send("PUT", "/creators/crt_bruno/codes", { coupons: ["ana10"] });
    expect(res.status).toBe(409);
  });
});
