import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlanReview, gitHead } from './git.js';
import { scaffoldProject } from './scaffold.js';

describe('buildPlanReview', () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solix-review-'));
    cwd = join(root, 'app');
    scaffoldProject({ cwd, name: 'app', template: 'node' });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports nothing changed right after scaffold', () => {
    const base = gitHead(cwd)!;
    const r = buildPlanReview(cwd, base);
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(0);
    expect(r.diff.trim()).toBe('');
  });

  it('captures a modified tracked file and a new untracked file', () => {
    const base = gitHead(cwd)!;
    // Modify a tracked file and add a brand-new one (what a worker would do).
    writeFileSync(join(cwd, 'index.js'), 'console.log("changed");\n', 'utf8');
    writeFileSync(join(cwd, 'feature.js'), 'export const x = 1;\n', 'utf8');

    const r = buildPlanReview(cwd, base);
    expect(r.ok).toBe(true);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('index.js');
    expect(paths).toContain('feature.js');
    expect(r.files.find((f) => f.path === 'index.js')!.status).toBe('modified');
    expect(r.files.find((f) => f.path === 'feature.js')!.status).toBe('added');
    // The diff carries both the modification and the new file.
    expect(r.diff).toContain('changed');
    expect(r.diff).toContain('feature.js');
  });

  it('reports notARepo for a non-git directory', () => {
    const plain = join(root, 'plain');
    mkdtempSync(join(root, 'x-')); // ensure root exists
    const r = buildPlanReview(plain);
    expect(r.notARepo).toBe(true);
    expect(r.files).toHaveLength(0);
  });
});
