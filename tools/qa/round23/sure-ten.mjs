// Round 23 (31 Oct 2026), the sure $10, on the theme mock (demo mode). Mo (30 Oct 2026): "make the rolling of the d20
// have an option for someone to either get $10 store credit or roll a d20 and get store credit equal to the number they
// rolled. Make it a choice for the user if they feel their luck is bad."
// My Lair's loyalty card says it's their pick and has Take $10 instead under Roll your d20; taking it rolls nothing (the
// die rests, both buttons grey out until the answer's back) and prints a coupon with a $10 coin; rolling is as before;
// the Wallet lists the $10 as played safe; a $10 Shopify couldn't add waits at the counter; a Lair app from before round
// 23 (no loyalty.sure) offers no $10; a failed $10 puts focus back on its button; the staff page's prizes to sort say
// it was taken instead of rolling. No sideways scroll, no console errors, axe. Small phone, phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4988] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round23/sure-ten.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round23-sure-ten');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF, today } = lib;
const PORT = Number(process.env.PORT || 4988);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
const PICK_LINE = 'Roll for $1 to $20, or play it safe with $10.';
const HOW_LINE = 'Feeling unlucky? Skip the roll and take a sure $10 instead. Your pick, every roll.';

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('19:00'));
  return ctx;
}
async function open(page, where, who = RUBY) {
  await go(page, BASE, where, who);
  // the card is drawn once GET /me is back, on Home or not (the Wallet hides it)
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page);
}

