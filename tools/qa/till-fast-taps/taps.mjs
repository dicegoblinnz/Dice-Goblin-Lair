// The till's own taps (Mo, 13 Nov 2026: "It is requiring a long press for the buttons to work can you remove that
// function make it almost instantaneous when a button is pressed to register?"). On the counter's tablet the browser's
// click after a quick touch didn't come, only after a long press, so the till recognises a tap itself from the finger's
// own events: down on a button, up without sliding, and the button is pressed there and then.
//
// On the theme mock (Practice sales), in either look, with touches sent through the debugger as a finger sends them,
// and with bare touch events that no click follows (which is the tablet's case):
//  1. Touch events alone press a button: nothing waits for the browser's click.
//  2. Once only: four quick taps are four PIN digits, one tap on + is one more, and the browser's own click for a touch
//     the till has handled is held back.
//  3. The press shows the moment the finger is down.
//  4. Not a tap: a finger that slides (a scroll), a second finger, a touch that lands while a list is rolling from a
//     flick (left to the browser), a button that's off. A list the till moved itself doesn't put the next tap off.
//  5. A button redrawn under the finger is still pressed (the sale's panel is redrawn when a price comes in).
//  6. "Staff: hold to go back" still wants its hold.
//  7. A mouse and a keyboard click as they always have; a field takes its tap (from the browser, or from the till when
//     the browser's doesn't come), by itself or by the words over it, and a tapped button puts the keyboard away.
//  8. A tick box (Use their store credit) is tapped the same way, by its words or by the box, once.
//  9. The browser's own click for a touch the till has pressed is held back anywhere on that button, and only until
//     the next touch begins; a button touched again straight after a tap keeps its pressed look.
// Usage: DG_THEME=/path/to/theme [LOOK=pieces|first] [PORT=4958] node tools/qa/till-fast-taps/taps.mjs
import fs from 'node:fs';
import path from 'node:path';
const lib = await import('../round15/lib.mjs');
const { chromium, m } = lib;
const THEME = process.env.DG_THEME;
const PORT = Number(process.env.PORT || 4958);
const LOOKS = process.env.LOOK ? [process.env.LOOK] : ['pieces', 'first'];
const TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
m.globalSettings.lair_mode = 'demo';
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/assets/')) return false;
  const type = TYPES[path.extname(url.pathname)];
  const file = path.join(THEME, 'assets', path.basename(url.pathname));
  if (!type || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(file));
  return true;
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
let pass = 0;
let fail = 0;
let look = '';
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${look}] ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 700)}`}`);
};

