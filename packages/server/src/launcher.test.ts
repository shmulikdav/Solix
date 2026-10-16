import { describe, expect, it } from 'vitest';
import {
  buildCodexExecArgs,
  buildPrintArgs,
  containmentGateEnv,
  parseClaudeJsonResult,
  parseCodexJsonResult,
} from './launcher.js';

describe('containmentGateEnv (safe-by-default)', () => {
  it('injects the fail-closed gate by default', () => {
    expect(containmentGateEnv({})).toEqual({
      SOLIX_GATE_ENABLED: '1',
      SOLIX_GATE_POLICY: 'deny',
    });
  });
  it('preserves an explicit policy', () => {
    expect(containmentGateEnv({ SOLIX_GATE_POLICY: 'closed' }).SOLIX_GATE_POLICY).toBe(
      'closed',
    );
  });
  it('injects nothing when the user opts out', () => {
    expect(containmentGateEnv({ SOLIX_CONTAINMENT: '0' })).toEqual({});
    expect(containmentGateEnv({ SOLIX_GATE_ENABLED: '0' })).toEqual({});
  });
});

describe('buildPrintArgs', () => {
  const full = { sessionId: true, jsonOutput: true };

  it('passes --session-id (correlation) and --output-format json (cost)', () => {
    const args = buildPrintArgs(
      { model: 'haiku', sessionId: 'uuid-1', prompt: 'hi' },
      full,
    );
    expect(args).toContain('--print');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('uuid-1');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--model');
    expect(args[args.length - 1]).toBe('hi'); // prompt is last
  });

  it('omits --model for the default model', () => {
    const args = buildPrintArgs({ model: 'default', prompt: 'p' }, full);
    expect(args).not.toContain('--model');
  });

  it('degrades gracefully when the installed claude lacks the flags', () => {
    const args = buildPrintArgs(
      { sessionId: 'uuid-1', prompt: 'p' },
      { sessionId: false, jsonOutput: false },
    );
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--output-format');
    expect(args).toEqual(['--print', 'p']);
  });
});

describe('parseClaudeJsonResult', () => {
  it('extracts result text + total_cost_usd from the envelope', () => {
    const r = parseClaudeJsonResult(
      JSON.stringify({
        type: 'result',
        result: 'the answer',
        is_error: false,
        total_cost_usd: 0.0123,
      }),
    );
    expect(r).toEqual({ result: 'the answer', isError: false, costUsd: 0.0123 });
  });

  it('flags is_error', () => {
    const r = parseClaudeJsonResult(
      JSON.stringify({ result: 'boom', is_error: true }),
    );
    expect(r?.isError).toBe(true);
    expect(r?.costUsd).toBeUndefined();
  });

  it('returns null for non-envelope output (plain text / array / garbage)', () => {
    expect(parseClaudeJsonResult('just some text')).toBeNull();
    expect(parseClaudeJsonResult('[{"type":"message"}]')).toBeNull();
    expect(parseClaudeJsonResult('')).toBeNull();
    expect(parseClaudeJsonResult('{not json')).toBeNull();
  });
});

describe('buildCodexExecArgs (Codex dispatch)', () => {
  it('builds `exec --json` with a model', () => {
    const a = buildCodexExecArgs({ model: 'gpt-5-codex', prompt: 'do it' }, { json: true });
    expect(a[0]).toBe('exec');
    expect(a).toContain('--json');
    expect(a[a.indexOf('--model') + 1]).toBe('gpt-5-codex');
    expect(a[a.length - 1]).toBe('do it');
  });
  it('omits --json when unsupported and --model when absent', () => {
    expect(buildCodexExecArgs({ prompt: 'p' }, { json: false })).toEqual(['exec', 'p']);
  });
});

describe('parseCodexJsonResult (best-effort)', () => {
  it('takes the last assistant text + cost from NDJSON events', () => {
    const out = [
      '{"type":"item","text":"thinking"}',
      '{"type":"item","text":"final answer"}',
      '{"type":"turn.completed","total_cost_usd":0.02}',
    ].join('\n');
    const r = parseCodexJsonResult(out);
    expect(r?.result).toBe('final answer');
    expect(r?.costUsd).toBe(0.02);
  });
  it('returns null when nothing parses', () => {
    expect(parseCodexJsonResult('plain text, not json')).toBeNull();
  });
});
