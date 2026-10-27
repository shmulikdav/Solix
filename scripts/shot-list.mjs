/** Screenshot the List view. Label-based tests pass on unreadable views. */
const pw = await import('/home/user/SolariX/node_modules/playwright/index.js');
const { chromium } = pw.default ?? pw;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
p.on('pageerror', (e) => console.log('PAGE ERROR:', String(e).slice(0, 200)));
await p.goto(process.env.URL ?? 'http://127.0.0.1:4455', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
// First run shows the welcome modal; it covers the whole view.
const dismiss = p.getByRole('button', { name: /close|dismiss|×/i }).first();
if (await dismiss.count()) await dismiss.click().catch(() => {});
await p.keyboard.press('Escape');
await p.waitForTimeout(600);
await p.keyboard.press('v');              // Galaxy -> List
await p.waitForTimeout(1200);
await p.screenshot({ path: '.smoke/list-attention.png' });
const txt = await p.evaluate(() => document.body.innerText);
// The header is CSS-uppercased, so match case-insensitively.
console.log('Attention header:', /attention/i.test(txt));
console.log('no stray "Health":', !/\bhealth\b/i.test(txt));
// `Done` is absent on a fresh load by design: the server's listActiveSessions
// excludes terminated sessions, so they never arrive. The label covers an
// agent that finishes WHILE you are watching, which the unit tests assert.
for (const want of ['Context at 94', 'error state']) {
  console.log(`shows "${want}":`, txt.includes(want));
}
const dashes = (txt.match(/—/g) ?? []).length;
console.log('dash count (healthy rows):', dashes);
await b.close();
