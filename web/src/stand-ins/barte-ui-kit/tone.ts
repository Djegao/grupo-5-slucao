/** O tom de um selo, de um número ou de uma barra: o mesmo vocabulário do kit real (`@barte-ai-services/barte-ui-kit`). */
export type Tone = "neutral" | "positive" | "waiting" | "negative" | "info";

/** A cor de cada tom, por token do design system, para quem pinta uma série de gráfico. */
export const toneColor: Record<Tone, string> = {
  neutral: "var(--content-secondary)",
  positive: "var(--accent-green)",
  waiting: "var(--accent-yellow)",
  negative: "var(--accent-red)",
  info: "var(--accent-blue)",
};
