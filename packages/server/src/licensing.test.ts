import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  evaluateRunGate,
  resolveEntitlement,
  verifyLicenseKey,
  type License,
} from './licensing.js';

function makeKeypair(): { pubPem: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signKey(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = edSign(null, bytes, privateKey);
  return `${bytes.toString('base64url')}.${Buffer.from(sig).toString('base64url')}`;
}

const validPayload = {
  licenseId: 'lic_123',
  product: 'solix',
  edition: 'pro',
  issuedAt: 1_700_000_000_000,
  updatesUntil: 1_800_000_000_000,
  purchaser: { email: 'buyer@example.com' },
};

describe('verifyLicenseKey', () => {
  it('accepts a correctly-signed Pro license', () => {
    const { pubPem, privateKey } = makeKeypair();
    const key = signKey(privateKey, validPayload);
    const lic = verifyLicenseKey(key, pubPem);
    expect(lic).not.toBeNull();
    expect(lic!.licenseId).toBe('lic_123');
    expect(lic!.purchaser?.email).toBe('buyer@example.com');
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const { pubPem, privateKey } = makeKeypair();
    const key = signKey(privateKey, validPayload);
    // Flip the payload to a different licenseId but keep the old signature.
    const forged = { ...validPayload, licenseId: 'lic_HACK' };
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url');
    const sigPart = key.slice(key.indexOf('.') + 1);
    expect(verifyLicenseKey(`${forgedPayload}.${sigPart}`, pubPem)).toBeNull();
  });

  it('rejects a key signed by a different key', () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const key = signKey(a.privateKey, validPayload);
    expect(verifyLicenseKey(key, b.pubPem)).toBeNull(); // verify with the wrong pubkey
  });

  it('rejects a non-Solix / non-Pro payload even if validly signed', () => {
    const { pubPem, privateKey } = makeKeypair();
    expect(
      verifyLicenseKey(
        signKey(privateKey, { ...validPayload, product: 'other' }),
        pubPem,
      ),
    ).toBeNull();
    expect(
      verifyLicenseKey(
        signKey(privateKey, { ...validPayload, edition: 'free' }),
        pubPem,
      ),
    ).toBeNull();
  });

  it('rejects malformed keys and returns null when no public key is configured', () => {
    const { pubPem, privateKey } = makeKeypair();
    expect(verifyLicenseKey('not-a-key', pubPem)).toBeNull();
    expect(verifyLicenseKey('only-one-part', pubPem)).toBeNull();
    expect(verifyLicenseKey('.', pubPem)).toBeNull();
    // No embedded/injected key → nothing can verify (beta default).
    expect(verifyLicenseKey(signKey(privateKey, validPayload), null)).toBeNull();
  });
});

describe('resolveEntitlement', () => {
  const license: License = validPayload;
  it('is Pro (beta) when enforcement is off', () => {
    const e = resolveEntitlement({ enforced: false, license: null });
    expect(e.tier).toBe('pro');
    expect(e.reason).toBe('beta');
  });
  it('is Pro when enforced with a valid license', () => {
    expect(resolveEntitlement({ enforced: true, license }).tier).toBe('pro');
  });
  it('is Community when enforced without a license', () => {
    const e = resolveEntitlement({ enforced: true, license: null });
    expect(e.tier).toBe('community');
  });

  it('drops an expired subscription to Community', () => {
    const expired: License = { ...license, kind: 'subscription', expiresAt: 1000 };
    const e = resolveEntitlement({ enforced: true, license: expired, now: 5000 });
    expect(e.tier).toBe('community');
    expect(e.reason).toMatch(/expired/);
  });

  it('honors a not-yet-expired subscription', () => {
    const active: License = { ...license, kind: 'subscription', expiresAt: 9000 };
    expect(
      resolveEntitlement({ enforced: true, license: active, now: 5000 }).tier,
    ).toBe('pro');
  });
});

describe('evaluateRunGate', () => {
  it('lets Pro run anything', () => {
    expect(evaluateRunGate({ tier: 'pro', taskCount: 20, autoMode: true }).allowed).toBe(true);
  });
  it('lets Community run a small plan', () => {
    expect(
      evaluateRunGate({ tier: 'community', taskCount: 3, autoMode: false }).allowed,
    ).toBe(true);
  });
  it('blocks Community on a large plan', () => {
    const g = evaluateRunGate({ tier: 'community', taskCount: 4, autoMode: false });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/Pro/);
  });
  it('blocks Community from full-auto', () => {
    const g = evaluateRunGate({ tier: 'community', taskCount: 1, autoMode: true });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/Full-auto/);
  });
});
