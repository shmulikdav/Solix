import type { TeamInstallResult, TeamTemplate } from '@solix/shared';

const PORT = process.env.SOLIX_PORT ?? '4242';
const BASE = `http://127.0.0.1:${PORT}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

function unreachable(err: unknown): void {
  console.error(`[solix] could not reach server at ${BASE}: ${String(err)}`);
  console.error('[solix] is `solix start` running?');
  process.exitCode = 1;
}

export async function listTeamsCmd(): Promise<void> {
  try {
    const list = await api<TeamTemplate[]>('/api/teams/templates');
    if (!list.length) {
      console.log('No team templates available.');
      return;
    }
    console.log('Ready-made teams — install with `solix teams install <id>`:\n');
    for (const t of list) {
      console.log(`  ${t.id}`);
      console.log(`    ${t.name} — ${t.goal}`);
      console.log(`    advisors: ${t.advisors.join(', ') || '—'}`);
      if (t.skills.length) console.log(`    skills:   ${t.skills.join(', ')}`);
      if (t.routines.length)
        console.log(`    routines: ${t.routines.map((r) => r.name).join(', ')}`);
      console.log('');
    }
  } catch (err) {
    unreachable(err);
  }
}

export async function installTeamCmd(
  id: string,
  opts: { cwd?: string },
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const r = await api<TeamInstallResult>(
      `/api/teams/templates/${encodeURIComponent(id)}/install`,
      { method: 'POST', body: JSON.stringify({ cwd }) },
    );
    console.log(`[solix] installed team "${id}" into ${cwd}`);
    console.log(`        advisors enabled: ${r.advisorsEnabled.join(', ') || '—'}`);
    console.log(`        skills installed: ${r.skillsInstalled.join(', ') || '—'}`);
    console.log(`        routines created: ${r.routinesCreated.length}`);
    for (const w of r.warnings) console.log(`        ⚠ ${w}`);
  } catch (err) {
    unreachable(err);
  }
}
