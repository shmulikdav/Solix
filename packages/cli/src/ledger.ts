import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '@solix/server/db';
import {
  ledgerPatterns,
  ledgerToCsv,
  ledgerToMarkdown,
  listLedger,
} from '@solix/server/ledger';

/**
 * `solix ledger` — what you allowed, and when.
 *
 * `solix gain` counts what Solix stopped. This is the other half, and the
 * one someone asks for after an agent does something expensive: the record
 * of what got through because a person said yes.
 *
 * A ledger entry holds the actual command or path — that is the point of it,
 * and why the export says so in the file and on the way out. `gain` is safe
 * to paste anywhere; this is not.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const WARN = '\x1b[33m';
const OK = '\x1b[32m';
const RED = '\x1b[31m';

const MARK = { approved: `${OK}✓${RESET}`, denied: `${RED}✗${RESET}`, blocked: `${WARN}⛔${RESET}` };

export function ledger(opts: {
  days?: number;
  md?: string | boolean;
  csv?: string | boolean;
} = {}): void {
  const db = getDb();
  const until = Date.now();
  const since = until - (opts.days ?? 30) * 24 * 60 * 60 * 1000;

  const entries = listLedger(db, { since, until });
  const patterns = ledgerPatterns(entries);

  if (opts.md || opts.csv) {
    const isCsv = Boolean(opts.csv);
    const given = isCsv ? opts.csv : opts.md;
    const file = resolve(
      typeof given === 'string' ? given : `solix-ledger.${isCsv ? 'csv' : 'md'}`,
    );
    writeFileSync(
      file,
      isCsv ? ledgerToCsv(entries) : ledgerToMarkdown(entries, patterns, { since, until }),
    );
    console.log(`[solix] wrote ${entries.length} decisions to ${file}`);
    console.log(
      `${WARN}[solix] it contains the real commands and paths your agents asked to\n` +
        `        run. Fine for your team; not for a public issue.${RESET}`,
    );
    return;
  }

  const days = opts.days ?? 30;
  console.log(
    `\n${BOLD}What you allowed${RESET} ${DIM}· last ${days} day${days === 1 ? '' : 's'}${RESET}\n`,
  );

  if (entries.length === 0) {
    console.log(
      `  ${DIM}No decisions yet. The gate runs on tasks Solix launches —\n` +
        `  once one asks for something, it is recorded here.${RESET}\n`,
    );
    return;
  }

  if (patterns.length) {
    console.log(`  ${BOLD}Worth a look${RESET}`);
    for (const p of patterns) {
      console.log(`    ${WARN}•${RESET} ${p.summary}`);
      if (p.detail) console.log(`      ${DIM}${p.detail}${RESET}`);
    }
    console.log('');
  }

  // The tail, not the lot: the whole record is what the export is for.
  const tail = entries.slice(-15);
  if (entries.length > tail.length) {
    console.log(`  ${DIM}… ${entries.length - tail.length} earlier${RESET}`);
  }
  for (const e of tail) {
    // Local time, because the late-night pattern is judged in local hours.
    // Printing UTC here would flag an approval as late and then show it at
    // an unremarkable hour, which reads as a bug in the flag.
    const when = localStamp(e.ts);
    const detail = e.detail.length > 56 ? `${e.detail.slice(0, 56)}…` : e.detail;
    console.log(`  ${DIM}${when}${RESET} ${MARK[e.decision]} ${e.tool.padEnd(8)} ${detail}`);
  }

  console.log(
    `\n${DIM}  ${entries.length} decision${entries.length === 1 ? '' : 's'} in the window.` +
      ` Export with --md or --csv.${RESET}\n`,
  );
}

/** `MM-DD HH:mm` in the machine's own timezone. */
function localStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
