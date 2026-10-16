import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOLIX_HOME, ensureSolixHome } from './paths.js';

/**
 * Local secret encryption for the connections store (AES-256-GCM). SQLite has no
 * encryption, so secret values are encrypted at the app layer with a key kept in
 * `~/.solix/secret.key` (0600, generated once). Authenticated (GCM tag) so a
 * tampered ciphertext fails to decrypt. The key never leaves the machine; losing
 * it just means re-entering secrets (acceptable for a local tool). Values are
 * never logged, never returned over the API, and never audited.
 */

const KEY_PATH = join(SOLIX_HOME, 'secret.key');
let cachedKey: Buffer | null = null;

/** Load (or generate once) the 32-byte local encryption key. */
export function loadSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  ensureSolixHome();
  if (existsSync(KEY_PATH)) {
    cachedKey = readFileSync(KEY_PATH);
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_PATH, cachedKey, { mode: 0o600 });
    try {
      chmodSync(KEY_PATH, 0o600); // enforce even if umask widened it
    } catch {
      /* non-POSIX */
    }
  }
  if (cachedKey.length !== 32) {
    throw new Error('solix secret key is not 32 bytes');
  }
  return cachedKey;
}

/** Encrypt → `base64(iv):base64(tag):base64(ciphertext)`. `key` is injectable
 *  for tests so they never touch ~/.solix. */
export function encryptSecret(plaintext: string, key: Buffer = loadSecretKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a value produced by `encryptSecret`. Throws on tamper / wrong key. */
export function decryptSecret(packed: string, key: Buffer = loadSecretKey()): string {
  const parts = packed.split(':');
  if (parts.length !== 3) throw new Error('malformed secret');
  const [ivB, tagB, ctB] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
