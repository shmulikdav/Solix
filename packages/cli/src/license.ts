import {
  activateLicense,
  getEntitlement,
  readLicenseFile,
} from '@solix/server/licensing';

const PORT = process.env.SOLIX_PORT ?? '4242';
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * `solix license activate <key>` — verify + persist the key locally (works
 * offline, no running server needed), then best-effort ping a running server so
 * it reloads without a restart.
 */
export async function activateLicenseCmd(key: string): Promise<void> {
  const res = activateLicense(key);
  if (!res.ok) {
    console.error(`[solix] ${res.error}`);
    process.exitCode = 1;
    return;
  }
  const l = res.license!;
  console.log(`[solix] license activated — ${l.product} ${l.edition} (${l.licenseId}).`);

  // If a server is up, have it reload the license live.
  try {
    await fetch(`${BASE}/api/license/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    console.log('[solix] running server reloaded.');
  } catch {
    console.log('[solix] saved. It takes effect the next time you run `solix start`.');
  }
}

/** `solix license status` — print the current tier + license summary. */
export function licenseStatusCmd(): void {
  const ent = getEntitlement();
  console.log(`[solix] tier: ${ent.tier} (${ent.reason})`);
  if (ent.license) {
    const l = ent.license;
    console.log(`  license : ${l.licenseId}`);
    if (l.updatesUntil) {
      console.log(
        `  updates : until ${new Date(l.updatesUntil).toISOString().slice(0, 10)}`,
      );
    }
    if (l.purchaser?.email) console.log(`  buyer   : ${l.purchaser.email}`);
  } else if (readLicenseFile()) {
    console.log(
      '  a license file exists but did not verify (wrong key, tampered, or licensing not configured in this build).',
    );
  }
}
