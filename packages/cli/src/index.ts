#!/usr/bin/env node
import { Command } from 'commander';

// Injected at build time by tsup from packages/cli/package.json. The
// previous hardcoded '1.0.0' literal was a bug — `solix --version`
// always lied no matter what version you installed.
declare const __SOLIX_VERSION__: string;
import {
  disableAdvisorCmd,
  enableAdvisorCmd,
  listAdvisorsCmd,
  pinAdvisorCmd,
  unpinAdvisorCmd,
} from './advisors.js';
import { demoCmd } from './demo.js';
import { doctor } from './doctor.js';
import { gain } from './gain.js';
import { importCmd } from './import.js';
import { level } from './level.js';
import { ledger } from './ledger.js';
import {
  exportGalaxyCmd,
  importGalaxyCmd,
  installFromRegistryCmd,
  publishGalaxyCmd,
} from './galaxy.js';
import { hooksSupported, install } from './install.js';
import { installShim } from './install-shim.js';
import { runWrapped } from './run.js';
import { installSkillCmd, listSkillsCmd } from './skills.js';
import {
  addScheduleCmd,
  disableScheduleCmd,
  enableScheduleCmd,
  fireScheduleCmd,
  listSchedulesCmd,
  removeScheduleCmd,
  scheduleRunsCmd,
} from './schedule.js';
import { addGoalCmd, listGoalsCmd, removeGoalCmd } from './goals.js';
import { installTeamCmd, listTeamsCmd } from './teams.js';
import { listOrgsCmd, newOrgCmd, useOrgCmd } from './orgs.js';
import { activateLicenseCmd, licenseStatusCmd } from './license.js';
import { connectCmd, listConnectionsCmd } from './connections.js';
import { start } from './start.js';
import { uninstall } from './uninstall.js';

const program = new Command();

program
  .name('solix')
  .description('Solix — the control layer for your coding agents')
  .version(__SOLIX_VERSION__);

program
  .command('start', { isDefault: true })
  .description('Start the Solix server and open the browser')
  .option('-p, --port <port>', 'port to listen on', (v) => parseInt(v, 10), 4242)
  .option('--no-open', 'do not open browser automatically')
  .action(async (opts: { port: number; open: boolean }) => {
    await start({ port: opts.port, noOpen: !opts.open });
  });

program
  .command('install')
  .description('Install Solix hooks into ~/.claude/settings.json')
  .option('--force', 'overwrite even if hooks already present')
  .action((opts: { force?: boolean }) => {
    // Refuse rather than install hooks the platform cannot execute. Writing
    // them and reporting success is how a Windows user ends up convinced
    // Solix is broken rather than unsupported.
    if (!hooksSupported()) {
      console.error(
        '[solix] native Windows is not supported yet — the hooks are POSIX\n' +
          '        shell scripts and will not run here. Install Solix inside\n' +
          '        WSL, where it works today.',
      );
      process.exitCode = 1;
      return;
    }
    install({ force: opts.force });
    console.log('\n[solix] install complete. Run `solix start` next.');
  });

program
  .command('uninstall')
  .description('Restore ~/.claude/settings.json from backup')
  .action(() => {
    uninstall();
  });

program
  .command('run')
  .description(
    'Wrap a claude session under a PTY so the Solix UI can send prompts to it. ' +
      'Pass any args you would normally pass to claude.',
  )
  .allowUnknownOption(true)
  .helpOption(false)
  .action(async (_opts, cmd: Command) => {
    await runWrapped(cmd.args ?? []);
  });

program
  .command('install-shim')
  .description(
    "Add `alias claude='solix run'` to your shell rc so every claude " +
      'session is wrapped automatically.',
  )
  .action(() => {
    installShim();
  });

program
  .command('doctor')
  .description('Run diagnostics')
  .action(async () => {
    await doctor();
  });

program
  .command('level [name]')
  .description('Show or set how much Solix holds for you (observe|standard|strict)')
  .action((name?: string) => {
    level(name);
  });

program
  .command('import')
  .description('Backfill the galaxy from your existing Claude Code transcripts')
  .action(async () => {
    await importCmd();
  });

