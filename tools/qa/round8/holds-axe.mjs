// Round 8, holds helper: axe-core (WCAG 2.x A and AA) and a keyboard pass on what round 8 changed on the staff page, in
// demo mode at 390px and 1280px: the Hold tables form with Weekly chosen (Repeats, Last date), a weekly hold's card, its
// Stop repeating question, and the floor's "Just this date, or stop repeating?". The keyboard pass goes through Repeats
// with the arrow keys, makes a weekly hold with Enter, skips a date, opens and closes Stop repeating, and answers the
// floor's question, checking where focus lands each time and that the focused chip shows its ring.
// Prints each view's violations ("0 violations") and PASS/FAIL lines; exits 1 on a violation or a FAIL.
// Usage: DG_THEME=/path/to/theme PORT=4913 AXE=/path/to/axe.min.js node tools/qa/round8/holds-axe.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const AXE = process.env.AXE || '/tmp/claude-0/-home-claude/5328840b-74f5-55ee-90fc-cbd04e2b255c/scratchpad/audit/performance/node_modules/axe-core/axe.min.js';
if (!process.env.DG_THEME || !fs.existsSync(AXE)) {
  console.error('Set DG_THEME to the theme checkout, and AXE to axe-core/axe.min.js.');
  process.exit(2);
}
const axe = fs.readFileSync(AXE, 'utf8');
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4913);
m.mockState.customer = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const server = await m.serve(PORT);
const browser = await chromium.launch();
let violations = 0;
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

async function scan(page, label, selector = 'lair-staff') {
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, selector);
  violations += result.length;
  console.log(`${label}: ${result.length} violations${result.length ? `\n  ${result.join('\n  ')}` : ''}`);
}
/** Tab until focus leaves the field (a native time or date field takes Tab through its own parts first) */
const tabOut = async (page) => {
  const from = await page.evaluateHandle(() => document.activeElement);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate((el) => document.activeElement === el, from))) return;
  }
};
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return '';
  return `${el.tagName.toLowerCase()}${el.dataset.act ? `[${el.dataset.act}]` : ''}${el.id ? `#${el.id}` : ''}${el.matches('[data-hold-repeat]') ? `=${el.value}` : ''}`;
});

for (const [size, vp] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: size === 'phone', hasTouch: size === 'phone' });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/pages/lair-staff#holds`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="holds"] [data-hold-form]', { timeout: 15000 });
  const day = await page.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 3));

  /* the keyboard: Repeats with the arrow keys, then Enter */
  await page.fill('#holdx-tables', 'T14-T17');
  await page.fill('#holdx-label', 'Keyboard league (r8)');
  await page.fill('#holdx-day', day);
  await page.focus('#holdx-to');
  await tabOut(page);
  check(`${size}: Tab from Until lands on Repeats (the chosen one)`, (await focused(page)) === 'input=', await focused(page));
  const ring = await page.evaluate(() => (document.activeElement.matches('[data-hold-repeat]') ? getComputedStyle(document.activeElement.nextElementSibling).outlineStyle : 'not on a chip'));
  check(`${size}: …and its chip shows the focus ring`, ring === 'solid', ring);
  await page.keyboard.press('ArrowRight');
  check(`${size}: the right arrow picks Weekly`, (await focused(page)) === 'input=weekly' && (await page.$eval('[data-hold-repeat][value="weekly"]', (el) => el.checked)), await focused(page));
  check(`${size}: …and Last date shows`, await page.locator('[data-hold-last]').isVisible());
  await page.keyboard.press('Tab');
  check(`${size}: Tab goes on to Last date`, (await focused(page)) === 'input#holdx-last', await focused(page));
  await scan(page, `${size} the Hold tables form, Weekly chosen`, '[data-panel="holds"] [data-hold-form]');
  await tabOut(page);
  check(`${size}: then to Hold tables`, (await page.evaluate(() => document.activeElement.type)) === 'submit', await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-series]', { timeout: 10000 }).catch(() => {});
  check(`${size}: Enter makes the weekly hold, and focus stays on the form's button`, (await page.locator('[data-series]').count()) === 1 && (await page.evaluate(() => document.activeElement.type)) === 'submit', await focused(page));
  const card = '[data-series]';
  await page.locator(card).scrollIntoViewIfNeeded();
  await scan(page, `${size} a weekly hold's card`, '[data-holds-list]');

  /* the card: Skip with Enter, Stop repeating asks, Keep it */
  await page.focus('#holds-list-title');
  let found = false;
  for (let i = 0; i < 40 && !found; i += 1) {
    await page.keyboard.press('Tab');
    found = await page.evaluate(() => document.activeElement.matches('[data-series] [data-act="skipdate"]'));
  }
  check(`${size}: Tab reaches the card's first Skip this date`, found, await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(`${size}: Enter skips it; focus on the next date's Skip`, (await focused(page)) === 'button[skipdate]', await focused(page));
  for (let i = 0; i < 6 && (await focused(page)) !== 'button[series-stop]'; i += 1) await page.keyboard.press('Tab');
  check(`${size}: Tab reaches Stop repeating`, (await focused(page)) === 'button[series-stop]', await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(`${size}: Enter asks first, focus on Yes`, (await focused(page)) === 'button[series-stop-yes]', await focused(page));
  await scan(page, `${size} Stop repeating asking`, '[data-holds-list]');
  await page.keyboard.press('Tab');
  check(`${size}: Tab to Keep it`, (await focused(page)) === 'button[series-stop-no]', await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(`${size}: Keep it puts focus back on Stop repeating`, (await focused(page)) === 'button[series-stop]', await focused(page));

  /* the floor's question */
  await page.evaluate(async () => {
    const { store } = window.Lair;
    const start = Date.now() - 3600000;
    await store.mutate('createBlock', { tables: ['P2'], start, end: start + 3 * 3600000, label: 'Floor league (r8)', type: 'event', repeat: 'weekly' });
  });
  await page.click('[data-tab="floor"]');
  await page.evaluate(() => {
    const staff = document.querySelector('lair-staff');
    staff.selected = [];
    staff.tapTable('P2');
  });
  await page.waitForTimeout(300);
  await page.focus('[data-sheet] [data-act="unhold"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(`${size}: Remove hold with Enter asks, focus on Just this date`, (await focused(page)) === 'button[unhold-date]', await focused(page));
  await scan(page, `${size} the floor's question`, '[data-sheet]');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check(`${size}: Tab, Tab to Keep it`, (await focused(page)) === 'button[unhold-keep]', await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(`${size}: Keep it puts focus back on Remove hold`, (await focused(page)) === 'button[unhold]', await focused(page));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(`${size}: Just this date with Enter: focus stays in the sheet (its heading)`, (await focused(page)) === 'h3', await focused(page));
  await ctx.close();
}
await browser.close();
server.close();
console.log(`holds r8 axe: ${violations} violations; keyboard: ${fails ? `${fails} FAILED` : 'all passed'}`);
process.exit(violations || fails ? 1 : 0);
