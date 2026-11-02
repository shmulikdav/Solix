import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-expect-error — a plain .mjs script, imported for its pure predicates.
import { markers, parseNotes } from '../../../scripts/publish-release-notes.mjs';

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
    expect(files.sort()).toEqual(['v1.17.0.md', 'v1.18.0.md', 'v1.18.1.md', 'v1.18.3.md']);
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
    expect(latest).toEqual(['v1.18.3.md']);
  });
});
