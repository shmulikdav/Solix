import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// @ts-expect-error — a plain .mjs script, imported for its pure predicates.
import { checkRelease, parseChangelogVersions } from '../../../scripts/release-tag.mjs';

/**
 * Every case here is a release that actually went wrong, or the near miss it
 * would have been. Tagging is publishing — the workflow fires on `v*` and runs
 * `npm publish` without tests, and npm only unpublishes within 72 hours — so
 * the guard is the last thing standing between a mistake and the registry.
 */
const BASE = {
  version: '1.14.0',
  dirty: false,
  branch: 'main',
  localSha: 'a'.repeat(40),
  remoteSha: 'a'.repeat(40),
  changelogVersions: ['1.14.0', '1.13.0'],
  publishedVersions: ['1.12.1', '1.13.0'],
  existingTagSha: null,
  headSha: 'a'.repeat(40),
  retag: false,
};

const only = (problems: string[], re: RegExp): boolean => problems.some((p) => re.test(p));

describe('release guard', () => {
  it('passes a release that is actually ready', () => {
    expect(checkRelease(BASE)).toEqual({ ok: true, problems: [] });
  });

  /**
   * v1.13.0 and v1.14.0 both shipped this way: the tag was pushed while the
   * version bump was still on a branch, so it pointed at a commit whose
   * package.json held the PREVIOUS version. The workflow dutifully built that
   * and npm refused it with a 403.
   *
   * The tell is the changelog: a version that has no entry has not been cut.
   */
  it('refuses when the version has no CHANGELOG entry (the bump never landed)', () => {
    const r = checkRelease({ ...BASE, changelogVersions: ['1.13.0', '1.12.1'] });
    expect(r.ok).toBe(false);
    expect(only(r.problems, /CHANGELOG/)).toBe(true);
  });

  /**
   * The second failure: `git pull origin main` refreshes main and nothing
   * else, so merging a stale `origin/<branch>` did nothing, main stayed where
   * it was, and the tag went onto the unbumped commit.
   */
  it('refuses when main is not in sync with origin/main', () => {
    const r = checkRelease({ ...BASE, remoteSha: 'b'.repeat(40) });
    expect(r.ok).toBe(false);
    expect(only(r.problems, /not in sync/)).toBe(true);
  });

  it('refuses a version npm already has', () => {
    const r = checkRelease({ ...BASE, publishedVersions: ['1.13.0', '1.14.0'] });
    expect(r.ok).toBe(false);
    expect(only(r.problems, /already on npm/)).toBe(true);
  });

  it('refuses a dirty tree', () => {
    const r = checkRelease({ ...BASE, dirty: true });
    expect(r.ok).toBe(false);
    expect(only(r.problems, /uncommitted/)).toBe(true);
  });

  it('refuses a branch that is not main', () => {
    const r = checkRelease({ ...BASE, branch: 'claude/some-feature' });
    expect(r.ok).toBe(false);
    expect(only(r.problems, /not main/)).toBe(true);
  });

  describe('an existing tag', () => {
    it('is fine when it already points at HEAD (a re-run)', () => {
      const r = checkRelease({ ...BASE, existingTagSha: BASE.headSha });
      expect(r.ok).toBe(true);
    });

    it('is refused when it points somewhere else', () => {
      const r = checkRelease({ ...BASE, existingTagSha: 'c'.repeat(40) });
      expect(r.ok).toBe(false);
      expect(only(r.problems, /--retag/)).toBe(true);
    });

    it('may be moved with --retag', () => {
      const r = checkRelease({ ...BASE, existingTagSha: 'c'.repeat(40), retag: true });
      expect(r.ok).toBe(true);
    });
  });

  /** Finding the second problem on the next run is how a release drags. */
  it('reports every problem at once, not just the first', () => {
    const r = checkRelease({
      ...BASE,
      dirty: true,
      branch: 'wip',
      remoteSha: 'b'.repeat(40),
      changelogVersions: [],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBe(4);
  });
});

describe('parseChangelogVersions', () => {
  it('reads the headings in file order', () => {
    expect(
      parseChangelogVersions('# Changelog\n\n## [1.14.0] — 2026-10-26\n\n## [1.13.0] — x\n'),
    ).toEqual(['1.14.0', '1.13.0']);
  });

  it('ignores [Unreleased], which is not a version', () => {
    expect(parseChangelogVersions('## [Unreleased]\n\n## [1.13.0] — x\n')).toEqual(['1.13.0']);
  });

  it('ignores a version mentioned in prose rather than as a heading', () => {
    expect(parseChangelogVersions('Upgrading from [1.9.9] is fine.\n\n## [1.13.0] — x\n')).toEqual([
      '1.13.0',
    ]);
  });

  /** The guard is only as good as this: the real file must parse. */
  it('finds the current release in the real CHANGELOG', () => {
    const versions = parseChangelogVersions(
      readFileSync(resolve(import.meta.dirname, '../../../CHANGELOG.md'), 'utf8'),
    );
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../cli/package.json'), 'utf8'),
    ) as { version: string };
    expect(versions).toContain(pkg.version);
  });
});
