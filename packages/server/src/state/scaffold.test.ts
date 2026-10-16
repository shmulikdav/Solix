import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugifyProjectName } from '../util.js';
import { resetDbForTests, type DB } from '../db.js';
import {
  createManagedProject,
  ensureProject,
  getProject,
  listProjects,
} from './projects.js';
import { scaffoldProject } from './scaffold.js';

describe('slugifyProjectName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyProjectName('My Cool App')).toBe('my-cool-app');
  });
  it('collapses punctuation and trims hyphens', () => {
    expect(slugifyProjectName('  Foo!! & Bar??  ')).toBe('foo-bar');
  });
  it('falls back to "project" for an all-symbol name', () => {
    expect(slugifyProjectName('***')).toBe('project');
  });
});

describe('scaffoldProject', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solix-scaffold-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a git repo with a baseline commit and template files (node)', () => {
    const cwd = join(root, 'app');
    const res = scaffoldProject({ cwd, name: 'app', template: 'node' });
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, '.git'))).toBe(true);
    expect(existsSync(join(cwd, 'package.json'))).toBe(true);
    expect(existsSync(join(cwd, 'index.js'))).toBe(true);
    // A baseline commit exists so the review surface can diff against it.
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd,
      encoding: 'utf8',
    });
    expect(log).toContain('Initial scaffold');
    // The name is substituted into the scaffold.
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"app"');
  });

  it('escapes an untrusted project name (no HTML/JS injection)', () => {
    const evil = `<script>alert(1)</script> Bob's "Blog"`;
    const cwd = join(root, 'evil');
    expect(scaffoldProject({ cwd, name: evil, template: 'web' }).ok).toBe(true);
    const html = readFileSync(join(cwd, 'index.html'), 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');

    const nodeCwd = join(root, 'evilnode');
    expect(scaffoldProject({ cwd: nodeCwd, name: evil, template: 'node' }).ok).toBe(
      true,
    );
    const js = readFileSync(join(nodeCwd, 'index.js'), 'utf8');
    // The name is a single JSON string literal argument — the double quote in
    // the name is escaped, so it can't break out of `console.log(...)` and
    // inject code. (`</script>` as inert text inside a .js string is harmless.)
    expect(js).toMatch(/^console\.log\(".*"\);\n$/s);
    expect(js).toContain('\\"Blog\\"'); // the quote was escaped, not raw
    expect(js).not.toMatch(/"\)\s*;.*;/); // no second statement after the call
  });

  it('writes only a README for the empty template', () => {
    const cwd = join(root, 'empty');
    const res = scaffoldProject({ cwd, name: 'empty', template: 'empty' });
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, 'README.md'))).toBe(true);
    expect(existsSync(join(cwd, 'package.json'))).toBe(false);
  });

  it('refuses to scaffold into a non-empty, non-repo directory', () => {
    // A plain directory that already has content (and isn't a git repo) must
    // not be scaffolded into — we don't litter an existing folder.
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'note.txt'), 'hi', 'utf8');
    const res = scaffoldProject({ cwd: plain, name: 'plain', template: 'empty' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not empty/i);
  });

  it('is idempotent on an existing repo (no clobber, no double-commit failure)', () => {
    const cwd = join(root, 'again');
    expect(scaffoldProject({ cwd, name: 'again', template: 'web' }).ok).toBe(true);
    // Second call: dir is already a repo → should succeed and not overwrite.
    const res2 = scaffoldProject({ cwd, name: 'again', template: 'web' });
    expect(res2.ok).toBe(true);
  });
});

describe('createManagedProject', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('inserts a durable managed project', () => {
    const p = createManagedProject(db, {
      cwd: '/tmp/proj-a',
      name: 'Proj A',
      template: 'node',
    });
    expect(p.managed).toBe(true);
    expect(p.template).toBe('node');
    const fetched = getProject(db, p.id)!;
    expect(fetched.name).toBe('Proj A');
    expect(fetched.managed).toBe(true);
    expect(listProjects(db).some((x) => x.id === p.id)).toBe(true);
  });

  it('upgrades a previously-observed project to managed', () => {
    const cwd = '/tmp/proj-b';
    const observed = ensureProject(db, cwd); // auto-observed → not managed
    expect(observed.managed).toBeUndefined();

    const upgraded = createManagedProject(db, {
      cwd,
      name: 'B2',
      template: 'web',
    });
    expect(upgraded.id).toBe(observed.id); // same cwd → same id
    expect(upgraded.name).toBe('B2');
    expect(upgraded.managed).toBe(true);
    expect(upgraded.template).toBe('web');
  });
});
