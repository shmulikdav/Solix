import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { expandHome } from './paths.js';
import { explainSpawnError } from './launcher.js';

/**
 * A person typing a project path writes `~/solix-qa`, because that is what
 * works in every shell they have ever used. Nothing expanded it, so the
 * literal string reached `spawn({ cwd })` — and the failure named `claude`
 * rather than the directory, so it read as a broken Claude Code install.
 *
 * Both halves are covered here: the expansion, and the error that misled.
 */
describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/solix-qa')).toBe(join(homedir(), 'solix-qa'));
  });

  it('expands a bare ~', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands deeper paths', () => {
    expect(expandHome('~/a/b/c')).toBe(join(homedir(), 'a/b/c'));
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/Users/someone/solix-qa')).toBe('/Users/someone/solix-qa');
  });

  it('leaves a relative path alone', () => {
    expect(expandHome('./project')).toBe('./project');
  });

  it('trims surrounding whitespace, which a paste often carries', () => {
    expect(expandHome('  ~/solix-qa  ')).toBe(join(homedir(), 'solix-qa'));
  });

  /**
   * `~user` means another user's home. We cannot resolve that correctly, and
   * guessing `<home>/../user` would be worse than leaving it — so it is left
   * exactly as typed and fails loudly rather than silently pointing somewhere
   * unintended.
   */
  it('does NOT touch ~user', () => {
    expect(expandHome('~otheruser/project')).toBe('~otheruser/project');
  });

  it('does not expand a ~ in the middle of a path', () => {
    expect(expandHome('/tmp/~/weird')).toBe('/tmp/~/weird');
  });
});

describe('explainSpawnError', () => {
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });

  it('names the missing directory rather than the command', () => {
    const msg = explainSpawnError(enoent, '/nope/not/here', 'claude');
    expect(msg).toContain('project directory does not exist');
    expect(msg).toContain('/nope/not/here');
    // The whole point: it must stop blaming claude.
    expect(msg).not.toMatch(/spawn claude ENOENT/);
  });

  it('blames the binary only when the directory really does exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solix-spawn-'));
    try {
      const msg = explainSpawnError(enoent, dir, 'claude');
      expect(msg).toContain('claude');
      expect(msg).not.toContain('project directory does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * "Install Claude Code" is the wrong advice for the case people actually
   * hit: nvm. The binary is installed, on a PATH the server does not have,
   * and SOLIX_CLAUDE_BIN is the documented fix — so the message has to name
   * it rather than sending someone to reinstall what they already have.
   */
  it('names SOLIX_CLAUDE_BIN instead of telling you to reinstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solix-spawn-'));
    try {
      const msg = explainSpawnError(enoent, dir, 'claude');
      expect(msg).toContain('SOLIX_CLAUDE_BIN');
      expect(msg).toMatch(/which claude/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A non-executable shim is its own failure, with its own fix. */
  it('explains EACCES rather than printing the raw error', () => {
    const eacces = Object.assign(new Error('spawn claude EACCES'), {
      code: 'EACCES',
    });
    const msg = explainSpawnError(eacces, '/nope', 'claude');
    expect(msg).toContain('not executable');
    expect(msg).toContain('SOLIX_CLAUDE_BIN');
  });

  it('passes through any other error untouched', () => {
    const eperm = Object.assign(new Error('spawn claude EPERM'), {
      code: 'EPERM',
    });
    expect(explainSpawnError(eperm, '/nope', 'claude')).toBe(
      'spawn claude EPERM',
    );
  });
});
