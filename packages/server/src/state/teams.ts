import type { TeamInstallResult, TeamTemplate } from '@solix/shared';
import type { DB } from '../db.js';
import { getAdvisor, setAdvisorEnabled } from './advisors.js';
import { ensureProject } from './projects.js';
import { listSkills, recordSkillInstall } from './skills.js';
import { createSchedule, listSchedules } from './schedules.js';

// ── Team templates (P2 #7) ─────────────────────────────────────────────
// Curated, installable bundles of advisors + skills + routines. Built-in and
// read-only — installing one enables its advisors, installs its skills into a
// project, and creates its routines. Pieces that don't exist in this install
// are skipped with a warning (never a hard failure), so a template degrades
// gracefully across advisor/skill sets.

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'ship-fast',
    name: 'Ship-fast build team',
    description:
      'Build features end-to-end: a builder, a UX eye, a reviewer, and QA. The default team for a new product.',
    goal: 'Build and ship features end-to-end.',
    advisors: ['forge', 'lumen', 'argus', 'mira'],
    skills: ['mission-summary'],
    routines: [
      {
        name: 'Daily backlog sweep',
        prompt:
          'Review the project backlog and open issues; summarize what should ship next and why.',
        trigger: 'interval',
        cadence: '1d',
      },
    ],
  },
  {
    id: 'quality-gate',
    name: 'Quality & security gate',
    description:
      'Keep the codebase correct, secure, and tested: a reviewer, a security auditor, QA, and a debugger.',
    goal: 'Hold the quality and security bar before merge.',
    advisors: ['argus', 'sentinel', 'mira', 'cinder'],
    skills: ['mission-summary', 'permission-explainer'],
    routines: [
      {
        name: 'Pre-merge audit',
        prompt:
          'Audit the current diff for correctness, security, and test coverage; list blockers before merge.',
        trigger: 'webhook',
      },
    ],
  },
  {
    id: 'launch',
    name: 'Launch & devrel team',
    description:
      'Ship releases and keep the story current: a release manager, a devrel voice, and a product manager.',
    goal: 'Cut releases and keep docs/launch material current.',
    advisors: ['vale', 'echo', 'compass'],
    skills: ['galaxy-publish', 'mission-summary'],
    routines: [
      {
        name: 'Release notes draft',
        prompt:
          'Draft release notes from the commits since the last tag, and flag anything user-facing that needs docs.',
        trigger: 'manual',
      },
    ],
  },
  {
    id: 'architecture',
    name: 'Architecture & data team',
    description:
      'Design before code and own the data layer: an architect, a data owner, and a FinOps watcher.',
    goal: 'Design systems and own the data layer up front.',
    advisors: ['spire', 'delta', 'ledger'],
    skills: [],
    routines: [],
  },
];

export function listTeamTemplates(): TeamTemplate[] {
  return TEAM_TEMPLATES;
}

export function getTeamTemplate(id: string): TeamTemplate | null {
  return TEAM_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Install a team template into a project: enable its advisors, install its
 * skills, and create its routines. Degrades gracefully — an advisor or skill
 * that isn't present is skipped with a warning rather than failing the install.
 */
export function installTeamTemplate(
  db: DB,
  templateId: string,
  input: {
    cwd: string;
    /** Create the template's routines. Default true. A routine is the only
     *  part of a team install with an ongoing effect — an interval routine
     *  launches a real agent session on a cadence, which costs money — so the
     *  caller can decline them while still taking the advisors + skills. */
    includeRoutines?: boolean;
  },
): TeamInstallResult {
  const template = getTeamTemplate(templateId);
  const warnings: string[] = [];
  const advisorsEnabled: string[] = [];
  const skillsInstalled: string[] = [];
  const routinesCreated: string[] = [];
  const routinesAlreadyPresent: string[] = [];
  if (!template) {
    return {
      ok: false,
      templateId,
      advisorsEnabled,
      skillsInstalled,
      routinesCreated,
      routinesAlreadyPresent,
      warnings: [`unknown team template "${templateId}"`],
    };
  }
  const cwd = input.cwd?.trim();
  if (!cwd) {
    return {
      ok: false,
      templateId,
      advisorsEnabled,
      skillsInstalled,
      routinesCreated,
      routinesAlreadyPresent,
      warnings: ['a working directory (cwd) is required'],
    };
  }

  const project = ensureProject(db, cwd);

  // Advisors — enable those that exist.
  for (const advisorId of template.advisors) {
    if (!getAdvisor(db, advisorId)) {
      warnings.push(`advisor "${advisorId}" not found — skipped`);
      continue;
    }
    setAdvisorEnabled(db, advisorId, true);
    advisorsEnabled.push(advisorId);
  }

  // Skills — resolve by id or name against the installed catalog.
  const catalog = listSkills(db);
  for (const ref of template.skills) {
    const skill = catalog.find((s) => s.id === ref || s.name === ref);
    if (!skill) {
      warnings.push(`skill "${ref}" not found — skipped`);
      continue;
    }
    recordSkillInstall(db, skill.id, project.id);
    skillsInstalled.push(skill.id);
  }

  /**
   * Routines — created in the target project, unless declined, and **never
   * twice**.
   *
   * This loop called createSchedule unconditionally. Installing a team
   * twice therefore produced two enabled interval routines running the same
   * prompt on the same cadence, each starting a real agent session and
   * billing on every run — and the success toast was identical both times,
   * so nothing said the first install had already happened.
   *
   * createSchedule already stamps `owner: template.id`, so recognising our
   * own work needs no new state: same project, same template, same routine
   * name is the same routine.
   */
  const includeRoutines = input.includeRoutines !== false;
  const existing = listSchedules(db).filter(
    (s) => s.cwd === cwd && s.owner === template.id,
  );
  for (const routine of includeRoutines ? template.routines : []) {
    const already = existing.find((s) => s.name === routine.name);
    if (already) {
      routinesAlreadyPresent.push(already.id);
      continue;
    }
    const sched = createSchedule(db, {
      cwd,
      prompt: routine.prompt,
      name: routine.name,
      trigger: routine.trigger ?? 'interval',
      cadence: routine.cadence,
      owner: template.id,
    });
    routinesCreated.push(sched.id);
  }

  if (routinesAlreadyPresent.length > 0) {
    warnings.push(
      `${routinesAlreadyPresent.length} routine(s) were already installed in ` +
        'this project — left as they are rather than duplicated',
    );
  }

  if (!includeRoutines && template.routines.length > 0) {
    warnings.push(
      `${template.routines.length} routine(s) not created (declined)`,
    );
  }

  return {
    ok: true,
    templateId,
    advisorsEnabled,
    skillsInstalled,
    routinesCreated,
    routinesAlreadyPresent,
    warnings,
  };
}
