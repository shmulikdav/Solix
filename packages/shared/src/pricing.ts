/**
 * Sprint M — model pricing for the cost-tracking feature.
 *
 * Prices are USD per **million** tokens and are deliberately approximate;
 * they're a starting point you can tune. Solix uses them only to turn the
 * token `usage` Claude already reports in each transcript message into a
 * running dollar estimate per session. Treat the displayed cost as an
 * estimate, not a billing-grade figure.
 *
 * `model` strings arrive in two shapes: the short alias the UI uses
 * (`opus` / `sonnet` / `haiku` / `default`) and the full id Claude writes
 * into transcripts (`claude-opus-4-7`, etc.). `costForUsage` normalizes both.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read input tokens. */
  cacheRead: number;
  /** USD per million cache-write (creation) tokens. */
  cacheWrite: number;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI / Codex (approximate, USD per million tokens) — multi-runtime cost
  // parity. Tune to the model you run.
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
};

/** Map any model string (alias or full id) to a pricing tier. Defaults to
 * sonnet pricing for unknown models — a middle-of-the-road estimate. */
export function pricingFor(model: string | undefined): ModelPrice {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return MODEL_PRICING.opus!;
  if (m.includes('haiku')) return MODEL_PRICING.haiku!;
  // OpenAI / Codex models.
  if (m.includes('gpt-5-mini') || m.includes('mini'))
    return MODEL_PRICING['gpt-5-mini']!;
  if (m.includes('gpt-5') || m.includes('codex') || m.includes('gpt'))
    return MODEL_PRICING['gpt-5']!;
  // sonnet, default, and anything unrecognized fall back to sonnet rates.
  return MODEL_PRICING.sonnet!;
}

/** USD cost of a single assistant message given its token usage + model. */
export function costForUsage(
  model: string | undefined,
  usage: TokenUsage | undefined,
): number {
  if (!usage) return 0;
  const p = pricingFor(model);
  const cost =
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return cost;
}

/** Total tokens in a usage record (used for mission rollups). */
export function totalTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
