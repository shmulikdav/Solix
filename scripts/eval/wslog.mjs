// Log every websocket event Solix broadcasts, so holds (permission_request)
// can be answered and counted. Writes to $SOLIX_EVAL_DIR/ws.log.
//
// env: SOLIX_PORT (default 4242), SOLIX_EVAL_DIR (default ./.eval)
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const port = process.env.SOLIX_PORT || '4242';
const dir = process.env.SOLIX_EVAL_DIR || join(process.cwd(), '.eval');
mkdirSync(dir, { recursive: true });
const out = join(dir, 'ws.log');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const log = (s) => appendFileSync(out, `${new Date().toISOString()} ${s}\n`);
ws.onopen = () => log('open');
ws.onclose = (e) => { log(`close ${e.code}`); setTimeout(() => process.exit(0), 100); };
ws.onerror = (e) => log(`error ${e.message || e}`);
ws.onmessage = (m) => {
  try {
    const d = JSON.parse(m.data);
    const t = d.type;
    if (t === 'permission_request') log(`PERMISSION_REQUEST ${JSON.stringify(d)}`);
    else if (t === 'permission_resolved') log(`PERMISSION_RESOLVED requestId=${d.requestId} outcome=${d.outcome}`);
    else if (/session|cost|context|plan|task|mission|audit/.test(t || '')) log(`${t} ${JSON.stringify(d).slice(0, 200)}`);
    else log(`${t}`);
  } catch { log(`raw ${String(m.data).slice(0, 120)}`); }
};
