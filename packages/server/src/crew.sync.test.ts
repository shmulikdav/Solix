import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The plugin ships copies of the advisor definitions, because a marketplace
 * install reads them straight from GitHub and a symlink would not survive
 * that. Copies drift, and a plugin quietly shipping last month's Sentinel
 * would be worse than shipping no plugin at all — so the drift is a test
 * failure, not something to notice later.
 *
 * Run `pnpm sync:plugin` to fix a failure here.
 */
const SRC = resolve('packages/agents');
const PLUGIN = resolve('plugin/solix-crew/agents');

function advisorNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

describe('solix-crew plugin stays in step with the advisors', () => {
  it('ships every advisor, and only those', () => {
    expect(existsSync(PLUGIN)).toBe(true);
    expect(advisorNames(PLUGIN)).toEqual(advisorNames(SRC));
  });

  it('ships them byte for byte', () => {
    for (const name of advisorNames(SRC)) {
      expect(
        readFileSync(resolve(PLUGIN, name), 'utf8'),
        `${name} differs — run \`pnpm sync:plugin\``,
      ).toBe(readFileSync(resolve(SRC, name), 'utf8'));
    }
  });

  /**
   * The manifest is Solix's own metadata (glyphs, colours, texture packs) and
   * has no meaning to a plugin. Shipping it would imply the plugin reads it.
   */
  it('does not ship Solix-internal metadata', () => {
    expect(readdirSync(PLUGIN)).not.toContain('manifest.json');
  });

  it('every advisor the manifest names has a file in the plugin', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(SRC, 'manifest.json'), 'utf8'),
    ) as { advisors: { id: string; agentMd: string }[] };
    const shipped = new Set(advisorNames(PLUGIN));
    for (const advisor of manifest.advisors) {
      expect(shipped, `${advisor.id} missing from the plugin`).toContain(
        advisor.agentMd,
      );
    }
  });
});
