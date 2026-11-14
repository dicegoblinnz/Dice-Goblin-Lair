// Round 39: the Stock off page (sections/lair-stock.liquid, assets/lair-stock.js and .css), on the theme mock, with a
// stand-in for the Lair app's stock routes and a stand-in barcode reader behind a fake camera. Written from the
// contract (docs/contracts/lair-api-contract-v39-stock-off.md, section 7), not from the page's code.
//
// Mo, 15 Nov 2026: "scan my items to then click a button to decrease the quantity of that item by the amount scanned
// [...] a relatively quick and easy way to handle so it doesnt slow me up during markets [...] a button to say that
// item is not sold".
//
//  A. The lab, nobody logged in: practice on made-up things. Where you are is asked once a day; a scan adds one, a box
//     held under the camera never counts twice, only a barcode inside the frame counts; a thing that can't come off
//     says why; a shared barcode asks which; Sold and Not sold (with reasons, and a note for Something else); Undo;
//     the practice list; what's on the phone survives a reload.
//  B. The real shop, a staff account, the section on Live: each lot is one POST /stock/off under its own key, in the
//     order tapped; what wasn't on the count is said; no signal (scans kept, lots kept through a reload, sent once
//     when it's back); an answer lost on the way (the same key again); Undo of a lot that went, that never left the
//     phone, and whose answer was lost (sent, then taken back, before the lot after it); a lot the Lair refuses is
//     held and can be put right; the list and taking a lot back from it; a hand scanner; the typed barcode.
//  C. Who and what: 401 and 403 lock the page; a Lair app from before round 39 means practice through the till's
//     product route, and "not live yet" when the section says Live; Practice on the real shop sends nothing.
//  D. Two tabs on one phone: a lot waiting in one isn't lost when the other saves.
//  E. No camera: the page says so and opens the box to type in.
//  F. The staff page links to it, and its top bar still fits a phone.
//  G. Hostile text (what staff type, what a QR code holds, and everything the Lair app sends back) shows as text.
//  H. What the separate review found (15 Nov 2026), each of which failed here before its fix: Undo while a lot's
//     scans are still being looked up; a lot that may already be off the count; two tabs, one of which takes a lot
//     back; a lab page asked to send a lot it isn't allowed to; and 99 of one thing scanned under two barcodes.
// No sideways scroll, no console errors and axe at each size (390×844, 360×640, 1280×800).
// Usage: DG_THEME=/path/to/theme [PORT=4996] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round39-stock-off/stock.mjs [A|B|C|D|E|F|G|H ...]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round39-stock-off');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, overflowX, axe, shot, watch, STAFF } = lib;
const PORT = Number(process.env.PORT || 4996);
const BASE = `http://localhost:${PORT}`;
const API = (m.globalSettings.lair_api || '/apps/liar').replace(/\/$/, '');
const only = process.argv.slice(2).map((s) => s.toUpperCase());
const wanted = (part) => !only.length || only.includes(part);
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 360, height: 640 };
const WIDE = { width: 1280, height: 800 };

/* ---------- the stand-in Lair app: the shop's count, lots under their keys, and a signal that can drop ---------- */
const CATAN = '9300000000017';
const WINGSPAN = '9300000000024';
const SLEEVES = '9300000000031'; // two colours share it
const OWN_DICE = '9300000000048';
const TICKET = '9300000000055';
const CATAN_CASE = '9300000000062'; // a second barcode of Catan's (its carton, say)
const REASONS = [
  { key: 'damaged', label: 'Damaged' }, { key: 'gift', label: 'Gift or giveaway' }, { key: 'prize', label: 'Prize' },
  { key: 'lost', label: 'Lost or stolen' }, { key: 'other', label: 'Something else' },
];
function lairApp({ round39 = true, who = 'staff' } = {}) {
  const thing = (id, title, option, stock) => ({ product: { id: `p${id}`, title, vendor: 'KOSMOS', type: 'Board Games', status: 'ACTIVE' }, variant: { id: String(id), title: option || 'Default Title', sku: null, stock } });
  const state = {
    calls: [],
    signal: 'up', // 'up' | 'down' (nothing gets through) | 'lost' (the next answer to /stock/off or /stock/undo is lost on the way back)
    who,
    things: { 4001: thing(4001, 'Catan', '', 5), 4002: thing(4002, 'Wingspan', '', 1), 4003: thing(4003, 'Dragon Shield Matte Sleeves', 'Jet', 4), 4004: thing(4004, 'Dragon Shield Matte Sleeves', 'Crimson', 0), 4005: thing(4005, 'Event Ticket', '', 9) },
    codes: { [CATAN]: ['4001'], [CATAN_CASE]: ['4001'], [WINGSPAN]: ['4002'], [SLEEVES]: ['4003', '4004'], [TICKET]: ['4005'] },
    stale: false, // every new lot is answered as one whose answer never came (the Lair's 409)
    expired: false, // the login runs out after the page has started: taking off and putting back answer 401
    cantComeOff: {}, // variantId → words: a thing the Lair refuses when its lot arrives
    lots: new Map(),
    events: ['Armageddon Auckland', 'Oddity Alley'],
    reasons: REASONS,
  };
  const answer = (status, body) => ({ status, body });
  const title = (t) => (t.variant.title !== 'Default Title' ? `${t.product.title} · ${t.variant.title}` : t.product.title);
  const gate = () => (state.who === 'nobody' ? answer(401, { error: 'Log in with your staff account to use Stock off.' }) : state.who === 'customer' ? answer(403, { error: 'Stock off is for the Dice Goblin team.' }) : null);
  const lookup = (code) => {
    const key = String(code || '').replace(/^0+(?=\d)/, '');
    if (!/^[A-Za-z0-9._+-]{1,40}$/.test(String(code || ''))) return answer(400, { error: "That doesn't look like a barcode. Scan it again, or type the numbers under it." });
    if (/^DGL/i.test(key)) return answer(422, { error: "That's a library copy, not shop stock, so there's nothing to take off." });
    if (key === OWN_DICE) return answer(422, { error: "Dice Goblin's own dice aren't counted one by one, so leave them out." });
    const ids = state.codes[key];
    if (!ids) return answer(404, { error: "Gobgob can't find that barcode in the shop." });
    const matches = ids.map((id) => JSON.parse(JSON.stringify(state.things[id])));
    return answer(200, { ...matches[0], ...(matches.length > 1 ? { choices: matches } : {}) });
  };
  const routes = {
    'GET stock': () => gate() || (round39 ? answer(200, { staff: { name: 'Mo', role: 'owner' }, day: '2026-11-21', undoHours: 24, reasons: state.reasons, events: state.events }) : answer(404, { error: 'Not found' })),
    'POST stock/product': (b) => gate() || (round39 ? lookup(b.code) : answer(404, { error: 'Not found' })),
    'POST till/product': (b) => (state.who !== 'staff' ? answer(403, { error: 'The till is for staff.' }) : lookup(b.code)),
    'POST stock/off': (b) => {
      const stop = gate();
      if (stop) return stop;
      if (state.expired) return answer(401, { error: 'Log in with your staff account to use Stock off.' });
      if (!round39) return answer(404, { error: 'Not found' });
      if (state.stale && !state.lots.has(b.id)) return answer(409, { error: 'That lot may already be off the count. Check it in Shopify, then start a new one.' });
      if (!/^so-[0-9a-f]{32}$/.test(String(b.id || ''))) return answer(400, { error: "That lot's details didn't come through. Try again." });
      const canon = JSON.stringify([b.event || '', b.outcome, b.reason || null, b.note || null, b.lines]);
      const had = state.lots.get(b.id);
      if (had) return had.canon === canon ? answer(200, { lot: had.lot }) : answer(409, { error: 'That lot was already sent with different things in it. Start a new one.' });
      if (!Array.isArray(b.lines) || !b.lines.length) return answer(400, { error: 'Scan at least one thing, and up to 40 different things a lot.' });
      if (b.outcome !== 'sold' && b.outcome !== 'not-sold') return answer(400, { error: 'Choose Sold or Not sold.' });
      const problems = b.lines.filter((l) => !state.things[l.variantId] || state.cantComeOff[l.variantId]).map((l) => ({ variantId: String(l.variantId), words: state.cantComeOff[l.variantId] || "Gobgob can't find that in the shop any more." }));
      if (problems.length) return answer(422, { error: "Some of that lot can't come off the count. Take those out and send it again.", problems });
      const lines = b.lines.map((l) => {
        const t = state.things[l.variantId];
        const took = Math.min(l.qty, Math.max(0, t.variant.stock));
        t.variant.stock -= took;
        return { variantId: String(l.variantId), title: title(t), qty: l.qty, took, short: l.qty - took, left: t.variant.stock };
      });
      const sum = (key) => lines.reduce((n, l) => n + l[key], 0);
      const lot = { id: b.id, event: b.event || '', outcome: b.outcome, reason: b.reason || null, reasonLabel: (REASONS.find((r) => r.key === b.reason) || {}).label || null, note: b.note || null, by: 'Mo', at: b.at || Date.now(), day: '2026-11-21', units: sum('qty'), took: sum('took'), short: sum('short'), lines, undone: null };
      state.lots.set(b.id, { canon, lot });
      return answer(200, { lot });
    },
    'POST stock/undo': (b) => {
      const stop = gate();
      if (stop) return stop;
      if (state.expired) return answer(401, { error: 'Log in with your staff account to use Stock off.' });
      const had = state.lots.get(b.id);
      if (!had) return answer(404, { error: "Gobgob can't find that lot." });
      if (!had.lot.undone) {
        had.lot.lines.forEach((l) => { state.things[l.variantId].variant.stock += l.took; });
        had.lot = { ...had.lot, undone: { at: Date.now(), by: 'Mo' } };
      }
      return answer(200, { lot: had.lot });
    },
    'GET stock/log': () => {
      const stop = gate();
      if (stop) return stop;
      const lots = [...state.lots.values()].map((x) => x.lot).reverse();
      const kept = lots.filter((l) => !l.undone);
      const units = (outcome) => kept.filter((l) => l.outcome === outcome).reduce((n, l) => n + l.units, 0);
      return answer(200, { day: '2026-11-21', lots, totals: { lots: kept.length, sold: units('sold'), notSold: units('not-sold'), short: kept.reduce((n, l) => n + l.short, 0) } });
    },
  };
  return {
    state,
    calls: (name) => state.calls.filter((c) => c.name === name),
    async handle(route) {
      const req = route.request();
      const name = `${req.method()} ${new URL(req.url()).pathname.slice(API.length + 1)}`;
      let body = {};
      try {
        body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : {};
      } catch {
        body = {};
      }
      if (state.signal === 'down') {
        state.calls.push({ name, body, got: 'nothing' });
        await route.abort('internetdisconnected');
        return;
      }
      const fn = routes[name];
      const { status, body: out } = fn ? fn(body) : answer(404, { error: 'Not found' });
      if (state.signal === 'lost' && /stock\/(off|undo)$/.test(name)) {
        // it arrived, and the Lair did its part: the answer never made it back
        state.signal = 'up';
        state.calls.push({ name, body, status, got: 'lost' });
        await route.abort('connectionreset');
        return;
      }
      state.calls.push({ name, body, status });
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
    },
  };
}

