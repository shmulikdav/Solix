import type { ScheduledTask, ScheduleRun } from '@solix/shared';
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

export async function listSchedulesCmd(): Promise<void> {
  try {
    const list = await api<ScheduledTask[]>('/api/schedules');
    if (!list.length) {
      console.log('No schedules. Add one with `solix schedules add`.');
      return;
    }
    console.log('id        trigger   state   when                 prompt');
    for (const s of list) {
      const trigger = s.trigger ?? 'interval';
      const when =
        trigger === 'interval'
          ? new Date(s.nextRunAt).toLocaleString()
          : trigger === 'webhook'
            ? 'on webhook'
            : 'on demand';
      const state = s.enabled ? 'on ' : 'off';
      console.log(
        `  ${s.id.padEnd(8)} ${trigger.padEnd(8)} [${state}] ${when.padEnd(20)} ${s.prompt.slice(0, 40)}`,
      );
    }
  } catch (err) {
    unreachable(err);
  }
}

export async function addScheduleCmd(
  prompt: string,
  opts: {
    cwd?: string;
    every?: string;
    name?: string;
    trigger?: string;
    owner?: string;
  },
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const trigger = (opts.trigger ?? 'interval') as 'interval' | 'webhook' | 'manual';
  if (!['interval', 'webhook', 'manual'].includes(trigger)) {
    console.error(`[solix] unknown trigger "${trigger}" (interval|webhook|manual)`);
    process.exitCode = 1;
    return;
  }
  const cadence = trigger === 'interval' ? (opts.every ?? '1h') : undefined;
  try {
    const s = await api<ScheduledTask>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ cwd, prompt, cadence, name: opts.name, trigger, owner: opts.owner }),
    });
    if (trigger === 'interval') {
      console.log(
        `[solix] scheduled ${s.id} — every ${s.cron} in ${cwd}\n        next run: ${new Date(s.nextRunAt).toLocaleString()}`,
      );
    } else if (trigger === 'webhook' && s.webhookToken) {
      const base = `http://127.0.0.1:${PORT}`;
      console.log(
        `[solix] webhook routine ${s.id} in ${cwd}\n` +
          `        fire it with: curl -X POST ${base}/api/triggers/${s.webhookToken}`,
      );
    } else {
      console.log(
        `[solix] manual routine ${s.id} in ${cwd}\n` +
          `        fire it with: solix schedules fire ${s.id}`,
      );
    }
  } catch (err) {
    unreachable(err);
  }
}

export async function fireScheduleCmd(id: string): Promise<void> {
  try {
    await api(`/api/schedules/${encodeURIComponent(id)}/fire`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    console.log(`[solix] fired routine ${id}`);
  } catch (err) {
    unreachable(err);
  }
}

export async function scheduleRunsCmd(id: string): Promise<void> {
  try {
    const runs = await api<ScheduleRun[]>(
      `/api/schedules/${encodeURIComponent(id)}/runs`,
    );
    if (!runs.length) {
      console.log(`No runs recorded for ${id} yet.`);
      return;
    }
    console.log('when                 trigger   status   detail');
    for (const r of runs) {
      console.log(
        `  ${new Date(r.firedAt).toLocaleString().padEnd(20)} ${String(r.trigger).padEnd(8)} ${r.status.padEnd(8)} ${(r.detail ?? '').slice(0, 48)}`,
      );
    }
  } catch (err) {
    unreachable(err);
  }
}

async function toggle(id: string, enabled: boolean): Promise<void> {
  try {
    await api(`/api/schedules/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    console.log(`[solix] schedule ${id} → ${enabled ? 'enabled' : 'disabled'}`);
  } catch (err) {
    unreachable(err);
  }
}

export const enableScheduleCmd = (id: string): Promise<void> => toggle(id, true);
export const disableScheduleCmd = (id: string): Promise<void> =>
  toggle(id, false);

export async function removeScheduleCmd(id: string): Promise<void> {
  try {
    await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    console.log(`[solix] removed schedule ${id}`);
  } catch (err) {
    unreachable(err);
  }
}
