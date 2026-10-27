import type { Mission, Session } from '@solix/shared';

export interface Suggestion {
  text: string;
  severity: 'info' | 'warn' | 'danger';
}

/**
 * Heuristic decision-helper. Looks at a pending permission's tool + args
 * and returns a one-liner the user can read in <2s.
 *
 * V1 is rule-based — easy to read, easy to extend, and doesn't burn
 * tokens. V2 swap path: hand the same shape to an Anthropic SDK call
 * with a small system prompt that returns a Suggestion. The DecisionCard
 * already renders `null` as "no suggestion," so adding async won't break
 * anything.
 */
/**
 * Does this shell command destroy something?
 *
 * This used to be `/\brm\s+-rf\b/ || /\bsudo\b/`, which is the *obvious*
 * spelling and therefore the one least likely to need a warning. A denied
 * agent reworded `rm -rf ./canary` as
 *
 *     rm /abs/canary/keep.txt && rmdir /abs/canary
 *
 * — identical effect, no warning shown. The rephrased form is exactly the one
 * a tired person waves through, so the narrow pattern was warning about the
 * wrong half of the problem.
 *
 * Deliberately generous. A false positive costs one extra second of reading;
 * a false negative is what this exists to prevent. It is a *hint* on a card
 * that already shows the full command — the hard guarantee is the containment
 * denylist, not this.
 */
export function isDestructive(command: string): boolean {
  const c = command.toLowerCase();
  return (
    // Any rm, not only -rf. `rm file`, `rm -r dir`, `rm -f x` all delete.
    /\brm\s+-{0,2}[a-z]*\s*[^|;&]*\S/.test(c) ||
    /\brmdir\b/.test(c) ||
    /\bsudo\b/.test(c) ||
    // Removes untracked files, including ones never backed up anywhere.
    /\bgit\s+clean\b/.test(c) ||
    /\bgit\s+reset\s+--hard\b/.test(c) ||
    /\bgit\s+checkout\s+--\s/.test(c) ||
    /\bgit\s+branch\s+-[dD]\b/.test(c) ||
    // Overwrites or shreds in place.
    /\bshred\b/.test(c) ||
    /\btruncate\b/.test(c) ||
    /\bdd\b[^|;&]*\bof=/.test(c) ||
    /\bmkfs\b/.test(c) ||
    // find … -delete / -exec rm
    /\bfind\b[^|;&]*\s-delete\b/.test(c) ||
    /\bfind\b[^|;&]*-exec\s+rm\b/.test(c) ||
    // Package and container teardown.
    /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/.test(c) ||
    // Truncating redirect onto a path that looks like a real file.
    /(^|[^>\d])>\s*\/\S+/.test(c)
  );
}

export function suggestForPermission(
  session: Session,
  _mission: Mission | undefined,
  tool: string,
  args: Record<string, unknown>,
): Suggestion | null {
  const command = stringArg(args, 'command');
  const filePath = stringArg(args, 'file_path');
  const url = stringArg(args, 'url');

  // Tool-specific rules — most specific first.
  if (tool === 'Bash' && command) {
    if (isDestructive(command)) {
      return {
        severity: 'danger',
        text: 'Destructive command. Deny unless you have already confirmed the diff.',
      };
    }
    if (/--no-verify\b/.test(command)) {
      return {
        severity: 'warn',
        text: 'Skipping pre-commit hooks. Investigate the failure first.',
      };
    }
    if (/git\s+push.*--force\b/.test(command)) {
      return {
        severity: 'danger',
        text: 'Force-push. Confirm no one else has pushed since.',
      };
    }
    if (
      /git\s+push/.test(command) &&
      /\b(main|master|prod|production)\b/.test(command)
    ) {
      return {
        severity: 'warn',
        text: 'Pushing to main/prod. Confirm the diff first.',
      };
    }
    if (/git\s+reset\s+--hard\b/.test(command)) {
      return {
        severity: 'warn',
        text: 'Hard reset will discard uncommitted changes. Stash first if unsure.',
      };
    }
  }

  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && filePath) {
    if (/\.env(\b|\.|\/)|credentials\.json|\.pem$|\.key$/i.test(filePath)) {
      return {
        severity: 'danger',
        text: 'Editing a secrets file. Make sure the agent really needs to.',
      };
    }
    if (/(^|\/)\.git\//.test(filePath)) {
      return {
        severity: 'warn',
        text: 'Editing inside .git/. Almost certainly a mistake.',
      };
    }
  }

  if (tool === 'WebFetch' && url) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(url)) {
      return null;
    }
    if (/^http:\/\//.test(url)) {
      return {
        severity: 'info',
        text: 'Plain HTTP fetch. OK for known internal hosts.',
      };
    }
  }

  // Cross-tool rules — context exhaustion drowns nuance.
  if (session.contextUsagePct >= 90) {
    return {
      severity: 'warn',
      text: `Context at ${session.contextUsagePct.toFixed(0)}%. Run /compact before continuing.`,
    };
  }

  return null;
}

/**
 * Standing suggestions for a session that aren't tied to a specific
 * pending permission. Shown in the SidePanel header when relevant.
 */
export function suggestForSession(
  session: Session,
  mission: Mission | undefined,
): Suggestion | null {
  if (session.status === 'error') {
    return {
      severity: 'danger',
      text: 'Session is in error state. Check the chat tab and consider restarting.',
    };
  }
  if (session.contextUsagePct >= 90) {
    return {
      severity: 'warn',
      text: `Context at ${session.contextUsagePct.toFixed(0)}%. Compact the conversation before the next prompt.`,
    };
  }
  if (session.contextUsagePct >= 80) {
    return {
      severity: 'info',
      text: `Context at ${session.contextUsagePct.toFixed(0)}%. Watch out — output quality drops past 90.`,
    };
  }
  if (
    mission &&
    mission.status === 'active' &&
    mission.metrics.toolCallCount === 0 &&
    Date.now() - mission.startedAt > 5 * 60 * 1000
  ) {
    return {
      severity: 'info',
      text: 'Active mission with no tool calls in 5+ minutes. Agent may be stuck.',
    };
  }
  return null;
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' ? v : null;
}