program
  .command('ledger')
  .description('What you allowed, and when — with the patterns worth a second look')
  .option('-d, --days <days>', 'window in days (default 30)', (v) => parseInt(v, 10))
  .option('--md [file]', 'write Markdown (default solix-ledger.md)')
  .option('--csv [file]', 'write CSV (default solix-ledger.csv)')
  .action((opts: { days?: number; md?: string | boolean; csv?: string | boolean }) => {
    ledger(opts);
  });

program
  .command('gain')
  .description('Show what Solix prevented — blocked commands, budget pauses')
  .option('-d, --days <days>', 'window in days (default 30)', (v) => parseInt(v, 10))
  .option('--share', 'plain text, formatted to paste into an issue or a post')
  .option('--json', 'machine-readable output')
  .action(async (opts: { days?: number; share?: boolean; json?: boolean }) => {
    await gain(opts);
  });

program
  .command('demo')
  .description(
    'Boot a sandbox server, seed a rich galaxy (8 projects, ~30 sessions, all advisors), ' +
      'and keep firing activity until Ctrl+C. Showcase mode for live demos.',
  )
  .option('-p, --port <port>', 'server port (falls back to +1 on conflict)', (v) => parseInt(v, 10), 4242)
  .option('--keep', 'preserve ~/.solix/demo.db after teardown (default removes it)')
  .option('--no-server', 'skip spawning a sandbox server; seed against the server you already have running')
  .option('--no-ticker', 'seed once and exit (static snapshot for screenshots)')
  .action(
    async (opts: {
      port?: number;
      keep?: boolean;
      server: boolean;
      ticker: boolean;
    }) => {
      await demoCmd({
        port: opts.port,
        keep: opts.keep,
        noServer: !opts.server,
        noTicker: !opts.ticker,
      });
    },
  );

const advisors = program
  .command('advisors')
  .description('Manage built-in advisor agents (PM, Builder, UX, etc.)');

advisors
  .command('list', { isDefault: true })
  .description('List all advisor agents and their state')
  .action(async () => {
    await listAdvisorsCmd();
  });

advisors
  .command('enable <id>')
  .description('Enable an advisor (add to the inner ring)')
  .action(async (id: string) => {
    await enableAdvisorCmd(id);
  });

advisors
  .command('disable <id>')
  .description('Disable an advisor (remove from the inner ring)')
  .action(async (id: string) => {
    await disableAdvisorCmd(id);
  });

advisors
  .command('pin <id>')
  .description('Pin an advisor (spawn an always-on session)')
  .action(async (id: string) => {
    await pinAdvisorCmd(id);
  });

advisors
  .command('unpin <id>')
  .description('Unpin an advisor (kill the always-on session)')
  .action(async (id: string) => {
    await unpinAdvisorCmd(id);
  });

const skills = program
  .command('skills')
  .description('Browse + install skills from Anthropic, Solix, and your own');

skills
  .command('list', { isDefault: true })
  .description('List skills detected in this project')
  .action(async () => {
    await listSkillsCmd();
  });

skills
  .command('install <id>')
  .description('Install a skill into the current project')
  .action(async (id: string) => {
    await installSkillCmd(id);
  });

const galaxy = program
  .command('galaxy')
  .description('Export, import, and publish galaxy presets');

galaxy
  .command('export <name>')
  .description('Snapshot the current crew + skills + projects into a manifest')
  .option('--author <author>', 'author tag for the manifest')
  .option('--description <description>', 'one-line manifest description')
  .action(
    async (
      name: string,
      opts: { author?: string; description?: string },
    ) => {
      await exportGalaxyCmd(name, opts);
    },
  );

galaxy
  .command('import <path>')
  .description('Apply a galaxy manifest (enables advisors, seeds skills + projects)')
  .action(async (path: string) => {
    await importGalaxyCmd(path);
  });

galaxy
  .command('publish <path>')
  .description('Publish a manifest to the configured registry (SOLIX_REGISTRY_URL)')
  .action(async (path: string) => {
    await publishGalaxyCmd(path);
  });

galaxy
  .command('install <id>')
  .description('Install a galaxy preset from the registry by id')
  .action(async (id: string) => {
    await installFromRegistryCmd(id);
  });

const schedules = program
  .command('schedules')
  .description('Manage recurring scheduled tasks');

schedules
  .command('list', { isDefault: true })
  .description('List schedules across all projects')
  .action(async () => {
    await listSchedulesCmd();
  });

