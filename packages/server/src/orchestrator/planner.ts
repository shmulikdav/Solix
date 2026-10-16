import { validatePlanGraph, type SchedulableTask } from './scheduler.js';

/**
 * Pure parsing + validation of a Maestro planner session's output into a plan.
 *
 * The planner is told to emit strict JSON, but LLMs leak markdown fences and
 * prose, so extraction is tolerant; validation is then strict. Treating the
 * output as untrusted data (Sentinel): `assignedAdvisorRole`/`model` are
 * allowlisted (unknown values are dropped, not trusted), and the task graph is
 * validated (unknown deps / self-deps / cycles) before anything can run.
 *
 * Zero I/O — unit-testable with canned planner strings.
 */

export interface ParsedTask {
  id: string;
  title: string;
  prompt: string;
  acceptanceCriteria: string;
  dependsOn: string[];
  assignedAdvisorRole?: string;
  model?: string;
  runtime?: 'claude' | 'codex';
}

export interface ParsedPlan {
  name: string;
  tasks: ParsedTask[];
}

export interface ParseResult {
  ok: boolean;
  errors: string[];
  /** Non-fatal notes (e.g. an unknown advisor role was dropped). */
  warnings: string[];
  plan?: ParsedPlan;
}

export interface ParseOptions {
  /** Advisor roles that actually exist (from the seeded roster). */
  knownAdvisorRoles: string[];
  /** Model ids/aliases the launcher will accept. */
  knownModels: string[];
}

/** Pull the first balanced JSON object out of a possibly-fenced/prose blob. */
function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  // Fast path: it's already clean JSON.
  if (trimmed.startsWith('{')) return trimmed;
  // Strip a ```json … ``` (or ``` … ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]?.trim().startsWith('{')) return fence[1].trim();
  // Last resort: from the first '{' to the last '}'.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function parsePlannerOutput(
  raw: string,
  opts: ParseOptions,
): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const jsonStr = extractJson(raw);
  if (jsonStr == null) {
    return { ok: false, errors: ['planner output contained no JSON object'], warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      errors: [`planner JSON did not parse: ${(err as Error).message}`],
      warnings,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['planner JSON is not an object'], warnings };
  }
  const obj = parsed as Record<string, unknown>;

  const name = isNonEmptyString(obj.name) ? obj.name.trim() : '';
  if (!name) errors.push('plan is missing a non-empty "name"');

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : null;
  if (!rawTasks || rawTasks.length === 0) {
    errors.push('plan has no tasks');
    return { ok: false, errors, warnings };
  }

  const roleSet = new Set(opts.knownAdvisorRoles);
  const modelSet = new Set(opts.knownModels);
  const seenIds = new Set<string>();
  const tasks: ParsedTask[] = [];

  rawTasks.forEach((rt, i) => {
    if (typeof rt !== 'object' || rt === null) {
      errors.push(`task[${i}] is not an object`);
      return;
    }
    const t = rt as Record<string, unknown>;
    const id = isNonEmptyString(t.id) ? t.id.trim() : '';
    const title = isNonEmptyString(t.title) ? t.title.trim() : '';
    const prompt = isNonEmptyString(t.prompt) ? t.prompt.trim() : '';
    // Verification is make-or-break — an empty acceptance criterion is illegal.
    const acceptanceCriteria = isNonEmptyString(t.acceptanceCriteria)
      ? t.acceptanceCriteria.trim()
      : '';

    if (!id) errors.push(`task[${i}] is missing a non-empty "id"`);
    else if (seenIds.has(id)) errors.push(`duplicate task id "${id}"`);
    if (!title) errors.push(`task "${id || i}" is missing a "title"`);
    if (!prompt) errors.push(`task "${id || i}" is missing a "prompt"`);
    if (!acceptanceCriteria)
      errors.push(`task "${id || i}" is missing "acceptanceCriteria"`);

    const dependsOn = Array.isArray(t.dependsOn)
      ? t.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];

    // Allowlist role + model; drop (don't trust) unknown values.
    let assignedAdvisorRole: string | undefined;
    if (isNonEmptyString(t.assignedAdvisorRole)) {
      const r = t.assignedAdvisorRole.trim();
      if (roleSet.has(r)) assignedAdvisorRole = r;
      else warnings.push(`task "${id || i}": dropped unknown advisor role "${r}"`);
    }
    let model: string | undefined;
    if (isNonEmptyString(t.model)) {
      const m = t.model.trim();
      if (modelSet.has(m)) model = m;
      else warnings.push(`task "${id || i}": dropped unknown model "${m}"`);
    }
    // Allowlist runtime — only the known agent runtimes.
    let runtime: 'claude' | 'codex' | undefined;
    if (isNonEmptyString(t.runtime)) {
      const r = t.runtime.trim();
      if (r === 'claude' || r === 'codex') runtime = r;
      else warnings.push(`task "${id || i}": dropped unknown runtime "${r}"`);
    }

    if (id) seenIds.add(id);
    if (id && title && prompt && acceptanceCriteria) {
      tasks.push({
        id,
        title,
        prompt,
        acceptanceCriteria,
        dependsOn,
        assignedAdvisorRole,
        model,
        runtime,
      });
    }
  });

  // Validate the graph over the well-formed tasks (existence / self-dep / cycle).
  if (tasks.length > 0) {
    const schedulable: SchedulableTask[] = tasks.map((t) => ({
      id: t.id,
      status: 'pending',
      dependsOn: t.dependsOn,
      attempts: 0,
      maxAttempts: 3,
    }));
    const graph = validatePlanGraph(schedulable);
    errors.push(...graph.errors);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors, warnings, plan: { name, tasks } };
}

export interface Verdict {
  pass: boolean;
  reason: string;
  /** True when the verifier output couldn't be parsed into a clear verdict.
   *  The orchestrator treats ambiguous as NOT passing (escalate, never
   *  auto-approve on unparseable output — Sentinel). */
  ambiguous: boolean;
}

/**
 * Parse a verifier session's output into a strict `{ pass, reason }` verdict.
 * The verifier is the acceptance gate, and its output is untrusted (an LLM,
 * influenced by attacker-crafted worker output), so anything that isn't a
 * clean boolean `pass` is treated as ambiguous → the caller escalates. Never
 * default to pass.
 */
export function parseVerifierOutput(raw: string): Verdict {
  const jsonStr = extractJson(raw);
  if (jsonStr == null) {
    return { pass: false, reason: 'verifier produced no JSON verdict', ambiguous: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { pass: false, reason: 'verifier verdict did not parse', ambiguous: true };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { pass: false, reason: 'verifier verdict was not an object', ambiguous: true };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pass !== 'boolean') {
    return {
      pass: false,
      reason: 'verifier verdict had no boolean "pass"',
      ambiguous: true,
    };
  }
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim()
      : obj.pass
        ? 'accepted'
        : 'rejected';
  return { pass: obj.pass, reason, ambiguous: false };
}