/** The roll box as a member sees it: what's ready, the pick line, the buttons (with where they sit), the result coupon */
const box = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const section = document.querySelector('.ml-roll');
  const ready = document.querySelector('[data-rolls-ready]');
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const button = (sel) => {
    const el = document.querySelector(`[data-roll-slots] ${sel}`);
    if (!el) return null;
    const r = rect(el);
    const s = rect(section);
    return {
      label: f(el.querySelector('[data-roll-label]')?.textContent), text: f(el.textContent), cls: el.className, disabled: el.disabled,
      top: r.top, bottom: r.bottom, height: r.height, inside: r.left >= s.left - 0.5 && r.right <= s.right + 0.5,
    };
  };
  const result = document.querySelector('[data-roll-slots] [data-result]');
  const die = document.querySelector('[data-die]');
  return {
    ready: ready && !ready.hidden ? f(ready.textContent) : '',
    pick: f(document.querySelector('.ml-roll__pick')?.textContent),
    roll: button('[data-roll]'),
    sure: button('[data-roll-sure]'),
    none: f(document.querySelector('[data-roll-slots] .ml-roll__none')?.textContent),
    error: f(document.querySelector('[data-roll-slots] .ml-roll__error')?.textContent),
    result: result ? {
      look: [...result.classList].find((c) => c.startsWith('ml-prize--')) || '',
      label: result.getAttribute('aria-label'),
      face: f(result.querySelector('.ml-face')?.textContent),
      coin: Boolean(result.querySelector('.ml-face--coin')),
      round: result.querySelector('.ml-face') ? getComputedStyle(result.querySelector('.ml-face')).clipPath : '',
      kicker: f(result.querySelector('.ml-prize__kicker')?.textContent),
      title: f(result.querySelector('.ml-prize__title')?.textContent),
      text: f(result.querySelector('.ml-prize__text, .ml-prize__stamp')?.textContent),
      focused: document.activeElement === result,
    } : null,
    die: { number: f(die?.querySelector('.d20__number')?.textContent), cls: die ? [...die.classList].filter((c) => c.startsWith('is-')) : [] },
    how: [...document.querySelectorAll('.ml-odds__list li')].map((li) => f(li.textContent)),
  };
});
/** The Wallet's rolls, newest first */
const wallet = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('[data-prizes] .ml-prizes__row')].map((li) => ({
    face: f(li.querySelector('.ml-face')?.textContent), coin: Boolean(li.querySelector('.ml-face--coin')),
    what: f(li.querySelector('.ml-prizes__what')?.childNodes[0]?.textContent), meta: f(li.querySelector('.ml-prizes__meta')?.textContent),
    badge: f(li.querySelector('.badge')?.textContent), claim: f(li.querySelector('.ml-prizes__claim')?.textContent),
  }));
});
/** Every POST /roll the page sends, and (with a delay) time to look at the page while one is on its way */
const spy = (page, delay = 0) => page.evaluate((ms) => {
  const be = window.Lair.store.backend;
  window.__rolls = [];
  if (!be.__realRoll) be.__realRoll = be.roll.bind(be);
  be.roll = async (input) => {
    window.__rolls.push(JSON.parse(JSON.stringify(input)));
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return be.__realRoll(input);
  };
}, delay);
const sent = (page) => page.evaluate(() => window.__rolls || []);
const rollsReady = (page) => page.evaluate(async () => (await window.Lair.store.backend.me()).loyalty.rolls.available);
/** Give the demo member n more rolls (as staff would) */
const giveRolls = (page, n) => page.evaluate((k) => {
  const be = window.Lair.store.backend;
  be.editLoyalty(String(be.cfg.customer.id), (x) => { x.staff = (Number(x.staff) || 0) + k; });
  be.commit();
}, n);

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  await open(page, '/pages/my-lair');
  await giveRolls(page, 1);
  await open(page, '/pages/my-lair');
  const ready = await rollsReady(page);
  let b = await box(page);
  check(`${tag} rolls ready, then the pick in words: "${PICK_LINE}"`, ready >= 2 && b.ready.startsWith(`${ready} rolls ready`) && b.pick === PICK_LINE, b);
  check(`${tag} Roll your d20 (gold, with how many) and, under it, Take $10 instead (the quieter button)`,
    b.roll && b.sure && b.roll.label === 'Roll your d20' && b.roll.text.endsWith(`${ready} ready`) && /button--gold/.test(b.roll.cls)
      && b.sure.label === 'Take $10 instead' && /button--ghost/.test(b.sure.cls) && b.sure.top >= b.roll.bottom - 0.5, { roll: b.roll, sure: b.sure });
  check(`${tag} both buttons are easy to tap (44px or more) and fit the card`, b.roll.height >= 44 && b.sure.height >= 44 && b.roll.inside && b.sure.inside, { roll: b.roll, sure: b.sure });
  check(`${tag} How it works says it's their pick`, b.how.includes(HOW_LINE) && b.how.indexOf(HOW_LINE) === b.how.findIndex((x) => /^Whatever you roll/.test(x)) + 1, b.how);
  await page.locator('.ml-roll').first().scrollIntoViewIfNeeded();
  await shot(page, `${size}-1-pick`, '.ml-roll');
  await axe(page, `${tag} the loyalty card with the pick`, '.ml-roll');

  // ---------- Take $10 instead: nothing rolls, both buttons wait, and the coupon prints with its coin ----------
  await spy(page, 700);
  await page.click('[data-roll-slots] [data-roll-sure]');
  await settle(page, 250);
  const during = await box(page);
  check(`${tag} while the $10 is on its way: both buttons greyed out, "Adding it…", and the die doesn't tumble`,
    during.roll.disabled && during.sure.disabled && during.sure.label === 'Adding it…' && !during.die.cls.includes('is-rolling'), during);
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 700);
  b = await box(page);
  check(`${tag} it asked the Lair for the sure $10`, JSON.stringify(await sent(page)) === JSON.stringify([{ kind: 'loyalty', pick: 'sure' }]), await sent(page));
  check(`${tag} the coupon: a round $10 coin, "You played it safe: $10 store credit is yours.", $10 store credit, on their account`,
    b.result && b.result.coin && b.result.face === '$10' && /circle/.test(b.result.round) && b.result.look === 'ml-prize--credit' && b.result.label === 'Your store credit'
      && b.result.kicker === 'You played it safe: $10 store credit is yours.' && b.result.title === '$10 store credit'
      && b.result.text === "Added to your account. It comes off at checkout while you're logged in, or at the counter." && b.result.focused, b.result);
  check(`${tag} the die rests on its 20 (no glow, nothing rolled)`, b.die.number === '20' && !b.die.cls.includes('is-win') && !b.die.cls.includes('is-crit'), b.die);
  check(`${tag} one roll fewer, and the next is still their pick: Roll your d20 (not Roll again) and Take $10 instead`,
    (await rollsReady(page)) === ready - 1 && b.ready.startsWith(`${ready - 1} roll`) && b.roll?.label === 'Roll your d20' && b.sure?.label === 'Take $10 instead' && !b.roll.disabled && !b.sure.disabled, b);
  await shot(page, `${size}-2-took-ten`, '.ml-roll');

  // ---------- rolling is as it was (?roll=14 forces the face) ----------
  await open(page, '/pages/my-lair?roll=14');
  await spy(page);
  const before = await rollsReady(page);
  await page.click('[data-roll-slots] [data-roll]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 900);
  b = await box(page);
  check(`${tag} Roll your d20 rolls it: a 14 is $14 store credit, with the d20's face`,
    b.result && !b.result.coin && b.result.face === '14' && b.result.kicker === 'You rolled a 14: $14 store credit is yours.' && b.result.label === 'Your roll'
      && (await rollsReady(page)) === before - 1 && JSON.stringify(await sent(page)) === JSON.stringify([{ kind: 'loyalty', pick: 'roll' }]), { result: b.result, sent: await sent(page) });
  if (before - 1 > 0) check(`${tag} after a roll: Roll again, and Take $10 instead still there`, b.roll?.label === 'Roll again' && b.sure?.label === 'Take $10 instead', b);
  // spend what's left, then nothing to pick
  for (let left = before - 1; left > 0; left -= 1) {
    await page.click('[data-roll-slots] [data-roll-sure]');
    await page.waitForFunction(() => !document.querySelector('[data-roll-slots] [data-roll-sure][disabled]'), null, { timeout: 10000 });
    await settle(page, 500);
  }
  b = await box(page);
  check(`${tag} no rolls left: no buttons, and it says so`, !b.roll && !b.sure && !b.pick && b.none === "That's all your rolls for now. Fill your card for the next one.", b);

  // ---------- the Wallet: the $10 has its coin and says it was played safe ----------
  await open(page, '/pages/my-lair#wallet');
  const rows = await wallet(page);
  // (the page's clock starts at 7pm again on every load, so these two can list either way round)
  const rolled = rows.find((r) => r.face === '14');
  const ten = rows.find((r) => r.coin);
  check(`${tag} the Wallet lists the roll with its face and the $10 with its coin, "Played it safe · <day>"`,
    rolled && rolled.what === '$14 store credit' && rolled.badge === 'Added' && /^Rolled 14, /.test(rolled.meta)
      && ten && ten.face === '$10' && ten.what === '$10 store credit' && /^Played it safe · \S+ \d{1,2} \S+$/.test(ten.meta) && ten.badge === 'Added', rows.slice(0, 5));
  await shot(page, `${size}-3-wallet`, '[data-prizes]');
  await axe(page, `${tag} the Wallet's stamps and rolls`, '[data-prizes]');

  // ---------- when Shopify can't add the $10, it waits at the counter ----------
  await open(page, `/pages/my-lair?roll=3&credit=pending`);
  await page.click('[data-roll-slots] [data-roll-sure]');
  await page.waitForSelector('[data-roll-slots] [data-result]', { timeout: 10000 });
  await settle(page, 600);
  b = await box(page);
  check(`${tag} a $10 that waits at the counter: the cream coupon says to show it, and when it was taken`,
    b.result && b.result.look === 'ml-prize--counter' && b.result.coin && b.result.kicker === 'You played it safe: $10 store credit is yours.'
      && /^Show this screen at the counter to claim it\. Taken at \d{1,2}(:\d{2})?[ap]m on \w+day \d{1,2} \w+\.$/.test(b.result.text), b.result);
  await shot(page, `${size}-4-counter`, '.ml-roll');

  // ---------- a $10 that didn't go through: the words, and focus back on its button ----------
  await giveRolls(page, 1);
  await open(page, '/pages/my-lair');
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.roll.bind(be);
    let once = true;
    be.roll = async (input) => {
      if (once) {
        once = false;
        const error = new Error('The Lair app is taking a breather. Try again in a moment.');
        error.status = 503;
        throw error;
      }
      return real(input);
    };
  });
  const readyBefore = await rollsReady(page);
  await page.click('[data-roll-slots] [data-roll-sure]');
  await page.waitForSelector('[data-roll-slots] .ml-roll__error', { timeout: 10000 });
  await settle(page, 400);
  b = await box(page);
  const focus = await page.evaluate(() => document.activeElement?.hasAttribute('data-roll-sure'));
  check(`${tag} a $10 that didn't go through says why, keeps the roll, and puts focus back on Take $10 instead`,
    b.error === 'The Lair app is taking a breather. Try again in a moment.' && b.sure && !b.sure.disabled && focus && (await rollsReady(page)) === readyBefore, { error: b.error, focus });

  // ---------- a Lair app from before round 23 (no loyalty.sure): no $10 on offer ----------
  await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const real = be.me.bind(be);
    be.me = async (...a) => {
      const data = await real(...a);
      if (data && data.loyalty) delete data.loyalty.sure;
      return data;
    };
    await document.querySelector('my-lair').refreshRolls();
  });
  await settle(page);
  b = await box(page);
  check(`${tag} an older Lair app: Roll your d20 only, and no pick line`, b.roll && !b.sure && !b.pick, b);

  // ---------- the staff page: a $10 to sort at the counter says it was taken instead of rolling ----------
  await go(page, BASE, '/pages/lair-staff#members', STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });
  const aroha = await page.evaluate(async () => {
    const be = window.Lair.store.backend;
    const found = (await be.members({ q: 'Aroha Ngata' })).find((x) => x.name === 'Aroha Ngata');
    const id = String(found.customerId);
    be.state.prizes = { ...(be.state.prizes || {}), [id]: [{ id: 'pz_qa_sure', kind: 'credit', amount: 1000, status: 'pending', roll: null, pick: 'sure', at: Date.now(), source: 'loyalty' }, ...((be.state.prizes || {})[id] || [])] };
    be.commit();
    return found;
  });
  await go(page, BASE, `/pages/lair-staff#members`, STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });
  await page.locator('.staff-mem-row', { hasText: 'Aroha Ngata' }).first().click();
  await page.waitForSelector('.staff-prizes', { timeout: 15000 }).catch(() => {});
  await settle(page, 600);
  const prizes = await page.evaluate(() => [...document.querySelectorAll('.staff-prize > span')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag} staff page: "$10 store credit to sort at the counter · took it instead of rolling"`, prizes.some((p) => /^\$10(\.00)? store credit to sort at the counter · took it instead of rolling · /.test(p)), { aroha: aroha?.name, prizes });

  check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} no console errors`, !page.errors.length, page.errors);
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (today ${today}; shots in ${process.env.OUT})`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
