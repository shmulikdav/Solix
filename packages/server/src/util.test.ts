import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import { previewTargetPath, resolveWithinRoot } from './util.js';

describe('resolveWithinRoot (preview containment)', () => {
  const root = '/srv/project';

  it('resolves a normal subpath inside the root', () => {
    expect(resolveWithinRoot(root, 'index.html')).toBe(
      join(root, 'index.html'),
    );
    expect(resolveWithinRoot(root, 'assets/app.js')).toBe(
      join(root, 'assets', 'app.js'),
    );
  });

  it('resolves an empty subpath to the root itself', () => {
    expect(resolveWithinRoot(root, '')).toBe(root);
  });

  it('refuses traversal outside the root', () => {
    expect(resolveWithinRoot(root, '../secrets')).toBeNull();
    expect(resolveWithinRoot(root, '../../etc/passwd')).toBeNull();
    expect(resolveWithinRoot(root, 'a/../../b')).toBeNull();
  });

  it('refuses an absolute path pointing elsewhere', () => {
    expect(resolveWithinRoot(root, '/etc/passwd')).toBeNull();
  });

  it('does not treat a sibling prefix as inside', () => {
    // /srv/project-evil must not count as inside /srv/project.
    expect(resolveWithinRoot(root, `..${sep}project-evil${sep}x`)).toBeNull();
  });
});

describe('previewTargetPath', () => {
  const root = '/srv/project';
  it('defaults an empty subpath to index.html', () => {
    expect(previewTargetPath(root, '')).toBe(join(root, 'index.html'));
  });
  it('passes through a safe subpath', () => {
    expect(previewTargetPath(root, 'styles.css')).toBe(
      join(root, 'styles.css'),
    );
  });
  it('returns null on traversal', () => {
    expect(previewTargetPath(root, '../../etc/passwd')).toBeNull();
  });
});
