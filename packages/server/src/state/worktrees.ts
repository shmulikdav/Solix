import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Git worktrees — an isolated checkout per task, so Maestro can run independent
 * tasks concurrently without two workers racing on one working tree.
 *
 * Moved here from the launcher (where it served only `launchInternalSession`)
 * so the orchestrator can use it too, and given the matching `removeWorktree`
 * the launcher never had — worktrees used to leak, one per branch, forever.
 */
export interface WorktreeResult {
  path: string;
  created: boolean;
}

/** The branch an isolated plan task runs on. Stable per (plan, task) so a
 *  retry reuses the same worktree rather than piling up new ones. */
export function worktreeBranchFor(planId: string, taskId: string): string {
  return `solix/p-${planId}-${taskId}`;
}

function repoRootOf(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`not a git repository: ${cwd}`);
  return (r.stdout ?? '').trim();
}

function worktreePathFor(repoRoot: string, branch: string): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return join(homedir(), '.solix', 'worktrees', `${basename(repoRoot)}-${safeBranch}`);
}

/**
 * Resolve (or create) a git worktree for `branch` rooted at the repo containing
 * `repoCwd`. Reuses an existing worktree registered at the same path. New
 * branches are created from `baseRef` (default `HEAD`).
 */
export function ensureWorktree(opts: {
  repoCwd: string;
  branch: string;
  baseRef?: string;
}): WorktreeResult {
  const repoRoot = repoRootOf(opts.repoCwd);
  const path = worktreePathFor(repoRoot, opts.branch);

  // Already registered? Reuse.
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (list.status === 0 && (list.stdout ?? '').includes(`worktree ${path}`)) {
    return { path, created: false };
  }

  mkdirSync(join(homedir(), '.solix', 'worktrees'), { recursive: true });

  // Branch exists locally? Use it; otherwise create from baseRef.
  const branchProbe = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const args =
    branchProbe.status === 0
      ? ['worktree', 'add', path, opts.branch]
      : ['worktree', 'add', path, '-b', opts.branch, opts.baseRef ?? 'HEAD'];
  const add = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (add.status !== 0) {
    throw new Error(`git worktree add failed: ${(add.stderr ?? '').slice(0, 280)}`);
  }
  return { path, created: true };
}

/**
 * Tear a worktree down and delete its branch. Best-effort and idempotent: a
 * worktree that is already gone, or was never a worktree, is not an error — the
 * caller is cleaning up, not asserting state. `--force` because the worker may
 * have left uncommitted changes (expected: we integrated what we wanted first).
 */
export function removeWorktree(path: string): void {
  if (!path || !existsSync(path)) return;
  let repoRoot: string | undefined;
  try {
    repoRoot = repoRootOf(path);
  } catch {
    // Detached or broken — fall back to removing by path from any parent repo.
  }
  const cwd = repoRoot ?? join(path, '..');
  // The branch this worktree is on, so we can delete it after detaching.
  const head = spawnSync('git', ['-C', path, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  const branch = head.status === 0 ? (head.stdout ?? '').trim() : '';
  spawnSync('git', ['worktree', 'remove', '--force', path], { cwd, encoding: 'utf8' });
  spawnSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' });
  if (branch && branch.startsWith('solix/')) {
    spawnSync('git', ['branch', '-D', branch], { cwd, encoding: 'utf8' });
  }
}

export type IntegrateResult = { ok: true } | { ok: false; reason: string };

/**
 * Apply an isolated task's worktree changes onto the plan's checkout — the
 * single place the review surface diffs. Both started from `baseRef`, so the
 * worktree's changes since `baseRef` are what this task produced.
 *
 * Deliberately conservative: it checks the patch applies cleanly first and
 * refuses rather than force it. A clean apply means the task really was
 * disjoint from everything already in the checkout; a failure means it was not
 * (two "isolated" tasks touched the same file), and the caller escalates to a
 * person rather than letting one silently clobber the other. The plan checkout
 * is left untouched on any failure. (`CLAIM-PARALLEL-INTEGRATES`)
 */
export function integrateWorktree(opts: {
  targetCwd: string;
  worktreeCwd: string;
  baseRef: string;
}): IntegrateResult {
  const { targetCwd, worktreeCwd, baseRef } = opts;

  // 1. Tracked changes since baseRef, as a patch applied to the target's
  //    working tree (where the review reads, and where non-isolated tasks also
  //    leave their uncommitted work).
  const diff = spawnSync('git', ['-C', worktreeCwd, 'diff', '--binary', baseRef], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.status !== 0) {
    return { ok: false, reason: `could not diff the worktree: ${(diff.stderr ?? '').slice(0, 200)}` };
  }
  const patch = diff.stdout ?? '';
  if (patch.trim()) {
    const check = spawnSync(
      'git',
      ['-C', targetCwd, 'apply', '--check', '--whitespace=nowarn'],
      { input: patch, encoding: 'utf8' },
    );
    if (check.status !== 0) {
      return {
        ok: false,
        reason:
          'changes conflict with another task — could not integrate ' +
          `(git apply --check failed: ${(check.stderr ?? '').slice(0, 160)})`,
      };
    }
    const apply = spawnSync(
      'git',
      ['-C', targetCwd, 'apply', '--whitespace=nowarn'],
      { input: patch, encoding: 'utf8' },
    );
    if (apply.status !== 0) {
      return { ok: false, reason: `failed to apply changes: ${(apply.stderr ?? '').slice(0, 200)}` };
    }
  }

  // 2. New untracked files → copy into the target, unless a different file is
  //    already there (then it is a conflict, not an overwrite).
  const untracked = spawnSync(
    'git',
    ['-C', worktreeCwd, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  );
  const paths = (untracked.stdout ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const rel of paths) {
    const src = join(worktreeCwd, rel);
    const dst = join(targetCwd, rel);
    if (existsSync(dst)) {
      try {
        if (readFileSync(dst).equals(readFileSync(src))) continue;
      } catch {
        /* unreadable → treat as a conflict */
      }
      return {
        ok: false,
        reason: `new file ${rel} already exists in the plan checkout with different content — could not integrate`,
      };
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  return { ok: true };
}