for (look of LOOKS) {
  m.mockState.customer = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
  m.mockState.sectionSettings = { 'lair-till': { sales: 'practice', look, quick_keys: ['session'] } };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 752 }, deviceScaleFactor: 1.5, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`http://localhost:${PORT}/pages/till`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  // every click that reaches the page, and whether the browser sent it (trusted) or the till did
  // (heard first, at the top of the page; whether it was held back is read afterwards)
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button, [data-act]');
      window.__clicks.push({ event: e, act: b ? b.dataset.act || b.dataset.hold || b.type : null });
    }, true);
  });
  const clicks = () => page.evaluate(() => window.__clicks.splice(0).map((c) => ({ trusted: c.event.isTrusted, act: c.act, stopped: c.event.defaultPrevented })));
  /** Where a button is: the one on the screen that's open */
  const at = (sel, nth = 0) => page.evaluate(([q, n]) => {
    const till = document.querySelector('lair-till');
    const over = till.querySelector('[data-r="over"]');
    const top = over && over.querySelector('.t-over') ? over : till;
    const el = [...top.querySelectorAll(q)].filter((b) => b.offsetParent)[n];
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [sel, nth]);
  /** A finger, through the debugger: down, held `ms`, perhaps slid `dx`, up */
  const finger = async (sel, { ms = 30, dx = 0, nth = 0, wait = 350 } = {}) => {
    const p = await at(sel, nth);
    if (!p) throw new Error(`no ${sel} on the screen`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, force: 0.3 }] });
    await page.waitForTimeout(ms);
    if (dx) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + dx, y: p.y, radiusX: 3, radiusY: 3, force: 0.3 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(wait);
    return p;
  };
  /** Touch events alone, as the page hears them, with no click to follow: the tablet's case */
  const bare = async (sel, { nth = 0, wait = 350, only = '' } = {}) => {
    const done = await page.evaluate(([q, n, part]) => {
      const till = document.querySelector('lair-till');
      const over = till.querySelector('[data-r="over"]');
      const top = over && over.querySelector('.t-over') ? over : till;
      const el = [...top.querySelectorAll(q)].filter((b) => b.offsetParent)[n];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const t = new Touch({ identifier: 7, target: el, clientX: x, clientY: y, radiusX: 3, radiusY: 3, force: 0.3 });
      const send = (type, touches) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches, targetTouches: touches, changedTouches: [t] }));
      window.__touched = el;
      if (part !== 'up') send('touchstart', [t]);
      if (part !== 'down') send('touchend', []);
      return { x, y };
    }, [sel, nth, only]);
    await page.waitForTimeout(wait);
    return done;
  };
  const till = () => page.evaluate(() => {
    const el = document.querySelector('lair-till');
    const s = el.s;
    const f = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    return { view: s.view, mode: s.mode, pick: s.pick || null, pin: (s.pin || '').length, quick: s.quick, lines: s.lines.map((l) => [f(l.title), l.qty]), down: [...el.querySelectorAll('.is-down')].map((b) => b.dataset.act || b.type), active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null, search: s.search || '', toast: f(el.querySelector('[data-r="toast"]')?.textContent) };
  });
  const quiet = () => page.evaluate(() => {
    const el = document.querySelector('lair-till');
    clearTimeout(el.toastTimer);
    el.s.toast = null;
    el.paintToast();
  });
  let v;
  try {
    /* 1. touch events alone */
    await bare('[data-act="staff-door"]');
    v = await till();
    let got = await clicks();
    check('touch events alone open the Staff door: no click from the browser is waited for', v.view !== 'welcome' && got.length === 1 && got[0].trusted === false && got[0].act === 'staff-door', { view: v.view, got });

    /* 2. once only */
    await finger('[data-act="pick"]');
    v = await till();
    got = await clicks();
    check('a quick touch on a name picks it, once (the browser\'s own click for that touch is held back)', Boolean(v.pick) && got.filter((c) => c.act === 'pick' && !c.stopped).length === 1, { pick: v.pick, got });
    for (const d of '1234') await finger(`[data-act="digit"][data-d="${d}"]`, { wait: 180 });
    await page.waitForTimeout(900);
    v = await till();
    if (v.view === 'newpin') {
      for (const d of '25802580') await finger(`[data-act="digit"][data-d="${d}"]`, { wait: 180 });
      await page.waitForTimeout(900);
      v = await till();
    }
    got = await clicks();
    check('four quick touches are four PIN digits and the till opens: each registered once', v.mode === 'staff' && v.view === 'till' && got.every((c) => c.act !== 'digit' || c.stopped || !c.trusted), { view: v.view, mode: v.mode, digits: got.filter((c) => c.act === 'digit').length, trusted: got.filter((c) => c.trusted && !c.stopped).length });
    await quiet();
    await finger('[data-act="quick"]');
    for (const code of ['810155276195', '31283123823']) {
      await page.evaluate((c) => document.querySelector('lair-till').onScan(c), code);
      await page.waitForTimeout(450);
    }
    await quiet();
    await clicks();
    await finger('[data-act="more"]');
    v = await till();
    got = await clicks();
    check('one quick touch on + is one more, not two', v.lines[0] && v.lines[0][1] === 2 && got.filter((c) => !c.stopped).length === 1, { lines: v.lines, got });
    check('and the browser\'s own click for that touch never comes: the till stops it at the touch', got.length === 1 && got[0].trusted === false, got);

    /* 3. the press shows the moment the finger is down */
    let p = await at('[data-act="more"]');
    const style = (sel) => page.evaluate((q) => {
      const b = [...document.querySelectorAll(q)].find((x) => x.offsetParent);
      const cs = getComputedStyle(b);
      return `${cs.filter}|${cs.transform}`;
    }, sel);
    const up = await style('[data-act="more"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, force: 0.3 }] });
    await page.waitForTimeout(16);
    v = await till();
    const down = await style('[data-act="more"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    const after = await till();
    check('the press shows the moment the finger is down, and the button acts when it lifts', v.down.length === 1 && v.down[0] === 'more' && down !== up && v.lines[0][1] === 2 && after.lines[0][1] === 3 && after.down.length === 0, { down: v.down, up, pressed: down, before: v.lines, after: after.lines, still: after.down });
    await clicks();
    // the quickest tap there is, on a button its own press draws again: the one that's there now shows it, for a moment
    const quickest = await page.evaluate(() => {
      const el = [...document.querySelectorAll('lair-till [data-act="more"]')].find((b) => b.offsetParent);
      const r = el.getBoundingClientRect();
      const t = new Touch({ identifier: 7, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, radiusX: 3, radiusY: 3 });
      const send = (type, touches) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches, targetTouches: touches, changedTouches: [t] }));
      send('touchstart', [t]);
      send('touchend', []);
      const down = [...document.querySelectorAll('lair-till .is-down')];
      return { redrawn: !el.isConnected, down: down.map((b) => b.dataset.act || b.type), there: down.every((b) => b.isConnected && b.offsetParent) };
    });
    await page.waitForTimeout(350);
    v = await till();
    check('even the quickest tap shows: the button as its own press drew it again looks pressed for a moment', quickest.redrawn && quickest.down.length === 1 && quickest.down[0] === 'more' && quickest.there && v.down.length === 0, { quickest, after: v.down });
    await clicks();

    /* 4. not a tap */
    const slid0 = (await till()).lines[0][1];
    await finger('[data-act="more"]', { dx: 40 });
    v = await till();
    check('a finger that slides isn\'t a tap: nothing is pressed', v.lines[0][1] === slid0 && v.down.length === 0, { lines: v.lines, slid0 });
    await clicks();
    p = await at('[data-act="more"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, id: 0 }] });
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, id: 0 }, { x: p.x + 200, y: p.y + 60, radiusX: 3, radiusY: 3, id: 1 }] });
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    v = await till();
    got = await clicks();
    check('a second finger calls the tap off', !got.some((c) => c.trusted === false) && v.down.length === 0, { got, lines: v.lines });
    // a second finger on another button: neither is pressed
    const two0 = (await till()).lines[0][1];
    const less = await at('[data-act="less"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, id: 0 }] });
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, radiusX: 3, radiusY: 3, id: 0 }, { x: less.x, y: less.y, radiusX: 3, radiusY: 3, id: 1 }] });
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    v = await till();
    got = await clicks();
    check('two fingers on two buttons press neither', v.lines[0][1] === two0 && got.length === 0 && v.down.length === 0, { got, lines: v.lines, two0 });
    // a finger that lifts while another is still down somewhere (off the till, where the till can't hear it land)
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('lair-till [data-act="more"]')].find((b) => b.offsetParent);
      const r = el.getBoundingClientRect();
      const mine = new Touch({ identifier: 7, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, radiusX: 3, radiusY: 3 });
      const other = new Touch({ identifier: 8, target: document.body, clientX: 5, clientY: 5, radiusX: 3, radiusY: 3 });
      const send = (type, touches) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches, targetTouches: touches.filter((t) => t === mine), changedTouches: [mine] }));
      send('touchstart', [mine]);
      send('touchend', [other]);
    });
    await page.waitForTimeout(350);
    v = await till();
    got = await clicks();
    check('a finger that lifts while another is still down isn\'t a tap', v.lines[0][1] === two0 && got.length === 0 && v.down.length === 0, { got, lines: v.lines, two0 });
    let before = (await till()).lines[0][1];
    const rolls = () => page.evaluate(() => {
      const list = document.querySelector('lair-till .t-lines') || document.querySelector('lair-till [data-r="sale"]');
      list.dispatchEvent(new Event('scroll'));
    });
    // a list the till moved itself (a button pressed, and the newest line brought into view): the next tap can come
    // straight after
    await bare('[data-act="more"]');
    await rolls();
    await bare('[data-act="more"]');
    v = await till();
    check('a list the till moved itself after a press doesn\'t put the next tap off', v.lines[0][1] === before + 2, v.lines);
    await clicks();
    // a finger flicks a list and it's still rolling: the touch that stops it is the browser's to deal with (it holds
    // its own click back), not the till's
    before = (await till()).lines[0][1];
    await finger('[data-act="more"]', { dx: 60, wait: 30 });
    await rolls();
    await bare('[data-act="more"]');
    v = await till();
    got = await clicks();
    check('a touch that lands while a list is rolling from a flick is left to the browser: the till presses nothing itself', v.lines[0][1] === before && got.filter((c) => !c.trusted).length === 0, { lines: v.lines, got });
    await page.waitForTimeout(300);
    await bare('[data-act="more"]');
    v = await till();
    check('and once the list is still, a touch presses again', v.lines[0][1] === before + 1, v.lines);
    await clicks();
    const offBefore = await till();
    await page.evaluate(() => {
      document.querySelector('lair-till [data-act="more"]').disabled = true;
    });
    await bare('[data-act="more"]', { only: 'down', wait: 120 });
    const offDown = (await till()).down;
    await bare('[data-act="more"]', { only: 'up' });
    v = await till();
    got = await clicks();
    check('a button that\'s off isn\'t pressed, and doesn\'t look pressed with a finger on it', v.lines[0][1] === offBefore.lines[0][1] && got.length === 0 && offDown.length === 0 && v.down.length === 0, { lines: v.lines, got, offDown });
    await page.evaluate(() => document.querySelector('lair-till').paintSale());

    /* 5. redrawn under the finger */
    const qty = (await till()).lines[0][1];
    await bare('[data-act="more"]', { only: 'down', wait: 30 });
    await page.evaluate(() => document.querySelector('lair-till').paintSale());
    const lifted = await page.evaluate(() => {
      // the finger lifts: its touchend goes to the button it first touched, which is out of the page now (a touch
      // keeps its first target, and an event sent to something out of the page reaches nothing above it)
      const old = window.__touched;
      const now = [...document.querySelectorAll('lair-till [data-act="more"]')].find((b) => b.offsetParent);
      const r = now.getBoundingClientRect();
      const t = new Touch({ identifier: 7, target: old, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, radiusX: 3, radiusY: 3 });
      old.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, composed: true, touches: [], targetTouches: [], changedTouches: [t] }));
      return { gone: !old.isConnected, other: old !== now };
    });
    await page.waitForTimeout(350);
    v = await till();
    check('a button redrawn under the finger is still pressed when the finger lifts', lifted.gone && lifted.other && v.lines[0][1] === qty + 1, { lifted, lines: v.lines, qty });
    await clicks();

    /* a form's own button: the dollars typed for a discount, then Use it */
    await quiet();
    await bare('[data-act="discount"]');
    await page.evaluate(() => {
      const input = document.querySelector('lair-till [data-form="discount"] input');
      input.value = '1';
    });
    await bare('[data-form="discount"] button[type="submit"]');
    const offs = await page.evaluate(() => document.querySelector('lair-till').s.lines.map((l) => l.off || 0));
    v = await till();
    check('a form\'s button is pressed the same way: a discount typed, then Use it', v.view === 'till' && offs[0] === 100, { view: v.view, offs });
    await quiet();
    await clicks();

    /* 6. hold to go back */
    await quiet();
    await finger('[data-act="customer"]');
    v = await till();
    const onCustomer = v.view === 'customer';
    await finger('[data-hold="staff"]');
    const tapped = await till();
    await finger('[data-hold="staff"]', { ms: 1100 });
    const held = await till();
    check('"Staff: hold to go back" still wants its hold: a quick touch stays, a held one goes back', onCustomer && tapped.view === 'customer' && held.view === 'till', { onCustomer, tapped: tapped.view, held: held.view });
    await clicks();

    /* 7. mouse, keyboard, fields */
    await page.waitForTimeout(800);
    p = await at('[data-act="more"]');
    const m0 = (await till()).lines[0][1];
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    v = await till();
    got = await clicks();
    check('a mouse clicks as it always has', v.lines[0][1] === m0 + 1 && got.length === 1 && got[0].trusted && !got[0].stopped, { lines: v.lines, got });
    await page.evaluate(() => [...document.querySelectorAll('lair-till [data-act="less"]')].find((b) => b.offsetParent).focus());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    v = await till();
    check('and so does the keyboard', v.lines[0][1] === m0, v.lines);
    await clicks();
    // the browser's click arriving after all, on the spot the till has just pressed: held back, once, there, for a moment
    const g0 = (await till()).lines[0][1];
    p = await bare('[data-act="more"]', { wait: 20 });
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    v = await till();
    got = await clicks();
    check('the browser\'s own click on a spot the till has just pressed is held back, so nothing is pressed twice', v.lines[0][1] === g0 + 1 && got.filter((c) => c.trusted && c.stopped).length === 1, { lines: v.lines, got });
    await page.waitForTimeout(800);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    v = await till();
    check('a moment later a click there counts again', v.lines[0][1] === g0 + 2, v.lines);
    await clicks();
    const s0 = (await till()).lines[0][1];
    await bare('[data-act="more"]', { wait: 20 });
    const other = await at('[data-act="less"]');
    await page.mouse.click(other.x, other.y);
    await page.waitForTimeout(300);
    v = await till();
    check('and a click somewhere else straight after isn\'t held back', v.lines[0][1] === s0, { lines: v.lines, s0 });
    await clicks();
    // a field takes its tap from the browser; a button tapped after puts the keyboard away
    const field = await at('.t-search input, input[type="search"], .t-input');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: field.x, y: field.y, radiusX: 3, radiusY: 3 }] });
    await page.waitForTimeout(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
    v = await till();
    const inField = v.active === 'input';
    await bare('[data-act="more"]');
    v = await till();
    check('a field still takes its touch, and a button touched after it puts the keyboard away', inField && v.active !== 'input', { inField, active: v.active });
    // and with touch events alone (no tap from the browser), the till puts the cursor in the field itself
    await clicks();
    await bare('.t-search input, input[type="search"], .t-input');
    v = await till();
    got = await clicks();
    check('touch events alone put the cursor in a field: the keyboard doesn\'t wait for the browser either', v.active === 'input' && got.length === 0, { active: v.active, got });
    // the words over a field do the same
    await bare('[data-act="more"]');
    await quiet();
    await bare('[data-act="discount"]');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await bare('label[for="t-off"]');
    const inOff = await page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
    check('and so do the words over a field', inOff === 't-off', { in: inOff });
    await bare('[data-act="back"]');
    await quiet();

    /* 8. a tick box: store credit, by its words, by the box, and with a real finger, once each */
    await page.evaluate(() => document.querySelector('lair-till').onScan('HW-GOLEM-09'));
    await page.waitForTimeout(700);
    await quiet();
    const tick = () => page.evaluate(() => {
      const el = document.querySelector('lair-till');
      const box = [...el.querySelectorAll('[data-in="credit"]')].find((b) => b.offsetParent);
      return { there: Boolean(box), box: Boolean(box && box.checked), use: Boolean(el.s.useCredit) };
    });
    const t0 = await tick();
    await clicks();
    await bare('label.t-check');
    const t1 = await tick();
    await bare('[data-in="credit"]');
    const t2 = await tick();
    await finger('label.t-check');
    const t3 = await tick();
    got = await clicks();
    check('a tick box is tapped the same way: its words, the box itself, and a real finger each tick or untick it once', t0.there && !t0.use && t1.use && t1.box && !t2.use && !t2.box && t3.use && t3.box, { t0, t1, t2, t3, got });

    /* 9. the browser's own click, again: anywhere on the button the till has just pressed, and never once the next
       touch has begun. And the pressed look, when a button is touched again straight away. (One of the check's own
       buttons, in the till: it stays where it is when it's pressed.) */
    await page.evaluate(() => {
      const el = document.querySelector('lair-till');
      const b = document.createElement('button');
      b.type = 'button';
      b.id = 'qa-wide';
      b.textContent = 'A wide button';
      b.style.cssText = 'position:absolute;left:24px;top:24px;width:240px;height:64px;z-index:2147483000';
      b.addEventListener('click', () => {
        window.__wide = (window.__wide || 0) + 1;
      });
      el.appendChild(b);
    });
    const wides = () => page.evaluate(() => window.__wide || 0);
    await page.waitForTimeout(800);
    const wide = await bare('#qa-wide', { wait: 20 });
    await page.mouse.click(wide.x + 90, wide.y);
    await page.waitForTimeout(250);
    let n = await wides();
    check('the browser\'s own click on another part of the button the till has just pressed is held back too', n === 1, { n, wide });
    await page.waitForTimeout(800);
    const w0 = await wides();
    await bare('#qa-wide', { wait: 20 });
    await finger('[data-act="more"]', { dx: 40, wait: 20 });
    await page.mouse.click(wide.x, wide.y);
    await page.waitForTimeout(250);
    n = await wides();
    check('but a click that comes once the next touch has begun is its own, and counts', n === w0 + 2, { n, w0 });
    await page.waitForTimeout(800);
    await bare('#qa-wide', { wait: 10 });
    await bare('#qa-wide', { only: 'down', wait: 160 });
    v = await till();
    check('a button touched again straight after a tap keeps its pressed look while the finger is down', v.down.length === 1, { down: v.down });
    await bare('#qa-wide', { only: 'up' });
    // a press the till takes a while to deal with: the browser's click that follows it is held back all the same
    await page.evaluate(() => {
      document.getElementById('qa-wide').addEventListener('click', () => {
        const until = performance.now() + 900;
        while (window.__slow && performance.now() < until);
      });
    });
    await page.waitForTimeout(800);
    const slow0 = await wides();
    await page.evaluate(() => {
      window.__slow = true;
    });
    await bare('#qa-wide', { wait: 20 });
    await page.mouse.click(wide.x, wide.y);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.__slow = false;
    });
    n = await wides();
    check('a press the till takes a while over has the browser\'s click held back just the same', n === slow0 + 1, { n, slow0 });
    await page.evaluate(() => document.getElementById('qa-wide').remove());
  } catch (e) {
    check('the run got to the end', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  }
  check('no errors on the page', errors.length === 0, errors);
  await ctx.close();
}
await browser.close();
server.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
