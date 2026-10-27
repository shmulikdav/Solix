import type { Mission, Session } from '@solix/shared';

/**
 * Per-session health score 0–100. Pure heuristic — no LLM, no I/O.
 *
 * **100 means nothing is wrong**, and the score comes down as things are.
 * That is a change: it used to be built up from four bands, one of which
 * (`progress`, worth 15) was only awarded when a mission was active or
 * completed. An idle agent with nothing whatsoever wrong therefore topped
 * out at **85** — and with 456 idle sessions imported from months of
 * history, the column was a wall of identical 85s. It was computing
 * correctly and telling you nothing, which reads exactly like a bug.
 *
 * The deductions, and why each is a health problem rather than a statistic:
 *
 *   context    up to 40, quadratic — the agent starts forgetting what it was
 *              doing and quietly producing worse work. Low usage barely
 *              dents; the curve bites near the top, which is where it hurts.
 *   attention  up to 50 — work has STOPPED pending an answer from you. The
 *              first held command costs the most; a queue behind it adds up.
 *   status     an error is total; `terminated` is over rather than unwell;
 *              `plan_review`/`awaiting_input` need you without having raised
 *              a permission.
 *
 * `reasons[]` comes back alongside so the List and the SidePanel can say
 * *why*. A score with no reason is a number nobody acts on.
 */
export function computeHealth(
  session: Session,
  /**
   * Retained for the call signature and for a future stall signal (an active
   * mission making no tool calls for a long time). Deliberately unused for
   * scoring: crediting mission progress is what made 100 unreachable for an
   * idle agent, and "has a mission in flight" is not the same question as
   * "is this agent in good shape".
   */
  _mission: Mission | undefined,
  pendingForSession: number,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  if (session.status === 'error') {
    return { score: 0, reasons: ['In error state'] };
  }

  let score = 100;

  // ── Context pressure ──────────────────────────────────────────────
  const pct = Math.max(0, Math.min(100, session.contextUsagePct ?? 0));
  const contextPenalty = 40 * (pct / 100) ** 2;
  score -= contextPenalty;
  if (pct >= 90) reasons.push(`Context at ${pct.toFixed(0)}% — compact soon`);
  else if (pct >= 75) reasons.push(`Context at ${pct.toFixed(0)}%`);

  // ── Waiting on you ────────────────────────────────────────────────
  if (pendingForSession > 0) {
    score -= Math.min(50, 30 + (pendingForSession - 1) * 10);
    reasons.push(
      `${pendingForSession} command${pendingForSession === 1 ? '' : 's'} waiting on you`,
    );
  }

  // ── Status ────────────────────────────────────────────────────────
  switch (session.status) {
    case 'terminated':
      score -= 20;
      reasons.push('Terminated');
      break;
    case 'plan_review':
    case 'awaiting_input':
      // Needs you, but hasn't raised a permission — so `attention` above
      // did not already account for it.
      if (pendingForSession === 0) {
        score -= 20;
        reasons.push(`Status: ${session.status}`);
      }
      break;
    default:
      break;
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    reasons,
  };
}

export function healthColor(score: number): string {
  if (score >= 75) return '#10b981'; // ok
  if (score >= 50) return '#fbbf24'; // warm
  if (score >= 25) return '#f97316'; // warning
  return '#ef4444'; // danger
}
