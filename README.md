# Conty. Vendas atribuídas ao criador

Recebe pedidos e estornos de uma loja por webhook, atribui cada venda a no máximo um criador (por cupom ou UTM) e reverte a atribuição quando o pedido é estornado, sem apagar nada.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3005` e grava em `data/vendas.sqlite` (`PORT` e `DB_PATH` mudam isso). Não conecta em loja nenhuma: os webhooks são chamados à mão ou pelos testes.

## Por onde ler

1. `src/attribution.ts`: a regra de atribuição, inteira, em uma função pura.
2. `src/sales.ts`: ingestão de pedido e de estorno, idempotência e o teto dos estornos.
3. `test/sales.test.ts`: duplicado, estorno parcial, repetido, acima do total e antes do pedido.
4. `src/db.ts` e `src/app.ts`: schema e HTTP.

## Regra de atribuição

Fica só em `attributeSale` (`src/attribution.ts`):

1. O cupom do pedido pertence a um criador: a venda é dele.
2. Não há cupom de criador, mas o `utm.content` do link pertence a um: a venda é dele.
3. Nenhum dos dois: a venda fica gravada como não atribuída, com o motivo.

**Desempate:** quando cupom e UTM apontam para criadores diferentes, **o cupom vence**. O cupom é digitado pelo comprador no checkout, um ato deliberado e preso ao pedido. A UTM é só o último link clicado e pode ter sido sobrescrita por qualquer clique no caminho. A regra aplicada (`coupon`, `utm`, `coupon_over_utm`, `none`) e o motivo ficam gravados no pedido.

A atribuição é decidida uma vez, quando o pedido chega, e não é recalculada depois.

## Idempotência

- **Pedido:** a chave é o `id` do pedido. A segunda entrega responde `200` com `outcome: "duplicate"` e não soma, não reatribui e não muda o valor, mesmo que o corpo venha diferente.
- **Estorno:** a chave é o `id` do estorno. O mesmo estorno entregue de novo não abate duas vezes.
- Toda entrega, inclusive a repetida, fica em `deliveries` na consulta do pedido.

## Estorno

- **Parcial:** abate só o valor estornado. O pedido passa a `partially_reversed`.
- **Total:** `net_cents` vai a zero e o estado vira `reversed`. O pedido, o criador, a regra e os estornos continuam lá.
- **Teto:** cada estorno aplica no máximo o que ainda resta da venda. Se pedir mais, `applied_cents` fica menor que `amount_cents` e `capped` vem `true`. A soma aplicada nunca passa do total.
- **Antes do pedido:** o estorno é gravado como `pending` e responde `202`. Quando o pedido chega, os pendentes são aplicados na ordem em que chegaram, com o mesmo teto. `received_at` e `applied_at` mostram as duas datas.

## API

| Rota | Faz |
|---|---|
| `PUT /creators/:id/codes` | registra cupons e `utm_contents` do criador |
| `POST /webhooks/orders` | recebe o pedido |
| `POST /webhooks/refunds` | recebe o estorno |
| `GET /orders/:id` | pedido, atribuição, estornos e entregas recebidas |
| `GET /refunds/:id` | um estorno, inclusive pendente |
| `GET /creators/:id/sales` | total bruto, estornado e líquido do criador |

Os webhooks respondem `201` quando processam, `200` quando é repetição e `202` quando o estorno ficou pendente. Entrada inválida responde `422` com `{ "error": { "code", "message" } }`.

### Exemplos

Pedido (o essencial de um pedido Shopify; valores em texto decimal):

```bash
curl -s -X PUT localhost:3005/creators/crt_ana/codes \
  -H 'content-type: application/json' -d '{"coupons":["ANA10"],"utm_contents":["ana"]}'

curl -s -X POST localhost:3005/webhooks/orders -H 'content-type: application/json' -d '{
  "id": 5001,
  "total_price": "150.00",
  "currency": "BRL",
  "financial_status": "paid",
  "discount_codes": [{ "code": "ANA10" }],
  "utm": { "source": "conty", "medium": "creator", "campaign": "verao", "content": "bruno" }
}'
```

Estorno parcial e a consulta depois dele:

```bash
curl -s -X POST localhost:3005/webhooks/refunds \
  -H 'content-type: application/json' -d '{"id":9001,"order_id":5001,"amount":"50.00"}'

curl -s localhost:3005/orders/5001
```

```json
{
  "order": {
    "id": "5001",
    "total_cents": 15000,
    "currency": "BRL",
    "financial_status": "paid",
    "coupon_codes": ["ana10"],
    "utm_content": "bruno",
    "received_at": "2026-03-10T15:00:00.000Z"
  },
  "attribution": {
    "creator_id": "crt_ana",
    "rule": "coupon_over_utm",
    "reason": "cupom aponta para crt_ana e UTM para crt_bruno; o cupom vence",
    "state": "partially_reversed",
    "gross_cents": 15000,
    "refunded_cents": 5000,
    "net_cents": 10000
  },
  "refunds": [
    {
      "id": "9001",
      "order_id": "5001",
      "amount_cents": 5000,
      "applied_cents": 5000,
      "status": "applied",
      "received_at": "2026-03-14T15:00:00.000Z",
      "applied_at": "2026-03-14T15:00:00.000Z",
      "capped": false
    }
  ],
  "deliveries": [
    { "topic": "order", "resource_id": "5001", "outcome": "processed", "received_at": "2026-03-10T15:00:00.000Z" },
    { "topic": "refund", "resource_id": "9001", "outcome": "processed", "received_at": "2026-03-14T15:00:00.000Z" }
  ]
}
```

## O que ficou de fora

- **Assinatura do webhook.** Não há verificação de HMAC; qualquer um que alcance a rota grava pedido.
- **`financial_status` não muda a conta.** O campo é gravado, mas um pedido `pending` soma igual a um `paid`. Só o webhook de estorno reverte.
- **Atualização de pedido.** A primeira entrega vence; não há tratamento para pedido editado depois.
- **Estorno pendente que nunca encontra pedido** fica pendente para sempre; não há alerta nem expiração.
- **UTM só por `utm.content`.** O pedido real da Shopify traz a UTM dentro de `landing_site` ou `note_attributes`; aqui ela chega já separada.
- **Moeda única.** `currency` é gravada, mas os totais do criador somam centavos sem converter.
- Autenticação, paginação e concorrência entre processos.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. A regra de desempate e as decisões acima foram propostas pela IA.

O que eu revisei: <preencher antes de enviar, só com o que foi de fato conferido>.
