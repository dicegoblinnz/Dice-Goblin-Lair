// Round 30 (6 Nov 2026, contract v30-credit), on the theme mock (demo mode). Mo: "I want the clients to have the ability
// to gift their store credit to another. Also have the ability to add the gm store credit after every client is paid
// inside a game ... But also the store credit are not updating properly."
//  1. My Lair's Wallet as Ruby: the balance (the demo's $25) on the card and Home's summary; Send some to a friend:
//     Find them (no code, a code nobody has, her own code, a friend's in lower case: "Sending to Sam T."), how much
//     (words, too little, more than she has), a note full of markup and quotes, the question, Change something, Yes,
//     the Lair app's words, the new balance everywhere, the gift at the top of the list as plain text; a lost answer
//     tried again sends nothing twice; a code changed after Find them asks again.
//  2. A loyalty roll's store credit shows on the card at once (the sure $10).
//  3. Games I run as Dan: a session that's started (Kai paid: "Paid · $5 to you"; Mia: Pays at the counter), one that
//     hasn't (Kai paid: "Paid · $5 on its way"), the line about his $5 as each player pays, and none for a $0 fee.
//  4. The TTRPG page and Run a game say the GM's fee comes as each player pays.
//  5. The staff page: a gift Shopify didn't confirm, on the sender's member page: what to look for, three outcomes,
//     a question first (Back keeps it), then Yes: marked, and the buttons go.
// No sideways scroll, no console errors and axe at each. 320, 390 and 1280 wide.
// Usage: DG_THEME=/path/to/theme [PORT=4993] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round30-credit/credit.mjs [small|phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round30-credit');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, watch, go, clockAt, RUBY, STAFF } = lib;
const PORT = Number(process.env.PORT || 4993);
const BASE = `http://localhost:${PORT}`;
const VIEWPORTS = { small: { width: 320, height: 640 }, phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } };
const sizes = process.argv[2] ? [process.argv[2]] : ['small', 'phone', 'desktop'];
const DAN = { id: 7310, first_name: 'Dan', last_name: 'Kerr', name: 'Dan Kerr', email: 'dan@example.com', phone: '', tags: ['gm'], orders_count: 0, orders: [], store_credit_account: { balance: 0 } };
const XSS = `<img src=x onerror="window.__xss=1"> "quoted" <script>window.__xss=2</script>`;

/** axe on a part of the page with the sticky site header and My Lair's bar unstuck: where they sit over a button
    depends on how far the page is scrolled, which axe would count against the button's size */
async function axeFree(page, label, sel) {
  const unstick = await page.addStyleTag({ content: '[id^="shopify-section-"]:has(> .site-header), my-lair .ml-bar { position: static !important; }' });
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
  await axe(page, label, sel);
  await unstick.evaluate((el) => el.remove());
}
const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 400) => page.waitForTimeout(ms);