/* ---------- the stand-in reader: it "sees" whatever the check holds up, where the check holds it ---------- */
const READER = () => {
  window.__codes = [];
  window.BarcodeDetector = class {
    static async getSupportedFormats() {
      return ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
    }

    async detect() {
      return window.__codes.map((c) => ({ ...c }));
    }
  };
  // hold codes up to the camera: [code, x, y], x and y as shares of the picture as the page draws it (0.5, 0.5 is its middle)
  window.__hold = (list) => {
    const v = document.querySelector('lair-stock video');
    const scale = Math.max(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
    const shownW = v.clientWidth / scale;
    const shownH = v.clientHeight / scale;
    window.__codes = list.map(([rawValue, x = 0.5, y = 0.5]) => ({ rawValue, format: 'ean_13', boundingBox: { x: (v.videoWidth - shownW) / 2 + x * shownW - 60, y: (v.videoHeight - shownH) / 2 + y * shownH - 20, width: 120, height: 40 } }));
  };
};
const NO_CAMERA = () => {
  const denied = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = denied;
};

/* ---------- reading the page as someone at the stall would ---------- */
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const stock = (page) => page.locator('lair-stock');
// (a thing's name, and which one of it when it has options: the page shows the two on lines of their own)
const lines = (page) => page.evaluate(() => [...document.querySelectorAll('lair-stock .so-line')].map((li) => ({
  title: [li.querySelector('.so-line__title').textContent.trim(), ((li.querySelector('.so-line__option') || {}).textContent || '').trim()].filter(Boolean).join(' · '),
  qty: Number(li.querySelector('.so-step__count').lastChild.textContent),
  hint: ((li.querySelector('.so-line__hint') || {}).textContent || '').trim(),
  status: li.dataset.status,
})));
const said = async (page) => flat(await page.locator('lair-stock .so-said').textContent());
const banner = (page) => page.evaluate(() => [...document.querySelectorAll('lair-stock .so-banner__line')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const toast = (page) => page.evaluate(() => {
  const t = document.querySelector('lair-stock .so-toast.is-up .so-toast__text');
  return t ? t.textContent.trim() : null;
});
const sheetTitle = (page) => page.evaluate(() => {
  const t = document.querySelector('lair-stock dialog[open] .so-sheet__title');
  return t ? t.textContent.trim() : null;
});
const scan = (page, code) => page.evaluate((c) => document.querySelector('lair-stock').onCode(c), code);
const hold = (page, list) => page.evaluate((l) => window.__hold(l), list);
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const online = (page) => page.evaluate(() => window.dispatchEvent(new Event('online')));
const cameraOn = (page) => page.waitForFunction(() => document.querySelector('lair-stock .so-cam')?.dataset.state === 'on', null, { timeout: 8000 }).then(() => true, () => false);
const tap = async (page, selector) => {
  await page.locator(selector).first().click();
  await settle(page, 250);
};

const server = await m.serve(PORT);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

/** A phone (or a bigger screen) on the page. shop: the booking system on Live with a staff account; lab: Demo, nobody logged in. */
async function visit({ size = PHONE, shop = false, section = 'practice', customer = shop ? STAFF : null, lair = null, camera = true, context = null, wait = 'networkidle' } = {}) {
  m.globalSettings.lair_mode = shop ? 'live' : 'demo';
  m.mockState.customer = customer;
  m.mockState.sectionSettings = { 'lair-stock': { stock: section } };
  const phone = size.width < 700;
  const ctx = context || (await browser.newContext({ viewport: size, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, permissions: ['camera'] }));
  if (!context) {
    await ctx.addInitScript(READER);
    if (!camera) await ctx.addInitScript(NO_CAMERA);
    if (lair) await ctx.route(`**${API}/**`, (route) => lair.handle(route));
  }
  const page = watch(await ctx.newPage());
  await page.goto(`${BASE}/pages/stock`, { waitUntil: wait, timeout: 60000 });
  await settle(page, wait === 'networkidle' ? 400 : 900);
  return { ctx, page };
}
/** Say where you are (the sheet is up when the page hasn't been told today) */
async function place(page, name = '') {
  if (name) {
    await page.fill('#so-where', name);
    await tap(page, 'lair-stock dialog[open] [data-form="where"] [type="submit"]');
  } else await tap(page, 'lair-stock dialog[open] [data-act="where-pick"][data-event=""]');
}
const errorsOf = (page, label) => check(`${label}: no console errors`, !page.errors.length, page.errors.slice(0, 4).join(' / '));
const offCalls = (lair) => lair.calls('POST stock/off');

/* ============ A. The lab: practice on made-up things ============ */
if (wanted('A')) {
  const { ctx, page } = await visit();
  check('A1 the lab asks where you are selling before anything else', (await sheetTitle(page)) === 'Where are you selling?');
  check('A1 that sheet can only be answered, not closed', (await page.locator('lair-stock dialog[open] [data-act="close"]').count()) === 0);
  await shot(page, 'a1-where');
  await axe(page, 'the where sheet', 'lair-stock dialog[open]');
  await place(page, 'Armageddon Auckland');
  check('A1 the place shows in the top bar', flat(await page.locator('.so-top__where-name').textContent()) === 'Armageddon Auckland');
  check('A1 it says practice on made-up things, that nothing comes off, and how to try the shop\'s own', (await banner(page)).includes("Practice on made-up things: nothing comes off. Log in as staff to scan the shop's own."), await banner(page));
  check('A1 one h1, the page\'s name', (await page.locator('h1').count()) === 1 && flat(await page.locator('h1').textContent()) === 'Stock off');
  check('A1 nothing scanned: Sold and Not sold are off', (await page.locator('[data-act="sold"]').isDisabled()) && (await page.locator('[data-act="not-sold"]').isDisabled()));
  check('A1 the shop\'s header and footer are out of the way', await page.evaluate(() => [...document.querySelectorAll('.shopify-section-group-header-group, .shopify-section-group-footer-group')].every((el) => getComputedStyle(el).display === 'none')));

  // the camera: one scan a look, never twice for a box held still, only inside the frame
  check('A2 the camera comes on by itself', await cameraOn(page));
  check('A2 and says what to do', (await said(page)) === 'Point the camera at a barcode.');
  await hold(page, [['29877030712']]);
  await settle(page, 500);
  let list = await lines(page);
  check('A2 a barcode in the frame is scanned: one line, one of it', list.length === 1 && list[0].title === 'Catan' && list[0].qty === 1, list);
  check('A2 the line says what the count has', list[0]?.hint === '5 on the count', list);
  check('A2 and the words under the picture name it', (await said(page)) === 'Catan', await said(page));
  await settle(page, 1600);
  list = await lines(page);
  check('A2 held under the camera, it never counts twice', list.length === 1 && list[0].qty === 1, list);
  await hold(page, []);
  await settle(page, 1500);
  await hold(page, [['29877030712']]);
  await settle(page, 500);
  list = await lines(page);
  check('A2 taken away and shown again, it counts again', list.length === 1 && list[0].qty === 2, list);
  check('A2 the words count along', (await said(page)) === 'Catan ×2', await said(page));
  await hold(page, []);
  await settle(page, 1500);
  await hold(page, [['644216627721', 0.5, 0.04]]);
  await settle(page, 500);
  check('A3 a barcode outside the frame is not scanned', (await lines(page)).length === 1, await lines(page));
  await hold(page, [['644216627721', 0.2, 0.3], ['5706569110024', 0.52, 0.5]]);
  await settle(page, 500);
  list = await lines(page);
  check('A3 of two in the frame, the one nearest the middle is scanned', list.length === 2 && list[0].title === 'Dragon Shield Matte Sleeves · Jet', list);
  await hold(page, []);
  await settle(page, 1500);
  await hold(page, [['https://example.com/win-a-prize?id=1']]);
  await settle(page, 500);
  check('A3 a web address in a QR code is not a barcode: no line, and not a word about it', (await lines(page)).length === 2 && (await said(page)) !== "That doesn't look like a barcode. Scan it again, or type the numbers under it.", await said(page));
  await hold(page, []);

  // what can't come off, and a barcode two things share
  await scan(page, 'DGL34-M011');
  await settle(page);
  check('A4 a library copy is refused in the Lair\'s own words', (await said(page)) === "That's a library copy, not shop stock, so there's nothing to take off.", await said(page));
  check('A4 and it is not on the list', (await lines(page)).length === 2);
  await scan(page, '644216627721');
  await settle(page);
  check('A4 the next scan\'s words replace the refusal at once', (await said(page)) === 'Wingspan', await said(page));
  await scan(page, '196214130001');
  await settle(page);
  list = await lines(page);
  check('A5 a barcode two things share asks which one it is', list[0].status === 'choose' && (await page.locator('.so-line__ask').textContent()) === 'Which one is it?', list);
  await tap(page, '[data-act="sold"]');
  check('A5 Sold waits until that is answered', (await lines(page)).length === 4 && (await said(page)) === 'Tap which one it is first.', await said(page));
  await shot(page, 'a5-which-one');
  await page.locator('[data-act="pick"]').nth(1).click();
  await settle(page);
  list = await lines(page);
  check('A5 tapping one makes the line that one', list[0].title === 'Pokemon 30th Celebration UPC · Night (Umbreon)' && list[0].status === 'ok', list);

  // the stepper
  const wing = () => page.locator('.so-line', { hasText: 'Wingspan' });
  await wing().locator('[data-act="more"]').click();
  await wing().locator('[data-act="more"]').click();
  await settle(page, 150);
  list = await lines(page);
  check('A6 plus adds one each tap', list.find((l) => l.title === 'Wingspan')?.qty === 3, list);
  check('A6 more scanned than the count has says so on the line', list.find((l) => l.title === 'Wingspan')?.hint === 'Only 2 on the count', list);
  await wing().locator('[data-act="less"]').click();
  await settle(page, 150);
  check('A6 minus takes one away', (await lines(page)).find((l) => l.title === 'Wingspan')?.qty === 2);
  const jet = () => page.locator('.so-line', { hasText: 'Jet' });
  await jet().locator('[data-act="less"]').click();
  await settle(page, 150);
  check('A6 minus on the last one takes the line off the list', !(await lines(page)).some((l) => l.title.includes('Jet')));
  check('A6 the Sold button counts what is on the lot', flat(await page.locator('[data-act="sold"]').textContent()).startsWith('Sold5'), await page.locator('[data-act="sold"]').textContent());
  check('A6 which one of a thing it is shows in full on a line of its own, however long the name', await page.evaluate(() => {
    const option = [...document.querySelectorAll('lair-stock .so-line__option')].find((el) => el.textContent.trim() === 'Night (Umbreon)');
    return Boolean(option) && option.scrollWidth <= option.clientWidth && option.getBoundingClientRect().height > 0;
  }));
  check('A6 no sideways scroll with a lot on the list', (await overflowX(page)) === 0);
  await axe(page, 'the page with a lot on it', 'lair-stock');
  await shot(page, 'a6-lot');

  // Sold, and Undo
  await tap(page, '[data-act="sold"]');
  check('A7 Sold is one tap: the list clears', (await lines(page)).length === 0);
  check('A7 and it says what would have come off, in practice', (await toast(page)) === 'Practice: 5 things would come off.', await toast(page));
  await tap(page, '[data-act="undo"]');
  list = await lines(page);
  check('A7 Undo puts the lot back on the list as it was', list.length === 3 && list.reduce((n, l) => n + l.qty, 0) === 5 && list[0].title.startsWith('Pokemon'), list);
  check('A7 and says so', (await said(page)) === "Taken back. It's on the list again.", await said(page));

  // Not sold: why, and a note for Something else
  await tap(page, '[data-act="not-sold"]');
  check('A8 Not sold asks why first', (await sheetTitle(page)) === "Why isn't it sold?");
  check('A8 with the five reasons', JSON.stringify(await page.locator('[data-act="why-pick"]').allTextContents()) === JSON.stringify(REASONS.map((r) => r.label)));
  await axe(page, 'the reasons sheet', 'lair-stock dialog[open]');
  await shot(page, 'a8-why');
  await tap(page, '[data-reason="other"]');
  check('A8 Something else asks what happened', (await sheetTitle(page)) === 'What happened?');
  await page.fill('#so-note', 'ok');
  await tap(page, 'lair-stock dialog[open] [type="submit"]');
  check('A8 two letters is not a note: nothing goes', (await sheetTitle(page)) === 'What happened?' && (await lines(page)).length === 3);
  await page.fill('#so-note', 'Box crushed in the van');
  await tap(page, 'lair-stock dialog[open] [type="submit"]');
  check('A8 with a note it goes, and the sheet closes', (await sheetTitle(page)) === null && (await lines(page)).length === 0);
  await scan(page, '29877030712');
  await settle(page);
  await tap(page, '[data-act="not-sold"]');
  await tap(page, '[data-reason="damaged"]');
  check('A8 any other reason goes on one tap', (await sheetTitle(page)) === null && (await lines(page)).length === 0 && (await toast(page)) === 'Practice: 1 thing would come off.', await toast(page));

  // the practice list
  await tap(page, '[data-act="list"]');
  const listText = flat(await page.locator('lair-stock dialog[open]').textContent());
  check('A9 the list says it is the practice one', listText.includes("This is the practice list: it's only on this phone, and nothing came off."), listText.slice(0, 200));
  check('A9 with both lots, their reasons and the note', listText.includes('Not sold: Damaged') && listText.includes('Not sold: Something else') && listText.includes('Box crushed in the van'), listText);
  check('A9 and what was scanned, added up', listText.includes('0 sold, 6 not sold'), listText);
  check('A9 nothing in a practice list can be taken back', (await page.locator('lair-stock dialog[open] [data-act="take-back"], lair-stock dialog[open] [data-act="unsend"]').count()) === 0);
  await axe(page, 'the list sheet', 'lair-stock dialog[open]');
  await shot(page, 'a9-list');
  await page.keyboard.press('Escape');
  await settle(page);
  check('A9 Escape closes the list', (await sheetTitle(page)) === null);

  // a sheet open: nothing is scanned, and a box still under the camera when it closes isn't scanned into the next lot
  await scan(page, '29877030712');
  await settle(page);
  await hold(page, [['644216627721']]);
  await settle(page, 500);
  check('A10 (a second thing scanned by the camera)', (await lines(page)).length === 2, await lines(page));
  await tap(page, '[data-act="sold"]');
  await settle(page, 1500);
  check('A10 a box still under the camera after Sold is not scanned into the next lot', (await lines(page)).length === 0, await lines(page));
  await hold(page, []);
  await settle(page, 1500);
  await scan(page, '29877030712');
  await settle(page);
  await tap(page, '[data-act="not-sold"]');
  await hold(page, [['644216627721']]);
  await settle(page, 600);
  check('A10 with a sheet open nothing is scanned', (await lines(page)).length === 1, await lines(page));
  await tap(page, '[data-reason="gift"]');
  await settle(page, 1500);
  check('A10 nor is that box scanned when the sheet closes on it', (await lines(page)).length === 0, await lines(page));
  await hold(page, []);

  // what's on the phone survives a reload
  await scan(page, '29877030712');
  await scan(page, '29877030712');
  await settle(page);
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page, 500);
  check('A11 after a reload the same day, where you are is not asked again', (await sheetTitle(page)) === null && flat(await page.locator('.so-top__where-name').textContent()) === 'Armageddon Auckland');
  list = await lines(page);
  check('A11 and what was scanned is still on the list', list.length === 1 && list[0].title === 'Catan' && list[0].qty === 2, list);
  await tap(page, '[data-act="where"]');
  check('A11 the place can be changed, with the last one a tap away', (await sheetTitle(page)) === 'Where are you selling?' && (await page.locator('[data-act="where-pick"]').allTextContents()).includes('Armageddon Auckland'));
  check('A11 and this time the sheet can be closed', (await page.locator('lair-stock dialog[open] [data-act="close"]').count()) === 1);
  await place(page);
  check('A11 At the shop is the shop', flat(await page.locator('.so-top__where-name').textContent()) === 'At the shop');
  errorsOf(page, 'A');
  await ctx.close();

  // in a theme preview Shopify lays its own strip along the bottom of the screen: the buttons stay clear of it
  {
    const v = await visit();
    await place(v.page);
    await v.page.evaluate(() => {
      const strip = document.createElement('div');
      strip.id = 'PBarNextFrameWrapper';
      strip.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:68px;z-index:2147483647;background:#fff';
      document.body.append(strip);
      window.dispatchEvent(new Event('resize'));
    });
    await settle(v.page, 300);
    const clear = await v.page.evaluate(() => ({ bar: Math.round(document.querySelector('lair-stock .so-bar').getBoundingClientRect().bottom), strip: Math.round(document.getElementById('PBarNextFrameWrapper').getBoundingClientRect().top), sold: Math.round(document.querySelector('[data-act="sold"]').getBoundingClientRect().height) }));
    check('A13 in a theme preview, Sold and Not sold sit above Shopify\'s strip, not under it', clear.bar <= clear.strip + 1 && clear.sold >= 64, clear);
    await v.ctx.close();
  }

  // the same page on a small phone and a wide screen
  for (const [name, size] of [['small', SMALL], ['wide', WIDE]]) {
    const v = await visit({ size });
    await place(v.page, 'Oddity Alley');
    for (const code of ['29877030712', '644216627721', '5706569110024', '5706569110215', '196214130001']) await scan(v.page, code);
    await settle(v.page, 500);
    check(`A12 ${name}: no sideways scroll`, (await overflowX(v.page)) === 0);
    const boxes = await v.page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) };
      };
      const small = [...document.querySelectorAll('lair-stock button, lair-stock a')].filter((el) => el.offsetParent !== null).map((el) => ({ el: el.dataset.act || el.className, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })).filter((b) => b.w < 43.5 || b.h < 43.5);
      return { vh: window.innerHeight, vw: window.innerWidth, cam: box('.so-cam'), list: box('.so-list'), bar: box('.so-bar'), sold: box('[data-act="sold"]'), notSold: box('[data-act="not-sold"]'), small };
    });
    check(`A12 ${name}: the camera, the lot and both buttons are all on the screen at once`, boxes.cam.top >= 0 && boxes.bar.bottom <= boxes.vh + 1 && boxes.list.h >= 80, boxes);
    check(`A12 ${name}: Sold and Not sold are big (64px, or 52px on a phone on its side)`, boxes.sold.h >= 64 && boxes.notSold.h >= 64, boxes);
    check(`A12 ${name}: nothing to tap is under 44px`, !boxes.small.length, boxes.small);
    if (name === 'wide') check('A12 wide: the camera and the lot sit side by side', boxes.list.left >= boxes.cam.right, boxes);
    await axe(v.page, `${name}: the page`, 'lair-stock');
    await shot(v.page, `a12-${name}`);
    await tap(v.page, '[data-act="pick"]'); // (the shared barcode: say which one, or Not sold waits)
    await tap(v.page, '[data-act="not-sold"]');
    const sheet = await v.page.evaluate(() => {
      const r = document.querySelector('lair-stock dialog[open]').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth };
    });
    check(`A12 ${name}: the reasons sheet is inside the screen`, sheet.top >= 0 && sheet.bottom <= sheet.vh + 1 && sheet.left >= 0 && sheet.right <= sheet.vw + 1, sheet);
    errorsOf(v.page, `A12 ${name}`);
    await v.ctx.close();
  }
}

