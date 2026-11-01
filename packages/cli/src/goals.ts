import type { Goal } from '@solix/shared';
import { resolvePort } from '@solix/shared';

const PORT = String(resolvePort());
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

export async function listGoalsCmd(): Promise<void> {
  try {
    const goals = await api<Goal[]>('/api/goals');
    if (!goals.length) {
      console.log('No goals. Add one with `solix goal add "<name>"`.');
      return;
    }
    console.log('id        color    name');
    for (const g of goals) {
      console.log(`  ${g.id.padEnd(8)} ${g.color.padEnd(8)} ${g.name}`);
    }
  } catch (err) {
    unreachable(err);
  }
}

export async function addGoalCmd(
  name: string,
  opts: { description?: string; color?: string },
): Promise<void> {
  try {
    const g = await api<Goal>('/api/goals', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: opts.description,
        color: opts.color,
      }),
    });
    console.log(`[solix] created goal ${g.id} — "${g.name}" (${g.color})`);
  } catch (err) {
    unreachable(err);
  }
}

export async function removeGoalCmd(id: string): Promise<void> {
  try {
    await api(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
    console.log(`[solix] removed goal ${id}`);
  } catch (err) {
    unreachable(err);
  }
}
