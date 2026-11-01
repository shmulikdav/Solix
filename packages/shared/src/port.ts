/**
 * Where Solix is expected to be listening.
 *
 * Every package reads `SOLIX_PORT` and each one parsed it for itself, in one
 * of three ways:
 *
 *   const PORT = process.env.SOLIX_PORT ?? '4242';        // 9 CLI commands
 *   Number(process.env.SOLIX_PORT ?? 4242)                // start, gain, doctor
 *   parseInt(process.env.SOLIX_PORT ?? '4242', 10)        // the server entry
 *
 * All three look right and none of them are. `??` fires only on null and
 * undefined, so `SOLIX_PORT=` — set but empty, which is what a conditional CI
 * step, a half-filled `.env` or `SOLIX_PORT= solix doctor` produces — is a
 * perfectly good string that falls straight through the default:
 *
 *   • the string form builds `http://127.0.0.1:/api/...`, which cannot resolve
 *   • `Number('')` is **0**, so `solix start` binds port 0 — a random free
 *     port — while the hooks, which read the same variable, call port 0 and
 *     find nothing. The gate then fail-closes on every tool call, which is
 *     the exact failure CLAIM-GATE-ANY-PORT exists to prevent, reached by a
 *     different road.
 *   • `parseInt('')` is NaN, and `SOLIX_PORT=auto` is NaN everywhere.
 *
 * One parse, in one place, that treats anything which is not a usable port as
 * no answer at all.
 */
export const DEFAULT_PORT = 4242;

export function resolvePort(
  raw: string | undefined = process.env.SOLIX_PORT,
): number {
  // Decimal digits only. `Number()` alone reads `0x10` as 16 and `1e3` as
  // 1000 — nobody writing a port means either of those, and silently honouring
  // them means the port the hooks compute can differ from the port a human
  // reads in the variable.
  const text = (raw ?? '').trim();
  if (!/^\d{1,5}$/.test(text)) return DEFAULT_PORT;
  const n = Number(text);
  return n > 0 && n < 65_536 ? n : DEFAULT_PORT;
}
