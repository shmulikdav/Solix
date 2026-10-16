import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PlanReview, PlanReviewFile } from '@solix/shared';

/**
 * Read-only git helpers for the build-studio review surface. All calls are
 * bounded and never mutate the repo (no add/commit), so a review is safe to run
 * at any time on a plan's working directory.
 */

const MAX_DIFF_BYTES = 200_000;

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Current HEAD sha of `cwd`, or null if it isn't a repo / has no commits. */
export function gitHead(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.out.trim() || null : null;
}

function isRepo(cwd: string): boolean {
  if (!existsSync(cwd)) return false;
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
}

/**
 * Diff a plan's working tree against `baseRef` (the HEAD captured when the plan
 * started). Captures tracked changes AND new untracked files (each rendered as
 * a proper new-file diff via `git diff --no-index`), so a fresh build shows up
 * even though its files are untracked. Falls back to diffing against HEAD when
 * no baseRef is known.
 */
export function buildPlanReview(cwd: string, baseRef?: string): PlanReview {
  if (!isRepo(cwd)) {
    return { ok: true, notARepo: true, files: [], diff: '' };
  }
  const base = baseRef && gitRefExists(cwd, baseRef) ? baseRef : 'HEAD';

  // Tracked changes since base (numstat → per-file add/delete counts).
  const files: PlanReviewFile[] = [];
  const numstat = git(cwd, ['diff', '--numstat', base]);
  for (const line of numstat.out.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const additions = m[1] === '-' ? 0 : Number(m[1]);
    const deletions = m[2] === '-' ? 0 : Number(m[2]);
    files.push({ path: m[3]!, status: 'modified', additions, deletions });
  }

  let diff = git(cwd, ['diff', base]).out;

  // New untracked files — each as a synthesized new-file diff.
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']);
  for (const path of untracked.out.split('\n').map((s) => s.trim())) {
    if (!path) continue;
    // --no-index exits non-zero when files differ; we want its stdout anyway.
    const nd = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', path], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = nd.stdout ?? '';
    if (text) diff += (diff ? '\n' : '') + text;
    const additions = text.split('\n').filter((l) => l.startsWith('+')).length;
    files.push({ path, status: 'added', additions, deletions: 0 });
  }

  // Deleted files show in numstat as modified; refine status from name-status.
  const nameStatus = git(cwd, ['diff', '--name-status', base]);
  const statusByPath = new Map<string, PlanReviewFile['status']>();
  for (const line of nameStatus.out.split('\n')) {
    const m = line.trim().match(/^([AMD])\t(.+)$/);
    if (!m) continue;
    statusByPath.set(
      m[2]!,
      m[1] === 'A' ? 'added' : m[1] === 'D' ? 'deleted' : 'modified',
    );
  }
  for (const f of files) {
    const s = statusByPath.get(f.path);
    if (s) f.status = s;
  }

  let truncated = false;
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES);
    truncated = true;
  }

  return {
    ok: true,
    baseRef: base === 'HEAD' ? undefined : base,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    diff,
    truncated,
  };
}

function gitRefExists(cwd: string, ref: string): boolean {
  return git(cwd, ['cat-file', '-e', `${ref}^{commit}`]).ok;
}
