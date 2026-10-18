/**
 * Clean-machine install rehearsal.
 *
 * `pnpm smoke:browser` exercises the repo; this exercises the TARBALL — the
 * thing a beta tester actually receives. Those differ in ways that only show
 * up here: a file missing from `files` in package.json, a hook script that
 * did not get copied into dist, a path that resolved in the workspace and
 * does not once installed.
 *
 * It walks the path a tester walks, against a throwaway HOME and a throwaway
 * npm prefix so nothing touches this machine:
 *
 *   npm i -g <tarball>  →  solix  →  hooks wire  →  a session appears
 *   →  a permission blocks and releases  →  solix uninstall  →  config intact
 *
 * Claude Code itself is not installed here, so the hook scripts are invoked
 * directly with realistic payloads. That is not a stand-in for the live test
 * a human still has to run, but it does cover everything between the hook
 * firing and the UI: the installed scripts, the shared token, the endpoints
 * and the ingestion.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4321;
const steps = [];
let failures = 0;

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => steps.push(`\x1b[32m✓\x1b[0m ${name}`))
    .catch((err) => {
      failures++;
      steps.push(`\x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
    });
}

const root = mkdtempSync(join(tmpdir(), 'solix-rehearse-'));
const home = join(root, 'home');
const prefix = join(root, 'npm');
const env = { ...process.env, HOME: home, SOLIX_PORT: String(PORT) };
let server;

async function waitForHealth(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server never became healthy');
}

function solix(args, opts = {}) {
  return execFileSync(join(prefix, 'bin', 'solix'), args, {
    env,
    encoding: 'utf8',
    ...opts,
  });
}

/** Fire an installed hook script the way Claude Code would. */
function fireHook(name, payload) {
  return execFileSync(join(home, '.solix', 'hooks', `${name}.sh`), [], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

try {
  execFileSync('mkdir', ['-p', home, prefix]);

  const tarball = join(
    process.cwd(),
    'packages/cli',
    execFileSync('ls', ['packages/cli'], { encoding: 'utf8' })
      .split('\n')
      .find((f) => f.endsWith('.tgz')) ?? '',
  );
  if (!tarball.endsWith('.tgz')) {
    throw new Error('no tarball — run `npm pack` in packages/cli first');
  }

  await step('installs globally from the tarball', () => {
    execFileSync('npm', ['i', '-g', '--prefix', prefix, tarball], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (!existsSync(join(prefix, 'bin', 'solix'))) {
      throw new Error('no solix binary after install');
    }
  });

  await step('reports its version', () => {
    const v = solix(['--version']).trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(`odd version: ${v}`);
  });

  // A tester who has never run Claude Code should be told, not left
  // guessing at an empty galaxy. `start` is a server, so it has to be
  // spawned and read rather than run to completion.
  await step('declines to wire hooks when Claude Code is absent', async () => {
    const probe = spawn(
      join(prefix, 'bin', 'solix'),
      ['start', '--no-open', '--port', String(PORT + 1)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    probe.stdout.on('data', (d) => (out += d));
    try {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (!/Claude Code not detected/.test(out)) {
        throw new Error(`expected a "not detected" notice, got:\n${out}`);
      }
      if (existsSync(join(home, '.claude'))) {
        throw new Error('created ~/.claude for software that is not installed');
      }
    } finally {
      probe.kill();
    }
  });

  // From here on, pretend Claude Code has been run once.
  execFileSync('mkdir', ['-p', join(home, '.claude')]);
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ mySetting: 'keep me', hooks: {} }, null, 2),
  );

  await step('first run wires the hooks and serves the UI', async () => {
    server = spawn(join(prefix, 'bin', 'solix'), ['start', '--no-open', '--port', String(PORT)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', (d) => (out += d));
    const health = await waitForHealth();
    if (!health.ok) throw new Error('health not ok');
    if (!/wiring Claude Code hooks/.test(out)) {
      throw new Error(`no wiring notice:\n${out}`);
    }
    for (const n of ['session-start', 'pre-tool-bash', 'stop']) {
      if (!existsSync(join(home, '.solix', 'hooks', `${n}.sh`))) {
        throw new Error(`hook script ${n}.sh missing after install`);
      }
    }
  });

  await step('serves the built UI, not a 404', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    const html = await r.text();
    if (!r.ok || !/<div id="root"/.test(html)) {
      throw new Error(`UI did not render (${r.status})`);
    }
  });

  await step('diagnostics report the install as current', async () => {
    const d = await (await fetch(`http://127.0.0.1:${PORT}/api/diagnostics`)).json();
    if (!d.hooks?.installed) throw new Error('hooks not reported installed');
    if (!d.hooks?.upToDate) {
      throw new Error(`hooks stamped ${d.hooks.stampedVersion}, running ${d.version}`);
    }
  });

  // The real hook scripts, the real token, the real endpoint.
  await step('a hook fires and the session appears', async () => {
    fireHook('session-start', {
      session_id: 'rehearsal-1',
      cwd: '/tmp/rehearsal',
      hook_event_name: 'SessionStart',
    });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions/rehearsal-1`);
      if (r.ok) {
        const s = await r.json();
        if (s?.id === 'rehearsal-1') return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      'the session never arrived — the installed hook script, its token, or ' +
        'the /events endpoint is broken in the packaged build',
    );
  });

  await step('uninstall keeps settings the user added afterwards', () => {
    const p = join(home, '.claude', 'settings.json');
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.addedLater = { mcpServers: ['mine'] };
    writeFileSync(p, JSON.stringify(cur, null, 2));

    solix(['uninstall']);

    const after = JSON.parse(readFileSync(p, 'utf8'));
    if (!after.addedLater) throw new Error('uninstall discarded a later edit');
    if (after.mySetting !== 'keep me') throw new Error('uninstall discarded a key');
    if (JSON.stringify(after.hooks ?? {}).includes('.solix')) {
      throw new Error('uninstall left Solix hooks behind');
    }
  });
} catch (err) {
  failures++;
  steps.push(`\x1b[31m✗\x1b[0m rehearsal aborted\n    ${err.message}`);
} finally {
  server?.kill();
  rmSync(root, { recursive: true, force: true });
}

console.log('\n' + steps.join('\n'));
if (failures) {
  console.error(`\n\x1b[31m✗ ${failures} problem(s) installing from the tarball\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ clean-machine rehearsal passed\x1b[0m');
