import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { type Clock, type Outcome, SalesError, createSales } from "./sales.ts";
import { SIGNATURE_HEADER, isSignedBy } from "./signature.ts";

// processed criou algo, duplicate não mudou nada, pending guardou o estorno à espera do pedido.
const STATUS_BY_OUTCOME: Record<Outcome, 200 | 201 | 202> = { processed: 201, duplicate: 200, pending: 202 };

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

// Sem webhookSecret os webhooks não são verificados: serve para rodar local e para os testes da regra.
export function createApp(db: DatabaseSync, clock: Clock = () => new Date(), webhookSecret?: string) {
  const sales = createSales(db, clock);
  const app = new Hono();

  app.use("/webhooks/*", async (c, next) => {
    if (!webhookSecret) return next();
    // A assinatura cobre o corpo cru, então ela é conferida antes de qualquer leitura como JSON.
    if (!isSignedBy(webhookSecret, await c.req.text(), c.req.header(SIGNATURE_HEADER))) {
      throw new SalesError(401, "signature_invalid", "assinatura do webhook ausente ou inválida");
    }
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof SalesError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.put("/creators/:id/codes", async (c) => {
    sales.registerCodes(c.req.param("id"), await jsonBody(c));
    return c.json({ creator_id: c.req.param("id") });
  });

  app.get("/creators/:id/sales", (c) => c.json(sales.creatorSales(c.req.param("id"))));

  app.post("/webhooks/orders", async (c) => {
    const result = sales.ingestOrder(await jsonBody(c));
    return c.json(result, STATUS_BY_OUTCOME[result.outcome]);
  });

  app.post("/webhooks/refunds", async (c) => {
    const result = sales.ingestRefund(await jsonBody(c));
    return c.json(result, STATUS_BY_OUTCOME[result.outcome]);
  });

  app.get("/orders/:id", (c) => c.json(sales.orderView(c.req.param("id"))));

  app.get("/refunds/:id", (c) => c.json(sales.refundById(c.req.param("id"))));

  return app;
}
