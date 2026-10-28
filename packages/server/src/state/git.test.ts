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

/**
 * "Review changes" asks "what did the fleet change?" and, when a plan has no
 * usable base, answered with the user's own uncommitted work.
 *
 * The base is captured at approve time, so every plan that failed before
 * approval has none — and `buildPlanReview` silently fell back to `HEAD`.
 * The signal was there all along in `baseRef` (undefined means it fell back)
 * and nothing read it. These pin the signal, so the banner that depends on it
 * cannot be quietly removed.
 */
describe('buildPlanReview and a missing base', () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solix-base-'));
    cwd = join(root, 'app');
    scaffoldProject({ cwd, name: 'app', template: 'node' });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports no baseRef when none was given', () => {
    writeFileSync(join(cwd, 'mine.js'), 'const mine = 1;\n', 'utf8');
    const r = buildPlanReview(cwd);
    expect(r.baseRef).toBeUndefined();
    expect(r.requestedBaseRef).toBeUndefined();
    // It still returns the diff — the point is that the caller must label it.
    expect(r.files.map((f) => f.path)).toContain('mine.js');
  });

  /** "Its base is gone" is a different kind of wrong from "it never had one". */
  it('distinguishes a base that no longer exists', () => {
    const r = buildPlanReview(cwd, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(r.baseRef).toBeUndefined();
    expect(r.requestedBaseRef).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('names the base when it is usable, so the honest case is legible too', () => {
    const base = gitHead(cwd)!;
    const r = buildPlanReview(cwd, base);
    expect(r.baseRef).toBe(base);
    expect(r.requestedBaseRef).toBeUndefined();
  });
});

describe('untracked files in a review', () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solix-untracked-'));
    cwd = join(root, 'app');
    scaffoldProject({ cwd, name: 'app', template: 'node' });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** `+++ b/path` is a header. Counting it made every count one too high. */
  it('counts added lines, not the diff header', () => {
    const base = gitHead(cwd)!;
    writeFileSync(join(cwd, 'three.js'), 'a\nb\nc\n', 'utf8');

    const r = buildPlanReview(cwd, base);
    const f = r.files.find((x) => x.path === 'three.js')!;
    expect(f.additions).toBe(3);
  });

  it('counts a single-line file as one addition', () => {
    const base = gitHead(cwd)!;
    writeFileSync(join(cwd, 'one.js'), 'x\n', 'utf8');
    const r = buildPlanReview(cwd, base);
    expect(r.files.find((x) => x.path === 'one.js')!.additions).toBe(1);
  });

  /**
   * Each untracked file costs a spawnSync on the server's main thread behind
   * a GET, so an unbounded loop stalls the whole local server.
   */
  it('caps how many it scans, and says how many it skipped', () => {
    const base = gitHead(cwd)!;
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(cwd, `gen-${i}.js`), `export const n = ${i};\n`, 'utf8');
    }
    const r = buildPlanReview(cwd, base);
    const generated = r.files.filter((f) => f.path.startsWith('gen-'));
    expect(generated.length).toBeLessThanOrEqual(100);
    expect(r.untrackedOmitted).toBeGreaterThan(0);
  });
});

