/**
 * Agent delegation (P2 #8) — a worker may PROPOSE subtasks; the orchestrator
 * decides. This module is the pure, strict parser for a worker's proposal: it
 * never trusts free-form output, so delegation stays as deterministic and
 * contained as the planner path. The worker emits one fenced block:
 *
 *   <<<SOLIX_SUBTASKS
 *   [{"title": "...", "prompt": "...", "acceptanceCriteria": "..."}]
 *   SOLIX_SUBTASKS>>>
 *
 * Subtasks are a flat list — each becomes a pending task depending only on the
 * (completed) parent, so no intra-batch edges exist and a cycle is impossible.
 */

/** Hard cap on how many delegation hops deep the fleet may go. */
export const MAX_DELEGATION_DEPTH = 2;
/** Hard cap on subtasks accepted from a single worker proposal. */
export const MAX_SUBTASKS_PER_DELEGATION = 5;

export interface SubtaskSpec {
  title: string;
  prompt: string;
  acceptanceCriteria: string;
}

export interface SubtaskProposal {
  subtasks: SubtaskSpec[];
  warnings: string[];
}

const BLOCK_RE = /<<<SOLIX_SUBTASKS\s*([\s\S]*?)\s*SOLIX_SUBTASKS>>>/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Extract + validate a worker's subtask proposal. Returns an empty list when no
 * block is present or it can't be parsed (delegation is opt-in — absence is
 * normal, not an error). Over-cap proposals are truncated with a warning.
 */
export function parseSubtaskProposal(
  output: string,
  opts: { max?: number } = {},
): SubtaskProposal {
  const warnings: string[] = [];
  const max = opts.max ?? MAX_SUBTASKS_PER_DELEGATION;
  if (!output) return { subtasks: [], warnings };

  const m = output.match(BLOCK_RE);
  if (!m || !m[1]) return { subtasks: [], warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return { subtasks: [], warnings: ['subtask proposal was not valid JSON — ignored'] };
  }
  if (!Array.isArray(parsed)) {
    return { subtasks: [], warnings: ['subtask proposal was not a JSON array — ignored'] };
  }

  const subtasks: SubtaskSpec[] = [];
  for (const raw of parsed) {
    if (subtasks.length >= max) {
      warnings.push(`proposal capped at ${max} subtasks`);
      break;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!isNonEmptyString(r.title) || !isNonEmptyString(r.prompt)) {
      warnings.push('skipped a subtask missing title/prompt');
      continue;
    }
    subtasks.push({
      title: r.title.trim().slice(0, 200),
      prompt: r.prompt.trim(),
      acceptanceCriteria: isNonEmptyString(r.acceptanceCriteria)
        ? r.acceptanceCriteria.trim()
        : 'The subtask is completed as described.',
    });
  }
  return { subtasks, warnings };
}

/**
 * The instruction block appended to a worker's prompt so it knows it MAY
 * delegate (only while under the depth cap). Kept terse + conditional so
 * workers don't over-decompose simple tasks.
 */
export function delegationPromptNote(currentDepth: number): string {
  if (currentDepth >= MAX_DELEGATION_DEPTH) return '';
  return (
    `\n\n=== OPTIONAL: DELEGATION ===\n` +
    `If — and only if — this task genuinely needs to be broken into independent ` +
    `follow-on pieces, you MAY propose up to ${MAX_SUBTASKS_PER_DELEGATION} subtasks ` +
    `by emitting exactly one block at the end of your response:\n` +
    `<<<SOLIX_SUBTASKS\n` +
    `[{"title": "...", "prompt": "...", "acceptanceCriteria": "..."}]\n` +
    `SOLIX_SUBTASKS>>>\n` +
    `Each becomes its own verified task. Prefer doing the work yourself; only ` +
    `delegate when the pieces are genuinely separable.`
  );
}