/* ============ B. The real shop, on Live ============ */
if (wanted('B')) {
  const lair = lairApp();
  const { ctx, page } = await visit({ shop: true, section: 'live', lair });
  check('B1 the page asks the Lair app who is here', lair.calls('GET stock').length === 1, lair.state.calls.map((c) => c.name));
  check('B1 the places lots came off lately are a tap away', JSON.stringify(await page.locator('[data-act="where-pick"]:not([data-event=""])').allTextContents()) === JSON.stringify(['Armageddon Auckland', 'Oddity Alley']));
  await tap(page, '[data-act="where-pick"][data-event="Armageddon Auckland"]');
  check('B1 on Live there is no practice line', !(await banner(page)).length, await banner(page));

  // a sale: two things, three of them
  await scan(page, CATAN);
  await scan(page, CATAN);
  await scan(page, TICKET);
  await settle(page);
  let list = await lines(page);
  check('B2 codes are looked up in the shop, once each', lair.calls('POST stock/product').length === 2 && list.length === 2 && list[1].title === 'Catan' && list[1].qty === 2 && list[1].hint === '5 on the count', list);
  await tap(page, '[data-act="sold"]');
  await settle(page, 400);
  let offs = offCalls(lair);
  check('B2 Sold sends the lot once', offs.length === 1, offs);
  check('B2 under a key of its own: so- and 32 hex digits', /^so-[0-9a-f]{32}$/.test(offs[0]?.body.id || ''), offs[0]?.body.id);
  check('B2 with where it was, that it sold, and each thing once in the order scanned', offs[0]?.body.event === 'Armageddon Auckland' && offs[0]?.body.outcome === 'sold' && offs[0]?.body.reason === null && JSON.stringify(offs[0]?.body.lines) === JSON.stringify([{ variantId: '4001', qty: 2 }, { variantId: '4005', qty: 1 }]), offs[0]?.body);
  check('B2 and when it was tapped, by the phone\'s clock', Math.abs((offs[0]?.body.at || 0) - Date.now()) < 26 * 3600 * 1000, offs[0]?.body.at);
  check('B2 the shop\'s count went down by what was scanned', lair.state.things[4001].variant.stock === 3 && lair.state.things[4005].variant.stock === 8);
  check('B2 the list is clear for the next customer, and the toast says what went', (await lines(page)).length === 0 && (await toast(page)) === 'Sold: 3 things.', await toast(page));
  await settle(page, 2800);
  check('B2 a lot that goes straight through never shows as waiting', !(await banner(page)).length, await banner(page));
  await scan(page, CATAN);
  await settle(page);
  check('B2 the next scan of it shows the count as it is now, without asking again', (await lines(page))[0]?.hint === '3 on the count' && lair.calls('POST stock/product').length === 2, await lines(page));
  await page.locator('[data-act="less"]').click();
  await settle(page, 150);

  // more scanned than the count has
  await scan(page, WINGSPAN);
  await scan(page, WINGSPAN);
  await settle(page);
  check('B3 two scanned with one on the count says so before the tap', (await lines(page))[0]?.hint === 'Only 1 on the count' && (await said(page)) === 'Wingspan ×2', [await lines(page), await said(page)]);
  await tap(page, '[data-act="sold"]');
  await settle(page, 400);
  check('B3 the toast says what was not on the count', (await toast(page)) === "Sold: 2 things. 1 wasn't on the count.", await toast(page));
  check('B3 and the count stops at zero', lair.state.things[4002].variant.stock === 0);

  // not sold
  await scan(page, TICKET);
  await settle(page);
  await tap(page, '[data-act="not-sold"]');
  await tap(page, '[data-reason="other"]');
  await page.fill('#so-note', '  Gave it to the   organiser ');
  await tap(page, 'lair-stock dialog[open] [type="submit"]');
  await settle(page, 400);
  offs = offCalls(lair);
  check('B4 Not sold sends the reason and the note, tidied', offs.length === 3 && offs[2].body.outcome === 'not-sold' && offs[2].body.reason === 'other' && offs[2].body.note === 'Gave it to the organiser', offs[2]?.body);
  check('B4 the toast names the reason', (await toast(page)) === 'Not sold: 1 thing (something else).', await toast(page));

  // no signal: scans are kept, lots are kept, and each goes once when it's back
  lair.state.signal = 'down';
  await scan(page, SLEEVES);
  await settle(page, 600);
  list = await lines(page);
  check('B5 with no signal a scan still goes on the list at once', list.length === 1 && list[0].title === `Barcode ${SLEEVES}` && list[0].status === 'offline', list);
  check('B5 and says it will be checked before it is sent', list[0]?.hint === "Not looked up yet: no signal. It'll be checked before it's sent.", list);
  await page.locator('[data-act="less"]').click();
  await scan(page, CATAN); // (the phone remembers this one)
  await scan(page, '9300000099999'); // nobody has ever scanned this one here
  await settle(page, 500);
  await tap(page, '[data-act="sold"]');
  check('B5 Sold works with no signal: the list clears', (await lines(page)).length === 0 && (await toast(page)) === 'Sold: 2 things.', await toast(page));
  await settle(page, 3000);
  check('B5 and after a moment the page says a lot is waiting', (await banner(page)).some((b) => b.startsWith('1 lot waiting to send.')), await banner(page));
  check('B5 nothing came off while there was no signal', offCalls(lair).filter((c) => c.status === 200).length === 3 && lair.state.things[4001].variant.stock === 3);
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page, 3200);
  check('B5 the waiting lot survives the page being closed and opened', (await banner(page)).some((b) => b.startsWith('1 lot waiting to send.')), await banner(page));
  await shot(page, 'b5-waiting');
  // signal's back, and the thing nobody had scanned turns out not to be in the shop: the lot is held, not sent
  lair.state.signal = 'up';
  await online(page);
  await settle(page, 900);
  check('B6 a thing that turns out not to be in the shop holds its lot back', (await banner(page)).includes('1 lot needs a look') && offCalls(lair).filter((c) => c.status === 200).length === 3, [await banner(page), lair.state.calls.slice(-4)]);
  await tap(page, '[data-act="held"]');
  let held = flat(await page.locator('lair-stock dialog[open]').textContent());
  check('B6 the sheet says which thing, in the Lair\'s words, and that nothing has come off', held.includes("Gobgob can't find that barcode in the shop.") && held.includes('Nothing in it has come off yet.') && held.includes('1 × Catan'), held);
  await axe(page, 'the needs-a-look sheet', 'lair-stock dialog[open]');
  await shot(page, 'b6-held');
  await tap(page, '[data-act="held-rest"]');
  await settle(page, 500);
  offs = offCalls(lair).filter((c) => c.status === 200);
  check('B6 Send the other 1 thing sends just that', offs.length === 4 && JSON.stringify(offs[3].body.lines) === JSON.stringify([{ variantId: '4001', qty: 1 }]) && lair.state.things[4001].variant.stock === 2, offs[3]?.body);
  check('B6 and nothing is left waiting', !(await banner(page)).length, await banner(page));

  // an answer lost on the way back: the same lot again under the same key, taken off once
  lair.state.signal = 'lost';
  await scan(page, TICKET);
  await settle(page);
  await tap(page, '[data-act="sold"]');
  await settle(page, 500);
  check('B7 (the lot arrived, and its answer was lost)', lair.state.things[4005].variant.stock === 6 && offCalls(lair).filter((c) => c.got === 'lost').length === 1, lair.state.calls.slice(-2));
  await online(page);
  await settle(page, 700);
  const lost = offCalls(lair).slice(-2);
  check('B7 it is sent again under the very same key, with the very same things', lost.length === 2 && lost[0].got === 'lost' && lost[1].status === 200 && lost[0].body.id === lost[1].body.id && JSON.stringify(lost[0].body) === JSON.stringify(lost[1].body), lost);
  check('B7 and came off once', lair.state.things[4005].variant.stock === 6);

  // Undo, three ways
  await scan(page, TICKET);
  await settle(page);
  await tap(page, '[data-act="sold"]');
  await settle(page, 500);
  check('B8 (a lot that went: the count is down)', lair.state.things[4005].variant.stock === 5);
  const wentId = offCalls(lair).at(-1).body.id;
  await tap(page, '[data-act="undo"]');
  await settle(page, 600);
  check('B8 Undo of a lot that went puts it back on the count', lair.calls('POST stock/undo').length === 1 && lair.calls('POST stock/undo')[0].body.id === wentId && lair.state.things[4005].variant.stock === 6, lair.calls('POST stock/undo'));
  list = await lines(page);
  check('B8 and back on the list, with the count as it is again', list.length === 1 && list[0].title === 'Event Ticket' && list[0].qty === 1 && list[0].hint === '6 on the count', list);

  // The phone has no connection at all, and knows it: nothing is even tried, so a lot taken back never existed.
  await ctx.setOffline(true);
  await settle(page, 200);
  let before = lair.state.calls.length;
  await tap(page, '[data-act="sold"]');
  await settle(page, 300);
  await tap(page, '[data-act="undo"]');
  await settle(page, 300);
  check('B9 with no connection, Undo still puts the lot back on the list', (await lines(page)).length === 1 && (await said(page)) === "Taken back. It's on the list again.", await lines(page));
  await ctx.setOffline(false);
  await settle(page, 1200);
  check('B9 a lot that never left the phone is never sent, and never taken back', !lair.state.calls.slice(before).some((c) => /stock\/(off|undo)$/.test(c.name)), lair.state.calls.slice(before).map((c) => [c.name, c.status, c.got]));
  check('B9 the count is as it was', lair.state.things[4005].variant.stock === 6);
  // A connection that drops everything while the phone thinks it has one: the lot was tried, so it may have arrived.
  // Taken back, it is sent (under its key) and then put back: never left half done.
  lair.state.signal = 'down';
  before = lair.state.calls.length;
  await tap(page, '[data-act="sold"]');
  await settle(page, 400);
  await tap(page, '[data-act="undo"]');
  await settle(page, 300);
  check('B9 with a connection that drops everything, Undo still puts the lot back on the list', (await lines(page)).length === 1, await lines(page));
  lair.state.signal = 'up';
  await online(page);
  await settle(page, 900);
  const tried = lair.state.calls.slice(before).filter((c) => /stock\/(off|undo)$/.test(c.name) && c.status);
  check('B9 a lot that was tried is sent under its key and then taken back, in that order', tried.length === 2 && tried[0].name === 'POST stock/off' && tried[1].name === 'POST stock/undo' && tried[0].body.id === tried[1].body.id && tried[0].body.id === lair.state.calls[before].body.id, tried.map((c) => [c.name, c.body.id]));
  check('B9 so the count is as it was either way', lair.state.things[4005].variant.stock === 6, lair.state.things[4005].variant.stock);
  check('B9 and nothing is left waiting', !(await banner(page)).length, await banner(page));

  // a lot whose answer was lost, undone before the phone knew: it's sent again, then taken back, before the next lot
  lair.state.signal = 'lost';
  await tap(page, '[data-act="sold"]'); // the ticket: arrives, answer lost
  await settle(page, 500);
  check('B10 (the lot arrived: the count is down, and the phone does not know)', lair.state.things[4005].variant.stock === 5);
  lair.state.signal = 'down';
  await tap(page, '[data-act="undo"]');
  await settle(page, 300);
  check('B10 Undo puts it back on the list straight away', (await lines(page)).length === 1);
  await page.locator('[data-act="more"]').click();
  await settle(page, 150);
  await tap(page, '[data-act="sold"]'); // the same ticket, two this time
  const mark = lair.state.calls.length;
  lair.state.signal = 'up';
  await online(page);
  await settle(page, 1200);
  const after = lair.state.calls.slice(mark).filter((c) => /stock\/(off|undo)$/.test(c.name) && c.status === 200);
  const lostId = offCalls(lair).filter((c) => c.got === 'lost').at(-1).body.id;
  check('B10 when signal is back: the lost lot again under its key, then its undo, then the next lot', after.length === 3 && after[0].name === 'POST stock/off' && after[0].body.id === lostId && after[1].name === 'POST stock/undo' && after[1].body.id === lostId && after[2].name === 'POST stock/off' && after[2].body.id !== lostId && after[2].body.lines[0].qty === 2, after.map((c) => [c.name, c.body.id, c.body.lines]));
  check('B10 so the count is right: only the second lot is off it', lair.state.things[4005].variant.stock === 4, lair.state.things[4005].variant.stock);
  check('B10 and nothing is left waiting', !(await banner(page)).length, await banner(page));

  // a lot the Lair refuses when it arrives
  lair.state.cantComeOff[4005] = "Shopify doesn't count Event Ticket, so there's nothing to take off.";
  await scan(page, TICKET);
  await scan(page, CATAN);
  await settle(page);
  await tap(page, '[data-act="sold"]');
  await settle(page, 600);
  check('B11 a lot the Lair refuses is held, and nothing in it came off', (await banner(page)).includes('1 lot needs a look') && lair.state.things[4001].variant.stock === 2, await banner(page));
  await tap(page, '[data-act="held"]');
  held = flat(await page.locator('lair-stock dialog[open]').textContent());
  check('B11 the sheet shows the Lair\'s words on the thing that can\'t come off', held.includes("Shopify doesn't count Event Ticket, so there's nothing to take off.") && held.includes("Some of that lot can't come off the count."), held);
  await tap(page, '[data-act="held-back"]');
  list = await lines(page);
  check('B11 Put it back on the list brings back what can come off', list.length === 1 && list[0].title === 'Catan', list);
  check('B11 and the lot is gone from the waiting ones', !(await banner(page)).length, await banner(page));
  delete lair.state.cantComeOff[4005];
  await page.locator('[data-act="less"]').click();
  await settle(page, 150);

  // lots go in the order they were tapped
  lair.state.signal = 'down';
  for (const code of [CATAN, TICKET, CATAN]) {
    await scan(page, code);
    await settle(page, 200);
    await tap(page, '[data-act="sold"]');
  }
  const from = lair.state.calls.length;
  lair.state.signal = 'up';
  await online(page);
  await settle(page, 1200);
  const order = lair.state.calls.slice(from).filter((c) => c.name === 'POST stock/off' && c.status === 200).map((c) => c.body.lines[0].variantId);
  check('B12 three lots tapped with no signal go in the order they were tapped', JSON.stringify(order) === JSON.stringify(['4001', '4005', '4001']), order);
  check('B12 each once', lair.state.things[4001].variant.stock === 0 && lair.state.things[4005].variant.stock === 3, [lair.state.things[4001].variant.stock, lair.state.things[4005].variant.stock]);

  // the list, and taking a lot back from it
  await settle(page, 12500); // (the last toast has gone)
  await tap(page, '[data-act="list"]');
  await settle(page, 400);
  const listText = flat(await page.locator('lair-stock dialog[open]').textContent());
  check('B13 the list is the Lair\'s own, with who and where', listText.includes("Today's list") && listText.includes('Mo') && listText.includes('Armageddon Auckland') && listText.includes('sold,'), listText.slice(0, 300));
  check('B13 a lot that was taken back says so', listText.includes('Taken back by Mo'), listText);
  await shot(page, 'b13-list');
  await axe(page, 'the live list', 'lair-stock dialog[open]');
  const undoBefore = lair.calls('POST stock/undo').length;
  const first = page.locator('lair-stock dialog[open] [data-act="take-back"]').first();
  await first.click();
  await settle(page, 200);
  check('B13 Take it back asks for a second tap', lair.calls('POST stock/undo').length === undoBefore && flat(await first.textContent()) === 'Tap again to take it back', await first.textContent());
  await first.click();
  await settle(page, 600);
  check('B13 the second tap puts that lot back on the count', lair.calls('POST stock/undo').length === undoBefore + 1 && lair.state.things[4001].variant.stock === 1, lair.state.things[4001].variant.stock);
  await tap(page, 'lair-stock dialog[open] [data-act="close"]');

  // a hand scanner, and the box to type in
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.type(TICKET, { delay: 5 });
  await page.keyboard.press('Enter');
  await settle(page);
  check('B14 a hand scanner (the numbers, then Enter) adds a line', (await lines(page))[0]?.title === 'Event Ticket', await lines(page));
  await tap(page, '[data-act="type"]');
  await page.fill('#so-code', `0${CATAN}`);
  await page.keyboard.press('Enter');
  await settle(page);
  list = await lines(page);
  check('B14 a typed barcode adds a line too, whatever zero it starts with', list.length === 2 && list[0].title === 'Catan', list);
  check('B14 and the box is ready for the next one', (await page.locator('#so-code').inputValue()) === '' && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'so-code');
  await page.fill('#so-code', 'not a code!');
  await page.keyboard.press('Enter');
  await settle(page);
  check('B14 something that is no barcode says so and adds nothing', (await lines(page)).length === 2 && (await said(page)) === "That doesn't look like a barcode. Scan it again, or type the numbers under it.", await said(page));
  check('B15 no sideways scroll', (await overflowX(page)) === 0);
  errorsOf(page, 'B');
  await ctx.close();
}

