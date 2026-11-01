import { resolvePort } from '@solix/shared';
interface SkillRow {
  id: string;
  name: string;
  source: 'anthropic' | 'solix' | 'user';
  description: string;
  installedInProjects: string[];
}

const PORT = String(resolvePort());
const BASE = `http://127.0.0.1:${PORT}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function listSkillsCmd(): Promise<void> {
  try {
    const skills = await api<SkillRow[]>('/api/skills');
    if (!skills.length) {
      console.log(
        'No skills found. Drop SKILL.md files into ~/.claude/skills/ or ~/.solix/skills/.',
      );
      return;
    }
    console.log('source     id                              installed  name');
    for (const s of skills) {
      const installed = String(s.installedInProjects.length).padStart(2, ' ');
      console.log(
        `${s.source.padEnd(10)} ${s.id.padEnd(32)} ${installed}         ${s.name}`,
      );
    }
  } catch (err) {
    console.error(`[solix] could not reach server at ${BASE}: ${String(err)}`);
    process.exitCode = 1;
  }
}

export async function installSkillCmd(
  id: string,
  projectId?: string,
): Promise<void> {
  if (!projectId) {
    console.error(
      '[solix] --project <projectId> is required (use `solix doctor` or `/api/projects` to find it)',
    );
    process.exitCode = 1;
    return;
  }
  try {
    const res = await api<{ ok: boolean }>(
      `/api/skills/${encodeURIComponent(id)}/install`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    if (res.ok) {
      console.log(`[solix] ${id} installed in project ${projectId}`);
    } else {
      console.error(`[solix] failed: skill not found?`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[solix] could not reach server: ${String(err)}`);
    process.exitCode = 1;
  }
}
