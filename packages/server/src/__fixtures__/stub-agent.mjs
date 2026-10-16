#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI, used by launcher.integration.test.ts.
 *
 * The launcher's spawn path (argv building, env scrub + gate injection, granted
 * secret merge, stdout capture, JSON result parsing, cost extraction, exit-code
 * handling, SIGTERM on abort) was previously only ever exercised against an
 * in-process fake that returned whatever the parser wanted. This script is a
 * REAL process, so that whole path runs for real — the one piece of the
 * live-agent story that can be verified without the actual binary.
 *
 * It also doubles as executable documentation of the CLI contract Solix
 * depends on: the flags it probes for, and the result envelope it parses.
 *
 * Behaviour is driven by STUB_MODE: ok (default) | fail | error_envelope |
 * error_arm | hang | not_json. STUB_PROBE_FILE, when set, receives the argv/env/cwd the
 * stub actually saw so the test can assert on them.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

// --help drives the launcher's capability probe; advertise the flags it looks for.
if (args.includes('--help')) {
  process.stdout.write(
    [
      'Usage: claude [options] [prompt]',
      '  --print                 Print response and exit',
      '  --output-format <fmt>   Output format (text, json, stream-json)',
      '  --session-id <uuid>     Use a specific session ID',
      '  --model <model>         Model for the session',
    ].join('\n') + '\n',
  );
  process.exit(0);
}

// Record what we were actually invoked with, for the test's assertions.
if (process.env.STUB_PROBE_FILE) {
  writeFileSync(
    process.env.STUB_PROBE_FILE,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      env: {
        SOLIX_GATE_ENABLED: process.env.SOLIX_GATE_ENABLED ?? null,
        SOLIX_GATE_POLICY: process.env.SOLIX_GATE_POLICY ?? null,
        GRANTED_TOKEN: process.env.GRANTED_TOKEN ?? null,
        AMBIENT_NOT_GRANTED: process.env.AMBIENT_NOT_GRANTED ?? null,
      },
    }),
    'utf8',
  );
}

const mode = process.env.STUB_MODE ?? 'ok';

if (mode === 'hang') {
  // Never exit — the test aborts the run and asserts we were signalled.
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.stderr.write('stub: exploded on purpose\n');
  process.exit(2);
} else if (mode === 'error_arm') {
  // The documented failure arm: `errors[]`, no `result`.
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 10,
      stop_reason: null,
      total_cost_usd: 0.31,
      errors: ['hit the turn limit before finishing'],
    }),
  );
  process.exit(0);
} else if (mode === 'not_json') {
  process.stdout.write('plain text, not an envelope\n');
  process.exit(0);
} else {
  const sidIdx = args.indexOf('--session-id');
  const isError = mode === 'error_envelope';
  // The result envelope shape the launcher parses.
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      result: isError ? 'the model reported a failure' : 'STUB_WORKER_OUTPUT',
      session_id: sidIdx >= 0 ? args[sidIdx + 1] : 'unset',
      total_cost_usd: 0.0425,
      duration_ms: 12,
      num_turns: 1,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  );
  process.exit(0);
}
