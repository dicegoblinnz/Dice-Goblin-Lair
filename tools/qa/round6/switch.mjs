// Round 6: staff switch between My Lair and the staff page (Mo, 5 Oct: "a button to switch views when you're inside
// your account"). Demo mode at 390px and 1280px: a staff customer sees "My Lair | Staff view" at the top of both pages,
// the current one marked, 44px tall, linking to the other; a customer without the staff tag sees nothing.
// Usage: DG_THEME=/path/to/theme PORT=4767 node tools/qa/round6/switch.mjs   (exits 1 if anything fails)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'demo';
const PORT = Number(process.env.PORT || 4767);
const STAFF = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
const PLAIN = { id: 7002, first_name: 'Ana', name: 'Ana Rewi', email: 'ana@example.com', phone: '', tags: [] };
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
async function look(path, customer, width) {
  m.mockState.customer = customer;
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    // round 9: every logged-in customer has it on the page, hidden until the Lair app says they're staff (a helper)
    const nav = document.querySelector('.view-switch:not([hidden])');
    if (!nav) return null;
    const box = nav.getBoundingClientRect();
    return {
      label: nav.getAttribute('aria-label'),
      top: Math.round(box.top + window.scrollY),
      width: Math.round(box.width),
      links: [...nav.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), current: a.getAttribute('aria-current'), h: Math.round(a.getBoundingClientRect().height) })),
    };
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await ctx.close();
  return { r, errors, overflow };
}

for (const width of [390, 1280]) {
  const tag = width < 700 ? 'phone' : 'desktop';
  const mine = await look('/pages/my-lair', STAFF, width);
  const r = mine.r;
  check(`${tag}: My Lair shows staff the switch, My Lair marked`, r && r.links.length === 2 && r.links[0].text === 'My Lair' && r.links[0].current === 'page' && r.links[1].text === 'Staff view' && r.links[1].href === '/pages/lair-staff' && !r.links[1].current, r);
  check(`${tag}: the switch is 44px tall, near the top, and not stretched`, r && r.links.every((l) => l.h >= 44) && r.top < 400 && r.width < width - 40, r);
  check(`${tag}: My Lair has no sideways scroll or errors`, mine.overflow <= 0 && !mine.errors.length, mine);
  const staff = await look('/pages/lair-staff', STAFF, width);
  const s = staff.r;
  check(`${tag}: the staff page shows the switch, Staff view marked`, s && s.links[1].current === 'page' && s.links[0].href === '/pages/my-lair' && !s.links[0].current, s);
  check(`${tag}: the staff page has no sideways scroll or errors`, staff.overflow <= 0 && !staff.errors.length, staff);
  const plain = await look('/pages/my-lair', PLAIN, width);
  check(`${tag}: a customer without the staff tag sees no switch`, plain.r === null, plain.r);
}
await browser.close();
server.close();
console.log(`switch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
