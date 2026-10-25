import { getDb } from '@solix/server/db';
import { importHistory } from '@solix/server/import';

/**
 * `solix import` — backfill the galaxy from Claude Code's own transcripts.
 *
 * Without this, a fresh install opens on nothing: Solix only ever saw
 * sessions started after its hooks were wired, so the first screen of a tool
 * about watching your fleet showed no fleet, however much work you had
 * already done.
 *
 * Reading the transcripts is local and read-only. Nothing is sent anywhere
 * and the files are not modified.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export async function importCmd(): Promise<void> {
  console.log(`\n${BOLD}Importing your Claude Code history${RESET}\n`);

  const db = getDb();
  let lastProject = '';
  const result = await importHistory(db, {
    onSession: (s) => {
      if (s.cwd !== lastProject) {
        lastProject = s.cwd;
        console.log(`  ${DIM}${s.cwd}${RESET}`);
      }
      const when = s.startedAt
        ? new Date(s.startedAt).toISOString().slice(0, 10)
        : '          ';
      console.log(
        `    ${when}  ${s.sessionId.slice(0, 8)}  $${s.costUsd.toFixed(2)}`,
      );
    },
  });

  if (result.scanned === 0) {
    console.log(
      `  ${DIM}No Claude Code transcripts found in ~/.claude/projects.\n` +
        `  Nothing to import — start a \`claude\` session and Solix will\n` +
        `  pick it up live.${RESET}\n`,
    );
    return;
  }

  console.log(
    `\n  ${BOLD}${result.imported}${RESET} imported` +
      ` · ${result.skipped} already known` +
      (result.failed ? ` · ${result.failed} unreadable` : '') +
      `\n  across ${result.projects} project${result.projects === 1 ? '' : 's'}` +
      `, $${result.costUsd.toFixed(2)} at list price\n`,
  );

  // Long agentic sessions are dominated by cache reads, so this figure can be
  // startling. It is what the tokens would cost at the published per-token
  // rate — which is not what a Pro or Max subscriber pays. Say so, rather
  // than letting someone think Solix is reporting a bill they owe.
  if (result.costUsd > 0) {
    console.log(
      `${DIM}  That is the published per-token rate for the tokens in your\n` +
        `  transcripts. On a Claude subscription it is a measure of usage,\n` +
        `  not an amount you were charged.${RESET}\n`,
    );
  }

  if (result.imported > 0) {
    console.log(`${DIM}  Open Solix to see them. Re-running this is safe —\n`);
    console.log(`  a session already known is left exactly as it is.${RESET}\n`);
  }
}
