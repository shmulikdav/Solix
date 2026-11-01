import type { Mission, Session } from '@solix/shared';
import type { DB } from '../db.js';
import { listMissions } from './missions.js';
import { getSession } from './sessions.js';
import { getAdvisor, readAdvisorAgentMd } from './advisors.js';

const MISSIONS_FOR_HANDOFF = 3;

const DEFAULT_ASKS: Record<string, string> = {
  pm: 'Review the recent missions and propose 1–3 next features in priority order, with a one-line rationale each.',
  builder:
    'Identify the smallest unfinished item from the recent missions and propose an implementation plan.',
  ux: 'Audit the most recent UI-affecting mission for visual polish opportunities.',
  reviewer:
    'Review the diff of the most recently completed mission. Output: numbered findings with severity and proposed fix.',
  security:
    'Audit the changes from the last 3 missions for security regressions, especially around hooks, settings.json, and child-process spawns.',
  qa: 'Identify the most recent untested change and propose the smallest test that would catch a regression in it.',
  devrel:
    'Identify the most recent user-facing change and update the README accordingly.',
  perf: 'Profile the most recent change for hot-path allocations or bundle-size regressions.',
  release:
    'Decide whether the recent missions justify a patch / minor / major bump and draft a one-paragraph changelog entry.',
  curator:
    'Review skills installed in this project against missions performed; recommend additions or retirements.',
};

function summarizeMission(m: Mission): string {
  const head = `- ${m.shortName}: ${m.longSummary ?? m.prompt.slice(0, 120)}`;
  const meta = `  (status: ${m.status}, ${m.metrics.toolCallCount} tool calls, ${m.metrics.subagentCount} subagents)`;
  const files =
    m.filesTouched.length > 0
      ? `  files: ${m.filesTouched.slice(0, 5).join(', ')}${
          m.filesTouched.length > 5 ? ` (+${m.filesTouched.length - 5})` : ''
        }`
      : '';
  return [head, meta, files].filter(Boolean).join('\n');
}

function contextBudgetNote(target: Session | null): string {
  if (!target) return '';
  const pct = target.contextUsagePct;
  // No measurement is not a quiet session. Until the watcher persisted this,
  // the column sat at 0 forever and neither branch below could ever be
  // reached outside `solix demo` — so the one advisor instruction that
  // depends on context pressure had never fired in real use.
  if (pct === null) return '';
  if (pct >= 90) {
    return `\n\n⚠ CONTEXT NEAR LIMIT: target session is at ${pct.toFixed(0)}%. Suggest the user run /compact before deeper work.`;
  }
  if (pct >= 80) {
    return `\n\n⚠ Context budget warning: target session is at ${pct.toFixed(0)}%. Keep your output tight.`;
  }
  return '';
}

export interface BuildEnvelopeArgs {
  advisorId: string;
  targetSessionId?: string;
  userPrompt?: string;
}

export interface ContextEnvelope {
  advisorId: string;
  advisorRole: string;
  prompt: string;
  recentMissions: Mission[];
  targetSession: Session | null;
}

/**
 * Compose a contextualized prompt for an advisor invocation.
 *
 * Strategy: pass mission summaries (the cheapest possible handoff currency),
 * not full transcripts. The advisor receives a short, structured envelope
 * that puts it in the right context window without flooding it.
 */
export function buildContextEnvelope(
  db: DB,
  args: BuildEnvelopeArgs,
): ContextEnvelope | null {
  const advisor = getAdvisor(db, args.advisorId);
  if (!advisor) return null;

  const target = args.targetSessionId
    ? getSession(db, args.targetSessionId)
    : null;

  const recent = target
    ? listMissions(db, {
        sessionId: target.id,
        limit: MISSIONS_FOR_HANDOFF,
      })
    : [];

  const role = advisor.role;
  const defaultAsk =
    DEFAULT_ASKS[role] ??
    `Act in your role as ${advisor.codename} (${advisor.name}).`;
  const userAsk = args.userPrompt?.trim();

  const lines: string[] = [];
  lines.push(`You are ${advisor.codename} (${advisor.name}).`);
  lines.push('');
  lines.push(advisor.description);

  if (target) {
    lines.push('');
    lines.push(`Active project: ${target.cwd}`);
    lines.push(
      // "context=0%" was what every advisor was told, always. Saying
      // "unknown" when nothing has measured it is the difference between a
      // model reasoning from a fact and reasoning from a default.
      `Focused planet: ${target.name ?? target.id.slice(0, 8)} (${target.model}, status=${target.status}, context=${
        target.contextUsagePct === null
          ? 'unknown'
          : `${target.contextUsagePct.toFixed(0)}%`
      })`,
    );
  }

  if (recent.length > 0) {
    lines.push('');
    lines.push(`Recent missions on this planet (latest first):`);
    for (const m of recent) {
      lines.push(summarizeMission(m));
    }
  } else if (target) {
    lines.push('');
    lines.push('No prior missions on this planet — you are starting clean.');
  } else {
    lines.push('');
    lines.push(
      'No focused planet — operate at the project level using your role guidance.',
    );
  }

  lines.push('');
  lines.push('Specific ask:');
  lines.push(userAsk && userAsk.length > 0 ? userAsk : defaultAsk);

  const tail = contextBudgetNote(target);
  if (tail) lines.push(tail);

  return {
    advisorId: advisor.id,
    advisorRole: advisor.role,
    prompt: lines.join('\n'),
    recentMissions: recent,
    targetSession: target,
  };
}

export function readAdvisorAgentSource(db: DB, advisorId: string): string {
  const advisor = getAdvisor(db, advisorId);
  if (!advisor) return '';
  return readAdvisorAgentMd(advisor);
}
