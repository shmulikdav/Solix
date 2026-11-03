#!/usr/bin/env node
/**
 * `pnpm release:notes <tag>…` — write a release body to GitHub from a file.
 *
 * ## The failure this exists to prevent
 *
 * Three releases were published with their markdown stripped. Measured on
 * 2026-11-02, source file against what GitHub was serving:
 *
 *   v1.18.3   8 headings → 0   50 bold → 2   42 code spans → 0   8 bullets → 0
 *   v1.18.0   4 headings → 0   10 bold → 0   48 code spans → 0
 *   v1.17.0   2 headings → 0   10 bold → 0   10 code spans → 0
 *
 * v1.16.0 and earlier were intact, which is what ruled out the API: all six
 * came back from one request. The cause was the paste — copying from rendered
 * text carries the words and not the markers. Stripping the markup from both
 * sides and comparing word by word gave 981 words on each side for v1.18.3,
 * identical, so nothing but structure had been lost.
 *
 * It was not cosmetic. v1.18.3 renders as one undifferentiated wall of text,
 * and the ⚠️ notice that *the release zeroes every recorded figure* sits in
 * the middle of it as a plain paragraph. That is the release where a reader
 * most needs to find that warning.
 *
 * So the body is never typed, pasted or interpolated into an argument. It is
 * handed to `gh` as a file, and `--notes-file` sends the file's bytes.
 *
 * ## The notes live in the repository
 *
 * They used to live wherever the release happened to be cut, which meant a
 * v1.18.0 body that took twenty minutes to find and was nearly rewritten from
 * the stripped published copy instead. `docs/releases/<tag>.md` is now the
 * source of truth, with the tag, title and latest-flag in front matter so a
 * release's facts travel in one file.
 *
 *   pnpm release:notes --dry-run v1.18.1   validate and print, touch nothing
 *   pnpm release:notes v1.18.1             create it, or replace its body
 *   pnpm release:notes --all               every file in docs/releases/
 *
 * Creating a release needs a GitHub token with `contents: write`. A Claude
 * Code cloud session cannot do it — its proxy answers *"Creating, editing, or
 * deleting releases is not permitted for this session type"* — so this is run
 * from a machine with the GitHub CLI authenticated.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTES_DIR = join(ROOT, 'docs', 'releases');
const REPO = 'shmulikdav/Solix';

/**
 * Split `---` front matter from the body.
 *
 * Returns the body with no leading blank lines, because GitHub renders a
 * leading blank as an empty paragraph above the first sentence.
 */
export function parseNotes(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('no front matter — expected a --- block with tag, title, latest');

  const meta = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) throw new Error(`front matter line is not key: value — ${JSON.stringify(line)}`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  for (const key of ['tag', 'title', 'latest']) {
    if (!meta[key]) throw new Error(`front matter is missing ${key}`);
  }
  if (meta.latest !== 'true' && meta.latest !== 'false') {
    throw new Error(`latest must be true or false, got ${JSON.stringify(meta.latest)}`);
  }

  const body = text.slice(match[0].length).replace(/^\n+/, '').trimEnd();
  if (!body) throw new Error('body is empty');
  return { meta, body: `${body}\n` };
}

/**
 * What the body carries, so a dry run reports something that would catch the
 * exact regression: a stripped paste reads 0 / 0 / 0 here.
 */