async function context(size) {
  const phone = size !== 'desktop';
  const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
  await ctx.addInitScript(clockAt('19:30'));
  return ctx;
}
async function myLair(page, customer, where = '/pages/my-lair#wallet') {
  await go(page, BASE, where, customer);
  await page.waitForSelector('[data-stamp-count] strong', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
}
const wallet = (page) => page.evaluate(() => {
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const q = (s) => document.querySelector(s);
  const shown = (el) => Boolean(el) && !el.hidden && !el.closest('[hidden]');
  return {
    amount: f(q('[data-credit-amount]')?.textContent), has: shown(q('[data-credit-has]')), none: shown(q('[data-credit-none]')),
    sum: f(q('[data-credit-sum]')?.textContent), send: shown(q('[data-send]')), open: Boolean(q('[data-send]')?.open),
    who: shown(q('[data-send-who]')) ? f(q('[data-send-who]').textContent) : '', more: shown(q('[data-send-more]')),
    left: f(q('[data-send-left]')?.textContent), button: f(q('[data-send-submit]')?.textContent),
    ask: shown(q('[data-send-sure]')) ? f(q('[data-send-sure]').textContent) : '', go: shown(q('[data-send-go]')),
    message: shown(q('[data-send-message]')) ? f(q('[data-send-message]').textContent) : '', ok: q('[data-send-message]')?.classList.contains('form-message--success'),
    rows: [...document.querySelectorAll('.ml-sends__row')].map((r) => f(r.textContent)),
    imgs: document.querySelectorAll('.ml-sends img, [data-send-sure] img').length, xss: window.__xss || 0,
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.getAttribute('data-send-submit') !== null && 'submit' || document.activeElement.className) : '',
  };
});
const say = async (page) => (await wallet(page)).message;

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(size);
  const page = watch(await ctx.newPage());
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* fresh demo */ } });

  /* ---------- 1. the Wallet ---------- */
  await myLair(page, RUBY);
  const w0 = await wallet(page);
  check(`${tag} the Wallet shows the demo's store credit ($25.00), and Home's summary ($25)`, w0.amount === '$25.00' && w0.has && !w0.none && w0.sum === '$25', w0);
  check(`${tag} Send some to a friend shows, closed; a gift from a friend is in the list`, w0.send && !w0.open && w0.rows.length === 1 && /^From Sam T\./.test(w0.rows[0]) && /\+\$5$/.test(w0.rows[0]), w0);
  await shot(page, `${size}-1-wallet`, '#ml-credit');
  await page.click('.ml-send__open');
  await settle(page, 250);
  await page.click('[data-send-find]');
  await settle(page, 200);
  let w = await wallet(page);
  check(`${tag} Find them with no code: what to type, and the code box`, w.message === "Type your friend's member code first." && w.focus === 'ml-send-code', w);
  await page.fill('#ml-send-code', 'ZZ-NOBODY-99');
  await page.press('#ml-send-code', 'Enter');
  await settle(page);
  check(`${tag} a code nobody has (Enter finds them): the Lair app's words`, (await say(page)) === "There's no member with that code. Check it with your friend.", await wallet(page));
  const own = await page.evaluate(() => window.Lair.store.backend.memberFor(window.Lair.store.cfg.customer).code);
  await page.fill('#ml-send-code', own);
  await page.click('[data-send-find]');
  await settle(page);
  check(`${tag} her own code: the Lair app's words`, (await say(page)) === "That's your own member code. Pop in your friend's instead.", await wallet(page));
  const friend = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const me = String(window.Lair.store.cfg.customer.id);
    const m = be.staffMembers().find((x) => String(x.customerId) !== me && x.code && x.name === 'Sam Tautahi');
    return { code: m.code, name: m.name };
  });
  await page.fill('#ml-send-code', friend.code.toLowerCase());
  await page.click('[data-send-find]');
  await settle(page);
  w = await wallet(page);
  check(`${tag} a friend's code (lower case): "Sending to Sam T.", how much and a note, focus on how much`, w.who.startsWith('Sending to Sam T.') && w.more && w.focus === 'ml-send-amount' && w.left === 'Up to $25: all your store credit.' && w.button === 'Send to Sam T.', w);
  await shot(page, `${size}-2-found`, '#ml-credit');
  for (const [typed, want] of [['ten', 'Type how much, like 10 or 7.50.'], ['0.50', 'Send $1 or more.'], ['30', 'You have $25 of store credit, so you can send $25 at most.']]) {
    await page.fill('#ml-send-amount', typed);
    await page.click('[data-send-submit]');
    await settle(page, 200);
    w = await wallet(page);
    check(`${tag} how much "${typed}": ${want}`, w.message === want && !w.ask && w.focus === 'ml-send-amount', w);
  }
  await page.fill('#ml-send-amount', '7.50');
  await page.fill('#ml-send-note', XSS);
  w = await wallet(page);
  check(`${tag} the button says how much and to whom`, w.button === 'Send $7.50 to Sam T.', w);
  await page.click('[data-send-submit]');
  await settle(page, 250);
  w = await wallet(page);
  check(`${tag} Send asks first: how much, to whom, that it comes off now, and the note as text`, w.ask.startsWith('Send $7.50 to Sam T.? It comes off your store credit straight away.') && w.ask.includes('Your note:') && w.ask.includes('<img src=x') && !w.go && w.imgs === 0 && w.focus === 'ml-send-q' && w.amount === '$25.00', w);
  await shot(page, `${size}-3-ask`, '#ml-credit');
  await axeFree(page, `${tag} the store credit card, asking`, '#ml-credit');
  await page.click('[data-send-back]');
  await settle(page, 200);
  w = await wallet(page);
  check(`${tag} Change something: the question goes, nothing's sent, focus back on Send`, !w.ask && w.go && w.amount === '$25.00' && w.focus === 'submit', w);
  // typing while the question shows takes it away
  await page.click('[data-send-submit]');
  await settle(page, 200);
  await page.fill('#ml-send-amount', '7.5');
  w = await wallet(page);
  check(`${tag} changing how much while it asks takes the question away`, !w.ask && w.go, w);
  await page.click('[data-send-submit]');
  await settle(page, 200);
  await page.click('[data-send-yes]');
  await settle(page, 700);
  w = await wallet(page);
  check(`${tag} Yes: the Lair app's words, focus on them, the balance everywhere ($17.50), the form cleared`,
    w.message === "Sent! $7.50 is on Sam's account now." && w.ok && w.focus.includes('form-message') && w.amount === '$17.50' && w.sum === '$17.50' && !w.more && !w.who, w);
  check(`${tag} the gift tops the list, its note as plain text (no tags run)`, /^To Sam T\./.test(w.rows[0]) && w.rows[0].includes('<img src=x onerror=') && /−\$7\.50$/.test(w.rows[0]) && w.imgs === 0 && !w.xss, w.rows);
  check(`${tag} what's left today follows: up to $17.50 (all her store credit)`, w.left === 'Up to $17.50: all your store credit.', w);
  await shot(page, `${size}-4-sent`, '#ml-credit');
  await axeFree(page, `${tag} the store credit card, sent`, '#ml-credit');
  check(`${tag} no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  // a lost answer: the gift went, the answer didn't come back. Trying again gets the same gift back: sent once. The
  // Lair app's answer to the repeat has no balance when Shopify didn't say one: the page takes the gift off itself
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.sendCreditGift.bind(be);
    let lost = false;
    be.sendCreditGift = async (input) => {
      window.__keys = [...(window.__keys || []), input.key];
      const answer = await real(input);
      if (!lost) {
        lost = true;
        throw new TypeError('Failed to fetch');
      }
      return { ...answer, balance: null };
    };
  });
  await page.fill('#ml-send-code', friend.code);
  await page.click('[data-send-find]');
  await settle(page);
  await page.fill('#ml-send-amount', '2');
  await page.click('[data-send-submit]');
  await settle(page, 200);
  await page.click('[data-send-yes]');
  await settle(page, 500);
  w = await wallet(page);
  check(`${tag} a lost answer: says so (never twice), keeps the form, and the question goes`, w.message === "Gobgob couldn't reach the Lair just now. Try again: it's never sent twice." && w.more && !w.ask && w.amount === '$17.50', w);
  await page.click('[data-send-submit]');
  await settle(page, 200);
  await page.click('[data-send-yes]');
  await settle(page, 600);
  w = await wallet(page);
  const keys = await page.evaluate(() => window.__keys);
  const demo = await page.evaluate(() => window.Lair.store.backend.state.creditGifts.filter((g) => g.amount === 200).length);
  check(`${tag} trying again sends the same key: one $2 gift, $15.50 left (no balance in the answer), and it says the gift had gone`,
    keys.length === 2 && keys[0] === keys[1] && demo === 1 && w.amount === '$15.50' && w.sum === '$15.50' && /^To Sam T\./.test(w.rows[0]) && /−\$2$/.test(w.rows[0])
    && w.message === 'Your $2 gift to Sam T. had already gone through. It’s on their account now.', { keys, demo, w });
  // a code changed after Find them asks again
  await page.fill('#ml-send-code', friend.code);
  await page.click('[data-send-find]');
  await settle(page);
  await page.fill('#ml-send-code', `${friend.code}X`);
  w = await wallet(page);
  check(`${tag} changing the code after Find them hides who and how much until it's found again`, !w.who && !w.more, w);

  /* ---------- 2. a roll's store credit shows at once ---------- */
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const c = window.Lair.store.cfg.customer;
    be.editLoyalty(String(c.id), (L) => { L.staff = (L.staff || 0) + 2; });
    be.commit();
  }).catch(() => {});
  await myLair(page, RUBY, '/pages/my-lair#home');
  const before = (await wallet(page)).amount;
  const sure = await page.$('[data-roll-slots] [data-roll-sure]');
  if (sure) {
    await sure.click();
    await settle(page, 1500);
    const after = await wallet(page);
    const cents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);
    check(`${tag} the sure $10: the Wallet's store credit goes up by $10 at once (${before} to ${after.amount}), and Home's summary`, cents(after.amount) === cents(before) + 1000 && cents(after.sum) === cents(before) + 1000, { before, after });
    // an answer without the balance (Shopify didn't say it): the prize is added to what the page shows
    await page.evaluate(() => {
      const be = window.Lair.store.backend;
      const real = be.roll.bind(be);
      be.roll = async (input) => {
        const answer = await real(input);
        const { balance, ...rest } = answer;
        return rest;
      };
    });
    const again = await page.$('[data-roll-slots] [data-roll-sure]');
    if (again) {
      await again.click();
      await settle(page, 1500);
      const third = await wallet(page);
      check(`${tag} a roll's answer without the balance: the $10 is added to what shows (${after.amount} to ${third.amount})`, cents(third.amount) === cents(after.amount) + 1000 && cents(third.sum) === cents(after.amount) + 1000, { after, third });
    } else check(`${tag} a second roll to take as the sure $10`, false, 'no Take $10 instead button');
  } else check(`${tag} a roll to take as the sure $10`, false, 'no Take $10 instead button');
  check(`${tag} My Lair: no console errors`, page.errors.length === 0, page.errors);
  await page.close();

  /* ---------- 3. Games I run ---------- */
  const gm = watch(await ctx.newPage());
  await go(gm, BASE, '/pages/gm-games', DAN);
  await gm.waitForFunction(() => Boolean(window.Lair && window.Lair.store && window.Lair.store.backend && window.Lair.store.backend.state), null, { timeout: 20000 });
  await gm.evaluate(async (dan) => {
    const { store } = window.Lair;
    const be = store.backend;
    const now = Date.now();
    const game = (id, title, start, gmFee) => ({
      id, title, system: 'D&D 5e', gm: 'Dan', gmCustomerId: dan, gmEmail: 'dan@example.com', blurb: "Dan's one-shot.", tables: ['G3'], room: 'gaming-room', seats: 4,
      start, end: start + 4 * 3_600_000, taken: 2, status: 'open', credited: null, gmFee, seatPrice: 1000 + gmFee, schedule: 'one-shot', seriesId: null, level: 'some',
      age: '13+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
    });
    const seat = (g, name, paid) => ({
      id: `bk-r30-${g.id}-${name.toLowerCase()}`, ref: `R30-${g.id.slice(-4).toUpperCase()}-${name.toUpperCase()}`, kind: 'gm-seat', gameId: g.id, tables: ['G3'], start: g.start, end: g.end,
      people: 1, players: [{ name, character: '' }], name, email: `${name.toLowerCase()}@example.com`, phone: '', notes: '', status: 'confirmed', pay: 'day', paid,
      paidAmount: paid ? g.seatPrice : 0, refund: null, amount: g.seatPrice, activity: 'rpg', extras: [], customerId: `demo-r30-${name.toLowerCase()}`, createdAt: now,
    });
    const ids = ['gm-r30-now', 'gm-r30-later', 'gm-r30-free'];
    be.state.games = be.state.games.filter((g) => !ids.includes(g.id));
    be.state.bookings = be.state.bookings.filter((b) => !ids.includes(b.gameId));
    const started = game(ids[0], 'Citadel of Credit', now - 3_600_000, 500);
    const later = game(ids[1], 'Tomb of Credit', now + 26 * 3_600_000, 500);
    const free = game(ids[2], 'Dan covers it', now + 50 * 3_600_000, 0);
    be.state.games.push(started, later, free);
    be.state.bookings.push(seat(started, 'Kai', true), seat(started, 'Mia', false), seat(later, 'Kai', true), seat(free, 'Kai', true));
    be.commit();
    await store.refresh();
  }, String(DAN.id));
  await myLair(gm, DAN, '/pages/my-lair#bookings');
  await gm.waitForSelector('[data-panel="games"] .ml-game', { timeout: 15000 });
  await settle(gm, 400);
  const cards = await gm.evaluate(() => [...document.querySelectorAll('[data-panel="games"] .ml-game')].map((a) => ({
    title: String(a.querySelector('.ml-game__title')?.textContent || '').trim(),
    players: [...a.querySelectorAll('.ml-roster li')].map((li) => [...li.children].map((c) => String(c.textContent || '').replace(/\s+/g, ' ').trim()).join(' ')),
    credit: String(a.querySelector('.ml-game__credit')?.textContent || '').replace(/\s+/g, ' ').trim(),
  })));
  const card = (title) => cards.find((c) => c.title === title) || { players: [], credit: '' };
  const LINE = 'You get $5 store credit as each player pays. Players count once they’re on your table, so get friends to book a seat here, or ask staff to add them before they pay.';
  check(`${tag} Games I run, a session that's started: Kai "Paid · $5 to you", Mia "Pays at the counter", and the line`,
    card('Citadel of Credit').players.join(' | ') === 'Kai Paid · $5 to you | Mia Pays at the counter' && card('Citadel of Credit').credit === LINE, cards);
  check(`${tag} one that hasn't started: Kai "Paid · $5 on its way"`, card('Tomb of Credit').players.join(' | ') === 'Kai Paid · $5 on its way' && card('Tomb of Credit').credit === LINE, cards);
  check(`${tag} a $0 GM fee: just Paid, and no line`, card('Dan covers it').players.join(' | ') === 'Kai Paid' && !card('Dan covers it').credit, cards);
  await shot(gm, `${size}-5-games`, '[data-panel="games"] .ml-game');
  await axeFree(gm, `${tag} Games I run`, '[data-panel="games"]');
  check(`${tag} Games I run: no sideways scroll`, (await overflowX(gm)) <= 0, await overflowX(gm));

  /* ---------- 4. the TTRPG page ---------- */
  await go(gm, BASE, '/pages/gm-games', DAN);
  await gm.waitForSelector('.gm-perks__list', { timeout: 20000 }).catch(() => {});
  const perks = await gm.evaluate(() => String(document.querySelector('.gm-perks__list')?.textContent || '').replace(/\s+/g, ' '));
  check(`${tag} the TTRPG page: the GM fee lands as each player pays`, perks.includes('It lands in your store credit as each player pays.') && !/after each session/.test(perks), perks);
  check(`${tag} the GM's pages: no console errors`, gm.errors.length === 0, gm.errors);
  await gm.close();

  /* ---------- 5. the staff page: a gift Shopify didn't confirm ---------- */
  const st = watch(await ctx.newPage());
  await go(st, BASE, '/pages/lair-staff#members', STAFF);
  await st.waitForSelector('.staff-mem-row', { timeout: 20000 });
  const waiting = await st.evaluate(() => {
    const be = window.Lair.store.backend;
    const g = be.giftsDemo().find((x) => x.status === 'check');
    const m = be.staffMembers().find((x) => String(x.customerId) === String(g.fromId));
    return { from: m.name, to: be.giftNameDemo(g.toId), id: g.id };
  });
  await st.locator('.staff-mem-row', { hasText: waiting.from }).first().click();
  await st.waitForSelector('[data-credit-history] .st-log', { timeout: 15000 });
  await settle(st, 500);
  const row = () => st.evaluate(() => {
    const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const li = document.querySelector('[data-credit-history] .st-log__item--check');
    return li ? {
      text: f(li.querySelector('.st-log__what')?.textContent), look: f(li.querySelector('.st-gift-check > p')?.textContent),
      buttons: [...li.querySelectorAll('button')].map((b) => f(b.textContent)), question: f(li.querySelector('[data-gift-q]')?.textContent),
      first: li === document.querySelector('[data-credit-history] .st-log__item'),
      focus: document.activeElement?.getAttribute('data-outcome') || document.activeElement?.getAttribute('data-gift-q') !== null && 'question' || '',
    } : null;
  });
  const fromFirst = waiting.from.split(' ')[0];
  const toFirst = waiting.to.split(' ')[0];
  let r = await row();
  check(`${tag} staff: the gift Shopify didn't confirm is first, says so, what to look for, and three outcomes`,
    r && r.first && r.text.startsWith(`−$15 · Gift to ${waiting.to}: Your seat on Friday`) && r.text.endsWith('Shopify didn’t confirm it')
    && r.look === `It came off ${fromFirst}’s store credit, but Shopify didn’t confirm it reached ${toFirst}. Look at ${toFirst}’s store credit in Shopify admin: if it’s not there, add it there first, then say where it is.`
    && r.buttons.join(' | ') === `${toFirst} has it | Back on ${fromFirst}’s | Nothing came off`, r);
  await st.locator('[data-gift-settle][data-outcome="sent"]').click();
  await settle(st, 250);
  r = await row();
  check(`${tag} staff: a tap asks first`, r && r.question === `Mark it as on ${toFirst}’s store credit? Gobgob emails ${toFirst} and ${fromFirst} to say so.` && r.buttons.join(' | ') === 'Yes, mark it | Back' && r.focus === 'question', r);
  await axeFree(st, `${tag} staff: the store credit section, asking`, '.st-credit');
  await st.click('[data-gift-no]');
  await settle(st, 250);
  r = await row();
  check(`${tag} staff: Back keeps it waiting, focus back on the outcome`, r && r.buttons.length === 3 && r.focus === 'sent', r);
  await st.locator('[data-gift-settle][data-outcome="sent"]').click();
  await settle(st, 250);
  await st.click('[data-gift-yes]');
  await settle(st, 800);
  r = await row();
  const said = await st.evaluate(() => String(document.querySelector('[data-credit-history] .st-gift-said')?.textContent || '').trim());
  const state = await st.evaluate((id) => window.Lair.store.backend.giftsDemo().find((g) => g.id === id).status, waiting.id);
  check(`${tag} staff: Yes marks it sent: said, no more buttons`, !r && said === 'Marked as sent. Gobgob has emailed them both.' && state === 'sent', { r, said, state });
  await shot(st, `${size}-6-staff`, '.st-credit');
  check(`${tag} staff: no sideways scroll`, (await overflowX(st)) <= 0, await overflowX(st));
  check(`${tag} staff: no console errors`, st.errors.length === 0, st.errors);
  await ctx.close();
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed (screenshots in ${process.env.OUT})`);
await browser.close();
server.close?.();
process.exit(fail ? 1 : 0);
