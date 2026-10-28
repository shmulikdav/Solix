import { getDb } from '@solix/server/db';
import {
  describeGovernanceLevel,
  getGovernanceLevel,
  isGovernanceLevel,
  setGovernanceLevel,
  type GovernanceLevel,
} from '@solix/server/governance';

/**
 * `solix level` — read or set the one governance dial.
 *
 * Writes to the database directly rather than through the server, so it
 * works whether or not Solix is running. A running server reads the level
 * per tool call, so a change takes effect on the next one.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const WARN = '\x1b[33m';

const ORDER: GovernanceLevel[] = ['observe', 'standard', 'strict'];

export function level(requested?: string): void {
  const db = getDb();

  if (requested === undefined) {
    const current = getGovernanceLevel(db);
    console.log(`\n${BOLD}Governance${RESET}  ${describeGovernanceLevel(current)}\n`);
    for (const l of ORDER) {
      const mark = l === current ? '●' : '○';
      console.log(`  ${mark} ${l.padEnd(9)} ${DIM}${describeGovernanceLevel(l).split('— ')[1] ?? ''}${RESET}`);
    }
    console.log(`\n${DIM}  Change it with \`solix level <name>\`.`);
    console.log(
      `  The command denylist is not on this dial — a destructive command is\n` +
        `  refused at every level, including observe.${RESET}\n`,
    );
    return;
  }

  if (!isGovernanceLevel(requested)) {
    console.error(
      `[solix] unknown level "${requested}" — use observe, standard or strict`,
    );
    process.exitCode = 1;
    return;
  }

  const next = setGovernanceLevel(db, requested);
  console.log(`[solix] governance: ${describeGovernanceLevel(next)}`);
  if (next === 'observe') {
    // Lowering supervision should never be a quiet success message — and
    // the reassurance has to be accurate, or it is worse than silence.
    // "The denylist still blocks destructive commands" said nothing about
    // *whose* commands, one line below a description that had just been
    // corrected to say "what Solix launched". A session you started
    // yourself is not governed and cannot be: Solix governs an agent by
    // setting its environment before the process starts.
    console.log(
      `${WARN}[solix] nothing will be held for your approval. The denylist still\n` +
        `        refuses destructive commands from agents Solix launched;\n` +
        `        everything else runs, and a \`claude\` session you started\n` +
        `        yourself is not governed at all.${RESET}`,
    );
  }
}
