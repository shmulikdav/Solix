import { describe, expect, it } from 'vitest';
import { pricingFor, MODEL_PRICING } from './pricing.js';

describe('pricingFor — multi-runtime', () => {
  it('routes Claude aliases + ids', () => {
    expect(pricingFor('opus')).toBe(MODEL_PRICING.opus);
    expect(pricingFor('claude-haiku-4-5')).toBe(MODEL_PRICING.haiku);
    expect(pricingFor('sonnet')).toBe(MODEL_PRICING.sonnet);
  });
  it('routes OpenAI / Codex models', () => {
    expect(pricingFor('gpt-5-codex')).toBe(MODEL_PRICING['gpt-5']);
    expect(pricingFor('gpt-5-mini')).toBe(MODEL_PRICING['gpt-5-mini']);
  });
  it('falls back to sonnet for the unknown', () => {
    expect(pricingFor('who-knows')).toBe(MODEL_PRICING.sonnet);
  });
});
