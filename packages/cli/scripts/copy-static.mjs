import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const repoRoot = resolve(cliRoot, '..', '..');
const distRoot = join(cliRoot, 'dist');

const trees = [
  {
    label: 'hooks',
    src: join(cliRoot, 'hooks'),
    dst: join(distRoot, 'hooks'),
    fatal: true,
  },
  {
    label: 'web',
    src: join(repoRoot, 'packages', 'web', 'dist'),
    dst: join(distRoot, 'web'),
    fatal: true,
  },
  {
    label: 'agents',
    src: join(repoRoot, 'packages', 'agents'),
    dst: join(distRoot, 'agents'),
    fatal: true,
  },
  {
    label: 'skills',
    src: join(repoRoot, 'packages', 'skills'),
    dst: join(distRoot, 'skills'),
    fatal: true,
  },
];

for (const { label, src, dst, fatal } of trees) {
  if (!existsSync(src)) {
    const msg = `[copy-static] source missing: ${src} — run \`pnpm -r build\` first`;
    if (fatal) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
    continue;
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-static] ${label}: ${src} -> ${dst}`);
}

// ── Texture presence check ────────────────────────────────────────────
// Planet/sky textures are deliberately NOT committed (binary assets); they are
// downloaded on demand by `pnpm --filter @solix/web prepare-assets`. That makes
// their presence untracked local state, so a fresh clone, a CI build, or a
// publish from a machine that never ran the fetch script would quietly ship a
// texture-less bundle. The scene degrades to its procedural look (and no longer
// crashes — see ErrorBoundary), but shipping it unintentionally is still worth
// a loud warning rather than a silent surprise.
{
  const texDir = join(distRoot, 'web', 'textures');
  const present = existsSync(texDir)
    ? readdirSync(texDir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    : [];
  if (present.length === 0) {
    console.warn(
      '[copy-static] ⚠ no planet textures in the bundle — the galaxy will render\n' +
        '              in its procedural (untextured) look. To include them:\n' +
        '                pnpm --filter @solix/web prepare-assets && pnpm -r build',
    );
  } else {
    console.log(`[copy-static] textures: ${present.length} present`);
  }
}
