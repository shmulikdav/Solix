import type { SessionRole } from '@solix/shared';
import { resolveWithinRoot } from './util.js';

/**
 * Worker containment (Sentinel). Autonomous Maestro worker/verifier sessions run
 * `claude` without a human at the keyboard, so their tool calls can't rely on the
 * interactive decision queue (which, in full-auto, degrades to auto-allow). This
 * is the HARD boundary that runs first: a denylisted shell command or a write
 * outside the project directory is blocked outright, regardless of gate policy or
 * full-auto — the containment the plan requires to land WITH dispatch.
 *
 * Pure + I/O-free so the security logic is exhaustively unit-testable. It is a
 * workflow guardrail, not a substitute for an OS sandbox (SOLIX_SANDBOX_CMD) —
 * the two layer.
 */

export interface ContainmentDecision {
  blocked: boolean;
  reason?: string;
}

/** Roles subject to containment — the autonomous, human-less ones. */
function isContainedRole(role?: SessionRole): boolean {
  return role === 'worker' || role === 'verifier';
}

/** Does a shell command match a destructive denylist pattern? Returns the
 *  reason to block, or null to allow. Curated for high signal / low false
 *  positives — a worker building a project never needs any of these. */
export function deniedCommandReason(commandRaw: string): string | null {
  const cmd = commandRaw.trim();
  if (!cmd) return null;
  const lower = cmd.toLowerCase();

  // Recursive+forced delete of a root / home / wildcard target.
  if (isDangerousRm(cmd)) return 'recursive force-delete of a root or home path';

  // Fork bomb.
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd)) return 'fork bomb';

  // Filesystem formatting / raw-device writes.
  if (/\bmkfs(\.\w+)?\b/.test(lower)) return 'filesystem format (mkfs)';
  if (/\bdd\b[^\n]*\bof=\/dev\//.test(lower)) return 'raw write to a block device (dd of=/dev/…)';
  if (/>\s*\/dev\/(sd|nvme|disk|hd)/.test(lower)) return 'redirect to a raw block device';

  // Piping remote content straight into a shell (curl … | sh).
  if (/\b(curl|wget|fetch)\b[^\n]*\|[^\n]*\b(sh|bash|zsh|python\d?|node)\b/.test(lower))
    return 'piping downloaded content into a shell';

  // Privilege escalation — an autonomous build never needs root.
  if (/(^|[;&|]\s*)sudo\b/.test(lower)) return 'privilege escalation (sudo)';
  if (/(^|[;&|]\s*)su\s+(-|root)\b/.test(lower)) return 'privilege escalation (su)';

  // Machine control.
  if (/(^|[;&|]\s*)(shutdown|reboot|halt|poweroff)\b/.test(lower)) return 'machine power control';

  // World-writable chmod on a root path; recursive chown of root.
  if (/\bchmod\b[^\n]*\s-[a-z]*r[a-z]*\s+0*777\s+\/(\s|$)/.test(lower))
    return 'recursive world-writable chmod on /';
  if (/\bchown\b[^\n]*\s-[a-z]*r[a-z]*\s[^\n]*\s\/(\s|$)/.test(lower))
    return 'recursive chown of /';

  // Tampering with SSH credentials.
  if (/(~|\/root|\$home)[^\n]*\.ssh\/(authorized_keys|id_[a-z0-9]+)\b/i.test(cmd) &&
      /(>|>>|tee|cp|mv|cat\s+>)/.test(cmd))
    return 'writing to SSH credential files';

  return null;
}

/**
 * Recursive+forced `rm` aimed at a catastrophic target: `/`, `~`, `$HOME`, a
 * top-level wildcard, or a system directory (/etc, /usr, …). Relative targets
 * (`./dist`, `node_modules`, `/tmp/foo`) are intentionally NOT flagged — the OS
 * sandbox is the real filesystem boundary; this is the obviously-catastrophic
 * backstop that must not false-positive on ordinary build cleanup.
 */
function isDangerousRm(cmd: string): boolean {
  if (!/\brm\b/.test(cmd)) return false;
  const hasRecursive = /\s-\w*r/i.test(cmd) || /--recursive\b/.test(cmd);
  const hasForce = /\s-\w*f/i.test(cmd) || /--force\b/.test(cmd);
  if (!(hasRecursive && hasForce)) return false;
  return (
    // bare /, /*, ~, ~/, $HOME, ${HOME}, or a trailing /
    /\s(\/|\/\*|~|~\/|\$home|\$\{home\})(\s|$|\*)/i.test(cmd) ||
    /\s\/\s*$/.test(cmd) ||
    // a system root directory
    /\s\/(etc|usr|var|bin|sbin|lib|lib64|boot|sys|proc|dev|root|home)(\/\S*)?(\s|$)/i.test(
      cmd,
    )
  );
}

/** Is a file-write target outside the plan's working directory? */
export function isWriteOutsideRoot(filePath: string, root: string): boolean {
  if (!filePath.trim()) return false;
  return resolveWithinRoot(root, filePath) == null;
}

const FILE_TOOLS = new Set(['write', 'edit', 'notebookedit', 'multiedit']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'run', 'exec_command']);

/**
 * The single containment decision for a gated tool call. Non-contained roles
 * (external/internal user sessions, planner) are never blocked here — they keep
 * the normal human gate.
 */
export function evaluateContainment(input: {
  role?: SessionRole;
  tool: string;
  command?: string;
  filePath?: string;
  cwd: string;
}): ContainmentDecision {
  if (!isContainedRole(input.role)) return { blocked: false };
  const tool = input.tool.toLowerCase();

  if (input.command && SHELL_TOOLS.has(tool)) {
    const reason = deniedCommandReason(input.command);
    if (reason) return { blocked: true, reason };
  }

  if (input.filePath && FILE_TOOLS.has(tool)) {
    if (isWriteOutsideRoot(input.filePath, input.cwd)) {
      return {
        blocked: true,
        reason: `write outside the project directory: ${input.filePath}`,
      };
    }
  }

  return { blocked: false };
}

/**
 * Whether autonomous execution (full-auto, or any dispatched worker) is safely
 * contained. Containment is now SAFE-BY-DEFAULT: Solix injects the fail-closed
 * gate into every worker/verifier it launches (launcher.buildSpawnEnv), so the
 * command denylist governs them out of the box. It's refused only when the user
 * explicitly opted OUT (SOLIX_CONTAINMENT=0 / SOLIX_GATE_ENABLED=0). An OS
 * sandbox (SOLIX_SANDBOX_CMD) is the recommended hard-isolation layer on top.
 */
export function fullAutoContainmentStatus(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reasons: string[];
} {
  if (env.SOLIX_CONTAINMENT === '0' || env.SOLIX_GATE_ENABLED === '0') {
    return {
      ok: false,
      reasons: [
        'worker containment is disabled (SOLIX_CONTAINMENT=0) — re-enable it to run autonomously',
      ],
    };
  }
  return { ok: true, reasons: [] };
}
