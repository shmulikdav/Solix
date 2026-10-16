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

/**
 * Envelope shapes taken from the documented SDKResultMessage arms (success +
 * the error arms). Previously the parser was only ever tested against the shape
 * it already assumed, which proved nothing about real CLI output; these pin the
 * documented contract, including the failure arms that carry `errors[]` and no
 * `result`.
 */
describe('parseClaudeJsonResult against documented envelope shapes', () => {
  it('parses a full success envelope', () => {
    const parsed = parseClaudeJsonResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        uuid: '6f1c2a9e-3b7d-4e8a-9c21-5d0e7b4a1f22',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        is_error: false,
        duration_ms: 8421,
        duration_api_ms: 7903,
        num_turns: 2,
        result: 'The auth module is wired up.',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0213,
        usage: {
          input_tokens: 3120,
          output_tokens: 412,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 18640,
        },
        modelUsage: { 'claude-sonnet-5': { costUSD: 0.0213 } },
        permission_denials: [],
      }),
    )!;
    expect(parsed.isError).toBe(false);
    expect(parsed.result).toBe('The auth module is wired up.');
    expect(parsed.costUsd).toBeCloseTo(0.0213, 6);
  });

  it('reads the reason from errors[] on a failure arm that has no result', () => {
    const parsed = parseClaudeJsonResult(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 10,
        stop_reason: null,
        total_cost_usd: 0.31,
        errors: ['hit the turn limit before finishing'],
      }),
    )!;
    expect(parsed.isError).toBe(true);
    // Without the errors[] fallback this would be '' — a failure with no reason.
    expect(parsed.result).toBe('hit the turn limit before finishing');
    expect(parsed.costUsd).toBeCloseTo(0.31, 6);
  });

  it('treats a non-success subtype as failure even without is_error', () => {
    const parsed = parseClaudeJsonResult(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        result: 'something broke',
      }),
    )!;
    expect(parsed.isError).toBe(true);
    expect(parsed.result).toBe('something broke');
  });

  it('handles the bare subtype:"error" shape seen in the wild', () => {
    const parsed = parseClaudeJsonResult(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '' }),
    )!;
    expect(parsed.isError).toBe(true);
  });

  it('tolerates a null/absent total_cost_usd', () => {
    expect(
      parseClaudeJsonResult(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: null }),
      )!.costUsd,
    ).toBeUndefined();
    expect(
      parseClaudeJsonResult(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }))!
        .costUsd,
    ).toBeUndefined();
  });

  it('does not mis-flag a non-result object as an error', () => {
    // A stray system/init object must not be read as a failed run.
    const parsed = parseClaudeJsonResult(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
    )!;
    expect(parsed.isError).toBe(false);
  });

  it('still rejects output that is not a JSON object', () => {
    expect(parseClaudeJsonResult('plain text')).toBeNull();
    expect(parseClaudeJsonResult('{broken')).toBeNull();
  });
});

/**
 * Codex cost parity. Codex reports token usage rather than a dollar figure, so
 * without local pricing a Codex worker's spend was always undefined — meaning
 * plan budget caps silently did not apply to Codex tasks. (Still EXPERIMENTAL:
 * these pin the tolerant parsing, not the real CLI's schema.)
 */
describe('parseCodexJsonResult — usage-derived cost', () => {
  // gpt-5: $1.25/M input, $10/M output → 1000 in + 500 out = $0.00625
  const EXPECTED = (1000 * 1.25 + 500 * 10) / 1_000_000;

  it('prices top-level snake_case usage', () => {
    const parsed = parseCodexJsonResult(
      [
        JSON.stringify({ type: 'item.completed', text: 'did the work' }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 500 } }),
      ].join('\n'),
      'gpt-5',
    )!;
    expect(parsed.result).toBe('did the work');
    expect(parsed.costUsd).toBeCloseTo(EXPECTED, 8);
  });

  it('prices usage nested under a turn envelope', () => {
    const parsed = parseCodexJsonResult(
      JSON.stringify({ turn: { usage: { input_tokens: 1000, output_tokens: 500 } }, text: 'x' }),
      'gpt-5',
    )!;
    expect(parsed.costUsd).toBeCloseTo(EXPECTED, 8);
  });

  it('accepts camelCase and prompt/completion token aliases', () => {
    expect(
      parseCodexJsonResult(
        JSON.stringify({ usage: { inputTokens: 1000, outputTokens: 500 }, text: 'x' }),
        'gpt-5',
      )!.costUsd,
    ).toBeCloseTo(EXPECTED, 8);
    expect(
      parseCodexJsonResult(
        JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 500 }, text: 'x' }),
        'gpt-5',
      )!.costUsd,
    ).toBeCloseTo(EXPECTED, 8);
  });

  it('prefers an explicit total_cost_usd when present', () => {
    const parsed = parseCodexJsonResult(
      JSON.stringify({ total_cost_usd: 0.99, usage: { input_tokens: 1000, output_tokens: 500 }, text: 'x' }),
      'gpt-5',
    )!;
    expect(parsed.costUsd).toBeCloseTo(0.99, 6);
  });

  it('flags an error event and keeps its message', () => {
    const parsed = parseCodexJsonResult(
      JSON.stringify({ type: 'error', error: 'codex blew up' }),
      'gpt-5',
    )!;
    expect(parsed.isError).toBe(true);
    expect(parsed.result).toBe('codex blew up');
  });

  it('ignores unrecognized events instead of throwing', () => {
    expect(
      parseCodexJsonResult(
        ['{"type":"something.new","fields":{"a":1}}', 'not json at all'].join('\n'),
        'gpt-5',
      ),
    ).toBeNull();
  });
});
