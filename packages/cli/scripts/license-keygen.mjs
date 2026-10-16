#!/usr/bin/env node
/**
 * Dev/beta license signer for Solix Pro. This is NOT the production path —
 * production signing is KMS/HSM-managed. Use this to generate a keypair for
 * local testing and to sign keys manually during the beta. Keep the private key
 * OUT of the repo (it's written 0600 and .gitignore'd by convention).
 *
 *   node packages/cli/scripts/license-keygen.mjs keygen [outPrivateKeyFile]
 *       → generates an Ed25519 keypair; writes the private key; prints the
 *         PUBLIC key PEM to paste into PUBLIC_KEY_PEM in
 *         packages/server/src/licensing.ts.
 *
 *   node packages/cli/scripts/license-keygen.mjs sign <privateKeyFile> \
 *       [--email you@x.com] [--name "Jane Doe"] [--days 365]
 *       → prints a signed license key string.
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as edSign,
} from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function usage() {
  console.log(
    'Usage:\n' +
      '  node license-keygen.mjs keygen [outPrivateKeyFile]\n' +
      '  node license-keygen.mjs sign <privateKeyFile> [--email x@y] [--name "N"] [--days 365]',
  );
}

if (cmd === 'keygen') {
  const out = rest[0] ?? 'solix-signing.key';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  try {
    chmodSync(out, 0o600);
  } catch {
    /* non-POSIX */
  }
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();
  console.log(`Private key → ${out}  (keep secret; move to KMS/HSM for production)\n`);
  console.log('Paste this into PUBLIC_KEY_PEM in packages/server/src/licensing.ts:\n');
  console.log(JSON.stringify(pubPem));
} else if (cmd === 'sign') {
  const keyFile = rest[0];
  if (!keyFile) {
    usage();
    process.exit(1);
  }
  const opts = {};
  for (let i = 1; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, '');
    if (k) opts[k] = rest[i + 1];
  }
  const priv = createPrivateKey(readFileSync(keyFile, 'utf8'));
  const now = Date.now();
  const days = Number(opts.days ?? 365);
  const kind = opts.kind === 'subscription' ? 'subscription' : 'perpetual';
  const payload = {
    licenseId: randomUUID(),
    product: 'solix',
    edition: 'pro',
    kind,
    issuedAt: now,
    updatesUntil: now + days * 24 * 3600 * 1000,
    // Subscriptions expire (enforced); perpetual keys never do.
    ...(kind === 'subscription'
      ? { expiresAt: now + days * 24 * 3600 * 1000 }
      : {}),
    ...(opts.order ? { orderId: opts.order } : {}),
    ...(opts.email || opts.name
      ? { purchaser: { email: opts.email, name: opts.name } }
      : {}),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = edSign(null, payloadBytes, priv);
  console.log(`${b64url(payloadBytes)}.${b64url(sig)}`);
} else {
  usage();
  process.exit(cmd ? 1 : 0);
}
