import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-shopify-hmac-sha256";

// A Shopify assina o corpo cru com HMAC-SHA256 e manda o resultado em base64.
// A comparação é em tempo constante, para o tempo de resposta não revelar a assinatura certa.
export function isSignedBy(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const received = Buffer.from(signature, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
