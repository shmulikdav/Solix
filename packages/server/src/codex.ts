import { HOOK_EVENTS, type HookEvent, type HookEventName } from '@solix/shared';

/**
 * Codex (OpenAI) → Solix ingestion shim. The ingestion boundary is already
 * agent-agnostic (one `HookEvent` envelope, one `router.handleHookEvent`), and
 * Codex's hooks emit the same field vocabulary (`session_id`, `cwd`, `tool_name`,
 * `tool_input`, `tool_response`), so a Codex adapter is mostly this name-mapping
 * shim — not new plumbing. Pure + unit-testable with canned Codex payloads.
 *
 * It maps Codex `hook_event_name` → Solix `HOOK_EVENTS`, splits `PreToolUse` by
 * tool into the bash/file/task buckets the router expects, and stamps
 * `runtime:'codex'` so the session renders as a Codex planet.
 */

function mapEventName(hookName: string, toolName: string): HookEventName | null {
  switch (hookName) {
    case 'SessionStart':
      return HOOK_EVENTS.SESSION_START;
    case 'UserPromptSubmit':
      return HOOK_EVENTS.USER_PROMPT_SUBMIT;
    case 'Stop':
    case 'SessionEnd':
      return HOOK_EVENTS.STOP;
    case 'SubagentStop':
      return HOOK_EVENTS.SUBAGENT_STOP;
    case 'PostToolUse':
      return HOOK_EVENTS.POST_TOOL;
    case 'Notification':
      return HOOK_EVENTS.NOTIFICATION;
    case 'PreToolUse':
    case 'PermissionRequest':
      return mapToolBucket(toolName);
    default:
      return null;
  }
}

/** Split a Codex tool name into the router's pre_tool_* buckets. */
function mapToolBucket(toolName: string): HookEventName {
  const t = (toolName || '').toLowerCase();
  if (t.startsWith('mcp__') || t === 'task') return HOOK_EVENTS.PRE_TOOL_TASK;
  if (
    t === 'apply_patch' ||
    t === 'edit' ||
    t === 'write' ||
    t === 'notebookedit' ||
    t.includes('patch')
  ) {
    return HOOK_EVENTS.PRE_TOOL_FILE;
  }
  // Bash / exec_command / shell / run / unknown → treat as a command.
  return HOOK_EVENTS.PRE_TOOL_BASH;
}

/**
 * Normalize one Codex hook payload (parsed JSON from the hook's stdin) into a
 * Solix `HookEvent`, or null if it isn't a recognized Codex hook. `runtime` is
 * stamped onto the payload so `onSessionStart` tags the session as Codex.
 */
export function normalizeCodexEvent(raw: unknown): HookEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const hookName =
    typeof p.hook_event_name === 'string'
      ? p.hook_event_name
      : typeof p.hookEventName === 'string'
        ? p.hookEventName
        : '';
  const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
  const event = mapEventName(hookName, toolName);
  if (!event) return null;

  const cwd = typeof p.cwd === 'string' ? p.cwd : process.cwd();
  // Surface a command/file_path at the top level too — the router reads either
  // the top-level field or tool_input.*.
  const toolInput = (p.tool_input as Record<string, unknown>) ?? {};

  return {
    event,
    pid: typeof p.pid === 'number' ? p.pid : 0,
    cwd,
    ts: Date.now(),
    payload: {
      ...p,
      runtime: 'codex',
      origin: 'external',
      session_id:
        typeof p.session_id === 'string'
          ? p.session_id
          : typeof p.sessionId === 'string'
            ? p.sessionId
            : undefined,
      tool_name: toolName || undefined,
      tool_input: toolInput,
    },
  };
}
