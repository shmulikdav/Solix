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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const all = argv.includes('--all');
  const tags = all
    ? readdirSync(NOTES_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort()
    : argv.filter((a) => !a.startsWith('--'));

  if (tags.length === 0) {
    console.error('usage: pnpm release:notes [--dry-run] <tag>… | --all');
    process.exit(2);
  }

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
      execFileSync(
        'gh',
        [
          'release',
          'create',
          tag,
          '--repo',
          REPO,
          '--title',
          meta.title,
          '--notes-file',
          file,
          `--latest=${meta.latest}`,
        ],
        { stdio: 'inherit' },
      );
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