/* ============ C. Who, and what the Lair app can do ============ */
if (wanted('C')) {
  // nobody logged in on the real shop: the section itself says so, and loads nothing
  let v = await visit({ shop: true, section: 'live', customer: null, lair: lairApp({ who: 'nobody' }) });
  check('C1 on the real shop, nobody logged in gets the locked page and a way to log in', flat(await stock(v.page).textContent()).includes('Stock off is for the Dice Goblin team') && (await v.page.locator('lair-stock a[href*="/customer_authentication/login?return_to="]').count()) === 1, flat(await stock(v.page).textContent()));
  check('C1 logging in comes back to this page', decodeURIComponent((await v.page.locator('lair-stock a[href*="return_to="]').getAttribute('href')) || '').endsWith('/pages/lair-staff?view=stock'), await v.page.locator('lair-stock a[href*="return_to="]').getAttribute('href'));
  check('C1 and the page\'s script is not loaded', (await v.page.locator('script[src*="lair-stock.js"]').count()) === 0);
  await axe(v.page, 'the locked page', 'lair-stock');
  await v.ctx.close();

  // logged in, and the Lair app says they're not on the team
  let lair = lairApp({ who: 'customer' });
  v = await visit({ shop: true, section: 'live', lair });
  await settle(v.page, 500);
  let text = flat(await stock(v.page).textContent());
  check('C2 a customer who is not on the team is told so, with no way in', text.includes("This account isn't on the team.") && !(await v.page.locator('lair-stock [data-act="sold"]').count()), text);
  check('C2 and the camera is not left on', await v.page.evaluate(() => !document.querySelector('lair-stock video')));
  await v.ctx.close();

  // a login that has run out: the Lair says 401
  lair = lairApp({ who: 'nobody' });
  v = await visit({ shop: true, section: 'live', lair });
  await settle(v.page, 500);
  text = flat(await stock(v.page).textContent());
  check('C3 a login that has run out gets the log-in page', text.includes('Log in with your staff account to use it.') && (await v.page.locator('lair-stock a[href*="return_to="]').count()) === 1, text);
  await v.ctx.close();

  // a Lair app from before round 39, with the section already on Live
  lair = lairApp({ round39: false });
  v = await visit({ shop: true, section: 'live', lair });
  await place(v.page);
  check('C4 before the Lair app has round 39, Live says it is not live yet', (await banner(v.page)).includes("Not live yet: the Lair app hasn't had its Stock off update, so nothing comes off the count."), await banner(v.page));
  await scan(v.page, CATAN);
  await settle(v.page);
  check('C4 codes are looked up through the till\'s route', (await lines(v.page))[0]?.title === 'Catan' && lair.calls('POST till/product').some((c) => c.body.code === CATAN) && !lair.calls('POST stock/product').length, lair.state.calls.map((c) => c.name));
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 500);
  check('C4 and Sold sends nothing: it is practice', !offCalls(lair).length && (await toast(v.page)) === 'Practice: 1 thing would come off.', await toast(v.page));
  errorsOf(v.page, 'C4');
  await v.ctx.close();

  // the real shop with the section on Practice
  lair = lairApp();
  v = await visit({ shop: true, section: 'practice', lair });
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page);
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 500);
  check('C5 on Practice the shop\'s real things are looked up, and Sold sends nothing', lair.calls('POST stock/product').length === 1 && !offCalls(lair).length && (await banner(v.page)).includes('Practice: nothing comes off the count.') && lair.state.things[4001].variant.stock === 5, lair.state.calls.map((c) => c.name));
  errorsOf(v.page, 'C5');
  await v.ctx.close();

  // the lab with a staff account: always practice, even with the section on Live
  lair = lairApp();
  v = await visit({ shop: false, section: 'live', customer: STAFF, lair });
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page);
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 500);
  check('C6 in the lab it is always practice, whatever the section says', !offCalls(lair).length && (await banner(v.page)).includes('Practice: nothing comes off the count.'), await banner(v.page));
  await v.ctx.close();

  // the page is ready before the Lair app has answered
  const slowly = (app, ms) => {
    const handle = app.handle.bind(app);
    app.handle = async (route) => {
      if (/\/stock$/.test(new URL(route.request().url()).pathname)) await new Promise((r) => setTimeout(r, ms));
      return handle(route);
    };
    return app;
  };
  lair = slowly(lairApp(), 4000);
  v = await visit({ shop: true, section: 'live', lair, wait: 'domcontentloaded' });
  check('C7 with the Lair app slow to answer, the page is already up and asking where you are', (await sheetTitle(v.page)) === 'Where are you selling?' && !lair.calls('GET stock').length, lair.state.calls.map((c) => c.name));
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page, 200);
  check('C7 and a scan is on the list at once, before the Lair app has said a word', (await lines(v.page)).length === 1 && !lair.calls('GET stock').length, await lines(v.page));
  await settle(v.page, 4500);
  check('C7 it is looked up once the Lair app has answered', (await lines(v.page))[0]?.title === 'Catan', await lines(v.page));
  await v.ctx.close();

  // the section on Live, a Lair app from before round 39 that's slow to say so, and Sold tapped before it has
  lair = slowly(lairApp({ round39: false }), 4000);
  v = await visit({ shop: true, section: 'live', lair, wait: 'domcontentloaded' });
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page, 200);
  await tap(v.page, '[data-act="sold"]');
  check('C8 (Sold was tapped before the Lair app had answered)', !lair.calls('GET stock').length && (await lines(v.page)).length === 0, lair.state.calls.map((c) => c.name));
  await settle(v.page, 6500);
  const waitingLines = await banner(v.page);
  check('C8 a lot tapped before an old Lair app said it was old waits on the phone, and the page says why', waitingLines.some((b) => b.startsWith('Not live yet:')) && waitingLines.some((b) => b.startsWith('1 lot waiting to send.')) && !waitingLines.some((b) => b.includes('needs a look')), waitingLines);
  check('C8 and nothing was taken off', !offCalls(lair).some((c) => c.status === 200), offCalls(lair));
  errorsOf(v.page, 'C8');
  await v.ctx.close();
}

