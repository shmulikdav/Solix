import type { Connection } from '@solix/shared';

const PORT = process.env.SOLIX_PORT ?? '4242';
const BASE = `http://127.0.0.1:${PORT}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as T;
}

function unreachable(err: unknown): void {
  console.error(`[solix] could not reach server at ${BASE}: ${String(err)}`);
  console.error('[solix] is `solix start` running?');
  process.exitCode = 1;
}

export async function listConnectionsCmd(): Promise<void> {
  try {
    const conns = await api<Connection[]>('/api/connections');
    if (!conns.length) {
      console.log('No connections. Add one with `solix connect <name> --secret KEY=VALUE --grant <role|*>`.');
      return;
    }
    for (const c of conns) {
      console.log(`  ${c.id}  ${c.name}  [${c.kind}]`);
      console.log(`     secrets: ${c.secretKeys.join(', ') || '(none)'}`);
      console.log(`     granted: ${c.grants.join(', ') || '(none — no worker can use it)'}`);
    }
  } catch (err) {
    unreachable(err);
  }
}

export async function connectCmd(
  name: string,
  opts: { kind?: string; secret?: string[]; grant?: string[] },
): Promise<void> {
  try {
    const conn = await api<Connection>('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ name, kind: opts.kind === 'mcp' ? 'mcp' : 'env' }),
    });
    for (const pair of opts.secret ?? []) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        console.error(`[solix] skipping malformed --secret "${pair}" (expected KEY=VALUE)`);
        continue;
      }
      await api(`/api/connections/${conn.id}/secrets`, {
        method: 'POST',
        body: JSON.stringify({ key: pair.slice(0, eq), value: pair.slice(eq + 1) }),
      });
    }
    for (const scope of opts.grant ?? []) {
      await api(`/api/connections/${conn.id}/grants`, {
        method: 'POST',
        body: JSON.stringify({ scope }),
      });
    }
    console.log(`[solix] connection "${name}" created (${conn.id}).`);
    await listConnectionsCmd();
  } catch (err) {
    unreachable(err);
  }
}
