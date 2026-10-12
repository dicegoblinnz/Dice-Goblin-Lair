// Round 15 checks for My Lair and the staff page, demo mode on the theme mock.
// Usage: DG_THEME=/path/to/theme [PORT=4982] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round15/mylair-staff.mjs [phone|desktop]
// Ruby (pay each visit) has a table more than 24 hours away and one inside, an owed no-show, a seat, a sign-up more than
// 24 hours away and one inside, an owed sign-up, and the demo's own examples (a weekly game, a split bill today...).
import { chromium, m, context, watch, go, shot, axe, check, totals, flat, overflowX, RUBY, STAFF } from './lib.mjs';
import { SEED } from './seed.mjs';

const PORT = Number(process.env.PORT || 4982);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const server = await m.serve(PORT);
const browser = await chromium.launch();

const meData = (page) => page.evaluate(() => document.querySelector('my-lair').me);
const waitMe = (page) => page.waitForSelector('[data-coming]:not([aria-busy])', { state: 'attached', timeout: 20000 }).then(() => page.waitForTimeout(500));

for (const size of sizes) {
  const tag = size;
  const ctx = await context(browser, size, '13:00');
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/my-lair', RUBY);
  await page.evaluate(() => localStorage.clear());
  await go(page, BASE, '/pages/my-lair', RUBY);
  await waitMe(page);
  const ids = await page.evaluate(SEED);
  check(`${tag}: the scenario seeded (far and soon tables, no-show, seat, sign-ups)`, ids.far && ids.soonTable && ids.noshow && ids.seat && ids.farJoin && ids.soonJoin && ids.owedJoin, ids);

  /* ---------- My Lair: Bookings ---------- */
  await go(page, BASE, '/pages/my-lair#bookings', RUBY);
  await waitMe(page);
  const me = await meData(page);
  const byId = (list, id) => (me[list] || []).find((x) => x.id === id) || {};
  const R = {
    far: byId('bookings', ids.far), soon: byId('bookings', ids.soonTable), noshow: byId('bookings', ids.noshow), seat: byId('seats', ids.seat),
    farJoin: byId('joins', ids.farJoin), soonJoin: byId('joins', ids.soonJoin), owedJoin: byId('joins', ids.owedJoin),
  };
  check(`${tag}: GET /me says far things can be cancelled and soon ones are locked`, !R.far.locked && R.far.cancelUntil < R.far.start && R.soon.locked && !R.farJoin.locked && R.soonJoin.locked, {
    far: [R.far.cancelUntil, R.far.locked], soon: [R.soon.cancelUntil, R.soon.locked], farJoin: [R.farJoin.cancelUntil, R.farJoin.locked], soonJoin: [R.soonJoin.cancelUntil, R.soonJoin.locked],
  });
  // open every later booking's row, so its ticket shows
  await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((d) => { d.open = true; }));
  const tickets = await page.evaluate(() => [...document.querySelectorAll('[data-coming] .ml-ticket')].map((t) => ({
    key: (t.getAttribute('aria-labelledby') || '').replace(/^ml-/, ''),
    title: t.querySelector('.ml-ticket__title').textContent.trim(),
    stub: t.querySelector('.ml-stub') ? t.querySelector('.ml-stub').textContent.replace(/\s+/g, ' ').trim() : '',
    qr: t.querySelectorAll('svg.qr, [data-qr-show]').length,
    cancel: (t.querySelector('[data-cancel]') || {}).textContent || '',
    by: (t.querySelector('.ml-cancel-row__by') || {}).textContent || '',
    lock: t.querySelector('.ml-lock') ? t.querySelector('.ml-lock').textContent.replace(/\s+/g, ' ').trim() : '',
    text: t.textContent.replace(/\s+/g, ' '),
  })));
  const tk = (prefix, ref) => tickets.find((x) => x.key === `${prefix}-${ref}`) || {};
  check(`${tag}: no ticket has a QR code or a code to show`, tickets.length > 4 && tickets.every((x) => !x.qr) && !tickets.some((x) => /Show this at the counter|Show your code|ring it up/.test(x.text)), tickets.filter((x) => x.qr).map((x) => x.key));
  check(`${tag}: the only QR on the page is the Goblin card`, (await page.evaluate(() => document.querySelectorAll('my-lair svg.qr').length)) === 1);
  const far = tk('bk', R.far.ref);
  check(`${tag}: a table 3 days away: "$X on your tab", Cancel booking with "Cancel by …"`, /^\$\d+ on your tab$/.test(far.stub) && far.cancel === 'Cancel booking' && /^Cancel by \w{3} \d+ \w{3}, \d/.test(far.by) && !far.lock, far);
  const soon = tk('bk', R.soon.ref);
  check(`${tag}: a table tonight: locked in, no Cancel, the locked words`, !soon.cancel && soon.lock === 'Locked in: on your tab It’s less than 24 hours away, so it can’t be cancelled online. Have a chat with us if you can’t make it.', soon);
  const seat = tk('st', R.seat.ref);
  check(`${tag}: a seat more than 24 hours away: on the tab, Give up my seat with its cancel-by`, /on your tab$/.test(seat.stub) && /^Give up my seat/.test(seat.cancel) && /^Cancel by/.test(seat.by), seat);
  const fj = tk('ej', R.farJoin.ref);
  check(`${tag}: a sign-up more than 24 hours away: on the tab, Cancel my sign-up with its cancel-by`, /on your tab$/.test(fj.stub) && fj.cancel === 'Cancel my sign-up' && /^Cancel by/.test(fj.by), fj);
  const sj = tk('ej', R.soonJoin.ref);
  check(`${tag}: a sign-up tonight: locked in, no Cancel`, !sj.cancel && /^Locked in: on your tab/.test(sj.lock), sj);
  check(`${tag}: the notes say it goes on their tab (Lair.TAB.onTab)`, far.text.includes('It goes on your tab: pay at the counter on the day, or pay for a few at once.'), far.text.slice(0, 300));
  // past list: the owed no-show and the owed sign-up
  const past = await page.evaluate(() => [...document.querySelectorAll('.ml-past__row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  check(`${tag}: earlier: the no-show and the sign-up from last week say Owed and how much`, past.some((x) => /T8/.test(x) && /Owed \$\d+/.test(x)) && past.some((x) => /Dungeons & Dragons/.test(x) && /Owed \$\d+/.test(x)), past);
  // rows of later bookings carry "Locked in" when they are (Home's coming up and the folded rows)
  await shot(page, `${tag}-bookings`, null, true);
  await axe(page, `${tag} My Lair Bookings (tickets, past)`, '[data-coming], [data-panel="bookings"], [data-panel="joins"], [data-panel="seats"]');

  // Cancel a sign-up more than 24 hours away: the dialog, then it's off the tab
  await page.click(`[data-cancel="ej-${R.farJoin.ref}"]`);
  await page.waitForSelector('[data-cancel-dialog][open]');
  const dlg = await page.evaluate(() => ({ title: document.querySelector('[data-cancel-title]').textContent, body: document.querySelector('[data-cancel-body]').textContent.replace(/\s+/g, ' ').trim() }));
  check(`${tag}: cancelling a sign-up asks first: "Cancel your sign-up?" and that it comes off the tab`, dlg.title === 'Cancel your sign-up?' && /It comes off your tab, so there’s nothing to pay\./.test(dlg.body) && /Cancel my sign-up/.test(dlg.body), dlg);
  await axe(page, `${tag} cancel dialog`, '[data-cancel-dialog]');
  await shot(page, `${tag}-cancel-dialog`, '[data-cancel-dialog]');
  await page.click('[data-confirm-cancel]');
  await page.waitForFunction(() => !document.querySelector('[data-cancel-dialog][open]'), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const afterJoin = await page.evaluate((ref) => ({ notice: (document.querySelector('[data-notice]') || {}).textContent || '', still: Boolean(document.querySelector(`[data-cancel="ej-${ref}"]`)), focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }), R.farJoin.ref);
  check(`${tag}: the sign-up is cancelled: "Cancelled: <event>, <day>. It’s off your tab." and its ticket goes`, /^Cancelled: Pokémon TCG league, \w{3} \d+ \w{3}\. It’s off your tab\. Thanks for letting us know\.$/.test(afterJoin.notice) && !afterJoin.still, afterJoin);

  // a cancel the Lair app refuses (409 locked): the far table moved inside 24 hours behind the page's back
  await page.evaluate((id) => {
    const be = window.Lair.store.backend;
    const b = be.state.bookings.find((x) => x.id === id);
    const now = Date.now();
    b.start = now + 3 * 3600000;
    b.end = now + 6 * 3600000;
    be.commit();
  }, ids.far);
  await page.click(`[data-cancel="bk-${R.far.ref}"]`);
  await page.waitForSelector('[data-cancel-dialog][open]');
  await page.click('[data-confirm-cancel]');
  await page.waitForSelector('[data-cancel-error]:not([hidden])', { timeout: 10000 });
  const refused = await page.evaluate(() => document.querySelector('[data-cancel-error]').textContent);
  check(`${tag}: a cancel the Lair app refuses shows its words (409 locked)`, /less than 24 hours away, so it can't be cancelled online now: it stays on your tab/.test(refused), refused);
  await page.click('[data-cancel-dialog] [data-dialog-close]');
  await page.waitForTimeout(900);
  const nowLocked = await page.evaluate((ref) => {
    const t = document.querySelector(`[aria-labelledby="ml-bk-${ref}"]`);
    return t ? { cancel: Boolean(t.querySelector('[data-cancel]')), lock: Boolean(t.querySelector('.ml-lock')) } : null;
  }, R.far.ref);
  check(`${tag}: after the refusal the page shows it locked in`, nowLocked && !nowLocked.cancel && nowLocked.lock, nowLocked);

  /* ---------- My Lair: the Tab view ---------- */
  await go(page, BASE, '/pages/my-lair#tab', RUBY);
  await waitMe(page);
  const tab = await page.evaluate(() => {
    const card = document.querySelector('[data-tab-status]');
    const coming = document.querySelector('[data-tab-coming]');
    return {
      title: (card.querySelector('.ml-tabcard__title') || {}).textContent || '',
      kicker: (card.querySelector('.ml-tabcard__kicker') || {}).textContent || '',
      qr: card.querySelectorAll('svg.qr').length,
      show: (card.querySelector('[data-qr-show]') || {}).textContent || '',
      lines: [...card.querySelectorAll('.ml-tabline--due')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
      owedNote: (card.querySelector('.ml-tabcard__owed') || {}).textContent || '',
      lede: coming ? coming.querySelector('.ml-upnext__lede').textContent : '',
      items: coming ? [...coming.querySelectorAll('.ml-upnext__item')].map((i) => ({ text: i.textContent.replace(/\s+/g, ' ').trim(), cancel: Boolean(i.querySelector('[data-tab-cancel]')), locked: Boolean(i.querySelector('.is-locked')) })) : [],
    };
  });
  check(`${tag}: the bill: "Pay at the counter: just give your name", no QR on it, Show my Goblin card`, tab.title === 'Pay at the counter: just give your name' && !tab.qr && /Show my Goblin card/.test(tab.show), tab);
  check(`${tag}: owed lines: "Owed: Table T8 (Sat 10 Oct)" and the sign-up, with what owed means`, tab.lines.some((l) => /^Owed: Table T8 \(\w{3} \d+ \w{3}\) \$\d+$/.test(l)) && tab.lines.some((l) => /^Owed: Dungeons & Dragons \(\w{3} \d+ \w{3}\)/.test(l)) && /even if you couldn’t make it/.test(tab.owedNote), tab.lines);
  check(`${tag}: the count says bookings, and how many are owed`, /\d+ bookings \(\d+ owed\)/.test(tab.kicker), tab.kicker);
  check(`${tag}: coming up: on the tab (Lair.TAB.onTab), each Cancel by … with Cancel, or locked in`, /^It goes on your tab/.test(tab.lede) && tab.items.some((i) => i.cancel && /Cancel by/.test(i.text)) && tab.items.some((i) => i.locked && /Locked in: on your tab/.test(i.text)) && !tab.items.some((i) => i.cancel && i.locked), tab.items.map((i) => i.text.slice(0, 90)));
  check(`${tag}: no "pay online" offered on the tab (pay each visit)`, !(await page.$('[data-account-pay]')) && !/Pay online now/.test(await page.textContent('[data-view="tab"]')));
  check(`${tag}: My Lair's Tab view: no sideways scroll`, (await overflowX(page)) === 0);
  await shot(page, `${tag}-tab`, null, true);
  await axe(page, `${tag} My Lair tab card and coming up`, '[data-tab-status], [data-tab-coming]');
  // the Goblin card from the bill: the one QR, big
  await page.click('[data-tab-status] [data-qr-show]');
  await page.waitForSelector('[data-qr-dialog][open]');
  const qrd = await page.evaluate(() => ({ title: document.querySelector('[data-qr-title]').textContent, qr: document.querySelectorAll('[data-qr-plate] svg.qr').length, how: document.querySelector('[data-qr-how]').textContent }));
  check(`${tag}: Show my Goblin card opens their card, big`, qrd.title === 'Your Goblin card' && qrd.qr === 1 && /pay everything on your tab/.test(qrd.how), qrd);
  await page.click('[data-qr-dialog] [data-dialog-close]');
  // Cancel from the running tab: the T10/T11 table tomorrow (the demo's), or the first one that can be
  const target = await page.evaluate(() => (document.querySelector('[data-tab-coming] [data-tab-cancel]') || {}).dataset?.tabCancel || '');
  if (check(`${tag}: something on the tab to cancel`, Boolean(target), target)) {
    await page.click(`[data-tab-cancel="${target}"]`);
    await page.waitForSelector('[data-cancel-dialog][open]');
    const title = await page.textContent('[data-cancel-title]');
    await page.click('[data-confirm-cancel]');
    await page.waitForFunction(() => !document.querySelector('[data-cancel-dialog][open]'), null, { timeout: 10000 });
    await page.waitForTimeout(600);
    const after = await page.evaluate((t) => ({ gone: !document.querySelector(`[data-tab-cancel="${t}"]`), notice: (document.querySelector('[data-notice]') || {}).textContent || '', focus: document.activeElement && document.activeElement.id }), target);
    check(`${tag}: cancelled from the tab ("${title}"): it's gone, the notice says so, focus on Coming up`, after.gone && /^Cancelled: /.test(after.notice) && after.focus === 'ml-upnext-title', after);
  }

  /* ---------- My Lair: a weekly game whose next seat is locked in: Stop saving my seat keeps it ---------- */
  const regular = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const id = String(be.cfg.customer.id);
    const m = (be.state.seriesMembers || []).find((x) => x.customerId === id);
    if (!m) return null;
    const now = Date.now();
    const seat = be.state.bookings.filter((b) => b.kind === 'gm-seat' && b.seriesId === m.seriesId && String(b.customerId) === id && b.status === 'confirmed' && b.start > now).sort((a, b) => a.start - b.start)[0];
    if (!seat) return null;
    seat.start = now + 4 * 3600000;
    seat.end = now + 8 * 3600000;
    // booked days ago (rolled forward after last week's session), so it isn't a seat Gobgob saved inside the 24 hours
    seat.createdAt = now - 3 * 86400000;
    be.commit();
    return { seriesId: m.seriesId, seat: seat.id };
  });
  if (check(`${tag}: a weekly game to stop`, Boolean(regular), regular)) {
    await go(page, BASE, '/pages/my-lair#bookings', RUBY);
    await waitMe(page);
    await page.evaluate(() => document.querySelectorAll('details.ml-later').forEach((d) => { d.open = true; }));
    const card = await page.evaluate((sid) => {
      const t = document.querySelector(`[aria-labelledby="ml-sr-${sid}"]`);
      return t ? { stub: (t.querySelector('.ml-stub') || {}).textContent || '', skip: Boolean(t.querySelector('[data-cancel]')), lock: Boolean(t.querySelector('.ml-lock')), leave: Boolean(t.querySelector('[data-leave]')), qr: t.querySelectorAll('svg.qr').length, text: t.textContent.replace(/\s+/g, ' ') } : null;
    }, regular.seriesId);
    check(`${tag}: the weekly game's card: no Goblin card QR, its next seat locked in (no Skip), Stop saving my seat`, card && !card.qr && !card.skip && card.lock && card.leave && /on your tab each week/.test(card.stub.replace(/\s+/g, ' ')), card);
    await page.click(`[data-leave="${regular.seriesId}"]`);
    await page.waitForSelector('[data-cancel-dialog][open]');
    const leaveBody = flat(await page.textContent('[data-cancel-body]'));
    check(`${tag}: Stop saving my seat says the locked seat stays on the tab`, /is locked in, so it stays on your tab\./.test(leaveBody), leaveBody);
    await page.click('[data-confirm-leave]');
    await page.waitForFunction(() => !document.querySelector('[data-cancel-dialog][open]'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const left = flat(await page.textContent('[data-notice]'));
    check(`${tag}: then the Lair app's notice: the seat stays on the tab`, /^Done\. Gobgob has stopped saving your seat at .+\. Your seat on .+ is less than 24 hours away, so it stays on your tab\./.test(left), left);
  }

  /* ---------- Home ---------- */
  await go(page, BASE, '/pages/my-lair', RUBY);
  await waitMe(page);
  const home = await page.evaluate(() => ({
    due: (document.querySelector('[data-home-due]') || {}).textContent || '', qr: document.querySelectorAll('my-lair [data-view="home"] svg.qr').length,
    rows: [...document.querySelectorAll('[data-next] .ml-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  }));
  check(`${tag}: Home: what's due says bookings and owed; the Goblin card is its one QR`, /bookings \(\d+ owed\)/.test(flat(home.due)) && home.qr === 1, home);
  await shot(page, `${tag}-home`, null, false);
  check(`${tag}: My Lair: no console errors`, !page.errors.length, page.errors.slice(0, 5));

  /* ---------- the staff page ---------- */
  const code = await page.evaluate(() => document.querySelector('my-lair').me.member.code);
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  const hint = flat(await page.textContent('#checkin-hint'));
  check(`${tag}: staff: the check-in hint says member card or pass, or their name (no ticket QR)`, !/ticket/i.test(hint) && /member card/.test(hint) && /give their name/.test(hint), hint);
  await page.fill('#checkin-code', code);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('.checkin-card--member', { timeout: 10000 });
  await page.waitForTimeout(400);
  const owedRows = await page.evaluate(() => [...document.querySelectorAll('[data-checkin-result] .staff-owed__row')].map((r) => ({
    id: r.dataset.owedRow, text: r.textContent.replace(/\s+/g, ' ').trim(), paid: Boolean(r.querySelector('[data-owed-paid]')), waive: Boolean(r.querySelector('[data-waive]')),
  })));
  const signup = owedRows.find((r) => r.id === ids.owedJoin);
  check(`${tag}: staff: the member card lists the owed sign-up with Mark paid and Waive`, signup && signup.paid && signup.waive && /Sign-up/.test(signup.text), owedRows);
  const noshowRow = owedRows.find((r) => r.id === ids.noshow);
  check(`${tag}: staff: and the owed no-show (a table) with Mark paid and Waive`, noshowRow && noshowRow.paid && noshowRow.waive && /No-show/.test(noshowRow.text), noshowRow);
  await shot(page, `${tag}-staff-member-card`, '.checkin');
  await axe(page, `${tag} staff member card (owed rows)`, '[data-checkin-result]');
  // Mark paid on the owed sign-up
  await page.click(`[data-checkin-result] [data-owed-paid="${ids.owedJoin}"]`);
  await page.waitForFunction((id) => {
    const r = document.querySelector(`[data-checkin-result] [data-owed-row="${id}"]`);
    return r && r.classList.contains('is-waived') && /Paid/.test(r.textContent);
  }, ids.owedJoin, { timeout: 10000 });
  const paidState = await page.evaluate((id) => ({
    focus: document.activeElement && document.activeElement.dataset && document.activeElement.dataset.owedRow,
    toast: (document.querySelector('.toast') || {}).textContent || '',
    join: (window.Lair.store.backend.state.joins || []).find((j) => j.id === id),
  }), ids.owedJoin);
  check(`${tag}: staff: Mark paid on the sign-up: it's paid (the Lair app took the sign-up's id), the row says Paid, focus on it`, paidState.join && paidState.join.paid && paidState.focus === ids.owedJoin, { focus: paidState.focus, toast: paidState.toast, paid: paidState.join && paidState.join.paid });
  // Waive the no-show: asks first
  await page.click(`[data-checkin-result] [data-waive="${ids.noshow}"]`);
  await page.waitForSelector(`[data-waive-yes="${ids.noshow}"]`);
  const ask = flat(await page.textContent('[data-checkin-result] .staff-confirm'));
  check(`${tag}: staff: Waive asks first`, /^Waive \$\d+ for Table T8 on \w{3} \d+ \w{3}\? .+ won’t owe it any more\. There’s no undo\./.test(ask), ask);
  await page.click(`[data-waive-yes="${ids.noshow}"]`);
  await page.waitForFunction((id) => /Waived/.test((document.querySelector(`[data-checkin-result] [data-owed-row="${id}"]`) || {}).textContent || ''), ids.noshow, { timeout: 10000 });
  check(`${tag}: staff: the no-show is waived`, await page.evaluate((id) => Boolean(window.Lair.store.backend.state.bookings.find((b) => b.id === id && b.waived)), ids.noshow));

  // a second owed sign-up, checked in by its own (older) code: the owed card, with Mark paid and Waive
  const owed2 = await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const c = be.staffMembers().find((x) => x.firstName === 'Ruby') || {};
    const o = be.occurrences().filter((x) => x.capacity && x.endMs < Date.now()).sort((a, b) => b.startMs - a.startMs)[1];
    if (!o) return null;
    const j = { id: `ej-qa${Date.now()}`, ref: be.newRef('Ruby Tane'), occurrenceId: o.id, people: 1, name: 'Ruby Tane', email: 'ruby@example.com', note: '', customerId: String(c.customerId), pay: 'day', paid: false, amount: 1500, paidAmount: 0, status: 'confirmed', createdAt: o.startMs - 3 * 86400000 };
    be.state.joins.push(j);
    be.commit();
    return { id: j.id, ref: j.ref, title: o.title };
  });
  if (check(`${tag}: staff: a second owed sign-up made`, Boolean(owed2), owed2)) {
    await page.evaluate(() => window.Lair.store.refresh());
    await page.waitForTimeout(400);
    await page.fill('#checkin-code', owed2.ref);
    await page.press('#checkin-code', 'Enter');
    await page.waitForSelector('[data-checkin-result] .checkin-card--warn', { timeout: 10000 });
    const card = await page.evaluate(() => ({
      status: document.querySelector('#checkin-status').textContent, message: document.querySelector('.checkin-card__message').textContent,
      what: document.querySelector('.checkin-card__what').textContent.replace(/\s+/g, ' '), paid: Boolean(document.querySelector('[data-checkin-result] [data-checkin-paid]')), waive: Boolean(document.querySelector('[data-checkin-result] [data-waive]')),
    }));
    check(`${tag}: staff: the owed card for a sign-up: Owed, ended unpaid (didn't come, still owed), Mark paid and Waive`, card.status === 'Owed' && /^This sign-up on .+ ended unpaid\. They didn’t check in, but it’s still owed\.$/.test(card.message) && /^Event sign-up: /.test(card.what) && card.paid && card.waive, card);
    await shot(page, `${tag}-staff-owed-card`, '.checkin');
    await axe(page, `${tag} staff owed card`, '[data-checkin-result]');
    await page.click('[data-checkin-result] [data-checkin-paid]');
    await page.waitForFunction(() => /^Paid$/.test((document.querySelector('#checkin-status') || {}).textContent || ''), null, { timeout: 10000 });
    check(`${tag}: staff: Mark paid on the owed card: Paid`, await page.evaluate((id) => Boolean((window.Lair.store.backend.state.joins || []).find((j) => j.id === id && j.paid)), owed2.id));
  }

  /* ---------- the member's page: tick two things, Mark paid ---------- */
  await page.fill('#checkin-code', code);
  await page.press('#checkin-code', 'Enter');
  await page.waitForSelector('.checkin-card--member', { timeout: 10000 });
  await page.click('[data-checkin-result] [data-member-view]');
  await page.waitForSelector('[data-person-account]:not([hidden]) .staff-acct__pay', { timeout: 20000 });
  await page.waitForTimeout(500);
  const acct = await page.evaluate(() => {
    const s = document.querySelector('[data-person-account]');
    return {
      ticks: [...s.querySelectorAll('[data-acct-tick]')].map((x) => ({ key: x.dataset.acctTick, id: x.id, label: x.closest('label').textContent.replace(/\s+/g, ' ').trim(), amount: Number(x.dataset.amount) })),
      locked: [...s.querySelectorAll('.staff-acct__locked')].length,
      lockNote: (s.querySelector('.staff-acct__lock-note') || {}).textContent || '',
      go: (s.querySelector('[data-acct-pay-go]') || {}).textContent || '',
      form: Boolean(s.querySelector('.staff-acct__form')),
    };
  });
  check(`${tag}: staff: their running tab has tick boxes, coming-up items say Locked in, and Mark paid`, acct.ticks.length >= 2 && acct.locked >= 1 && /Locked in: less than 24 hours to go/.test(acct.lockNote) && acct.go === 'Mark paid' && acct.form, acct);
  await shot(page, `${tag}-staff-member-account`, '[data-person-account]');
  await axe(page, `${tag} staff member page "Tab and account"`, '[data-person-account]');
  const two = acct.ticks.slice(0, 2);
  for (const tkx of two) await page.check(`#${tkx.id.replace(/([^\w-])/g, '\\$1')}`);
  const ticked = await page.evaluate(() => ({ go: document.querySelector('[data-acct-pay-go]').textContent, sum: document.querySelector('[data-acct-pay-sum]').textContent, focus: document.activeElement && document.activeElement.matches('[data-acct-tick]') }));
  const total = two.reduce((s, x) => s + x.amount, 0);
  const dollars = (c) => `$${(c / 100).toFixed(2)}`;
  check(`${tag}: staff: ticking two says what's ticked and the total`, ticked.go === `Mark 2 paid (${dollars(total)})` && ticked.sum === `2 things ticked: ${dollars(total)}.` && ticked.focus, ticked);
  await page.click('[data-acct-pay-go]');
  await page.waitForSelector('[data-acct-said]', { timeout: 10000 });
  await page.waitForTimeout(700);
  const done = await page.evaluate((keys) => {
    const s = document.querySelector('[data-person-account]');
    const be = window.Lair.store.backend;
    const isPaid = (k) => {
      const [type, id] = k.split(/:(.*)/s);
      const x = type === 'join' ? (be.state.joins || []).find((j) => j.id === id) : be.state.bookings.find((b) => b.id === id);
      return Boolean(x && x.paid);
    };
    return {
      said: s.querySelector('[data-acct-said]').textContent, focus: document.activeElement && document.activeElement.matches('[data-acct-said]'),
      paid: keys.map(isPaid), stillTickable: keys.filter((k) => s.querySelector(`[data-acct-tick="${CSS.escape(k)}"]`)),
    };
  }, two.map((x) => x.key));
  check(`${tag}: staff: Mark paid: both paid, it says what and the total, the fresh account shows (they're not to pay any more), focus on what it said`,
    done.paid.every(Boolean) && new RegExp(`^Marked paid: .+ and .+\\. \\${dollars(total)} in all\\.$`).test(done.said) && !done.stillTickable.length && done.focus, done);
  await shot(page, `${tag}-staff-member-paid`, '[data-person-account]');
  check(`${tag}: staff: no sideways scroll`, (await overflowX(page)) === 0);

  // a helper with Check-in and Members only: Mark paid, no Waive, no billing form
  await page.evaluate(() => {
    const el = document.querySelector('lair-staff');
    el.access = { ...el.access, role: 'helper', perms: ['checkin', 'members'] };
    el.members.view = null;
    el.renderMembers();
  });
  await page.evaluate(() => document.querySelector('lair-staff').openMember(String(window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Ruby').customerId)));
  await page.waitForSelector('[data-person-account]:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(600);
  const helper = await page.evaluate(() => ({
    form: Boolean(document.querySelector('[data-person-account] .staff-acct__form')), bills: Boolean(document.querySelector('[data-person-account] .staff-acct__bills')),
    ticks: document.querySelectorAll('[data-person-account] [data-acct-tick]').length, waive: document.querySelectorAll('[data-person-owed] [data-waive]').length,
  }));
  check(`${tag}: staff: a Check-in helper sees the tab with tick boxes, but no billing form and no Waive`, !helper.form && !helper.bills && !helper.waive, helper);
  check(`${tag}: staff: no console errors`, !page.errors.length, page.errors.slice(0, 5));
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
