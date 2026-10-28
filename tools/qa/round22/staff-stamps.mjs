// Round 22 (28 Oct 2026), stamps staff add by hand, on the theme mock (demo mode): a member's page on the staff page
// has Add stamps under their loyalty card (1 to 10, a note for staff), the stamps land on the card straight away, and a
// list under the card says what each was, who added it and when, with Undo. A retry after a lost answer adds nothing
// more, ten stamps fill a card (a roll in My Lair), and a Lair app from before round 22 (no `stamps` on the member)
// shows no Add stamps. The member card at check-in has their card too, with Add a stamp and Undo that stamp. No sideways
// scroll, no console errors, axe. Phone and desktop. The page's clock is today at 1pm.
// Usage: DG_THEME=/path/to/theme [PORT=4987] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round22/staff-stamps.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round22-staff-stamps');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4987);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const NOTE = 'TCG night, paid in packs';

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 500) => page.waitForTimeout(ms);

/** The loyalty card on their page: stamps, cards filled, rolls ready, and the list of stamps added by hand */
const card = (page) => page.evaluate(() => {
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const root = document.querySelector('[data-person-loyalty]');
  if (!root) return null;
  const facts = Object.fromEntries([...root.querySelectorAll('.staff-person__facts > div')].map((d) => [f(d.querySelector('dt')?.textContent), f(d.querySelector('dd')?.textContent)]));
  const count = f(root.querySelector('.staff-loyalty__count')?.textContent);
  return {
    count,
    stamps: Number((count.match(/^(\d+) of 10/) || [])[1]),
    dots: root.querySelectorAll('.staff-loyalty__dot.is-on').length,
    cards: Number(facts['Cards filled']),
    rolls: Number(facts['Rolls ready']),
    heading: f(root.querySelector('.staff-loyalty__added-h')?.textContent),
    items: [...root.querySelectorAll('.staff-loyalty__item')].map((li) => ({
      what: f(li.querySelector('.staff-loyalty__what')?.textContent),
      meta: f(li.querySelector('p.muted')?.textContent),
      undone: li.classList.contains('is-undone'),
      back: f(li.querySelector('p:not(.muted)')?.textContent),
      undo: li.querySelector('[data-stamp-undo]') ? { label: li.querySelector('[data-stamp-undo]').getAttribute('aria-label'), height: li.querySelector('[data-stamp-undo]').getBoundingClientRect().height } : null,
      fits: li.getBoundingClientRect().right <= root.getBoundingClientRect().right + 0.5,
    })),
  };
});
const form = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-stamps-form]');
  if (!el) return null;
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  const error = el.querySelector('[data-form-error]');
  return {
    hidden: el.hidden,
    label: f(el.querySelector('.field__label')?.textContent),
    hint: f(el.querySelector('.small.muted')?.textContent),
    count: el.count.value,
    note: el.note.value,
    error: error && !error.hidden ? f(error.textContent) : '',
    button: f(el.querySelector('[type="submit"]')?.textContent),
    steppers: [...el.querySelectorAll('[data-seats-step]')].map((b) => b.getAttribute('aria-label')),
    key: el.dataset.key || '',
  };
});
const toast = async (page) => flat(await page.locator('.toast').last().innerText().catch(() => ''));
const submit = async (page) => {
  await page.click('[data-stamps-form] button[type="submit"]');
  await settle(page, 700);
};

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(browser, size, '13:00');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff#members', STAFF);
  await page.waitForSelector('.staff-mem-row', { timeout: 20000 });

  // ---------- the check-in card: a member code brings their card, Add a stamp, Undo that stamp (Aroha) ----------
  const aroha = await page.evaluate(async () => (await window.Lair.store.backend.members({ q: 'Aroha Ngata' })).find((x) => x.name === 'Aroha Ngata'));
  await page.fill('#checkin-code', aroha.code);
  await page.click('.checkin__go');
  await page.waitForSelector('.checkin-card--member .checkin-card__loyalty', { timeout: 15000 });
  await settle(page);
  const ci = () => page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const el = document.querySelector('.checkin-card--member .checkin-card__loyalty');
    const count = f(el?.querySelector('.staff-loyalty__count')?.textContent);
    return {
      label: el?.getAttribute('aria-label') || '',
      title: f(el?.querySelector('.checkin-pass__title')?.textContent),
      count, stamps: Number((count.match(/^(\d+) of 10/) || [])[1]),
      dots: el ? el.querySelectorAll('.staff-loyalty__dot.is-on').length : -1,
      note: f(el?.querySelector('.small.muted')?.textContent),
      add: f(el?.querySelector('[data-checkin-stamp]')?.textContent),
      undo: f(el?.querySelector('[data-checkin-stamp-undo]')?.textContent),
    };
  });
  const k0 = await ci();
  check(`${tag} check-in: Aroha's card on her member card, with Add a stamp and no Undo yet`,
    k0.label === 'Aroha’s loyalty card' && /^Loyalty card \d+$/.test(k0.title) && Number.isFinite(k0.stamps) && k0.dots === k0.stamps
    && k0.note === 'Checking in and paying stamp their card by themselves. Add one for a session the Lair app doesn’t know about.'
    && k0.add === 'Add a stamp' && !k0.undo, k0);
  await page.click('[data-checkin-stamp]');
  await settle(page, 700);
  const k1 = await ci();
  const t1k = await toast(page);
  const wantK = (k0.stamps + 1) % 10;
  check(`${tag} check-in: Add a stamp puts one on (${k0.stamps} to ${wantK} of 10), says so, and offers Undo that stamp`,
    k1.stamps === wantK && k1.dots === wantK && (wantK ? t1k === `Stamp added: Aroha is on ${wantK} of 10.` : /card is full/.test(t1k)) && k1.undo === 'Undo that stamp', { k1, t1k });
  await shot(page, `${size}-checkin-card`, '.checkin-card--member');
  await page.evaluate(() => document.querySelector('.checkin-card__loyalty')?.scrollIntoView({ block: 'center' }));
  await axe(page, `${tag} the check-in card with the loyalty card`, '.checkin-card--member');
  check(`${tag} check-in card: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click('[data-checkin-stamp-undo]');
  await settle(page, 700);
  const k2 = await ci();
  const t2k = await toast(page);
  check(`${tag} check-in: Undo that stamp takes it back (${k0.stamps} of 10) and goes`, k2.stamps === k0.stamps && !k2.undo && t2k === 'Took that stamp back off Aroha’s card.', { k2, t2k });
  await page.click('[data-checkin-clear]').catch(() => {});
  await settle(page, 300);

  await page.locator('.staff-mem-row', { hasText: 'Sam Tautahi' }).click();
  await page.waitForSelector('[data-person-loyalty] .staff-loyalty__count', { timeout: 15000 });
  await settle(page);
  const id = await page.evaluate(() => document.querySelector('[data-stamps-form]')?.dataset.id || '');

  // ---------- the form ----------
  const f0 = await form(page);
  check(`${tag} Add stamps shows under Sam's card, starting at 1, with when to use it`,
    f0 && !f0.hidden && f0.label === 'Add stamps' && f0.count === '1' && f0.button === 'Add stamps'
    && f0.hint === 'For a session the Lair app doesn’t know about: check-ins and payments stamp their card by themselves. 1 to 10.'
    && JSON.stringify(f0.steppers) === JSON.stringify(['One stamp fewer', 'One stamp more']), f0);
  const order = await page.evaluate(() => {
    const s = document.querySelector('.staff-loyalty');
    return [...s.children].map((c) => (c.matches('[data-person-loyalty]') ? 'card' : c.matches('[data-stamps-form]') ? 'stamps' : c.matches('[data-rolls-form]') ? 'rolls' : c.matches('[data-since-form]') ? 'since' : c.tagName.toLowerCase()));
  });
  check(`${tag} the order: the card, Add stamps, Give rolls, Customer since`, JSON.stringify(order.filter((x) => x !== 'h4')) === JSON.stringify(['card', 'stamps', 'rolls', 'since']), order);
  const c0 = await card(page);
  check(`${tag} no list of added stamps before any are added`, c0 && !c0.heading && !c0.items.length, c0);

  // ---------- two stamps with a note ----------
  await page.click('[data-stamps-form] [data-seats-step="1"]');
  await page.fill('[data-stamps-form] [name="note"]', NOTE);
  await submit(page);
  const c1 = await card(page);
  const want1 = (c0.stamps + 2) % 10;
  const filled1 = c0.stamps + 2 >= 10 ? 1 : 0;
  const t1 = await toast(page);
  check(`${tag} 2 stamps: the card goes from ${c0.stamps} to ${want1} of 10`, c1.stamps === want1 && c1.dots === want1 && c1.cards === c0.cards + filled1, { c0: c0.count, c1: c1.count });
  check(`${tag} 2 stamps: the toast says so`, t1 === `Added 2 stamps to Sam’s card. Sam is on ${want1} of 10.`, t1);
  const row1 = c1.items[0];
  check(`${tag} 2 stamps: the list under the card says what, who, when and the note, with Undo`,
    c1.heading === 'Added by hand or rung up at the counter' && c1.items.length === 1 && row1.what === '+2 A stamp from Gobgob, 2 stamps'
    && row1.meta === `Added by Mo · Today, 1pm · ${NOTE}` && row1.undo && row1.undo.label === 'Take back 2 stamps: A stamp from Gobgob' && !row1.undone, row1);
  check(`${tag} Undo is a 44px tap target, and the row fits the card`, row1.undo && row1.undo.height >= 44 && row1.fits, row1.undo);
  const f1 = await form(page);
  check(`${tag} the form is ready for the next: back to 1, no note, no key`, f1.count === '1' && f1.note === '' && !f1.key && !f1.error, f1);
  const appNow = await page.evaluate(async (who) => (await window.Lair.store.backend.members({ q: who }))[0]?.loyalty, id);
  check(`${tag} the Lair app (demo) has them on the card too`, appNow && appNow.stamps === want1, appNow);

  // ---------- out of range ----------
  await page.fill('[data-stamps-form] [name="count"]', '11');
  await submit(page);
  const f2 = await form(page);
  const c2 = await card(page);
  check(`${tag} 11 stamps: refused, with why, and nothing added`, f2.error === 'Add between 1 and 10 stamps.' && c2.stamps === c1.stamps && c2.items.length === 1, { error: f2.error, stamps: c2.stamps });

  // ---------- a lost answer, then a second tap: one stamp, not two ----------
  await page.fill('[data-stamps-form] [name="count"]', '1');
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.memberStamps.bind(be);
    let lost = false;
    be.memberStamps = async (...a) => {
      const answer = await real(...a);
      if (!lost) {
        lost = true;
        throw new Error('The Lair app didn’t answer. Try again.');
      }
      return answer;
    };
  });
  await submit(page);
  const t3a = await toast(page);
  const f3 = await form(page);
  await submit(page);
  const t3b = await toast(page);
  const c3 = await card(page);
  const want3 = (c1.stamps + 1) % 10;
  check(`${tag} a lost answer: the toast says so and the form keeps its key`, /didn’t answer/.test(t3a) && Boolean(f3.key), { t3a, key: f3.key });
  check(`${tag} the second tap adds nothing more: ${want3} of 10, and it says they were on already`,
    c3.stamps === want3 && c3.items.length === 2 && t3b === `Those stamps were on Sam’s card already. Sam is on ${want3} of 10.`, { stamps: c3.stamps, items: c3.items.length, t3b });

  // ---------- Undo ----------
  const twoRow = c3.items.findIndex((x) => x.what.startsWith('+2'));
  await page.locator('.staff-loyalty__item').nth(twoRow).locator('[data-stamp-undo]').click();
  await settle(page, 700);
  const c4 = await card(page);
  const t4 = await toast(page);
  const undone = c4.items.find((x) => x.what.startsWith('+2'));
  const want4 = (want3 - 2 + 10) % 10;
  check(`${tag} Undo takes the 2 back: ${want4} of 10, and says so`, c4.stamps === want4 && t4 === 'Took 2 stamps back off Sam’s card.', { stamps: c4.stamps, t4 });
  check(`${tag} the taken back row stays, struck through, with who and when, and no Undo`,
    undone && undone.undone && undone.back === 'Taken back by Mo, Today, 1pm' && !undone.undo, undone);
  // twice (a second tab, a slow tap): nothing more taken back
  const sid = await page.evaluate((who) => {
    const be = window.Lair.store.backend;
    return be.stampLedgerOf(be.staffMember(who)).find((s) => s.count === 2)?.id;
  }, id);
  const again = await page.evaluate(async ([who, s]) => window.Lair.store.backend.memberStampUndo(who, s), [id, sid]);
  check(`${tag} Undo twice: already, and the card stays at ${want4}`, again && again.already === true && again.member.loyalty.stamps === want4, again && { already: again.already, stamps: again.member?.loyalty?.stamps });
  await shot(page, `${size}-ledger`, '.staff-loyalty');
  // (the element screenshot scrolls the section to the top, under the site's sticky header, which axe would count as
  // covering the Undo buttons: put the list in the middle of the screen first)
  await page.evaluate(() => document.querySelector('.staff-loyalty__added')?.scrollIntoView({ block: 'center' }));
  await axe(page, `${tag} the loyalty card with Add stamps and its list`, '.staff-loyalty');

  // ---------- ten stamps fill a card ----------
  const before10 = await card(page);
  await page.fill('[data-stamps-form] [name="count"]', '10');
  await submit(page);
  const c5 = await card(page);
  check(`${tag} 10 stamps fill a card: a card filled, a roll ready, the same ${before10.stamps} of 10 on the next`,
    c5.stamps === before10.stamps && c5.cards === before10.cards + 1 && c5.rolls === before10.rolls + 1, { before: before10, after: { stamps: c5.stamps, cards: c5.cards, rolls: c5.rolls } });
  check(`${tag} the member page: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await shot(page, `${size}-member`, null, true);

  // ---------- the members list keeps up ----------
  await page.click('[data-members-back]');
  await page.waitForSelector('.staff-mem-row', { timeout: 15000 });
  await settle(page, 800);
  const cell = flat(await page.locator('.staff-mem-row', { hasText: 'Sam Tautahi' }).locator('.staff-mem-row__cell--card .staff-mem-row__v').innerText().catch(() => ''));
  check(`${tag} the members list shows Sam's card: ${c5.stamps}/10`, cell.startsWith(`${c5.stamps}/10`), cell);

  // ---------- a Lair app from before round 22: no stamps on the member, so no Add stamps ----------
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.memberDetail.bind(be);
    be.memberDetail = async (...a) => {
      const answer = await real(...a);
      if (answer && answer.member) delete answer.member.stamps;
      return answer;
    };
    const el = document.querySelector('lair-staff');
    for (const x of Object.values(el.members.people)) delete x.stamps;
  });
  await page.locator('.staff-mem-row', { hasText: 'Sam Tautahi' }).click();
  await page.waitForSelector('[data-person-loyalty] .staff-loyalty__count', { timeout: 15000 });
  await settle(page);
  const old = await form(page);
  const oldCard = await card(page);
  check(`${tag} an older Lair app: no Add stamps and no list, the card as before`, old && old.hidden && oldCard && !oldCard.heading && Number.isFinite(oldCard.stamps), { hidden: old && old.hidden, heading: oldCard && oldCard.heading });

  check(`${tag} no console errors`, !page.errors.length, page.errors.slice(0, 4).join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
