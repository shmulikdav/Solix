import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLIX_HOME, ensureSolixHome } from './paths.js';

/**
 * Offline Pro licensing (v2 Phase 4b). Verification ONLY — the private signing
 * key never lives here; it sits in a KMS/HSM and issues keys in your private
 * pipeline (out of this MIT repo). Solix embeds the PUBLIC key, verifies a key
 * offline, and never makes a network call for licensing (the product's
 * 100%-local promise). Consequence: a delivered perpetual key can't be remotely
 * revoked — acceptable for a $49–79 dev tool.
 *
 * Ships DORMANT: enforcement is off by default (free public beta → everyone is
 * Pro). Flip it on with SOLIX_PRO_ENFORCE=1 (or bake the default to true in the
 * monetization release) once you're selling.
 *
 * Positioned as compliance, not hard security: an MIT binary is inherently
 * bypassable, which is fine (Sentinel).
 */

/**
 * The Ed25519 public key (SPKI PEM) whose private half is in your KMS/HSM.
 * Replace this null with your real public key before enabling enforcement.
 * (Generate a dev keypair with `node packages/cli/scripts/license-keygen.mjs`.)
 * If your KMS lacks Ed25519 (e.g. AWS KMS), issue ECDSA-P256 keys instead and
 * pass that alg/key here — `verifyLicenseKey`'s crypto.verify call handles both.
 */
const PUBLIC_KEY_PEM: string | null = null;

const LICENSE_PATH = join(SOLIX_HOME, 'license');

export interface License {
  licenseId: string;
  product: string;
  edition: string;
  issuedAt: number;
  /** Epoch ms until which this license covers NEW releases (perpetual + 1yr
   *  updates). Stored now; version-window enforcement is deferred. */
  updatesUntil?: number;
  /** 'perpetual' (one-time, never expires) or 'subscription' (must carry
   *  `expiresAt`). Defaults to perpetual when absent. */
  kind?: 'perpetual' | 'subscription';
  /** Epoch ms this entitlement lapses — ENFORCED for subscriptions. */
  expiresAt?: number;
  /** Payment-provider order/transaction id (e.g. Paddle) — for support/audit. */
  orderId?: string;
  purchaser?: { email?: string; name?: string };
  meta?: Record<string, unknown>;
}

export type Tier = 'pro' | 'community';

export interface Entitlement {
  tier: Tier;
  reason: string;
  license?: License;
}

/** Free-tier per-plan task cap. Runs up to this size are free; larger ones are Pro. */
export const FREE_TASK_LIMIT = 3;

/** Whether the paid gate is being enforced. Off by default = free public beta. */
export function enforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLIX_PRO_ENFORCE === '1';
}

/** Whether a signing public key is baked in (i.e. licensing can verify keys at
 *  all). False during the beta until the real key is embedded. */
export function licensingConfigured(): boolean {
  return PUBLIC_KEY_PEM != null;
}

/**
 * Verify a license key offline and return its payload, or null if the signature
 * is invalid / the format is wrong / it isn't a Solix Pro license. NEVER trusts
 * unverified fields — the payload is only returned after the signature checks
 * out. `publicKeyPem` is injectable so tests can sign with an ephemeral keypair.
 *
 * Key format: base64url(JSON payload) + "." + base64url(Ed25519 signature).
 */
export function verifyLicenseKey(
  key: string,
  publicKeyPem: string | null = PUBLIC_KEY_PEM,
): License | null {
  if (!publicKeyPem) return null; // no key configured → nothing can verify
  try {
    const trimmed = key.trim();
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot === trimmed.length - 1) return null;
    const payloadBytes = Buffer.from(trimmed.slice(0, dot), 'base64url');
    const sig = Buffer.from(trimmed.slice(dot + 1), 'base64url');
    if (payloadBytes.length === 0 || sig.length === 0) return null;
    const pub = createPublicKey(publicKeyPem);
    // Ed25519 (and Ed448) require the algorithm argument to be null.
    if (!cryptoVerify(null, payloadBytes, pub, sig)) return null;
    const parsed = JSON.parse(payloadBytes.toString('utf8')) as License;
    if (parsed.product !== 'solix' || parsed.edition !== 'pro') return null;
    if (typeof parsed.licenseId !== 'string' || !parsed.licenseId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readLicenseFile(): string | null {
  try {
    return readFileSync(LICENSE_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeLicenseFile(key: string): void {
  ensureSolixHome();
  writeFileSync(LICENSE_PATH, `${key.trim()}\n`, { mode: 0o600 });
  try {
    chmodSync(LICENSE_PATH, 0o600); // enforce even if the file pre-existed
  } catch {
    /* non-POSIX (Windows) — best effort */
  }
}

let cache: { key: string | null; license: License | null } | null = null;

/** Load + verify the on-disk license (cached by key string). */
export function loadLicense(): License | null {
  const key = readLicenseFile();
  if (!key) {
    cache = { key: null, license: null };
    return null;
  }
  if (cache && cache.key === key) return cache.license;
  const license = verifyLicenseKey(key);
  cache = { key, license };
  return license;
}

export function clearLicenseCache(): void {
  cache = null;
}

/** Pure entitlement decision — testable without env or disk. Enforces
 *  `expiresAt` (subscriptions), so a lapsed key drops to Community. */
export function resolveEntitlement(opts: {
  enforced: boolean;
  license: License | null;
  now?: number;
}): Entitlement {
  if (!opts.enforced) return { tier: 'pro', reason: 'beta' };
  const lic = opts.license;
  if (!lic) return { tier: 'community', reason: 'no valid license' };
  if (lic.expiresAt != null && lic.expiresAt < (opts.now ?? Date.now())) {
    return { tier: 'community', reason: 'license expired' };
  }
  return { tier: 'pro', reason: 'licensed', license: lic };
}

/** The live entitlement: enforcement flag × on-disk license. */
export function getEntitlement(env: NodeJS.ProcessEnv = process.env): Entitlement {
  return resolveEntitlement({
    enforced: enforcementEnabled(env),
    license: loadLicense(),
  });
}

/**
 * Pure gate for a plan RUN (approve / full-auto). Planning + preview are always
 * free; this only bites at the run trigger. Community may run small plans
 * (≤ FREE_TASK_LIMIT tasks); full-auto and larger runs are Pro.
 */
export function evaluateRunGate(input: {
  tier: Tier;
  taskCount: number;
  autoMode: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.tier === 'pro') return { allowed: true };
  if (input.autoMode) {
    return {
      allowed: false,
      reason: 'Full-auto is a Pro feature — activate a license to run hands-off.',
    };
  }
  if (input.taskCount > FREE_TASK_LIMIT) {
    return {
      allowed: false,
      reason: `Free runs are limited to ${FREE_TASK_LIMIT} tasks; this plan has ${input.taskCount}. Upgrade to Pro to run larger builds.`,
    };
  }
  return { allowed: true };
}

/** Verify + persist a license key (used by the CLI and the HTTP endpoint). */
export function activateLicense(key: string): {
  ok: boolean;
  license?: License;
  error?: string;
} {
  if (!licensingConfigured()) {
    return {
      ok: false,
      error:
        'Licensing is not enabled in this build yet — Solix is in free public beta and everything is already unlocked.',
    };
  }
  const license = verifyLicenseKey(key);
  if (!license) {
    return { ok: false, error: 'Invalid or unrecognized license key.' };
  }
  writeLicenseFile(key);
  clearLicenseCache();
  return { ok: true, license };
}
