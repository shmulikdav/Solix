import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '@solix/server/db';
import {
  buildReport,
  reportToCsv,
  reportToMarkdown,
  verifyReport,
  type FleetReport,
} from '@solix/server/report';

/**
 * `solix report` — the artifact you hand to someone else.
 *
 * `gain` and `ledger` are for you and are plain editable text. This is the
 * same facts with a hash chain over them and a signature on the digest, so
 * the person reading it can tell whether it changed on the way.
 *
 * Also increment 0 of Solix Teams (docs/TEAMS-SPEC.md): the records here are
 * exactly what a Teams server would aggregate, so the format gets used by a
 * real artifact before anything depends on it over a wire.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const OK = '\x1b[32m';
const RED = '\x1b[31m';
const WARN = '\x1b[33m';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportOptions {
  days?: number;
  format?: string;
  out?: string;
  redact?: boolean;
  unsigned?: boolean;
  verify?: string;
}

/** Re-check a report file written earlier. */
function runVerify(path: string): void {
  const full = resolve(path);
  let report: FleetReport;
  try {
    report = JSON.parse(readFileSync(full, 'utf8')) as FleetReport;
  } catch (err) {
    console.error(
      `${RED}✗${RESET} could not read ${full} as a report: ${(err as Error).message}`,
    );
    console.error(
      `${DIM}  Verification needs the JSON form — the one written by --format json.${RESET}`,
    );
    process.exitCode = 1;
    return;
  }

  const res = verifyReport(report);
  if (!res.ok) {
    console.error(`${RED}✗ ${res.reason}${RESET}`);
    process.exitCode = 1;
    return;
  }
  const n = report.records.length;
  console.log(
    `${OK}✓${RESET} ${BOLD}intact${RESET} — ${n} decision${n === 1 ? '' : 's'}, digest matches${res.signed ? ' and the signature checks out' : ''}.`,
  );
  if (!res.signed) {
    console.log(`${WARN}  This report is unsigned.${RESET}`);
  }
  console.log(
    `${DIM}  Proves the file is unchanged since the machine produced it.${RESET}`,
  );
  console.log(
    `${DIM}  Does NOT prove that machine reported honestly — it holds the key.${RESET}`,
  );
}

export function report(opts: ReportOptions = {}): void {
  if (opts.verify) {
    runVerify(opts.verify);
    return;
  }

  const until = Date.now();
  const days = opts.days && opts.days > 0 ? opts.days : 30;
  const built = buildReport(getDb(), {
    since: until - days * DAY_MS,
    until,
    redact: opts.redact,
    unsigned: opts.unsigned,
  });

  const format = (opts.format ?? 'md').toLowerCase();
  let body: string;
  let defaultName: string;
  if (format === 'json') {
    body = `${JSON.stringify(built, null, 2)}\n`;
    defaultName = 'solix-report.json';
  } else if (format === 'csv') {
    body = reportToCsv(built);
    defaultName = 'solix-report.csv';
  } else if (format === 'md' || format === 'markdown') {
    body = reportToMarkdown(built);
    defaultName = 'solix-report.md';
  } else {
    console.error(`${RED}✗${RESET} unknown format "${opts.format ?? ''}" — use md, csv or json.`);
    process.exitCode = 1;
    return;
  }

  if (!opts.out) {
    process.stdout.write(body);
    if (format !== 'json') {
      console.error(
        `${DIM}\nOnly the JSON form can be verified later — write one with --format json.${RESET}`,
      );
    }
    return;
  }

  const path = resolve(opts.out === 'true' ? defaultName : opts.out);
  writeFileSync(path, body, 'utf8');
  const n = built.records.length;
  console.log(
    `${OK}✓${RESET} wrote ${path} ${DIM}(${n} decision${n === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'})${RESET}`,
  );

  if (built.redacted) {
    console.log(`${DIM}  Commands are fingerprinted, not included.${RESET}`);
  } else {
    // The same warning `solix ledger` gives, for the same reason: this file
    // holds the actual commands your agents ran.
    console.log(
      `${WARN}  This file contains the real commands — treat it like a log, not a summary.${RESET}`,
    );
  }
  if (!built.signature) {
    console.log(`${WARN}  Unsigned — the device key could not be read or written.${RESET}`);
  }
  if (format === 'json') {
    console.log(`${DIM}  Check it any time with: solix report --verify ${path}${RESET}`);
  } else {
    console.log(
      `${DIM}  Keep the JSON alongside it if you need to prove this later:${RESET}`,
    );
    console.log(`${DIM}    solix report --format json --out solix-report.json${RESET}`);
  }
}
