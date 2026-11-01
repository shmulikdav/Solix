import { readFileSync, writeFileSync } from 'node:fs';
import { resolvePort } from '@solix/shared';

const PORT = String(resolvePort());
const BASE = `http://127.0.0.1:${PORT}`;

interface ImportResponse {
  ok: boolean;
  advisorsEnabled: number;
  advisorsDisabled: number;
  projectsHinted: number;
  error?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${path}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function exportGalaxyCmd(
  outFile: string,
  opts: { name?: string; author?: string; description?: string } = {},
): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (opts.name) params.set('name', opts.name);
    if (opts.author) params.set('author', opts.author);
    if (opts.description) params.set('description', opts.description);
    const qs = params.toString();
    const manifest = await api<unknown>(
      `/api/galaxy/export${qs ? `?${qs}` : ''}`,
    );
    const text = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(outFile, text);
    console.log(`[solix] exported galaxy to ${outFile}`);
  } catch (err) {
    console.error(`[solix] export failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

export async function publishGalaxyCmd(
  slug: string,
  opts: { name?: string; author?: string; description?: string } = {},
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/galaxy/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, ...opts }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      slug?: string;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      console.error(
        `[solix] publish failed: ${data.error ?? `HTTP ${res.status}`}`,
      );
      console.error(
        '[solix] hint: set SOLIX_REGISTRY_URL and SOLIX_REGISTRY_KEY before starting the server.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[solix] published as ${data.slug ?? slug}`);
  } catch (err) {
    console.error(`[solix] publish failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

export async function installFromRegistryCmd(slug: string): Promise<void> {
  try {
    const res = await fetch(
      `${BASE}/api/galaxy/registry/${encodeURIComponent(slug)}/install`,
      { method: 'POST' },
    );
    const data = (await res.json()) as ImportResponse & { error?: string };
    if (!res.ok || !data.ok) {
      console.error(
        `[solix] install failed: ${data.error ?? `HTTP ${res.status}`}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `[solix] installed ${slug}: ${data.advisorsEnabled} advisor(s) enabled, ` +
        `${data.advisorsDisabled} disabled, ${data.projectsHinted} project(s) hinted`,
    );
  } catch (err) {
    console.error(`[solix] install failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

export async function importGalaxyCmd(fileOrUrl: string): Promise<void> {
  try {
    let body: string;
    if (
      fileOrUrl.startsWith('http://') ||
      fileOrUrl.startsWith('https://')
    ) {
      body = JSON.stringify({ url: fileOrUrl });
    } else {
      const text = readFileSync(fileOrUrl, 'utf8');
      // Just round-trip the manifest as-is.
      body = text;
    }
    const res = await api<ImportResponse>(`/api/galaxy/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) {
      console.log(
        `[solix] imported: ${res.advisorsEnabled} advisor(s) enabled, ` +
          `${res.advisorsDisabled} disabled, ${res.projectsHinted} project(s) hinted`,
      );
    } else {
      console.error(`[solix] import failed: ${res.error ?? 'unknown'}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[solix] import failed: ${String(err)}`);
    process.exitCode = 1;
  }
}
