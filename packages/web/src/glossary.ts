/**
 * Plain-English definitions for terms surfaced in the UI. Used as
 * native `title=` tooltips on status badges, hover labels, and
 * SidePanel headers. New terms get added here as we notice them.
 */
export const GLOSSARY: Record<string, string> = {
  // List columns
  attention:
    'The one thing worth doing about this agent right now — a held command, context filling up, an error. A dash means nothing needs you, which is what most rows should say.',

  // Session statuses
  active:
    'The agent is currently working — emitting tool calls or generating output.',
  idle:
    'No mission running. The agent is waiting for the next prompt or has been quiet for a while.',
  spawning:
    'The agent process just started. It will transition to active within a second or two.',
  awaiting_permission:
    'The agent paused to ask permission for a sensitive tool call. Approve or deny in the Decision Queue.',
  awaiting_input:
    'The agent finished what it could and is waiting for your next prompt.',
  plan_review:
    "The agent produced a plan and is waiting for your approval before executing.",
  error:
    'The agent crashed or hit an unrecoverable error. Look at the SidePanel transcript for details.',
  terminated:
    'The agent process exited. No more activity will come from this session.',

  // Glyphs / structural concepts
  subagent:
    'A child agent spawned by another session (typically via the Task tool). Rendered as a moon orbiting the parent planet.',
  advisor:
    'A long-lived specialist agent (Compass, Forge, Lumen, Argus, Sentinel, …) with its own AGENT.md describing its role.',
  pinned:
    "An advisor that's always running. Pinned advisors orbit close to the sun in the inner ring.",
};
