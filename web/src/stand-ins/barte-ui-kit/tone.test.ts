import { describe, expect, it } from "vitest";
import { toneColor, type Tone } from "./tone";

describe("#53/AC-2 tone, as cores dos tons do kit", () => {
  it("#53/AC-2: cada tom tem uma cor que é um token do design system", () => {
    const tones: Tone[] = ["neutral", "positive", "waiting", "negative", "info"];
    expect(Object.keys(toneColor).sort()).toEqual([...tones].sort());
    for (const tone of tones) expect(toneColor[tone]).toMatch(/^var\(--[a-z-]+\)$/);
  });
});
