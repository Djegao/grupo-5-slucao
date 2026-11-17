const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Reais (não centavos) em `R$ 1.234,56`. */
export function formatCurrency(reais: number): string {
  return BRL.format(reais);
}

/** `2026-11-10` (com ou sem hora) em `10/11/2026`, sem passar por fuso. Texto que não é data volta como veio. */
export function formatIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}
