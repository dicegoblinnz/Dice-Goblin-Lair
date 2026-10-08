// The staff page in live mode against a stand-in for the Lair app that answers only what the round 5 contract
// promises (and, from round 6, GET /members/:id/spend, which a member's page asks for): GET /members?q=&sort=&owing=1
// (an array; no round 6 loyalty fields, so the page copes without them), GET /members/birthdays (suggested, giftedThisYear, lastGift),
// POST /members/:id/gift (problems as plain words), POST /checkin with a member code (rows with owed: true),
// GET /passes (source, orderName), POST /bookings/:id/update { waived: true }, POST /games/:id/image, and from round 6
// GET /library/holds (the Library tab's count, asked for as the page loads). It logs what the page asked for.
// Usage: node live-members.mjs phone|desktop
import { m, chromium, open, shot, text, overflow, smallTargets, STAFF, PORT } from './lib.mjs';
const tag = process.argv[2] || 'phone';
m.globalSettings.lair_mode = 'live';
m.globalSettings.lair_api = '/apps/liar';
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const asked = [];
const members = [
  { customerId: '7101', name: 'Sam Jones', email: 'sam@example.com', code: 'SJ-OWLBEAR-17', birthday: '10-09', spendYear: 24000, spendTotal: 61000, lastSeen: now - DAY, owed: 3000, owedCount: 2, openTab: 900, pendingPrizes: [{ id: 'pz1', kind: 'credit', amount: 200, status: 'pending', roll: 11, at: now - 2 * DAY }], giftedThisYear: false },
  { customerId: '7102', name: 'Kiri Smith', email: 'kiri@example.com', code: 'KS-TUI-4', birthday: '10-12', spendYear: 52000, spendTotal: 118000, lastSeen: now - 3 * DAY, owed: 0, owedCount: 0, openTab: 0, pendingPrizes: [], giftedThisYear: true },
];
const owedRow = (id, days) => ({ id, type: 'booking', kind: 'gm-seat', ref: `SJ-RUNE-${days}`, name: 'Sam Jones', people: 1, tables: ['G1', 'G2'], start: now - days * DAY, end: now - days * DAY + 3 * 3600 * 1000, status: 'confirmed', arrivedAt: null, paid: false, amount: 1500, covered: 0, due: 1500, paidAmount: 0, payments: [], customerId: '7101', pass: null, refund: null, note: '', title: 'Abomination Vaults', gameId: 'gone', occurrenceId: null, owed: true });
let waived = new Set();
m.mockState.customer = STAFF;
m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  const route = url.pathname.slice('/apps/liar'.length);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  asked.push(`${req.method} ${route}${url.search}${body ? ` ${JSON.stringify(body).slice(0, 160)}` : ''}`);
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  };
  if (route === '/floor') return send(200, { bookings: [], blocks: [], games: [{ id: 'g1', title: 'Picture game', system: 'D&D 5e', gm: 'Ana', tables: ['G1', 'G2'], start: now + 2 * DAY, end: now + 2 * DAY + 3 * 3600 * 1000, seats: 5, taken: 0, status: 'open', seatPrice: 1500, gmFee: 500, schedule: 'one-shot', image: null }], events: [], features: {}, shopTables: ['T1', 'T2', 'T3'], openings: [], joins: [] });
  if (route === '/members') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let list = members.filter((x) => !q || x.customerId === q || x.name.toLowerCase().includes(q) || x.code.toLowerCase().includes(q));
    if (url.searchParams.get('owing') === '1') list = list.filter((x) => x.owed + x.openTab > 0);
    return send(200, list);
  }
  if (route === '/members/birthdays') {
    return send(200, [
      { ...members[0], date: '2026-10-09', days: 5, suggested: { low: 5, high: 12 }, giftedThisYear: false, lastGift: null },
      { ...members[1], date: '2026-10-12', days: 8, suggested: { low: 10, high: 26 }, giftedThisYear: true, lastGift: { at: now - DAY, credit: 1500, sessions: 2, rolls: 0, product: null } },
    ]);
  }
  // round 6: a member's page also asks for their spend by month and NZ financial year (contract v6, section 2)
  const spendOf = route.match(/^\/members\/([^/]+)\/spend$/);
  if (spendOf) {
    const months = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 23 + i, 1));
      return { month: d.toISOString().slice(0, 7), amount: i % 3 ? 2500 : 0, orders: i % 3 ? 1 : 0 };
    });
    return send(200, { months, years: [{ fy: '2026/27', from: '2026-04-01', to: '2027-03-31', amount: 15000, orders: 6 }], total: 61000, since: '2023-07-21' });
  }
  // round 7: a member's page asks for the member by customer ID (contract v7, section 5): the list's item, their profile,
  // every gift and their library
  const memberOf = route.match(/^\/members\/(\d+)$/);
  if (memberOf) {
    const found = members.find((x) => x.customerId === memberOf[1]);
    return found ? send(200, { member: { ...found, mobile: '', pronouns: '', favouriteGames: [], about: '', gifts: [], library: { plan: null, holds: [], atHome: [] } } }) : send(404, { error: 'No member with that customer ID.' });
  }
  if (route === '/members/7101/gift') {
    return send(200, { gift: { id: 'gf1', at: now, credit: Math.round((body.credit || 0) * 100), sessions: body.sessions || 0, passCode: body.sessions ? 'SJ-CAKE-9' : null, rolls: 0, product: body.productVariantId ? { title: body.productTitle, code: 'HBD-SJOWLBEAR17' } : null, emailed: true, problems: body.rolls ? ['Dice rolls: no permission to add them, so add them by hand.'] : [] } });
  }
  if (route === '/checkin') {
    if (String(body.code || '').replace(/[^a-z0-9]/gi, '').toUpperCase() === 'SJOWLBEAR17') {
      return send(200, { found: true, kind: 'member', type: 'member', checkedIn: false, member: { customerId: '7101', name: 'Sam Jones', firstName: 'Sam', email: 'sam@example.com', code: 'SJ-OWLBEAR-17' }, rows: [owedRow('o1', 6), owedRow('o2', 13)].filter((r) => !waived.has(r.id)), passes: [], due: 3000 });
    }
    return send(404, { error: 'No booking, member or pass with that code.' });
  }
  if (route === '/passes') {
    return send(200, { passes: [
      { id: 'p1', code: 'SJ-PASS-3', label: 'Session pass: 10 sessions', sessionsTotal: 10, sessionsUsed: 1, sessionsLeft: 9, cover: 1000, holder: { customerId: '7101', name: 'Sam Jones', email: 'sam@example.com' }, note: 'Bought online', pricePaid: 10000, expiresAt: null, status: 'active', createdAt: now - 5 * DAY, source: 'order', orderName: '#1550', uses: [] },
      { id: 'p2', code: 'DG-COIN-8', label: 'Session pass: 5 sessions', sessionsTotal: 5, sessionsUsed: 0, sessionsLeft: 5, cover: 1000, holder: { customerId: null, name: 'Sold at the counter', email: '' }, note: 'Bought at the counter', pricePaid: 5000, expiresAt: null, status: 'active', createdAt: now - DAY, source: 'order', orderName: '#1553', uses: [] },
    ] });
  }
  const update = route.match(/^\/bookings\/([^/]+)\/update$/);
  if (update) {
    waived.add(decodeURIComponent(update[1]));
    return send(200, { booking: { ...owedRow(decodeURIComponent(update[1]), 6), owed: false, waived: true, due: 0 } });
  }
  if (route === '/games/g1/image') return send(200, { image: 'https://cdn.example/x.jpg' });
  // Round 6: the staff page loads the library holds for its Library tab's count (contract v6, section 4)
  if (route === '/library/holds') return send(200, { holds: [] });
  // Round 7: and the games at home (contract v7, section 6), for that tab and a scanned member's card
  if (route === '/library/loans') return send(200, { loans: [] });
  // Round 9 (team): the staff page asks who's using it first (the main account here), the Team tab's list, and a member's
  // page asks for their store credit and the emails staff sent them
  if (route === '/staff/me') return send(200, { staff: true, role: 'owner', perms: ['checkin', 'tables', 'sessions', 'events', 'members', 'money', 'library', 'community', 'team'], name: 'Mo' });
  if (route === '/team') return send(200, { owners: [{ customerId: '7001', name: 'Mo Ashgrove', email: 'mo@example.com', code: null }], helpers: [], perms: [], defaults: ['checkin', 'tables'], log: [] });
  if (/^\/members\/\d+\/credit$/.test(route)) return send(200, { balance: 2500, currency: 'NZD', problem: null, history: [] });
  if (/^\/members\/\d+\/emails$/.test(route)) return send(200, { to: 'sam@example.com', emails: [], left: 30, limit: 30 });
  return send(404, { error: 'Not found' });
};
const server = await m.serve(PORT);
const browser = await chromium.launch();
const { ctx, page } = await open(browser, tag, '/pages/lair-staff');
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
await page.click('[data-tab="members"]');
await sleep(600);
log('list:', (await page.$$eval('.staff-mem-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
await page.click('[data-members-sort="owing"]');
await sleep(300);
await page.click('[data-members-owing]');
await sleep(400);
log('owing only:', (await page.$$eval('.staff-mem-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)))).join(' || '));
await page.click('.staff-mem-row');
await sleep(900);
log('owed on the page:', await text(page, '[data-person-owed]'));
log('passes on the page:', await text(page, '[data-person-passes]'));
await page.click('[data-person-owed] [data-waive]');
await sleep(200);
await page.click('[data-waive-yes]');
await sleep(900);
log('after waive:', await text(page, '[data-person-owed]'), '| toast:', await text(page, '.toast'));
await page.click('[data-gift-open]');
await sleep(300);
log('credit prefilled:', await page.inputValue('#gift-credit'), '|', await text(page, '#gift-credit-hint'));
await page.click('.staff-gift__count:nth-child(1) [data-seats-step="1"]');
await page.click('.staff-gift__count:nth-child(2) [data-seats-step="1"]');
await page.click('[data-gift-form] button[type="submit"]');
await sleep(900);
log('gift result (string problem):', await text(page, '.staff-gift--done'));
await shot(page, `${tag}-l1-live-gift`);
await page.click('[data-members-back]');
await sleep(400);
log('birthdays:', await text(page, '[data-birthdays]'));
// the counter: a member code brings owed rows; Waive there too
await page.fill('#checkin-code', 'sj owlbear 17');
await page.press('#checkin-code', 'Enter');
await sleep(800);
log('member card:', await text(page, '[data-checkin-result]'));
// Passes: sources, live shape
await page.click('[data-tab="passes"]');
await sleep(600);
log('passes:', (await page.$$eval('.staff-pass-row', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
log('overflow', await overflow(page), 'small', JSON.stringify(await smallTargets(page, 'lair-staff')));
log('asked the Lair app:');
for (const a of asked.filter((x) => !x.startsWith('GET /floor'))) console.log('   ', a);
log('errors', JSON.stringify(page.errors));
await ctx.close();
await browser.close();
server.close();
