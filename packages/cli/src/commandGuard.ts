/**
 * Refuse a first word that is not a command, before anything starts.
 *
 * `start` is the default command, so commander hands it any word it does not
 * recognise. With options that produced a misleading error — `solix gate
 * --rules x` on a release without `gate` said "unknown option '--rules'",
 * reported from a real machine on 2026-11-03. Without options it was worse:
 * commander 12 ignores excess arguments, so a typo like `solix gaet` started
 * the server, wired `~/.claude`, and opened the browser. A mistyped command
 * must do nothing. (`CLAIM-TYPO-NEVER-STARTS`)
 */
export interface UnknownCommand {
  name: string;
  /** The closest real command, when one is close enough to be a typo. */
  suggestion?: string;
}

/** `argv` is `process.argv`: [node, script, first, …]. */
export function unknownCommand(argv: readonly string[], known: readonly string[]): UnknownCommand | null {
  const first = argv[2];
  if (first === undefined || first === '' || first.startsWith('-')) return null;
  if (first === 'help' || known.includes(first)) return null;
  let best: { name: string; d: number } | undefined;
  for (const name of known) {
    const d = editDistance(first, name);
    if (!best || d < best.d) best = { name, d };
  }
  // Close enough to be a slip of the keyboard: at most 2 edits, and not more
  // than a third of the word (so `x` is not "suggested" as `ls`).
  const near = best && best.d <= 2 && best.d <= Math.ceil(first.length / 3) ? best.name : undefined;
  return near ? { name: first, suggestion: near } : { name: first };
}

/** Damerau-free Levenshtein; command names are short. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

export function unknownCommandMessage(u: UnknownCommand, version: string): string {
  return (
    `error: unknown command '${u.name}'` +
    (u.suggestion ? ` — did you mean '${u.suggestion}'?` : '') +
    `\n       this is solix ${version}; \`solix --help\` lists its commands.` +
    '\n       A command from newer docs may need a newer release.'
  );
}
