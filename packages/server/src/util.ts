import { createHash } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';

export function hashCwd(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

export function projectNameFromCwd(cwd: string): string {
  return basename(cwd) || cwd;
}

export function now(): number {
  return Date.now();
}

/**
 * Turn a human project name into a safe directory slug: lowercase, spaces and
 * punctuation collapsed to single hyphens, trimmed. Falls back to 'project' so
 * the result is never empty (e.g. a name of only symbols).
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'project';
}

/**
 * Resolve `rel` against `root` and return the absolute path ONLY if it stays
 * inside `root` (the preview server's containment guard). Returns null on any
 * traversal escape (`..`, absolute paths pointing elsewhere, symlink-style
 * `../` chains). An empty `rel` resolves to `root` itself.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const base = resolve(root);
  // resolve() normalizes every `..`; the startsWith check is then authoritative.
  // (Do NOT pre-strip `..` — that silently redirects an escape into the root
  // instead of rejecting it, which hides traversal rather than blocking it.)
  const target = rel ? resolve(base, rel) : base;
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/** Convenience: the preview path for a subpath (defaults to index.html). */
export function previewTargetPath(root: string, rel: string): string | null {
  const resolved = resolveWithinRoot(root, rel);
  if (resolved == null) return null;
  return rel ? resolved : join(resolve(root), 'index.html');
}