/* ============ D. Two tabs on one phone ============ */
if (wanted('D')) {
  const lair = lairApp();
  const a = await visit({ shop: true, section: 'live', lair });
  await place(a.page, 'Oddity Alley');
  await scan(a.page, CATAN);
  await settle(a.page);
  lair.state.signal = 'down';
  await tap(a.page, '[data-act="sold"]');
  await settle(a.page, 300);
  // the same phone opens the page again in another tab, and the first is put away for good
  const b = await visit({ shop: true, section: 'live', lair, context: a.ctx });
  await a.page.close();
  await scan(b.page, TICKET);
  await settle(b.page, 400);
  lair.state.signal = 'up';
  await online(b.page);
  await settle(b.page, 1200);
  const sent = offCalls(lair).filter((c) => c.status === 200);
  check('D1 a lot waiting in a tab that was closed is sent by the next one', sent.length === 1 && sent[0].body.lines[0].variantId === '4001' && sent[0].body.event === 'Oddity Alley' && lair.state.things[4001].variant.stock === 4, sent.map((c) => c.body));
  errorsOf(b.page, 'D');
  await a.ctx.close();
}

/* ============ E. No camera ============ */
if (wanted('E')) {
  const v = await visit({ camera: false });
  await place(v.page);
  await settle(v.page, 400);
  check('E1 with the camera blocked the page says so, and how to carry on', (await said(v.page)) === "The camera is blocked. Allow it for this site in the browser's settings, or type the barcode.", await said(v.page));
  check('E1 and the box to type in is open', (await v.page.locator('#so-code').count()) === 1);
  check('E1 with a button to try the camera again', flat(await v.page.locator('.so-cam__tap').textContent()) === 'Try the camera again');
  await v.page.fill('#so-code', '29877030712');
  await v.page.keyboard.press('Enter');
  await settle(v.page);
  check('E1 a typed barcode works without it', (await lines(v.page))[0]?.title === 'Catan', await lines(v.page));
  check('E1 no sideways scroll', (await overflowX(v.page)) === 0);
  await axe(v.page, 'no camera', 'lair-stock');
  await shot(v.page, 'e1-no-camera');
  errorsOf(v.page, 'E');
  await v.ctx.close();
}

