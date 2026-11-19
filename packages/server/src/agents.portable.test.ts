import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CLAIM-ADVISORS-PORTABLE. The advisors Solix installs into
 * `~/.claude/agents` work on the user's project, not on Solix's.
 *
 * Found on 2026-11-19 while answering an outside tester's note that the
 * site's opt-in advisor cards looked unfinished: the prompts themselves had
 * been written for this repository. Sentinel, on by default, reviewed
 * "Solix's attack surface — it patches ~/.claude/settings.json, runs a server
 * on 127.0.0.1:4242". Helios aimed for "60fps with 20 simultaneous planets";
 * Lumen tuned "the solar-system scene" in `packages/web/src/scene/`; Forge
 * ran `pnpm -r typecheck` and guarded `packages/server/src/router.ts`. Every
 * user got them, and on any other project they reviewed the wrong product.
 *
 * Each pattern is a fingerprint of this repository's internals. Mentioning
 * Solix itself is fine — the advisors are Solix's crew, and Compass reads
 * the user's own missions from the local Solix API.
 */
const AGENTS = resolve('packages/agents');

const SOLIX_INTERNALS: [RegExp, string][] = [
  [/packages\/(server|web|cli|shared|skills|agents)\b/, 'a path inside this repository'],
  [/\bR3F\b|useFrame|InstancedMesh|react-three/i, 'the galaxy renderer'],
  [/solar[- ]system scene|asteroid belt|\bHUD\b/i, "Solix's own UI"],
  [/60\s?fps|simultaneous planets/i, "Solix's own performance target"],
  [/router\.ts|db\.ts|ensureColumn|broadcaster/i, "Solix's own modules"],
  [/pnpm -r\b/, "this repository's build command"],
  [/@shmulikdav\/solix/, "Solix's own npm package"],
  [/Solix's (attack|security) surface|patches `?~\/\.claude\/settings\.json/i, "Solix's own security review"],
  [/\bthe PRD\b/i, "Solix's own PRD"],
  [/\(Pro\)|build-studio/i, 'a paid tier that does not exist'],
];

function shipped(): [string, string][] {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith('.md') || f === 'manifest.json');
  return files.map((f) => [f, readFileSync(resolve(AGENTS, f), 'utf8')]);
}

describe('CLAIM-ADVISORS-PORTABLE: the shipped advisors are about your project', () => {
  it.each(SOLIX_INTERNALS.map(([re, what]) => [what, re] as const))(
    'no advisor or manifest entry refers to %s',
    (_what, re) => {
      const hits = shipped()
        .filter(([, text]) => re.test(text))
        .map(([file, text]) => `${file}: ${text.match(re)?.[0]}`);
      expect(hits).toEqual([]);
    },
  );

  it('still ships all fifteen, so the patterns above are checking something', () => {
    expect(shipped().filter(([f]) => f.endsWith('.md'))).toHaveLength(15);
  });
});
