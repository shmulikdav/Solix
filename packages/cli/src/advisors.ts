import { resolvePort } from '@solix/shared';
interface AdvisorRow {
  id: string;
  codename: string;
  name: string;
  role: string;
  enabled: boolean;
  pinned: boolean;
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

export async function listAdvisorsCmd(): Promise<void> {
  try {
    const advisors = await api<AdvisorRow[]>('/api/advisors');
    if (!advisors.length) {
      console.log('No advisors found. Run `solix install` to seed the crew.');
      return;
    }
    const lines = advisors.map((a) => {
      const flag = a.pinned ? 'pinned' : a.enabled ? 'on' : 'off';
      return `  ${a.id.padEnd(10)} ${a.codename.padEnd(10)} ${a.role.padEnd(10)} [${flag}]`;
    });
    console.log('id          codename   role       state');
    console.log(lines.join('\n'));
  } catch (err) {
    console.error(`[solix] could not reach server at ${BASE}: ${String(err)}`);
    console.error('[solix] is `solix start` running?');
    process.exitCode = 1;
  }
}

async function postAdvisor(id: string, action: string): Promise<void> {
  try {
    const res = await api<{ ok: boolean }>(
      `/api/advisors/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
    );
    if (res.ok) {
      console.log(`[solix] ${id} → ${action}`);
    } else {
      console.error(`[solix] failed: advisor not found?`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[solix] could not reach server: ${String(err)}`);
    process.exitCode = 1;
  }
}

export const enableAdvisorCmd = (id: string): Promise<void> =>
  postAdvisor(id, 'enable');
export const disableAdvisorCmd = (id: string): Promise<void> =>
  postAdvisor(id, 'disable');
export const pinAdvisorCmd = (id: string): Promise<void> =>
  postAdvisor(id, 'pin');
export const unpinAdvisorCmd = (id: string): Promise<void> =>
  postAdvisor(id, 'unpin');
