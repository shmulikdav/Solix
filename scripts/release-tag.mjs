#!/usr/bin/env node
/**
 * `pnpm release:tag` — tag a release, refusing every way we have got it wrong.
 *
 * Pushing the tag IS publishing: `.github/workflows/publish.yml` fires on
 * `v*` and runs `npm publish`. It does not run tests, and npm only allows an
 * unpublish within 72 hours. So the checks belong here, before the push.
 *
 * Three real failures this exists to prevent, all of which happened:
 *
 * 1. **Tagged before the version bump was on main.** The tag is only a
 *    pointer — named v1.14.0 while pointing at a commit whose package.json
 *    said 1.13.0, so the workflow built 1.13.0 and npm refused it. Twice.
 * 2. **A stale remote-tracking ref.** `git pull origin main` updates main and
 *    nothing else, so merging `origin/<branch>` silently did nothing and the
 *    bump never landed. Hence the unconditional `git fetch`.
 * 3. **A check that did not gate anything.** `node -p ...version` printed the
 *    wrong number and the next line tagged anyway, because they were separate
 *    statements. Here the checks and the push are one program.
 *
 * Usage:
 *   pnpm release:tag              # check, confirm, tag, push
 *   pnpm release:tag --dry-run    # check and print, touch nothing
 *   pnpm release:tag --retag      # move an existing tag that published nothing
 *   pnpm release:tag --yes        # skip the confirmation prompt
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` only exists from Node 20.11, and package.json declares
// `node >= 20` — so using it crashed this script with an unreadable
// ERR_INVALID_ARG_TYPE on a supported runtime. fileURLToPath works everywhere.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = resolve(ROOT, 'packages/cli/package.json');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');
const RELEASE_BRANCH = 'main';

const C = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  ok: '\x1b[32m',
  red: '\x1b[31m',
  warn: '\x1b[33m',
};

/** Every `## [x.y.z]` heading in the changelog, in file order. */
export function parseChangelogVersions(changelog) {
  return [...changelog.matchAll(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/gm)].map((m) => m[1]);
}

/**
 * The whole decision, as a pure function of facts — so it can be tested
 * without a git repo, an npm registry or a release to burn.
 *
 * Returns every problem rather than the first, because finding out about the
 * second one on the next run is how a five-minute release becomes twenty.
 */
export function checkRelease(facts) {
  const problems = [];
  const {
    version,
    dirty,
    branch,
    localSha,
    remoteSha,
    changelogVersions,
    publishedVersions,
    existingTagSha,
    headSha,
    retag,
  } = facts;

  if (dirty) {
    problems.push('the working tree has uncommitted changes — commit or stash them first');
  }
  if (branch !== RELEASE_BRANCH) {
    problems.push(`on branch "${branch}", not ${RELEASE_BRANCH} — releases are cut from ${RELEASE_BRANCH}`);
  }
  if (localSha !== remoteSha) {
    problems.push(
      `${RELEASE_BRANCH} is not in sync with origin/${RELEASE_BRANCH} (local ${localSha.slice(0, 7)}, remote ${remoteSha.slice(0, 7)}) — ` +
        'push or pull first, or the tag will point at a commit nobody else has',
    );
  }
  if (!changelogVersions.includes(version)) {
    problems.push(
      `CHANGELOG.md has no "## [${version}]" section — either the entry is missing, ` +
        'or the version was never bumped and this would publish the previous release',
    );
  }
  if (publishedVersions.includes(version)) {
    problems.push(
      `${version} is already on npm — bump packages/cli/package.json, because npm refuses to republish a version`,
    );
  }
  if (existingTagSha && existingTagSha !== headSha && !retag) {
    problems.push(
      `tag v${version} already exists at ${existingTagSha.slice(0, 7)}, not ${headSha.slice(0, 7)} — ` +
        'pass --retag to move it, but only if it published nothing',
    );
  }
  return { ok: problems.length === 0, problems };
}

