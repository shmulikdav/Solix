/**
 * How often an interval routine fires.
 *
 * This lived in the server and was mirrored by a regex in the Routines tab,
 * with a comment saying so — two copies of the one rule that decides whether a
 * routine costs what it says it costs. The duplication was load-bearing: the
 * cadence `1w` was plausible given the placeholder, parsed by neither, and
 * parked an hour out by the server's fallback, so a routine whose card said
 * "every 1w" fired hourly — 168× the agreed spend, concealed by the two pieces
 * of UI whose job was to disclose it.
 *
 * One parser, read by the validator, the scheduler and the form.
 */
export function cadenceToMs(cadence: string): number | null {
  const m = cadence.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

/** The sentence to show when a cadence cannot be read. One wording, everywhere. */
export function cadenceHelp(cadence: string): string {
  return (
    `cadence "${cadence.trim()}" is not one Solix understands. Use a number ` +
    `followed by m, h or d — for example 30m, 2h or 1d. Weeks are not ` +
    `supported yet; use 7d.`
  );
}