/* ============ F. The staff page's way in ============ */
if (wanted('F')) {
  m.globalSettings.lair_mode = 'demo';
  for (const look of ['pieces', 'first']) {
    for (const width of look === 'pieces' ? [360, 390, 430] : [390]) {
      m.mockState.customer = STAFF;
      m.mockState.sectionSettings = { 'lair-staff': { look } };
      const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = watch(await ctx.newPage());
      await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
      await settle(page, 600);
      const link = page.locator('.staff-stock-link a');
      check(`F1 ${look} ${width}: the staff page links to Stock off for staff`, (await link.count()) === 1 && (await link.isVisible()) && (await link.getAttribute('href')) === '/pages/lair-staff?view=stock', await link.count());
      check(`F1 ${look} ${width}: on one line`, (await link.evaluate((el) => el.getClientRects().length)) === 1);
      if (look === 'pieces') check(`F1 ${look} ${width}: the top bar still has room for its name`, await page.evaluate(() => {
        const t = document.querySelector('.staff-top__title');
        return t.scrollWidth <= t.clientWidth;
      }));
      check(`F1 ${look} ${width}: no sideways scroll`, (await overflowX(page)) === 0);
      await ctx.close();
    }
  }
  // someone logged in who isn't staff never sees the link
  m.mockState.customer = { ...STAFF, tags: [] };
  m.mockState.sectionSettings = { 'lair-staff': { look: 'first' } };
  m.globalSettings.lair_mode = 'live';
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  await ctx.route(`**${API}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ member: { id: 1, staff: false } }) }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle', timeout: 60000 });
  await settle(page, 600);
  check('F2 a customer who is not staff does not see the link', (await page.locator('.staff-stock-link').count()) === 1 && !(await page.locator('.staff-stock-link').isVisible()));
  await ctx.close();
  m.globalSettings.lair_mode = 'demo';
}

/* ============ G. Hostile text shows as text ============ */
if (wanted('G')) {
  const NASTY = `<img src=x onerror="window.__xss=1">"'><script>window.__xss=1</script><a href="javascript:window.__xss=1">x</a>`;
  const clean = (page) => page.evaluate(() => ({ ran: window.__xss === undefined, made: document.querySelectorAll('lair-stock img, lair-stock script, lair-stock iframe, lair-stock a[href^="javascript:"], lair-stock [onerror], lair-stock dialog a').length }));
  const safe = async (page, label) => {
    const c = await clean(page);
    check(`G ${label}: nothing ran and nothing was made of it`, c.ran && c.made === 0, c);
  };

  // what staff type: where they are, the note, a barcode (and what a QR code at a stall might hold)
  let v = await visit();
  await place(v.page, NASTY);
  check('G1 a place typed as markup shows as the words typed', (await v.page.locator('.so-top__where-name').textContent()).startsWith('<img src=x onerror='), await v.page.locator('.so-top__where-name').textContent());
  await safe(v.page, 'the place');
  await tap(v.page, '[data-act="type"]');
  await v.page.fill('#so-code', NASTY.slice(0, 40));
  await v.page.keyboard.press('Enter');
  await settle(v.page);
  check('G1 markup typed as a barcode is no barcode', (await lines(v.page)).length === 0 && (await said(v.page)).startsWith("That doesn't look like a barcode."), await said(v.page));
  await hold(v.page, [[NASTY]]);
  await settle(v.page, 500);
  check('G1 nor is markup in a QR code', (await lines(v.page)).length === 0);
  await hold(v.page, []);
  await scan(v.page, '29877030712');
  await settle(v.page);
  await tap(v.page, '[data-act="not-sold"]');
  await tap(v.page, '[data-reason="other"]');
  await v.page.fill('#so-note', NASTY);
  await tap(v.page, 'lair-stock dialog[open] [type="submit"]');
  await tap(v.page, '[data-act="list"]');
  check('G1 a note typed as markup shows in the list as the words typed', flat(await v.page.locator('lair-stock dialog[open]').textContent()).includes('<script>window.__xss=1</script>'), flat(await v.page.locator('lair-stock dialog[open]').textContent()));
  await safe(v.page, 'the note in the list');
  await v.page.keyboard.press('Escape');
  await v.page.reload({ waitUntil: 'networkidle' });
  await settle(v.page, 400);
  await tap(v.page, '[data-act="where"]');
  check('G1 kept on the phone and offered again, the place is still only words', (await v.page.locator('[data-act="where-pick"]').first().textContent()).startsWith('<img src=x onerror='), await v.page.locator('[data-act="where-pick"]').first().textContent());
  await safe(v.page, 'the place, from the phone');
  await v.ctx.close();

  // what the Lair app sends back: places, reasons, a thing's name, its words for a no, and every part of a lot in the list
  const lair = lairApp();
  lair.state.events = [NASTY, 'Oddity Alley'];
  lair.state.reasons = REASONS.map((r) => (r.key === 'damaged' ? { key: 'damaged', label: NASTY } : r));
  lair.state.things[4001].product.title = NASTY;
  lair.state.things[4003].variant.title = NASTY;
  v = await visit({ shop: true, section: 'live', lair });
  check('G2 a place from the Lair app that is markup is offered as words', (await v.page.locator('[data-act="where-pick"]').first().textContent()).startsWith('<img src=x onerror='));
  await safe(v.page, 'the places');
  await tap(v.page, '[data-act="where-pick"]');
  await scan(v.page, CATAN);
  await scan(v.page, SLEEVES);
  await settle(v.page);
  check('G2 a thing whose name is markup is listed by those words', (await lines(v.page)).some((l) => l.title.startsWith('<img src=x onerror=')), await lines(v.page));
  await safe(v.page, 'names on the list and on the choices');
  await tap(v.page, '[data-act="pick"]');
  await tap(v.page, '[data-act="not-sold"]');
  await safe(v.page, 'the reasons');
  await tap(v.page, '[data-reason="damaged"]');
  await settle(v.page, 500);
  await safe(v.page, 'the toast');
  lair.state.cantComeOff[4005] = NASTY;
  await scan(v.page, TICKET);
  await settle(v.page);
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 600);
  await tap(v.page, '[data-act="held"]');
  check('G2 the Lair app\'s words for a no that are markup show as words', flat(await v.page.locator('lair-stock dialog[open]').textContent()).includes('<script>window.__xss=1</script>'));
  await safe(v.page, 'the needs-a-look sheet');
  await tap(v.page, '[data-act="held-drop"]');
  for (const kept of lair.state.lots.values()) kept.lot = { ...kept.lot, by: NASTY, note: NASTY, event: NASTY, reasonLabel: NASTY, undone: { at: Date.now(), by: NASTY } };
  await tap(v.page, '[data-act="list"]');
  await settle(v.page, 500);
  check('G2 a lot in the list whose every part is markup shows them all as words', (flat(await v.page.locator('lair-stock dialog[open]').textContent()).match(/<script>window\.__xss=1<\/script>/g) || []).length >= 5, flat(await v.page.locator('lair-stock dialog[open]').textContent()));
  await safe(v.page, 'the list');
  errorsOf(v.page, 'G');
  await v.ctx.close();
}

