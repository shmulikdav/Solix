import { getDb } from '@solix/server/db';
import {
  getCursor,
  pendingBatch,
  push,
  readReportingConfig,
  reportingEnabled,
  writeReportingConfig,
  REPORTING_CONFIG_PATH,
  type ReportingConfig,
} from '@solix/server/reporting';

/**
 * `solix reporting` — send decisions to a server your company runs.
 *
 * `solix report` makes an artifact you hand over once. This is the continuous
 * version, and increment 1 of Solix Teams (docs/TEAMS-SPEC.md).
 *
 * Everything here is off until someone turns it on, and the commands are
 * written so that the thing being turned on is never in doubt: `enable`
 * prints what will be sent and what will not, `preview` shows the actual
 * batch before any of it moves, and `status` says where it goes.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const OK = '\x1b[32m';
const RED = '\x1b[31m';
const WARN = '\x1b[33m';

function describeTarget(cfg: ReportingConfig): string {
  return cfg.endpoint.startsWith('file:')
    ? `${cfg.endpoint.slice('file:'.length)} ${DIM}(local file — no network)${RESET}`
    : cfg.endpoint;
}

/** The sentence that has to be true, printed wherever it matters. */
function boundary(): void {
  console.log(`${DIM}  Sent:      decisions, containment blocks, spend.${RESET}`);
  console.log(
    `${DIM}  Not sent:  prompts, model output, diffs, file contents — ever.${RESET}`,
  );
}

export function reportingStatus(): void {
  const cfg = readReportingConfig();
  if (!cfg) {
    console.log(`${BOLD}Reporting is off.${RESET} ${DIM}Nothing is sent anywhere.${RESET}`);
    console.log(
      `${DIM}  Turn it on with: solix reporting enable --endpoint <url|file:/path>${RESET}`,
    );
    return;
  }
  const on = reportingEnabled(cfg);
  console.log(
    `${BOLD}Reporting is ${on ? `${OK}on${RESET}` : `${WARN}configured but disabled${RESET}`}${RESET}`,
  );
  console.log(`  endpoint : ${describeTarget(cfg)}`);
  console.log(`  auth     : ${cfg.token ? 'bearer token set' : 'none'}`);
  console.log(`  commands : ${cfg.redact ? 'fingerprinted (--redact)' : 'sent in full'}`);
  console.log(`  config   : ${REPORTING_CONFIG_PATH} ${DIM}(0600)${RESET}`);

  const db = getDb();
  const pending = pendingBatch(db, cfg).records.length;
  console.log(
    `  pending  : ${pending} decision${pending === 1 ? '' : 's'} ${DIM}since ${getCursor(db) === 0 ? 'the beginning' : new Date(getCursor(db)).toISOString().slice(0, 19).replace('T', ' ')}${RESET}`,
  );
  boundary();
}

export function reportingEnable(opts: {
  endpoint?: string;
  token?: string;
  redact?: boolean;
  intervalMinutes?: number;
}): void {
  const endpoint = opts.endpoint?.trim();
  if (!endpoint) {
    console.error(`${RED}✗${RESET} --endpoint is required (an https:// URL, or file:/abs/path).`);
    process.exitCode = 1;
    return;
  }
  if (!/^https?:\/\//.test(endpoint) && !endpoint.startsWith('file:')) {
    console.error(`${RED}✗${RESET} endpoint must be https:// or file:/abs/path — got "${endpoint}".`);
    process.exitCode = 1;
    return;
  }
  if (endpoint.startsWith('http://')) {
    console.log(
      `${WARN}!${RESET} That is plain http — the records and your token would cross the network in the clear.`,
    );
  }

  const existing = readReportingConfig();
  const cfg: ReportingConfig = {
    endpoint,
    ...(opts.token ? { token: opts.token } : existing?.token ? { token: existing.token } : {}),
    ...(opts.redact ? { redact: true } : {}),
    ...(opts.intervalMinutes ? { intervalMs: opts.intervalMinutes * 60_000 } : {}),
    enabled: true,
  };
  writeReportingConfig(cfg);

  console.log(`${OK}✓${RESET} reporting on → ${describeTarget(cfg)}`);
  boundary();
  console.log(
    `${DIM}  See exactly what would go, before it goes: solix reporting preview${RESET}`,
  );
  console.log(`${DIM}  Stop at any time:                       solix reporting disable${RESET}`);
}

export function reportingDisable(): void {
  const cfg = readReportingConfig();
  if (!cfg) {
    console.log(`${DIM}Reporting was already off.${RESET}`);
    return;
  }
  writeReportingConfig({ ...cfg, enabled: false });
  console.log(`${OK}✓${RESET} reporting disabled. Nothing will be sent.`);
  console.log(
    `${DIM}  The endpoint is kept so you can re-enable it; delete ${REPORTING_CONFIG_PATH} to forget it.${RESET}`,
  );
}

/** Print the next batch exactly as it would be sent, and send nothing. */
export function reportingPreview(): void {
  const cfg = readReportingConfig();
  if (!cfg) {
    console.log(`${DIM}Reporting is not configured — there is nothing to preview.${RESET}`);
    return;
  }
  const batch = pendingBatch(getDb(), cfg);
  process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
  console.error(
    `${DIM}\nThat is the exact body. ${batch.records.length} record${batch.records.length === 1 ? '' : 's'} — nothing was sent.${RESET}`,
  );
}

export async function reportingPush(): Promise<void> {
  const cfg = readReportingConfig();
  if (!cfg) {
    console.error(`${RED}✗${RESET} reporting is not configured — see 'solix reporting enable'.`);
    process.exitCode = 1;
    return;
  }
  const res = await push(getDb(), {});
  if (res.skipped === 'disabled') {
    console.log(`${DIM}Reporting is disabled — nothing sent.${RESET}`);
    return;
  }
  if (!res.ok) {
    console.error(`${RED}✗${RESET} ${res.error ?? 'delivery failed'}`);
    console.error(
      `${DIM}  Nothing was consumed — these records are still queued and go on the next push.${RESET}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${OK}✓${RESET} sent ${res.sent} decision${res.sent === 1 ? '' : 's'} → ${describeTarget(cfg)}`,
  );
  if (res.more) console.log(`${DIM}  More remain — run it again to keep draining.${RESET}`);
}
