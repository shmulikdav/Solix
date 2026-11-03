import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-expect-error — a plain .mjs script, imported for its pure predicates.
import { createArgs, markers, parseNotes, readArgs } from '../../../scripts/publish-release-notes.mjs';

/**
 * v1.17.0, v1.18.0 and v1.18.3 were all published with their markdown
 * stripped — 0 headings, 0 code spans, 0 bullets — because the body was
 * pasted from rendered text, which carries the words and not the markers.
 *
 * `markers()` is what a dry run prints, so these are the assertions that make
 * a stripped body visible before it reaches GitHub rather than after.
 */
const NOTES_DIR = resolve(import.meta.dirname, '../../../docs/releases');

const frontMatter = (over: Record<string, string> = {}): string => {
  const meta = { tag: 'v1.2.3', title: 'v1.2.3 — a thing', latest: 'false', ...over };
  return `---\n${Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n`;
};

describe('parseNotes', () => {
  it('reads the tag, title and latest flag, and returns the body', () => {
    const { meta, body } = parseNotes(`${frontMatter()}\n## Fixed\n\nSomething.\n`);
    expect(meta).toEqual({ tag: 'v1.2.3', title: 'v1.2.3 — a thing', latest: 'false' });
    expect(body).toBe('## Fixed\n\nSomething.\n');
  });

  /**
   * GitHub renders a leading blank line as an empty paragraph above the first
   * sentence, and the front matter is always followed by one.
   */
  it('does not leave the blank line after the front matter in the body', () => {
    const { body } = parseNotes(`${frontMatter()}\n\n\nFirst sentence.\n`);
    expect(body.startsWith('First sentence.')).toBe(true);
  });

  it('refuses a file with no front matter, rather than posting it as a body', () => {
    expect(() => parseNotes('## Fixed\n\nSomething.\n')).toThrow(/front matter/);
  });

  it.each(['tag', 'title', 'latest'])('refuses a file missing %s', (key) => {
    const fm = frontMatter();
    const without = fm
      .split('\n')
      .filter((l) => !l.startsWith(`${key}:`))
      .join('\n');
    expect(() => parseNotes(`${without}\nBody.\n`)).toThrow(new RegExp(key));
  });

  /**
   * `--latest=maybe` would reach `gh` as an argument and be rejected there, or
   * worse, be accepted as falsy and quietly move the Latest badge off the
   * current release.
   */
  it('refuses a latest flag that is not true or false', () => {
    expect(() => parseNotes(`${frontMatter({ latest: 'yes' })}\nBody.\n`)).toThrow(/true or false/);
  });

  it('refuses an empty body, which would blank a published release', () => {
    expect(() => parseNotes(`${frontMatter()}\n\n`)).toThrow(/empty/);
  });
});

describe('markers', () => {
  it('counts the markup that a paste destroys', () => {
    const body = '## Heading\n\n- a bullet\n- another\n\n**bold** and `code`.\n';
    expect(markers(body)).toEqual({ headings: 1, bold: 2, code: 2, bullets: 2 });
  });

  /**
   * The regression itself. This is the shape all three published bodies had:
   * every word present, every marker gone. A dry run showing zeros is the
   * signal that the file has been flattened.
   */
  it('reports zero for a body that has been stripped of its markup', () => {
    const stripped = 'Heading\n\na bullet\nanother\n\nbold and code.\n';
    expect(markers(stripped)).toEqual({ headings: 0, bold: 0, code: 0, bullets: 0 });
  });
});

/**
 * The notes in the repository are the ones that get published, so they are
 * part of the assertion rather than fixtures for it.
 */
describe('docs/releases', () => {
  const files = readdirSync(NOTES_DIR).filter((f) => f.endsWith('.md'));

  it('has notes for every release that has been published', () => {
    expect(files.sort()).toEqual(['v1.17.0.md', 'v1.18.0.md', 'v1.18.1.md', 'v1.18.3.md', 'v1.20.0.md']);
  });

  it.each(files)('%s parses and carries its markup', (file) => {
    const { meta, body } = parseNotes(readFileSync(resolve(NOTES_DIR, file), 'utf8'));
    expect(`${meta.tag}.md`).toBe(file);
    expect(meta.title).toContain(meta.tag);

    // Every one of these notes has sections and code spans. Zero here means a
    // file was flattened in the repository, where it is cheap to notice.
    const m = markers(body);
    expect(m.headings).toBeGreaterThan(0);
    expect(m.code).toBeGreaterThan(0);
  });

  /** Exactly one release wears the Latest badge, and it is the newest. */
  it('marks only the newest release as latest', () => {
    const latest = files.filter(
      (f) => parseNotes(readFileSync(resolve(NOTES_DIR, f), 'utf8')).meta.latest === 'true',
    );
    expect(latest).toEqual(['v1.20.0.md']);
  });
});

/**
 * 2026-11-03: `pnpm release:notes v1.20.0 # creates the release` was pasted
 * into zsh, which passes `#` and the words after it as arguments. The script
 * created the v1.20.0 release — and with it the tag, which ran the npm publish
 * workflow — and only then crashed on `#`. Two guards, so writing notes can
 * never publish a package again.
 */
describe('release:notes arguments are all checked before anything is sent', () => {
  it.each([['#'], ['creates'], ['1.20.0'], ['v1.20'], ['--force']])('refuses %j', (arg) => {
    const r = readArgs(['v1.20.0', arg], NOTES_DIR);
    expect(r.ok).toBe(false);
  });

  it('refuses the exact paste that published v1.20.0, naming every bad word', () => {
    const r = readArgs(['v1.20.0', '#', 'creates', 'the', 'release'], NOTES_DIR);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(4);
  });

  it('refuses a well-formed tag that has no notes file', () => {
    const r = readArgs(['v9.9.9'], NOTES_DIR);
    expect(r).toMatchObject({ ok: false });
    expect(r.errors[0]).toMatch(/no notes file/);
  });

  it('accepts a tag with notes, --dry-run, and --all', () => {
    expect(readArgs(['v1.20.0'], NOTES_DIR)).toEqual({ ok: true, dryRun: false, tags: ['v1.20.0'] });
    expect(readArgs(['--dry-run', 'v1.20.0'], NOTES_DIR)).toEqual({ ok: true, dryRun: true, tags: ['v1.20.0'] });
    const all = readArgs(['--all'], NOTES_DIR);
    expect(all.ok && all.tags).toContain('v1.20.0');
  });

  it('refuses no tag at all', () => {
    expect(readArgs([], NOTES_DIR).ok).toBe(false);
  });
});

describe('release:notes never creates a tag', () => {
  /**
   * Without `--verify-tag`, `gh release create` makes a missing tag at the
   * default branch, and a `v*` tag push is the npm publish.
   */
  it('creates a release only for a tag that already exists (--verify-tag)', () => {
    const args = createArgs('v1.2.3', { title: 'v1.2.3 — x', latest: 'false' }, '/tmp/n.md');
    expect(args.slice(0, 3)).toEqual(['release', 'create', 'v1.2.3']);
    expect(args).toContain('--verify-tag');
    expect(args).toContain('--notes-file');
  });
});
