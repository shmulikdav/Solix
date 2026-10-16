import { describe, expect, it } from 'vitest';
import { normalizeCodexEvent } from './codex.js';

describe('normalizeCodexEvent', () => {
  it('maps SessionStart and stamps runtime=codex', () => {
    const e = normalizeCodexEvent({
      hook_event_name: 'SessionStart',
      session_id: 'cdx-1',
      cwd: '/repo',
    });
    expect(e?.event).toBe('session_start');
    expect((e?.payload as Record<string, unknown>).runtime).toBe('codex');
    expect((e?.payload as Record<string, unknown>).session_id).toBe('cdx-1');
  });

  it('splits PreToolUse by tool into bash/file/task buckets', () => {
    const bucket = (tool: string, input: Record<string, unknown> = {}) =>
      normalizeCodexEvent({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: '/r',
        tool_name: tool,
        tool_input: input,
      })?.event;
    expect(bucket('Bash', { command: 'ls' })).toBe('pre_tool_bash');
    expect(bucket('exec_command', { command: 'ls' })).toBe('pre_tool_bash');
    expect(bucket('apply_patch', { file_path: 'a.ts' })).toBe('pre_tool_file');
    expect(bucket('Edit', { file_path: 'a.ts' })).toBe('pre_tool_file');
    expect(bucket('mcp__github__search')).toBe('pre_tool_task');
  });

  it('maps Stop / SessionEnd / PostToolUse / Notification', () => {
    const ev = (name: string) =>
      normalizeCodexEvent({ hook_event_name: name, session_id: 's', cwd: '/r' })
        ?.event;
    expect(ev('Stop')).toBe('stop');
    expect(ev('SessionEnd')).toBe('stop');
    expect(ev('PostToolUse')).toBe('post_tool');
    expect(ev('Notification')).toBe('notification');
  });

  it('preserves the command/file fields the router reads', () => {
    const e = normalizeCodexEvent({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/r',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    });
    const p = e?.payload as Record<string, unknown>;
    expect((p.tool_input as Record<string, unknown>).command).toBe('rm -rf build');
  });

  it('returns null for an unrecognized or malformed payload', () => {
    expect(normalizeCodexEvent({ hook_event_name: 'Nope' })).toBeNull();
    expect(normalizeCodexEvent('not an object')).toBeNull();
    expect(normalizeCodexEvent(null)).toBeNull();
  });
});