/* ============ H. What the separate review found ============ */
if (wanted('H')) {
  const slowLookups = (app, ms) => {
    const handle = app.handle.bind(app);
    app.handle = async (route) => {
      if (/\/stock\/product$/.test(new URL(route.request().url()).pathname)) await new Promise((r) => setTimeout(r, ms));
      return handle(route);
    };
    return app;
  };

  // 1. Undo while the lot's scan is still being looked up: the lot must not go once the look-up comes back
  let lair = slowLookups(lairApp(), 2500);
  let v = await visit({ shop: true, section: 'live', lair });
  await place(v.page);
  await scan(v.page, TICKET);
  await settle(v.page, 200);
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 300);
  await tap(v.page, '[data-act="undo"]');
  check('H1 (Undo tapped while the scan was still being looked up: the lot is back on the list)', (await lines(v.page)).length === 1 && !offCalls(lair).length, await lines(v.page));
  await settle(v.page, 6000);
  check('H1 a lot taken back while its scan was being looked up is never sent', !offCalls(lair).length && lair.state.things[4005].variant.stock === 9, offCalls(lair).map((c) => [c.status, c.body.lines]));
  check('H1 and the list still has it, to send again', (await lines(v.page)).length === 1 && (await lines(v.page))[0].title === 'Event Ticket', await lines(v.page));
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 700);
  check('H1 tapped again, it goes once', offCalls(lair).filter((c) => c.status === 200).length === 1 && lair.state.things[4005].variant.stock === 8, offCalls(lair).map((c) => c.status));
  errorsOf(v.page, 'H1');
  await v.ctx.close();

  // 2. A lot whose answer never came, a day on: the Lair says it may already be off the count
  lair = lairApp();
  v = await visit({ shop: true, section: 'live', lair });
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page);
  lair.state.stale = true;
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 600);
  await tap(v.page, '[data-act="held"]');
  let sheet = flat(await v.page.locator('lair-stock dialog[open]').textContent());
  check('H2 a lot that may already be off the count shows the Lair\'s words', sheet.includes('That lot may already be off the count. Check it in Shopify, then start a new one.'), sheet);
  check('H2 and never says nothing has come off', !sheet.includes('Nothing in it has come off yet.'), sheet);
  const ways = (await v.page.locator('lair-stock dialog[open] .so-sheet__actions button').allTextContents()).map(flat);
  check('H2 the two ways out say what each means', JSON.stringify(ways) === JSON.stringify(["It's off the count: forget this lot", "It isn't: put it back on the list"]), ways);
  await shot(v.page, 'h2-may-be-off');
  await axe(v.page, 'the may-be-off sheet', 'lair-stock dialog[open]');
  await tap(v.page, '[data-act="held-drop"]');
  check('H2 forgetting it leaves nothing on the list and nothing waiting', (await lines(v.page)).length === 0 && !(await banner(v.page)).length, [await lines(v.page), await banner(v.page)]);
  await v.ctx.close();

  // 3. Two tabs of the page on one phone, both with a lot that hasn't gone: taken back in one, it must not go from the other
  lair = lairApp();
  lair.state.signal = 'down';
  const a = await visit({ shop: true, section: 'live', lair });
  await place(a.page, 'Oddity Alley');
  await scan(a.page, TICKET);
  await settle(a.page, 400);
  await tap(a.page, '[data-act="sold"]');
  await settle(a.page, 300);
  const b = await visit({ shop: true, section: 'live', lair, context: a.ctx }); // the second tab reads the lot off the phone
  await a.page.bringToFront();
  await settle(a.page, 12500); // (the toast has gone: the list is the way to take it back)
  await tap(a.page, '[data-act="list"]');
  const waitingBack = a.page.locator('lair-stock dialog[open] [data-act="unsend"]').first();
  check('H3 (the first tab lists the lot as still on the phone)', (await waitingBack.count()) === 1);
  await waitingBack.click();
  await waitingBack.click();
  await settle(a.page, 400);
  lair.state.signal = 'up';
  await online(a.page);
  await online(b.page);
  await b.page.bringToFront();
  await settle(b.page, 2500);
  check('H3 a lot taken back in one tab is not sent by the other', !offCalls(lair).some((c) => c.status === 200) && lair.state.things[4005].variant.stock === 9, lair.state.calls.filter((c) => /stock\/(off|undo)$/.test(c.name)).map((c) => [c.name, c.status, c.got]));
  check('H3 and neither tab still shows it waiting', !(await banner(b.page)).some((x) => x.includes('waiting')) && !(await banner(a.page)).some((x) => x.includes('waiting')), [await banner(a.page), await banner(b.page)]);
  await a.ctx.close();

  // 4. A page that isn't allowed to send (the lab logged out; a login that ran out) with a lot left on the phone by the live page
  const leftOver = (id) => `(() => { try { localStorage.setItem('dg-stock-off-v1', JSON.stringify({ queue: [{ id: '${id}', event: '', outcome: 'sold', reason: null, note: null, at: Date.now(), lines: [{ code: '${CATAN}', variantId: '4001', title: 'Catan', qty: 1, stock: 5 }], status: 'waiting', tries: 0, tried: false, nextAt: 0, error: null }] })); } catch (e) {} })();`;
  for (const [label, opts, app] of [
    ['the lab with nobody logged in', { shop: false, section: 'live', customer: null }, lairApp({ who: 'nobody' })],
    ['the lab with a login that has run out', { shop: false, section: 'live', customer: STAFF }, Object.assign(lairApp(), { expire: true })],
  ]) {
    if (app.expire) app.state.expired = true;
    m.globalSettings.lair_mode = 'demo';
    m.mockState.customer = opts.customer;
    m.mockState.sectionSettings = { 'lair-stock': { stock: opts.section } };
    const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
    await ctx.addInitScript(READER);
    await ctx.addInitScript(leftOver(`so-${'a'.repeat(32)}`));
    await ctx.route(`**${API}/**`, (route) => app.handle(route));
    const page = watch(await ctx.newPage());
    await page.goto(`${BASE}/pages/stock`, { waitUntil: 'domcontentloaded', timeout: 60000 }); // (asked over and over, the page never goes quiet)
    await settle(page, 3500);
    const asked = app.state.calls.filter((c) => /stock\/(off|undo)$/.test(c.name)).length;
    // (it waits 3 seconds before a second go, then longer each time: two in this while is that, hundreds was the bug)
    check(`H4 ${label}: a lot left on the phone is not asked for over and over`, asked <= 2, asked);
    check(`H4 ${label}: and nothing came off`, app.state.things[4001].variant.stock === 5);
    await ctx.close();
  }

  // 7. (the second review, of the fixes) A lot taken back before its answer came, and by the time the phone has signal
  //    the Lair can only say it may already be off the count: that isn't "nothing came off", so it isn't forgotten
  lair = lairApp();
  v = await visit({ shop: true, section: 'live', lair });
  await place(v.page);
  await scan(v.page, CATAN);
  await settle(v.page);
  lair.state.signal = 'down';
  await tap(v.page, '[data-act="sold"]');
  await settle(v.page, 400);
  await tap(v.page, '[data-act="undo"]');
  await settle(v.page, 300);
  await v.page.locator('[data-act="less"]').click(); // (the lines came back: off the list again, so only the old lot is in play)
  lair.state.stale = true;
  lair.state.signal = 'up';
  await online(v.page);
  await settle(v.page, 900);
  check('H7 a lot taken back that the Lair says may already be off the count is not quietly forgotten', (await banner(v.page)).includes('1 lot needs a look'), [await banner(v.page), lair.state.calls.slice(-3).map((c) => [c.name, c.status])]);
  await tap(v.page, '[data-act="held"]');
  sheet = flat(await v.page.locator('lair-stock dialog[open]').textContent());
  check('H7 its sheet says it could not be taken back, with the Lair\'s words, and never that nothing came off', sheet.includes("This lot couldn't be taken back.") && sheet.includes('That lot may already be off the count. Check it in Shopify') && !sheet.includes('Nothing in it has come off yet.'), sheet);
  check('H7 and the only way out is to say you have seen it', JSON.stringify((await v.page.locator('lair-stock dialog[open] .so-sheet__actions button').allTextContents()).map(flat)) === JSON.stringify(['Got it']));
  await v.ctx.close();

  // 6. 99 of one thing, then its other barcode: the page says it's full, and nothing is quietly lost
  lair = lairApp();
  lair.state.things[4001].variant.stock = 500;
  v = await visit({ shop: true, section: 'live', lair });
  await place(v.page);
  await v.page.evaluate((code) => { for (let i = 0; i < 99; i += 1) document.querySelector('lair-stock').onCode(code); }, CATAN);
  await settle(v.page, 500);
  await scan(v.page, CATAN_CASE);
  await settle(v.page, 500);
  const full = await lines(v.page);
  check('H6 the hundredth of one thing, scanned by its other barcode, is not quietly dropped: the page says 99 is the most', full.length === 1 && full[0].qty === 99 && (await said(v.page)) === "That's 99, the most of one thing in a lot.", [full, await said(v.page)]);
  await v.ctx.close();
}

m.mockState.sectionSettings = null;
m.mockState.customer = null;
await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screenshots: ${process.env.OUT}`);
process.exit(fail ? 1 : 0);