export function markers(body) {
  const lines = body.split('\n');
  return {
    headings: lines.filter((l) => l.startsWith('#')).length,
    bold: (body.match(/\*\*/g) ?? []).length,
    code: (body.match(/`/g) ?? []).length,
    bullets: lines.filter((l) => l.startsWith('- ')).length,
  };
}

function load(tag) {
  const path = join(NOTES_DIR, `${tag}.md`);
  const { meta, body } = parseNotes(readFileSync(path, 'utf8'));
  // The filename is what the caller named; the front matter is what the file
  // claims. A mismatch means one release's body is about to be written over
  // another's, which is the kind of thing that is obvious only afterwards.
  if (meta.tag !== tag) {
    throw new Error(`${path} declares tag ${meta.tag} but is named ${tag}.md`);
  }
  return { path, meta, body };
}

const TAG_SHAPE = /^v\d+\.\d+\.\d+$/;
const FLAGS = new Set(['--dry-run', '--all']);

/**
 * Read the arguments and refuse the whole run if any of them is wrong —
 * before a single request is sent.
 *
 * Measured on 2026-11-03: `pnpm release:notes v1.20.0 # creates the release`
 * was pasted into zsh, which does not treat `#` as a comment interactively.
 * The script created the v1.20.0 release, then crashed on the argument `#`.
 * Each argument was only looked at when its turn came, so the good one acted
 * before the bad one was noticed. Now every argument is checked first: a tag
 * is `vX.Y.Z` with a notes file in docs/releases/, a flag is one this script
 * knows, and anything else stops the run with nothing sent.
 */
export function readArgs(argv, notesDir = NOTES_DIR) {
  const bad = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) bad.push(`${a} is not an option (--dry-run, --all)`);
    } else if (!TAG_SHAPE.test(a)) {
      bad.push(`${JSON.stringify(a)} is not a release tag (vX.Y.Z)`);
    } else if (!existsSync(join(notesDir, `${a}.md`))) {
      bad.push(`${a} has no notes file at docs/releases/${a}.md`);
    }
  }
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const named = argv.filter((a) => !a.startsWith('--'));
  if (all && named.length > 0) bad.push('--all takes no tags');
  if (bad.length > 0) return { ok: false, errors: bad };
  const tags = all
    ? readdirSync(notesDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort()
    : named;
  if (tags.length === 0) return { ok: false, errors: ['no tag given'] };
  return { ok: true, dryRun, tags };
}

/**
 * The `gh release create` arguments.
 *
 * `--verify-tag` is the point. Without it, `gh release create` for a tag that
 * does not exist yet creates the tag at the default branch — and pushing a
 * `v*` tag runs the npm publish workflow. That is how v1.20.0 was published on
 * 2026-11-03: by this script, not by `pnpm release:tag`, whose checks and
 * confirmation it skipped. Writing a release body must never publish a
 * package, so a release is only ever created for a tag that already exists.
 */
export function createArgs(tag, meta, file) {
  return [
    'release',
    'create',
    tag,
    '--repo',
    REPO,
    '--verify-tag',
    '--title',
    meta.title,
    '--notes-file',
    file,
    `--latest=${meta.latest}`,
  ];
}

function releaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.ok) {
    for (const e of args.errors) console.error(`release:notes: ${e}`);
    console.error('usage: pnpm release:notes [--dry-run] <tag>… | --all');
    console.error('nothing was sent.');
    process.exit(2);
  }
  const { dryRun, tags } = args;

  // Every file parses before anything is sent, for the same reason.
  for (const tag of tags) load(tag);

  const scratch = dryRun ? null : mkdtempSync(join(tmpdir(), 'solix-notes-'));

  for (const tag of tags) {
    const { meta, body } = load(tag);
    const m = markers(body);
    const shape = `headings=${m.headings} bold=${m.bold} code=${m.code} bullets=${m.bullets}`;

    if (dryRun) {
      // Deliberately does not ask GitHub anything, so this half is verifiable
      // on a machine with no `gh` and no network.
      console.log(`${tag}  ${body.length} bytes  ${shape}`);
      console.log(`  title : ${meta.title}`);
      console.log(`  latest: ${meta.latest}`);
      continue;
    }

    const file = join(scratch, `${tag}.md`);
    writeFileSync(file, body);

    if (releaseExists(tag)) {
      // Body only. The titles of already-published releases are correct and
      // are not ours to rewrite from a file that may carry a working subtitle.
      execFileSync('gh', ['release', 'edit', tag, '--repo', REPO, '--notes-file', file], {
        stdio: 'inherit',
      });
      console.log(`edited  ${tag}  ${shape}`);
    } else {
      try {
        execFileSync('gh', createArgs(tag, meta, file), { stdio: 'inherit' });
      } catch {
        console.error(
          `release:notes: could not create ${tag}. If the tag does not exist yet, run \`pnpm release:tag\` first —` +
            ' this script writes release notes and never creates a tag.',
        );
        process.exit(1);
      }
      console.log(`created ${tag}  ${shape}`);
    }
  }

  if (!dryRun) {
    console.log('\nVerify what GitHub now serves, not what was sent:');
    console.log(`  gh release view ${tags[0]} --repo ${REPO} | head -30`);
  }
}

if (process.argv[1]?.endsWith('publish-release-notes.mjs')) {
  main();
}