schedules
  .command('add <prompt>')
  .description('Schedule a task (interval, webhook, or manual trigger)')
  .option('--cwd <dir>', 'working directory (default: current dir)')
  .option('--every <cadence>', 'cadence, e.g. 30m, 1h, 1d (interval only; default 1h)')
  .option('--trigger <kind>', 'interval | webhook | manual (default: interval)')
  .option('--owner <owner>', 'owner label (advisor role, person, team)')
  .option('--name <name>', 'short label for the schedule')
  .action(
    async (
      prompt: string,
      opts: {
        cwd?: string;
        every?: string;
        name?: string;
        trigger?: string;
        owner?: string;
      },
    ) => {
      await addScheduleCmd(prompt, opts);
    },
  );

schedules
  .command('fire <id>')
  .description('Fire a routine now (manual trigger)')
  .action(async (id: string) => {
    await fireScheduleCmd(id);
  });

schedules
  .command('runs <id>')
  .description('Show a routine’s recent run history')
  .action(async (id: string) => {
    await scheduleRunsCmd(id);
  });

schedules
  .command('remove <id>')
  .description('Remove a schedule')
  .action(async (id: string) => {
    await removeScheduleCmd(id);
  });

schedules
  .command('enable <id>')
  .description('Enable a schedule')
  .action(async (id: string) => {
    await enableScheduleCmd(id);
  });

schedules
  .command('disable <id>')
  .description('Disable a schedule')
  .action(async (id: string) => {
    await disableScheduleCmd(id);
  });

const teams = program
  .command('teams')
  .description('Install ready-made advisor+skill+routine team templates');

teams
  .command('list', { isDefault: true })
  .description('List available team templates')
  .action(async () => {
    await listTeamsCmd();
  });

teams
  .command('install <id>')
  .description('Install a team template into a project')
  .option('--cwd <dir>', 'project directory (default: current dir)')
  .action(async (id: string, opts: { cwd?: string }) => {
    await installTeamCmd(id, opts);
  });

const orgs = program
  .command('orgs')
  .description('Manage orgs/tenants (scopes plans + goals)');

orgs
  .command('list', { isDefault: true })
  .description('List orgs + storage backend status')
  .action(async () => {
    await listOrgsCmd();
  });

orgs
  .command('new <name>')
  .description('Create an org')
  .action(async (name: string) => {
    await newOrgCmd(name);
  });

orgs
  .command('use <id>')
  .description('Switch the active org')
  .action(async (id: string) => {
    await useOrgCmd(id);
  });

const goals = program
  .command('goals')
  .description('Manage cross-session goals (constellations)');

goals
  .command('list', { isDefault: true })
  .description('List all goals')
  .action(async () => {
    await listGoalsCmd();
  });

goals
  .command('add <name>')
  .description('Create a goal')
  .option('--description <desc>', 'optional description')
  .option('--color <hex>', 'goal color (default sky blue)')
  .action(
    async (name: string, opts: { description?: string; color?: string }) => {
      await addGoalCmd(name, opts);
    },
  );

goals
  .command('remove <id>')
  .description('Remove a goal')
  .action(async (id: string) => {
    await removeGoalCmd(id);
  });

const license = program
  .command('license')
  .description('Manage your Solix Pro license (offline, local-only)');

license
  .command('status', { isDefault: true })
  .description('Show your current tier and license')
  .action(() => {
    licenseStatusCmd();
  });

license
  .command('activate <key>')
  .description('Activate a Pro license key')
  .action(async (key: string) => {
    await activateLicenseCmd(key);
  });

const collect = (v: string, acc: string[]): string[] => {
  acc.push(v);
  return acc;
};

program
  .command('connections')
  .description('List connections (scoped credential store for agents)')
  .action(async () => {
    await listConnectionsCmd();
  });

program
  .command('connect <name>')
  .description('Create a connection with secrets + grants')
  .option('--kind <kind>', "'env' (default) or 'mcp'", 'env')
  .option('--secret <KEY=VALUE>', 'a secret (repeatable)', collect, [])
  .option('--grant <scope>', 'advisor role, plan id, or * (repeatable)', collect, [])
  .action(
    async (
      name: string,
      opts: { kind?: string; secret?: string[]; grant?: string[] },
    ) => {
      await connectCmd(name, opts);
    },
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
