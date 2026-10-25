/**
 * `solix gain` — what Solix prevented.
 *
 * Solix is the only tool in this space that intercepts the tool call, so it
 * is the only one that can report what did *not* happen: commands the
 * denylist refused, runs that stopped at their cap. That is the number the
 * product has never been able to show, and governance reads as pure overhead
 * until it can.
 *
 * It reads the local server's /api/impact, which aggregates rows already in
 * the audit table. Nothing is collected and nothing is transmitted; `--share`
 * only formats the same figures for a human to paste somewhere by choice.
 */

interface BlockReason {
  reason: string;
  count: number;
}

interface Impact {
  sinceMs: number;
  untilMs: number;
  approved: number;
  denied: number;
  blockedByContainment: number;
  blockReasons: BlockReason[];
  budgetPauses: number;
  spendAtPauseUsd: number;
  advisorInvocations: number;
  sessionsTerminated: number;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const WARN = '\x1b[33m';
const OK = '\x1b[32m';

function days(impact: Impact): number {
  return Math.max(
    1,
    Math.round((impact.untilMs - impact.sinceMs) / (24 * 60 * 60 * 1000)),
  );
}

/** Plain text, no colour — for `--share`, which is going into an issue. */
function shareBlock(impact: Impact): string {
  const d = days(impact);
  const lines = [
    `Solix impact — last ${d} day${d === 1 ? '' : 's'}`,
    `  commands blocked by containment : ${impact.blockedByContainment}`,
    `  denied by me                    : ${impact.denied}`,
    `  approved by me                  : ${impact.approved}`,
    `  plans paused at their cap       : ${impact.budgetPauses}`,
  ];
  if (impact.budgetPauses > 0) {
    lines.push(
      `  spend held at those pauses      : $${impact.spendAtPauseUsd.toFixed(2)}`,
    );
  }
  if (impact.blockReasons.length) {
    lines.push('  what the denylist caught:');
    for (const r of impact.blockReasons) {
      lines.push(`    ${r.count}x ${r.reason}`);
    }
  }
  return lines.join('\n');
}

export async function gain(opts: {
  days?: number;
  share?: boolean;
  json?: boolean;
} = {}): Promise<void> {
  const port = Number(process.env.SOLIX_PORT ?? 4242);
  const qs = opts.days ? `?days=${opts.days}` : '';
  let impact: Impact;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/impact${qs}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    impact = (await res.json()) as Impact;
  } catch {
    console.error(
      `[solix] no server on http://127.0.0.1:${port} — start Solix and try again.`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(impact, null, 2));
    return;
  }

  if (opts.share) {
    console.log(shareBlock(impact));
    return;
  }

  const d = days(impact);
  const nothingHappened =
    impact.blockedByContainment === 0 &&
    impact.denied === 0 &&
    impact.budgetPauses === 0 &&
    impact.approved === 0;

  console.log(`\n${BOLD}What Solix prevented${RESET} ${DIM}· last ${d} day${d === 1 ? '' : 's'}${RESET}\n`);

  if (nothingHappened) {
    // Say so plainly rather than printing a wall of zeroes. An empty report
    // usually means the gate never engaged, which is worth knowing.
    console.log(
      `  ${DIM}Nothing yet. The gate runs on tasks Solix launches — start one\n` +
        `  from the UI, or run \`solix demo\` to see the shape of this report.${RESET}\n`,
    );
    return;
  }

  const row = (label: string, value: string, colour = ''): void => {
    console.log(`  ${label.padEnd(32)} ${colour}${value}${RESET}`);
  };

  row(
    'Commands blocked automatically',
    String(impact.blockedByContainment),
    impact.blockedByContainment > 0 ? OK : DIM,
  );
  row('Denied by you', String(impact.denied), impact.denied > 0 ? OK : DIM);
  row('Approved by you', String(impact.approved), DIM);
  row(
    'Plans paused at their cap',
    String(impact.budgetPauses),
    impact.budgetPauses > 0 ? WARN : DIM,
  );
  if (impact.budgetPauses > 0) {
    row('Spend held at those pauses', `$${impact.spendAtPauseUsd.toFixed(2)}`, WARN);
  }

  if (impact.blockReasons.length) {
    console.log(`\n  ${DIM}What the denylist caught${RESET}`);
    for (const r of impact.blockReasons) {
      console.log(`    ${String(r.count).padStart(3)}x  ${r.reason}`);
    }
  }

  console.log(
    `\n${DIM}  Local only — these numbers are read from your own machine and sent\n` +
      `  nowhere. \`solix gain --share\` formats them to paste if you want to.${RESET}\n`,
  );
}