// ─────────────────────────── IO below this line ───────────────────────────

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * The sha a tag resolves to, or null when it does not exist.
 *
 * stderr is swallowed: an absent tag is the ordinary case for a new release,
 * and git's "fatal: ambiguous argument 'v1.15.0'" printed above a clean run
 * reads like the failure rather than the expected path.
 */
function tagSha(tag) {
  try {
    return execFileSync('git', ['rev-list', '-n', '1', tag], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function publishedVersions(name) {
  try {
    return JSON.parse(
      execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8' }),
    );
  } catch {
    // A package that has never been published, or a registry we cannot reach.
    // Not a reason to block: npm itself refuses a duplicate, and this check is
    // here to give a better message than a failed CI run, not to be the gate.
    return [];
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const retag = args.has('--retag');
  const assumeYes = args.has('--yes') || args.has('-y');

  // Unconditional, and first: failure #2 was a ref that was never refreshed.
  console.log(`${C.dim}fetching origin…${C.reset}`);
  git('fetch', 'origin', '--tags', '--force', '--quiet');

  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const headSha = git('rev-parse', 'HEAD');

  const facts = {
    version,
    dirty: git('status', '--porcelain') !== '',
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    localSha: headSha,
    remoteSha: git('rev-parse', `origin/${RELEASE_BRANCH}`),
    changelogVersions: parseChangelogVersions(readFileSync(CHANGELOG, 'utf8')),
    publishedVersions: publishedVersions(pkg.name),
    existingTagSha: tagSha(tag),
    headSha,
    retag,
  };

  const { ok, problems } = checkRelease(facts);

  console.log(`\n${C.bold}${pkg.name} ${version}${C.reset} ${C.dim}→ ${tag} at ${headSha.slice(0, 7)}${C.reset}`);

  if (!ok) {
    console.error(`\n${C.red}✗ not releasing:${C.reset}`);
    for (const p of problems) console.error(`  ${C.red}·${C.reset} ${p}`);
    process.exit(1);
  }

  console.log(`${C.ok}✓${C.reset} tree clean, on ${RELEASE_BRANCH}, in sync with origin`);
  console.log(`${C.ok}✓${C.reset} CHANGELOG has a [${version}] section`);
  console.log(`${C.ok}✓${C.reset} ${version} is not on npm yet`);
  if (facts.existingTagSha && retag) {
    console.log(`${C.warn}!${C.reset} moving existing tag ${tag} from ${facts.existingTagSha.slice(0, 7)}`);
  }

  if (dryRun) {
    console.log(`\n${C.dim}--dry-run: nothing was tagged or pushed.${C.reset}`);
    return;
  }

  console.log(
    `\n${C.warn}Pushing ${tag} publishes ${pkg.name}@${version} to npm.${C.reset}\n` +
      `${C.dim}The workflow does NOT run tests. npm allows an unpublish for 72 hours.${C.reset}`,
  );

  if (!assumeYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Type ${C.bold}${version}${C.reset} to confirm: `)).trim();
    rl.close();
    if (answer !== version) {
      console.error(`${C.red}✗${C.reset} did not match — nothing was tagged.`);
      process.exit(1);
    }
  }

  if (facts.existingTagSha && retag) {
    try {
      git('push', 'origin', `:refs/tags/${tag}`);
    } catch {
      /* already gone from the remote */
    }
    git('tag', '-d', tag);
  }
  git('tag', '-a', tag, '-m', `${tag} — ${pkg.name} ${version}`);
  git('push', 'origin', tag);

  console.log(`\n${C.ok}✓${C.reset} pushed ${tag}. Publishing: ${C.dim}gh api repos/:owner/:repo/actions/runs${C.reset}`);
  console.log(`${C.dim}  Confirm with: npm view ${pkg.name} version   (allow a minute or two)${C.reset}`);
}

// Only run when invoked directly, so the tests can import the predicates.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`${C.red}✗${C.reset} ${err.message}`);
    process.exit(1);
  });
}
