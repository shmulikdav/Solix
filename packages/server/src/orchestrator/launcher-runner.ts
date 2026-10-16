import type { Launcher } from '../launcher.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

/**
 * Production SessionRunner — spawns a real `claude --print` session via the
 * Launcher and returns its stdout.
 *
 * Under `SOLIX_FAKE_CLAUDE=1` it returns canned, role-keyed output instead, so
 * the entire orchestrator loop (plan → approve → …) runs with no real `claude`
 * for dev/demo/CI. The planner fake emits a small valid plan JSON derived from
 * the goal so the PlanPanel has something real to render.
 */
export class LauncherSessionRunner implements SessionRunner {
  constructor(private readonly launcher: Launcher) {}

  async runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
    if (process.env.SOLIX_FAKE_CLAUDE === '1') {
      return fakeRunOnce(opts);
    }
    const res = await this.launcher.runOnce({
      cwd: opts.cwd,
      prompt: opts.prompt,
      model: opts.model,
      runtime: opts.runtime,
      signal: opts.signal,
      // Workers/verifiers run autonomously → contained (env-scrubbed) by default.
      contain: opts.role === 'worker' || opts.role === 'verifier',
      // Deterministic id → claude runs under it, so its hooks enrich the
      // pre-created plan-linked row (containment role lookup + visualization).
      sessionId: opts.sessionId,
      // Scoped secrets (granted connections) for this worker.
      env: opts.env,
    });
    return {
      ok: res.ok,
      output: res.output,
      sessionId: opts.sessionId,
      error: res.error,
      costUsd: res.costUsd,
    };
  }
}

function extractGoal(prompt: string): string {
  const marker = '=== GOAL ===';
  const idx = prompt.indexOf(marker);
  return (idx >= 0 ? prompt.slice(idx + marker.length) : prompt).trim();
}

function fakeRunOnce(opts: RunOnceOpts): RunOnceResult {
  if (opts.role === 'planner') {
    const goal = extractGoal(opts.prompt);
    const plan = {
      name: (goal.slice(0, 40) || 'Demo plan').trim(),
      tasks: [
        {
          id: 't1',
          title: 'Scaffold',
          prompt: `Set up the groundwork for: ${goal}`,
          acceptanceCriteria: 'Project builds and the entry point exists.',
          dependsOn: [],
          assignedAdvisorRole: 'forge',
        },
        {
          id: 't2',
          title: 'Implement',
          prompt: `Implement the core of: ${goal}`,
          acceptanceCriteria: 'The feature works end-to-end and typechecks.',
          dependsOn: ['t1'],
          assignedAdvisorRole: 'forge',
        },
        {
          id: 't3',
          title: 'Review',
          prompt: `Review the implementation of: ${goal}`,
          acceptanceCriteria: 'No critical correctness or security issues remain.',
          dependsOn: ['t2'],
          assignedAdvisorRole: 'argus',
        },
      ],
    };
    return { ok: true, output: JSON.stringify(plan), sessionId: opts.sessionId };
  }
  if (opts.role === 'verifier') {
    return {
      ok: true,
      output: JSON.stringify({ pass: true, reason: 'looks good (synthetic)' }),
      sessionId: opts.sessionId,
      costUsd: 0.001,
    };
  }
  return {
    ok: true,
    output: '(synthetic worker output)',
    sessionId: opts.sessionId,
    costUsd: 0.01,
  };
}
