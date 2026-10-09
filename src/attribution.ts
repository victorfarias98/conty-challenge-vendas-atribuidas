export type AttributionRule = "coupon" | "utm" | "coupon_over_utm" | "none";

export type Attribution = {
  creator_id: string | null;
  rule: AttributionRule;
  reason: string;
};

// A regra de atribuição mora só aqui. Uma venda vai para no máximo um criador.
//
// Desempate: quando cupom e UTM apontam para criadores diferentes, o cupom vence.
// O cupom é digitado pelo comprador no checkout, um ato deliberado e ligado ao pedido.
// A UTM é o último link clicado e pode ter sido sobrescrita por qualquer clique no caminho.
export function attributeSale(input: {
  couponCreatorId: string | null;
  utmCreatorId: string | null;
}): Attribution {
  const { couponCreatorId, utmCreatorId } = input;
  if (couponCreatorId && utmCreatorId && couponCreatorId !== utmCreatorId) {
    return {
      creator_id: couponCreatorId,
      rule: "coupon_over_utm",
      reason: `cupom aponta para ${couponCreatorId} e UTM para ${utmCreatorId}; o cupom vence`,
    };
  }
  if (couponCreatorId) {
    return { creator_id: couponCreatorId, rule: "coupon", reason: "cupom do criador usado no pedido" };
  }
  if (utmCreatorId) {
    return { creator_id: utmCreatorId, rule: "utm", reason: "pedido sem cupom de criador; UTM do criador no link" };
  }
  return { creator_id: null, rule: "none", reason: "nem cupom nem UTM do pedido pertencem a um criador" };
}
