#!/usr/bin/env node
/**
 * Headless browser smoke check for the Solix UI.
 *
 * Complements `capture-shots.mjs`: that one must run HEADED on a real GPU to
 * produce pretty launch screenshots (headless renders the 3D view black). This
 * one answers a different, cheaper question — does the app actually RUN in a
 * browser? It catches the class of bug that typecheck and jsdom component tests
 * both miss: a crash on mount, a bad hook dependency, a failed asset, a WebGL
 * context that never initializes, a panel that throws when opened.
 *
 * Software WebGL (SwiftShader) is forced on, so the galaxy really does
 * initialize — it just looks dark. We assert on errors and geometry, not pixels.
 *
 * Usage:
 *   1. solix demo                       (seeds a synthetic galaxy)
 *   2. node scripts/smoke-browser.mjs   (exit 0 = clean)
 *
 * Env: SOLIX_URL (default http://127.0.0.1:4242), SHOT_DIR (default ./.smoke),
 *      CHROMIUM_PATH (explicit browser binary, for images that ship their own
 *      Chromium whose build differs from the pinned Playwright version).
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.SOLIX_URL ?? 'http://127.0.0.1:4242';
const SHOT_DIR = resolve(process.env.SHOT_DIR ?? '.smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Noise we do not want to fail the build over.
const IGNORE = [
  /favicon/i,
  // Chromium echoes every failed request to the console WITHOUT the URL, so it
  // can't be attributed to a specific asset. The `response` listener below
  // already records each 4xx/5xx authoritatively *with* its URL and still fails
  // the run for anything unexpected, so dropping this duplicate loses nothing.
  /^Failed to load resource: the server responded with a status of \d+/,
  /Download the React DevTools/i,
  /WebGL.*deprecated/i,
  /SwiftShader/i,
  /Automatic fallback to software WebGL/i,
  /GroupMarkerNotSet/i,
];
const ignorable = (t) => IGNORE.some((re) => re.test(t));

// Missing planet textures are an EXPECTED, documented state: they're binary
// assets fetched by `prepare-assets` and deliberately not committed, and the
// scene is supposed to fall back to its procedural look. Report them as
// degradation, not failure — but keep every other error fatal, so this stays a
// real signal rather than a rubber stamp.
const DEGRADED = [/\/textures\//];
const degrading = (t) => DEGRADED.some((re) => re.test(t));

const problems = [];
const degraded = [];
const steps = [];
const note = (msg) => (degrading(msg) ? degraded : problems).push(msg);

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ no Solix server at ${BASE} — run \`solix demo\` first`);
    process.exit(1);
  }
  await mkdir(SHOT_DIR, { recursive: true });

  // Prefer an explicitly provided Chromium (CI images often ship one whose
  // build number differs from the pinned Playwright, which otherwise demands a
  // fresh download).
  const executablePath =
    process.env.CHROMIUM_PATH ||
    ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) =>
      existsSync(p),
    ) ||
    undefined;

  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--enable-unsafe-swiftshader', // allow software WebGL in headless
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', (m) => {
    if (m.type() === 'error' && !ignorable(m.text())) {
      note(`console.error: ${m.text()}`);
    }
  });
  // A pageerror is ALWAYS fatal — an uncaught error blanks the app, which is
  // exactly the regression this script exists to catch.
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (!ignorable(r.url())) {
      note(`requestfailed: ${r.url()} (${r.failure()?.errorText})`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !ignorable(r.url())) {
      note(`http ${r.status()}: ${r.url()}`);
    }
  });

  const step = async (name, fn) => {
    try {
      await fn();
      steps.push(`✓ ${name}`);
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
      steps.push(`✗ ${name}`);
    }
  };

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3000); // let the scene + websocket settle

  await step('app mounts (#root has content)', async () => {
    const kids = await page.evaluate(
      () => document.getElementById('root')?.childElementCount ?? 0,
    );
    if (kids === 0) throw new Error('#root is empty — the app did not mount');
  });

  await step('WebGL is available', async () => {
    const ok = await page.evaluate(() => {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    });
    if (!ok) throw new Error('no WebGL context available');
  });

  await step('galaxy canvas is rendered with real geometry', async () => {
    const box = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (!box) throw new Error('no <canvas> in the document');
    if (box.w < 100 || box.h < 100) {
      throw new Error(`canvas too small: ${box.w}x${box.h}`);
    }
  });

  await step('websocket connected (live snapshot arrived)', async () => {
    // The HUD only reports planets once the WS snapshot lands.
    await page.waitForFunction(
      () => /\d/.test(document.body.innerText) && document.body.innerText.length > 50,
      { timeout: 15000 },
    );
  });

  await page.screenshot({ path: `${SHOT_DIR}/01-galaxy.png` });

  // ── The surfaces added this cycle ──
  // O1, asserted in the browser because that is where it was invisible: the
  // modal used to hide itself once any session existed, and this page has ~30
  // from `solix demo` — the very command the README suggests first. A fresh
  // browser context has no dismissed flag, so onboarding must be on screen.
  await step('onboarding appears even with sessions present (O1)', async () => {
    await page.waitForSelector('text=Pick one to start', { timeout: 10000 });
    await page.screenshot({ path: `${SHOT_DIR}/01-onboarding.png` });
    // Dismiss it so the rest of the run can reach the top bar. That it blocks
    // the UI until dismissed is the point — it is a first-run modal again.
    await page.keyboard.press('Escape');
    await page.waitForSelector('text=Pick one to start', {
      state: 'detached',
      timeout: 5000,
    });
  });

  // O3: help and onboarding were the same component, and closing help wrote
  // the first-run flag. They are separate now, and the legend is complete.
  await step('help is its own panel with the full legend', async () => {
    await page.keyboard.press('?');
    await page.waitForSelector('text=What you\'re looking at', { timeout: 10000 });
    for (const term of ['Sun', 'Planet', 'Asteroid belt']) {
      await page.waitForSelector(`text="${term}"`, { timeout: 5000 });
    }
    await page.screenshot({ path: `${SHOT_DIR}/02-help.png` });
    await page.keyboard.press('Escape');
  });

  // The CONNECTED chip was a bordered pill that looked exactly like the
  // controls beside it and did nothing when clicked. It is a dot now, and the
  // detail it could not fit — that the socket retries on its own, and the
  // galaxy is stale until it does — moved into a hover tooltip.
  await step('connection status is a dot with a tooltip, not a fake button', async () => {
    const body = await page.textContent('[data-topbar]');
    if (/CONNECTED|OFFLINE/.test(body ?? '')) {
      throw new Error('the CONNECTED chip is still in the top bar');
    }
    const dot = page.locator('[data-topbar] [role="status"]');
    if ((await dot.count()) !== 1) {
      throw new Error(`expected one status dot, found ${await dot.count()}`);
    }
    await dot.hover();
    await page.waitForSelector('[role="tooltip"]', { timeout: 5000 });
    const tip = await page.textContent('[role="tooltip"]');
    if (!/live updates/.test(tip ?? '')) {
      throw new Error(`tooltip did not describe the state: ${tip}`);
    }
  });

  await step('Maestro plan panel opens (P)', async () => {
    await page.keyboard.press('p');
    await page.waitForSelector('text=Plan a build', { timeout: 10000 });
    await page.screenshot({ path: `${SHOT_DIR}/02-maestro.png` });
    await page.keyboard.press('Escape');
  });

  // Fleet is one door for six configuration surfaces that each used to own a
  // top-level button (or, for Routines, had no UI at all). Every tab has to
  // actually render — a tab strip that opens an empty panel is worse than the
  // four buttons it replaced.
  await step('every Fleet tab renders', async () => {
    const tabs = [
      ['Crew', 'Active crew'],
      ['Skills', 'Author a skill'],
      ['Teams', 'Ship-fast build team'],
      ['Routines', 'A routine starts an agent session on its own'],
      ['Connections', 'Notifications'],
      ['Orgs', 'An org scopes which plans you see'],
    ];
    await page.click('[data-nav-rail] >> text="Fleet"');
    await page.waitForSelector('[data-dock-panel]', { timeout: 10000 });
    for (const [tab, expected] of tabs) {
      await page.click(`[data-dock-panel] >> text="${tab}"`);
      await page.waitForSelector(`text=${expected}`, { timeout: 10000 });
      await page.screenshot({ path: `${SHOT_DIR}/03-fleet-${tab.toLowerCase()}.png` });
    }
    await page.keyboard.press('Escape');
  });

  // S4: a routine is recurring spend. It was creatable from the UI (installing
  // a team makes them) but only cancellable from a terminal, because the web
  // layer had one read-only selector and zero write actions for schedules.
  await step('a routine can be created and then stopped in-app (S4)', async () => {
    await page.click('[data-nav-rail] >> text="Fleet"');
    await page.waitForSelector('[data-dock-panel]', { timeout: 10000 });
    await page.click('[data-dock-panel] >> text="Routines"');
    await page.waitForSelector('text=New routine', { timeout: 10000 });

    // The demo seeds no routines, so create one. This also checks that the
    // consequence of creating recurring spend is stated before the button.
    await page.fill('[data-dock-panel] input[placeholder="Name (optional)"]', 'Smoke routine');
    await page.fill('[data-dock-panel] input[placeholder="/path/to/project"]', '/tmp/smoke-proj');
    await page.fill(
      '[data-dock-panel] textarea[placeholder="What should the agent do on each run?"]',
      'say hello',
    );
    await page.waitForSelector('text=/costs money on every run/', { timeout: 5000 });
    await page.click('[data-dock-panel] >> text="Create routine"');
    await page.waitForSelector('text=Smoke routine', { timeout: 10000 });

    // Now the part that did not exist: turning it off without a terminal.
    const toggle = page.locator('[data-dock-panel] input[type=checkbox]').first();
    if ((await toggle.count()) === 0) {
      throw new Error('no routine on/off control — recurring spend is unstoppable in-app');
    }
    await page.waitForSelector('text=/is running on a schedule/', { timeout: 5000 });
    await toggle.click();
    await page.waitForSelector('text=/is running on a schedule/', {
      state: 'detached',
      timeout: 10000,
    });
    await page.screenshot({ path: `${SHOT_DIR}/04-routines.png` });

    // Leave the demo db as we found it.
    await page.click('[data-dock-panel] >> text="Delete"');
    await page.click('[data-dock-panel] >> text="Delete for good"');
    await page.keyboard.press('Escape');
  });

  await step('Share panel still opens on its own tabs', async () => {
    await page.click('[data-nav-rail] >> text="Share"');
    await page.waitForSelector('text=Versions', { timeout: 10000 });
    await page.screenshot({ path: `${SHOT_DIR}/05-share.png` });
    await page.keyboard.press('Escape');
  });

  // N6: Mission Control had no button at all. It opened only by clicking the 3D
  // sun or pressing W — and the sun does not exist in List or Missions view, so
  // there the whole panel was keyboard-only and effectively undiscoverable.
  await step('Mission Control opens from the top bar (N6)', async () => {
    await page.click('[data-nav-rail] >> text="Mission Control"');
    // Wait on the dock itself, not on the text: the button carries the same
    // label, so a text selector resolves instantly against the button and the
    // assertion then races the lazy panel chunk.
    await page.waitForSelector('[data-dock-panel]', { timeout: 10000 });
    await page.waitForSelector('text=Context pressure', { timeout: 10000 });
    const docks = await page.locator('[data-dock-panel]').count();
    if (docks !== 1) {
      throw new Error(`expected exactly 1 dock panel open, found ${docks}`);
    }
    await page.screenshot({ path: `${SHOT_DIR}/07-mission-control.png` });
    await page.keyboard.press('Escape');
  });

  // Regression guard for B6: two dock panels used to be able to paint over each
  // other, because one group was local component state and the other was the
  // store, and the two never coordinated. The panel on top wins visually but
  // the Decision Queue's offset is computed from the *other* one, so a pending
  // permission prompt can end up underneath a panel. Permission prompts are
  // what unblock stuck agents, so this is a safety surface going missing.
  // Only one dock panel may exist in the DOM at a time.
  await step('opening a second dock panel closes the first', async () => {
    await page.keyboard.press('p');
    await page.waitForSelector('text=Plan a build', { timeout: 10000 });
    await page.click('[data-nav-rail] >> text="Fleet"');
    await page.waitForSelector('text=Active crew', { timeout: 10000 });
    const docks = await page.locator('[data-dock-panel]').count();
    if (docks !== 1) {
      throw new Error(`expected exactly 1 dock panel open, found ${docks}`);
    }
    if (await page.locator('text=Plan a build').count()) {
      throw new Error('plan panel is still mounted behind the connections panel');
    }
    await page.screenshot({ path: `${SHOT_DIR}/06-single-dock.png` });
    await page.keyboard.press('Escape');
  });

  // Regression guard: the top bar grows every time a surface is added, and an
  // overflowing bar silently pushes its right-most control (the help button)
  // off the viewport — invisible to typecheck and to jsdom tests, and only
  // noticed when a human squints at a screenshot. Check at a laptop width.
  // Every previous attempt at this failed: the bar carried identity, status,
  // a view switch and seven destinations, and wrapped at every width up to
  // 1920px. Moving destinations to the rail is what finally makes a single
  // row possible, so assert it at the narrowest width we support rather than
  // at the width that happens to pass.
  await step('the top bar is a single row at 1280px', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const bar = document.querySelector('[data-topbar]');
      if (!bar) return null;
      const kids = [...bar.querySelectorAll('button, span, kbd')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {
        rows: new Set(
          kids.map((b) => Math.round(b.getBoundingClientRect().top / 8)),
        ).size,
        height: Math.round(bar.getBoundingClientRect().height),
      };
    });
    if (!info) throw new Error('top bar not found');
    if (info.rows > 1) {
      throw new Error(`top bar wrapped to ${info.rows} rows at 1280px`);
    }
    if (info.height > 56) {
      throw new Error(`top bar is ${info.height}px tall, expected one row`);
    }
  });

  // The rail is the navigation now, so every destination must be in it.
  await step('every rail destination is present', async () => {
    for (const label of [
      'Galaxy', 'List', 'Missions', 'New task', 'Maestro',
      'Mission Control', 'Fleet', 'Share', 'Timeline', 'Help',
    ]) {
      const n = await page.locator(`[data-nav-rail] >> text="${label}"`).count();
      if (n === 0) throw new Error(`rail is missing "${label}"`);
    }
  });

  await step('no top-bar control is clipped at 1280px', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(600);
    const clipped = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      return [...document.querySelectorAll('button, select')]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && r.top < 120)
        .filter(({ r }) => r.right > w + 1 || r.left < -1)
        .map(({ el, r }) => `${(el.textContent || el.tagName).trim().slice(0, 24)} @${Math.round(r.right)}>${w}`);
    });
    if (clipped.length) {
      throw new Error(`clipped out of viewport: ${clipped.join('; ')}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(400);
  });

  // The org <select> moved into Fleet > Orgs. What stays in the bar is a
  // label, because the active org changes which plans Maestro lists — but with
  // only the default org there is nothing to disambiguate, so the chip is
  // hidden and the switcher has to be reachable in Fleet instead.
  await step('orgs are managed in Fleet, with the default org active', async () => {
    const strayLegacySelect = await page
      .locator('[data-topbar] select[title*="Active org"]')
      .count();
    if (strayLegacySelect > 0) {
      throw new Error('the org <select> is still in the top bar');
    }
    await page.click('[data-nav-rail] >> text="Fleet"');
    await page.waitForSelector('[data-dock-panel]', { timeout: 10000 });
    await page.click('[data-dock-panel] >> text="Orgs"');
    await page.waitForSelector('text=An org scopes which plans you see', {
      timeout: 10000,
    });
    const active = await page.locator('[data-dock-panel] >> text="active"').count();
    if (active !== 1) {
      throw new Error(`expected exactly one active org, found ${active}`);
    }
    await page.keyboard.press('Escape');
  });

  await page.screenshot({ path: `${SHOT_DIR}/06-final.png`, fullPage: false });
  await browser.close();

  console.log(steps.join('\n'));
  if (degraded.length) {
    const files = [...new Set(degraded.map((d) => d.match(/\/textures\/[\w.]+/)?.[0]))]
      .filter(Boolean)
      .join(', ');
    console.log(
      `\nℹ degraded (not a failure): ${degraded.length} texture message(s) — ${files}\n` +
        `  The scene is rendering its procedural look. Run:\n` +
        `    pnpm --filter @solix/web prepare-assets && pnpm -r build`,
    );
  }
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\n✓ browser smoke clean — shots in ${SHOT_DIR}`);
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
