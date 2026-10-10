import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/vendas.sqlite");
const port = Number(process.env.PORT ?? 3005);
const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || undefined;

serve({ fetch: createApp(db, undefined, webhookSecret).fetch, port }, (info) => {
  console.log(`vendas atribuídas em http://127.0.0.1:${info.port}`);
  if (!webhookSecret) console.warn("SHOPIFY_WEBHOOK_SECRET não definido: os webhooks estão sem verificação de assinatura");
});
