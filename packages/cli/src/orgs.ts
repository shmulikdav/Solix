import type { Org, StorageStatus } from '@solix/shared';
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

export async function listOrgsCmd(): Promise<void> {
  try {
    const { orgs, currentOrgId } = await api<{ orgs: Org[]; currentOrgId: string }>(
      '/api/orgs',
    );
    for (const o of orgs) {
      const marker = o.id === currentOrgId ? '→' : ' ';
      console.log(`${marker} ${o.id.padEnd(16)} ${o.name}`);
    }
    const storage = await api<StorageStatus>('/api/system/storage');
    console.log(`\nstorage: ${storage.active} — ${storage.note}`);
  } catch (err) {
    unreachable(err);
  }
}

export async function newOrgCmd(name: string): Promise<void> {
  try {
    const org = await api<Org>('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    console.log(`[solix] created org ${org.id} (${org.name})`);
  } catch (err) {
    unreachable(err);
  }
}

export async function useOrgCmd(id: string): Promise<void> {
  try {
    await api('/api/orgs/current', {
      method: 'POST',
      body: JSON.stringify({ orgId: id }),
    });
    console.log(`[solix] active org → ${id}`);
  } catch (err) {
    unreachable(err);
  }
}
