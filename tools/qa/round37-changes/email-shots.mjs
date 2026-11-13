// Round 37: pictures of the emails emails.mjs wrote, at a phone's width, for a look before they're switched on.
// Usage: node tools/qa/round37-changes/email-shots.mjs <dir emails.mjs wrote to>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'index.json'))) {
  console.error('Give the folder emails.mjs wrote to.');
  process.exit(2);
}
const list = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const item of list) {
  const page = await ctx.newPage();
  await page.setContent(fs.readFileSync(path.join(dir, `${item.name}.html`), 'utf8'), { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${item.name}.png`), fullPage: true });
  await page.close();
  console.log(`${item.name}.png: ${item.subject}`);
}
await browser.close();
