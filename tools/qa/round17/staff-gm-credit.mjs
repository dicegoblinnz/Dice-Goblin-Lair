// Round 17 (16 Oct 2026), GM credit for staff, on the theme mock: the Team tab's "GM credit for staff" (Never until the
// main account picks, Not in their hours, Always) and each person's Hours (add, save, a bad time's words, Cancel), the GM
// games tab's "Earlier this week" card for a staff GM's session in each state (Never; in their hours, with "They weren't
// working"; outside them, with "They were working"; Always) and what each button records, the GM page's words for a
// staff GM, the live backend's three calls against a stubbed Lair app, no sideways scroll and axe. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4985] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round17/staff-gm-credit.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round17-staff-gm');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4985);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const ANA = 'demo-ana-gm';

const server = await m.serve(PORT);
const browser = await chromium.launch();

/** The staff page's last toast */
const toast = (page) => page.evaluate(() => (document.querySelector('[data-live-region]')?.textContent || '').trim());
const settle = (page, ms = 350) => page.waitForTimeout(ms);
/** The demo, through its own backend: a helper (Ana) who ran a GM game yesterday 6pm to 9pm, with one paid seat ($5 fee) */
const seed = (page) => page.evaluate(async (ana) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  await be.teamAdd({ customerId: ana, name: 'Ana Ngata', email: 'ana@example.com', perms: ['sessions'] });
  const day = t.addDays(t.today(), -1);
  const start = t.at(day, 18 * 60);
  const end = t.at(day, 21 * 60);
  const id = 'gm-r17-ana';
  be.state.games = be.state.games.filter((g) => g.id !== id);
  be.state.games.push({
    id, title: 'Ana’s staff one-shot', system: 'D&D 5e', gm: 'Ana', gmCustomerId: ana, gmEmail: 'ana@example.com', blurb: 'A test session.',
    tables: ['G1'], room: 'game-room', seats: 4, start, end, taken: 1, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'one-shot',
    seriesId: null, level: 'new', age: '18+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
  });
  be.state.bookings.push({
    id: 'bk-r17-seat', ref: 'MI-OWL-7', kind: 'gm-seat', gameId: id, tables: ['G1'], start, end, people: 1, players: [{ name: 'Mia', character: '' }],
    name: 'Mia', email: 'mia@example.com', status: 'done', pay: 'day', paid: true, amount: 1500, paidAmount: 1500, activity: 'rpg', extras: [],
  });
  be.commit();
  await store.refresh();
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][t.weekday(day)];
  return { id, day, weekday };
}, ANA);
/** Back to "not credited yet", with the setting and Ana's hours as given */
const reset = (page, mode, hours) => page.evaluate(async ([ana, modeTo, hoursTo]) => {
  const { store } = window.Lair;
  const be = store.backend;
  const game = be.state.games.find((g) => g.id === 'gm-r17-ana');
  game.credited = null;
  if (be.state.gmCredits) delete be.state.gmCredits[game.id];
  be.commit();
  await be.teamGmCredit(modeTo);
  await be.teamHours(ana, hoursTo);
  await store.refresh();
}, [ANA, mode, hours]);
/** The GM games tab's card for Ana's session: its buttons, words and badge */
const card = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('.staff-gm-card')].find((a) => a.textContent.includes('Ana’s staff one-shot'));
  if (!el) return null;
  const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
  return {
    buttons: [...el.querySelectorAll('[data-act="credit"]')].map((b) => ({ text: f(b.textContent), value: b.dataset.value || '', gold: b.classList.contains('button--gold') })),
    notes: [...el.querySelectorAll('.cluster .small')].map((s) => f(s.textContent)),
    badge: f(el.querySelector('.cluster .badge')?.textContent),
  };
});
const clickCredit = async (page, value = '') => {
  await page.click(`.staff-gm-card [data-act="credit"]${value ? `[data-value="${value}"]` : ':not([data-value])'}`);
  await settle(page, 500);
};

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(browser, size);
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  const { day, weekday } = await seed(page);
  const DAY = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }[weekday];
  const SHORT = DAY.slice(0, 3);

  /* ---------- the Team tab ---------- */
  await page.click('[data-tab="team"]');
  await page.waitForSelector('[data-team-gm-form]', { timeout: 15000 });
  const gm = await page.evaluate(() => {
    const f = (x) => String(x || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('.st-gm');
    return {
      h: f(sec.querySelector('h4').textContent),
      lede: f(sec.querySelector('p').textContent),
      choices: [...sec.querySelectorAll('label.check')].map((l) => ({ value: l.querySelector('input').value, checked: l.querySelector('input').checked, text: f(l.textContent) })),
    };
  });
  check(`${tag} Team: GM credit for staff, Never ticked until it's picked, with each choice's words`,
    gm.h === 'GM credit for staff' && /players still pay its GM fee/.test(gm.lede)
    && JSON.stringify(gm.choices.map((c) => [c.value, c.checked])) === JSON.stringify([['never', true], ['shifts', false], ['earn', false]])
    && gm.choices[0].text === "Never Staff don't earn GM credit for the sessions they run: they're paid to be there."
    && gm.choices[1].text === 'Not in their hours No GM credit for a session in their hours, even partly. Outside their hours they earn it like any GM.'
    && gm.choices[2].text === 'Always Staff earn GM credit like any GM.', gm);
  const people = await page.evaluate(() => [...document.querySelectorAll('.st-person')].map((p) => ({
    id: p.dataset.teamPerson || '', hours: String(p.querySelector('.st-person__hours')?.textContent || '').replace(/\s+/g, ' ').trim(), button: Boolean(p.querySelector('[data-team-hours]')),
  })));
  check(`${tag} Team: the main account and the helper each say No hours set, with an Hours button`, people.length >= 2 && people.every((p) => p.hours === 'No hours set' && p.button) && people.some((p) => p.id === ANA), people);

  // Hours: add one time, save it
  await page.click(`[data-team-person="${ANA}"] [data-team-hours]`);
  await page.waitForSelector(`[data-team-hours-form="${ANA}"]`);
  const opened = await page.evaluate((ana) => {
    const form = document.querySelector(`[data-team-hours-form="${ana}"]`);
    return { h: form.querySelector('h4').textContent.trim(), none: !form.querySelector('[data-hours-none]').hidden, rows: form.querySelectorAll('[data-hours-row]').length, focus: document.activeElement === form.querySelector('[data-hours-add]') };
  }, ANA);
  check(`${tag} Hours: Ana’s hours opens with No times yet, focus on Add a time`, opened.h === 'Ana’s hours' && opened.none && opened.rows === 0 && opened.focus, opened);
  await page.click(`[data-team-hours-form="${ANA}"] [data-hours-add]`);
  const row = `[data-team-hours-form="${ANA}"] [data-hours-row]`;
  await page.selectOption(`${row} select[name="day"]`, weekday);
  await page.fill(`${row} input[name="from"]`, '16:00');
  await page.fill(`${row} input[name="to"]`, '00:00');
  await shot(page, `${size}-team-hours-form`, `[data-team-hours-form="${ANA}"]`);
  await axe(page, `${tag} Ana’s hours form`, `[data-team-hours-form="${ANA}"]`);
  check(`${tag} Hours form: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await page.click(`[data-team-hours-form="${ANA}"] [type="submit"]`);
  await settle(page, 600);
  const savedHours = await page.evaluate((ana) => String(document.querySelector(`[data-team-person="${ana}"] .st-person__hours`)?.textContent || '').replace(/\s+/g, ' ').trim(), ANA);
  check(`${tag} Hours: saved, the toast and Ana’s card say ${SHORT} 4pm–midnight`, savedHours === `Hours ${SHORT} 4pm–midnight` && (await toast(page)) === `Saved. Ana’s hours: ${SHORT} 4pm–midnight`, { savedHours, toast: await toast(page) });

  // a time that ends before it starts: the Lair app's words, nothing saved
  await page.click(`[data-team-person="${ANA}"] [data-team-hours]`);
  await page.waitForSelector(`[data-team-hours-form="${ANA}"] [data-hours-row]`);
  await page.fill(`${row} input[name="from"]`, '20:00');
  await page.fill(`${row} input[name="to"]`, '19:00');
  await page.click(`[data-team-hours-form="${ANA}"] [type="submit"]`);
  await settle(page, 400);
  const bad = await page.evaluate((ana) => document.querySelector(`[data-team-hours-form="${ana}"] [data-form-error]`)?.textContent.trim(), ANA);
  check(`${tag} Hours: a time that ends before it starts says so, word for word`, bad === `A time on ${DAY} ends before it starts. Use 24:00 for midnight.`, bad);
  await page.click(`[data-team-hours-form="${ANA}"] [data-team-cancel]`);
  await settle(page);
  const kept = await page.evaluate((ana) => String(document.querySelector(`[data-team-person="${ana}"] .st-person__hours`)?.textContent || '').replace(/\s+/g, ' ').trim(), ANA);
  check(`${tag} Hours: Cancel keeps what was saved`, kept === `Hours ${SHORT} 4pm–midnight`, kept);

  // the setting: Not in their hours
  await page.check('[data-team-gm-form] input[value="shifts"]');
  await page.click('[data-team-gm-form] [type="submit"]');
  await settle(page, 600);
  const picked = await page.evaluate(() => ({
    checked: document.querySelector('[data-team-gm-form] input[name="mode"]:checked')?.value,
    changed: [...document.querySelectorAll('.st-gm .small.muted')].map((p) => p.textContent.trim()).find((x) => /^Last changed/.test(x)) || '',
    note: document.querySelector('.st-gm__note')?.textContent.trim() || '',
  }));
  check(`${tag} Team: Not in their hours saved (toast, still ticked, Last changed …), no "nobody has hours" note now Ana has hours`,
    picked.checked === 'shifts' && /^Last changed /.test(picked.changed) && !picked.note && (await toast(page)) === 'Saved. GM credit for staff: Not in their hours.', { picked, toast: await toast(page) });
  await shot(page, `${size}-team-tab`, 'staff-team');
  await axe(page, `${tag} Team tab with GM credit for staff`, 'staff-team');
  check(`${tag} Team tab: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- the GM games tab: Earlier this week ---------- */
  await page.click('[data-tab="games"]');
  await page.waitForSelector('.staff-gm-card', { timeout: 15000 });
  let c = await card(page);
  check(`${tag} GM games: in Ana’s hours: Session done: no GM credit, why, and They weren’t working: credit $5`,
    c && JSON.stringify(c.buttons) === JSON.stringify([{ text: 'Session done: no GM credit', value: '', gold: true }, { text: 'They weren’t working: credit $5', value: 'off', gold: false }])
    && c.notes[0] === `No GM credit: it’s in Ana’s hours (${SHORT} 4pm–midnight). 1 paying player × $5 stays with the shop.`, c);
  await shot(page, `${size}-gm-card-in-hours`, '.staff-gm-card:has([data-act="credit"])');
  await axe(page, `${tag} GM games tab, a staff GM’s session`, '[data-panel="games"]');
  check(`${tag} GM games tab: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  await clickCredit(page);
  c = await card(page);
  const recorded = await page.evaluate(() => window.Lair.store.backend.state.gmCredits['gm-r17-ana']);
  check(`${tag} GM games: Session done records it with no credit: the toast, the card's Done, no GM credit and why`,
    (await toast(page)) === `No GM credit: it was in Ana's hours, ${SHORT} 4pm–midnight (it would have been $5.00 for 1 paying player).`
    && c.badge === 'Done, no GM credit' && c.notes[0] === `No GM credit: it was in Ana's hours, ${SHORT} 4pm–midnight (it would have been $5.00 for 1 paying player).`
    && c.buttons.length === 0 && recorded.status === 'staff' && recorded.amount === 0, { toast: await toast(page), c, recorded });
  await shot(page, `${size}-gm-card-done`, '.staff-gm-card:has(.badge)');

  // outside her hours: credit as usual, or mark that she was working
  await reset(page, 'shifts', [{ day: weekday, from: '10:00', to: '14:00' }]);
  await settle(page);
  c = await card(page);
  check(`${tag} GM games: outside Ana’s hours: Session done: credit GM $5, why, and They were working: no credit`,
    c && JSON.stringify(c.buttons) === JSON.stringify([{ text: 'Session done: credit GM $5', value: '', gold: true }, { text: 'They were working: no credit', value: 'on', gold: false }])
    && c.notes[0] === `1 paying player × $5. It’s outside Ana’s hours (${SHORT} 10am–2pm), so they earn it like any GM.`, c);
  await clickCredit(page, 'on');
  c = await card(page);
  check(`${tag} GM games: They were working records no credit, marked on the staff page`,
    c.badge === 'Done, no GM credit' && c.notes[0] === 'No GM credit: Ana was working then, as marked on the staff page (it would have been $5.00 for 1 paying player).', c);

  // in her hours, but she wasn't working: credited as usual
  await reset(page, 'shifts', [{ day: weekday, from: '16:00', to: '24:00' }]);
  await settle(page);
  await clickCredit(page, 'off');
  c = await card(page);
  check(`${tag} GM games: They weren’t working credits it as usual`,
    (await toast(page)) === 'Added $5 store credit for 1 paying player' && c.badge === 'GM credited for 1 player', { toast: await toast(page), c });

  // Never: no button to mark anything
  await reset(page, 'never', []);
  await settle(page);
  c = await card(page);
  check(`${tag} GM games: Never: Session done: no GM credit, because Ana is staff, and nothing to mark`,
    c && JSON.stringify(c.buttons) === JSON.stringify([{ text: 'Session done: no GM credit', value: '', gold: true }])
    && c.notes[0] === 'No GM credit: Ana is staff, and staff don’t earn GM credit. 1 paying player × $5 stays with the shop.', c);

  // Always: as before round 17
  await reset(page, 'earn', []);
  await settle(page);
  c = await card(page);
  check(`${tag} GM games: Always: the usual Session done: credit GM $5, nothing about staff`,
    c && JSON.stringify(c.buttons) === JSON.stringify([{ text: 'Session done: credit GM $5', value: '', gold: true }]) && c.notes.join(' ') === '1 paying player × $5', c);
  check(`${tag} staff page: no script errors`, !page.errors.length, page.errors.slice(0, 5));

  /* ---------- the GM page's words for a staff GM ---------- */
  await go(page, BASE, '/pages/gm-games', STAFF);
  await page.waitForSelector('gm-board', { state: 'attached', timeout: 20000 });
  await settle(page, 600);
  const words = await page.evaluate(async ([key]) => {
    const { store } = window.Lair;
    const t = store.time;
    const board = document.querySelector('gm-board');
    const s = { start: t.at(key, 18 * 60), end: t.at(key, 21 * 60) };
    const say = (staffGm) => {
      board.staffGm = staffGm;
      return board.youGet(500, s);
    };
    await store.backend.teamGmCredit('never');
    const me = await store.backend.me();
    const weekdayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][t.weekday(key)];
    return {
      me: me.customer.staffGmCredit,
      never: say({ mode: 'never', hours: [] }),
      inHours: say({ mode: 'shifts', hours: [{ day: weekdayKey, from: '17:00', to: '19:00' }] }),
      outside: say({ mode: 'shifts', hours: [{ day: weekdayKey, from: '10:00', to: '18:00' }] }),
      notStaff: say(null),
      covering: board.youGet(0, s),
    };
  }, [day]);
  check(`${tag} GM page: a staff GM's "You get" follows the setting (never, in their hours, outside them), and GET /me sends it`,
    words.never === 'No GM credit: you’re on the Dice Goblin team. Players still pay the GM fee.'
    && words.inHours === 'No GM credit for this session: it’s in your hours. Sessions outside them earn it.'
    && words.outside === '$5 store credit per player, after each session outside your hours'
    && words.notStaff === '$5 store credit per player, after each session'
    && words.covering === 'No store credit. Thanks for covering your players!'
    && words.me && words.me.mode === 'never', words);
  check(`${tag} GM page: no script errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();

  /* ---------- live: the three calls, against a stubbed Lair app ---------- */
  m.globalSettings.lair_mode = 'live';
  const calls = [];
  m.mockState.before = async (req, res, url) => {
    if (!url.pathname.startsWith('/apps/liar/')) return false;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const route = url.pathname.replace('/apps/liar', '');
    if (req.method === 'POST') calls.push({ path: route, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (route === '/team/gm-credit') res.end(JSON.stringify({ gmCredit: { mode: 'shifts', choices: [], changedBy: null, changedAt: 1 } }));
    else if (/^\/team\/[^/]+\/hours$/.test(route)) res.end(JSON.stringify({ customerId: '9101', hours: [], hoursText: '' }));
    else if (/^\/games\/[^/]+\/credit$/.test(route)) res.end(JSON.stringify({ players: 1, amount: 0, status: 'staff', note: 'x', withheld: 500 }));
    else res.end(JSON.stringify({}));
    return true;
  };
  const lctx = await context(browser, size);
  const lp = watch(await lctx.newPage());
  await go(lp, BASE, '/pages/my-lair', STAFF);
  await lp.waitForFunction(() => window.Lair && window.Lair.store && window.Lair.store.backend, null, { timeout: 20000 });
  await lp.evaluate(async () => {
    const be = window.Lair.store.backend;
    await be.teamGmCredit('shifts');
    await be.teamHours('9101', [{ day: 'sat', from: '10:00', to: '18:00' }]);
    await be.creditGm('gm_123', { onShift: true });
    await be.creditGm('gm_456');
  });
  check(`${tag} live: POST /team/gm-credit { mode }, /team/:id/hours { hours } and /games/:id/credit with and without onShift`,
    JSON.stringify(calls.filter((x) => /gm-credit|hours|credit/.test(x.path))) === JSON.stringify([
      { path: '/team/gm-credit', body: { mode: 'shifts' } },
      { path: '/team/9101/hours', body: { hours: [{ day: 'sat', from: '10:00', to: '18:00' }] } },
      { path: '/games/gm_123/credit', body: { onShift: true } },
      { path: '/games/gm_456/credit', body: {} },
    ]), calls);
  await lctx.close();
  m.mockState.before = null;
  m.globalSettings.lair_mode = 'demo';
}

const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed. Screens in ${process.env.OUT}`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
