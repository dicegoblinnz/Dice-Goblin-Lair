// Round 7, staff-admin helper: the staff page in live mode against a stand-in Lair app that answers round 7's staff
// routes in the contract's shapes (v7 sections 3, 5, 8, 9 and 10), so the LiveBackend methods are checked for their
// paths, methods and bodies, which the demo can't show: GET /events, POST /events/pictures, POST /events,
// POST /events/:handle/update (only what changed), POST /events/:handle/delete, the 503 before Shopify allows writes,
// GET /customers, GET|POST /groups, POST /groups/:id/members, POST /groups/:id/update, POST /passes with groupId,
// GET|POST /roll-codes, POST /roll-codes/:id/update and GET /members/:customerId. Prints PASS/FAIL lines.
// Usage: DG_THEME=/path/to/theme PORT=4848 node tools/qa/round7/staff-admin-live.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
if (!process.env.DG_THEME) {
  console.error('Set DG_THEME to the theme checkout.');
  process.exit(2);
}
const m = await import(new URL('../theme-mock/render.mjs', import.meta.url).href);
m.globalSettings.lair_mode = 'live';
m.globalSettings.lair_api = '/apps/liar';
const PORT = Number(process.env.PORT || 4848);
m.mockState.customer = { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@example.com', phone: '', tags: ['staff'] };
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const asked = [];
let denied = false;
const person = (id, name, email, code) => ({ customerId: id, name, email, code });
const SAM = person('7101', 'Sam Jones', 'sam@example.com', 'SJ-OWLBEAR-17');
const MERE = { customerId: '7201', name: 'Mere Paewai', firstName: 'Mere', email: 'mere@example.com', code: null, member: false };
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const configOf = (e) => ({
  id: e.handle, title: e.title, type: e.type, game: e.game, start: iso(e.start), end: e.end ? iso(e.end) : null, repeat: e.repeat, repeatUntil: e.repeatUntil,
  skipDates: e.skipDates, capacity: e.capacity, tables: e.tables, entryFee: e.entryFee, gameTables: e.gameTables, payment: e.payment, lockTables: e.lockTables,
  price: e.priceNote, url: e.link, link: e.link, product: null, blurb: e.description, image: e.image ? e.image.url : null, imageAlt: e.image ? e.image.alt : '',
});
const events = [{
  id: 'gid://shopify/Metaobject/1', handle: 'warhammer-wargames', title: 'Warhammer & other wargames', type: 'wargame', game: 'Warhammer', start: now + DAY, end: now + DAY + 5 * 3600 * 1000,
  repeat: 'weekly', repeatUntil: null, skipDates: [], description: 'Bring your army.', image: null, capacity: null, priceNote: '', entryFee: 1000, payment: 'store',
  tables: 'T20-T21', gameTables: 'T14+T15', lockTables: false, link: '', product: null, repeatTag: 'Weekly · Thursdays 6pm', next: now + DAY, last: now + 300 * DAY,
  booked: [], updatedAt: now,
}].map((e) => ({ ...e, config: configOf(e) }));
const groups = [{ id: 'gp1', name: 'Thursday league', organiser: SAM, members: [SAM], note: '', status: 'active', passes: [], createdAt: now, updatedAt: now }];
const codes = [{ id: 'rc1', code: 'ROLL-FOR-LOOT', rolls: 1, limit: null, uses: 3, left: null, expiresAt: null, status: 'active', note: "Gobgob's welcome loot, for every customer", createdAt: now, createdBy: 'staff', lastUsedAt: now, recent: [] }];

m.mockState.before = async (req, res, url) => {
  if (!url.pathname.startsWith('/apps/liar/')) return false;
  const route = url.pathname.slice('/apps/liar'.length);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  asked.push({ method: req.method, route, search: url.search, body });
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  };
  const write = () => (denied ? send(503, { error: "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again." }) : null);
  if (route === '/floor') return send(200, { bookings: [], blocks: [], games: [], events: [], features: {}, shopTables: ['T1', 'T2', 'T3'], openings: [], joins: [] });
  if (route === '/library/holds') return send(200, { holds: [] });
  // the library tab (round 7, merged after this check was written) asks for games at home as the page loads
  if (route === '/library/loans') return send(200, { loans: [] });
  // round 9: the staff page asks who's using it first, and a member's page asks for their store credit and emails
  if (route === '/staff/me') return send(200, { staff: true, role: 'owner', perms: ['checkin', 'tables', 'sessions', 'events', 'members', 'money', 'library', 'community', 'team'], name: 'Mo' });
  if (route === '/team') return send(200, { owners: [{ customerId: '7001', name: 'Mo Ashgrove', email: 'mo@example.com', code: null }], helpers: [], perms: [], defaults: ['checkin', 'tables'], log: [] });
  if (/^\/members\/\d+\/credit$/.test(route)) return send(200, { balance: 0, currency: 'NZD', problem: null, history: [] });
  if (/^\/members\/\d+\/emails$/.test(route)) return send(200, { to: 'sam@example.com', emails: [], left: 30, limit: 30 });
  if (route === '/members/birthdays') return send(200, []);
  if (route === '/members' && req.method === 'GET') return send(200, [{ ...SAM, spendYear: 1000, spendTotal: 1000, lastSeen: now, owed: 0, owedCount: 0, openTab: 0, pendingPrizes: [], giftedThisYear: true, giftsThisYear: [{ id: 'g1', at: now - DAY, words: '$20 store credit, 5 rolls' }] }]);
  if (route === '/members/7101') return send(200, { member: { ...SAM, spendYear: 1000, spendTotal: 1000, lastSeen: now, owed: 0, owedCount: 0, openTab: 0, pendingPrizes: [], giftedThisYear: true, mobile: '021 555 0101', pronouns: 'they/them', favouriteGames: ['Root'], about: '', gifts: [{ id: 'g1', at: now - DAY, credit: 2000, sessions: 0, passCode: null, rolls: 5, product: null, state: 'claimed', claimedAt: now - DAY, words: '$20 store credit, 5 rolls', emailed: true, note: '' }], library: { plan: null, holds: [], atHome: [] } } });
  if (route === '/members/7101/spend') return send(200, { months: [], years: [], total: 0, since: null });
  if (route === '/checkin') return send(200, { found: true, kind: 'member', type: 'member', checkedIn: false, member: { ...SAM, firstName: 'Sam' }, rows: [], passes: [], due: 0 });
  if (route === '/passes' && req.method === 'GET') return send(200, { passes: [] });
  if (route === '/passes' && req.method === 'POST') {
    const g = groups.find((x) => x.id === body.groupId);
    return send(200, { pass: { id: 'ps9', code: 'TL-KOBOLD-3', label: body.label, sessionsTotal: body.sessions, sessionsUsed: 0, sessionsLeft: body.sessions, cover: 1000, holder: { customerId: null, name: g ? g.name : '', email: '' }, group: g ? { id: g.id, name: g.name } : null, note: '', pricePaid: 0, expiresAt: null, status: 'active', createdAt: now, source: 'staff', uses: [] } });
  }
  if (route === '/events' && req.method === 'GET') return send(200, { events });
  if (route === '/events/pictures') return write() || send(200, { image: { id: 'gid://shopify/MediaImage/9', url: null, alt: body.alt || '', status: 'UPLOADED' } });
  if (route === '/events' && req.method === 'POST') {
    if (write()) return true;
    const e = { ...body, id: 'gid://shopify/Metaobject/2', handle: 'qa-live-night', image: body.imageId ? { id: body.imageId, url: null, alt: '' } : null, product: null, entryFee: body.entryFee != null ? Math.round(body.entryFee * 100) : null, repeatTag: null, next: body.start, last: body.start, booked: [], updatedAt: now };
    e.config = configOf({ ...e, repeat: e.repeat || '', skipDates: e.skipDates || [], tables: e.tables || '', gameTables: e.gameTables || '', priceNote: e.priceNote || '', description: e.description || '', link: e.link || '' });
    events.push(e);
    return send(200, { event: e, notice: null });
  }
  const upd = route.match(/^\/events\/([^/]+)\/update$/);
  if (upd) {
    if (write()) return true;
    const e = events.find((x) => x.handle === decodeURIComponent(upd[1]));
    Object.assign(e, body, body.entryFee !== undefined ? { entryFee: body.entryFee == null ? null : Math.round(body.entryFee * 100) } : {});
    e.config = configOf(e);
    return send(200, { event: e, notice: body.capacity ? 'Thu 8 Oct already has 8 people, more than the new capacity. Nobody\'s been cancelled.' : null });
  }
  const del = route.match(/^\/events\/([^/]+)\/delete$/);
  if (del) return write() || send(200, { ok: true, handle: decodeURIComponent(del[1]) });
  if (route === '/customers') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const list = [{ ...SAM, firstName: 'Sam', member: true }, MERE].filter((x) => x.name.toLowerCase().includes(q));
    return send(200, { customers: list, shopify: true });
  }
  if (route === '/groups' && req.method === 'GET') return send(200, { groups: groups.filter((g) => (url.searchParams.get('status') || 'active') === 'all' || g.status === (url.searchParams.get('status') || 'active')) });
  if (route === '/groups' && req.method === 'POST') {
    const g = { id: 'gp2', name: body.name, organiser: body.organiser ? person(body.organiser.customerId, body.organiser.name, body.organiser.email, 'XX-ONE-1') : null, members: (body.members || []).map((p) => person(p.customerId, p.name, p.email, 'XX-TWO-2')), note: body.note || '', status: 'active', passes: [], createdAt: now, updatedAt: now };
    if (g.organiser && !g.members.some((x) => x.customerId === g.organiser.customerId)) g.members.unshift(g.organiser);
    groups.push(g);
    return send(200, { group: g });
  }
  const gm = route.match(/^\/groups\/([^/]+)\/members$/);
  if (gm) {
    const g = groups.find((x) => x.id === gm[1]);
    (body.add || []).forEach((p) => g.members.push(person(p.customerId, p.name, p.email, 'XX-ADD-3')));
    g.members = g.members.filter((x) => !(body.remove || []).includes(x.customerId));
    return send(200, { group: g });
  }
  const gu = route.match(/^\/groups\/([^/]+)\/update$/);
  if (gu) {
    const g = groups.find((x) => x.id === gu[1]);
    Object.assign(g, body.status ? { status: body.status } : {}, body.name ? { name: body.name } : {});
    return send(200, { group: g });
  }
  if (route === '/roll-codes' && req.method === 'GET') return send(200, { codes });
  if (route === '/roll-codes' && req.method === 'POST') {
    const c = { id: 'rc2', code: body.code || 'GG-KOBOLD-14', rolls: body.rolls || 1, limit: body.limit ?? null, uses: 0, left: body.limit ?? null, expiresAt: null, status: 'active', note: body.note || '', createdAt: now, createdBy: 'staff', lastUsedAt: null, recent: [] };
    codes.unshift(c);
    return send(200, { code: c });
  }
  const cu = route.match(/^\/roll-codes\/([^/]+)\/update$/);
  if (cu) {
    const c = codes.find((x) => x.id === cu[1]);
    Object.assign(c, body);
    return send(200, { code: c });
  }
  console.log(`  (the stand-in doesn't answer ${req.method} ${route}${url.search})`);
  return send(404, { error: 'Not found' });
};

const server = await m.serve(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 503/.test(msg.text())) errors.push(`console: ${msg.text()}`); });
page.on('response', (r) => { if (r.status() === 404) errors.push(`404: ${r.url()}`); });
const call = (method, re) => asked.filter((a) => a.method === method && re.test(a.route));
await page.goto(`http://localhost:${PORT}/pages/lair-staff#events`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('.sa-event', { timeout: 10000 });
check('GET /events lists the events, with the Lair app\'s repeat tag', /Weekly · Thursdays 6pm/.test(await page.textContent('[data-event-list]')) && call('GET', /^\/events$/).length === 1);
// add one with a picture
await page.click('[data-event-new]');
await page.fill('#sa-ev-title', 'QA live night');
await page.selectOption('#sa-ev-type', 'social');
const day = await page.evaluate(() => window.Lair.store.time.addDays(window.Lair.store.time.today(), 5));
await page.fill('#sa-ev-date', day);
await page.fill('#sa-ev-from', '18:00');
await page.fill('#sa-ev-until', '01:00');
await page.fill('#sa-ev-entryFee', '12.5');
await page.evaluate(async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: 400, height: 225 });
  canvas.getContext('2d').fillRect(0, 0, 400, 225);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const input = document.querySelector('[data-event-file]');
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForSelector('[data-picture-note]');
await page.click('[data-event-form] button[type="submit"]');
await page.waitForSelector('[data-event-handle="qa-live-night"]', { timeout: 10000 });
const pic = call('POST', /^\/events\/pictures$/)[0];
const made = call('POST', /^\/events$/)[0];
check('POST /events/pictures sends the shrunk picture as a data URL, with the title as alt', pic && /^data:image\/jpeg;base64,/.test(pic.body.dataUrl) && pic.body.alt === 'QA live night', pic && { alt: pic.body.alt, head: String(pic.body.dataUrl).slice(0, 30) });
const startMs = await page.evaluate((d) => window.Lair.store.time.at(d, 18 * 60), day);
const endMs = await page.evaluate((d) => window.Lair.store.time.at(window.Lair.store.time.addDays(d, 1), 60), day);
check('POST /events sends the fields: start and end in ms (an end past midnight the next day), entry fee in dollars, the picture id', made && made.body.title === 'QA live night' && made.body.type === 'social' && made.body.start === startMs && made.body.end === endMs && made.body.entryFee === 12.5 && made.body.imageId === 'gid://shopify/MediaImage/9' && made.body.payment === 'store' && made.body.lockTables === false && !('repeat' in made.body), made && made.body);
check('…and store.cfg.events takes the config', await page.evaluate(() => window.Lair.store.cfg.events.some((e) => e.id === 'qa-live-night')));
// edit: only what changed
await page.locator('[data-event-handle="qa-live-night"] [data-event-edit]').click();
await page.fill('#sa-ev-capacity', '20');
await page.click('[data-event-form] button[type="submit"]');
await page.waitForTimeout(600);
const upd = call('POST', /^\/events\/qa-live-night\/update$/)[0];
check('POST /events/:handle/update sends only what changed', upd && JSON.stringify(upd.body) === JSON.stringify({ capacity: 20 }), upd && upd.body);
check('…and the notice shows', /more than the new capacity/.test(flat(await page.locator('.toast').innerText().catch(() => ''))));
// remove
await page.locator('[data-event-handle="qa-live-night"] [data-event-ask]').click();
await page.locator('[data-event-handle="qa-live-night"] [data-event-remove]').click();
await page.waitForTimeout(500);
check('POST /events/:handle/delete', call('POST', /^\/events\/qa-live-night\/delete$/).length === 1 && !(await page.$('[data-event-handle="qa-live-night"]')));
// the 503
denied = true;
await page.click('[data-event-new]');
await page.fill('#sa-ev-title', 'Blocked');
await page.selectOption('#sa-ev-type', 'other');
await page.fill('#sa-ev-date', day);
await page.click('[data-event-form] button[type="submit"]');
await page.waitForTimeout(500);
check('the 503 shows over the form', /Shopify hasn't let the Lair change events yet/.test(await page.textContent('[data-event-form] [data-form-error]')));
denied = false;
await page.click('[data-event-back]');

// groups
await page.click('[data-tab="groups"]');
await page.waitForSelector('.sa-row');
check('GET /groups?q=&status=active', call('GET', /^\/groups$/).some((a) => a.search === '?q=&status=active'));
await page.click('[data-group-new]');
await page.fill('#sa-group-name', 'QA live club');
await page.fill('staff-customer-pick[data-id="sa-group-organiser"] .sa-pick__input', 'sam');
await page.waitForSelector('staff-customer-pick[data-id="sa-group-organiser"] [data-pick]');
await page.click('staff-customer-pick[data-id="sa-group-organiser"] [data-pick]');
await page.fill('staff-customer-pick[data-id="sa-group-people"] .sa-pick__input', 'mere');
await page.waitForSelector('staff-customer-pick[data-id="sa-group-people"] [data-pick]');
await page.click('staff-customer-pick[data-id="sa-group-people"] [data-pick]');
check('GET /customers?q= (the picker)', call('GET', /^\/customers$/).some((a) => a.search === '?q=mere'));
await page.click('[data-group-form] button[type="submit"]');
await page.waitForSelector('[data-group-people] .sa-person');
const g = call('POST', /^\/groups$/)[0];
check('POST /groups: name, organiser and people as { customerId, name, email }', g && g.body.name === 'QA live club' && g.body.organiser.customerId === '7101' && g.body.organiser.name === 'Sam Jones' && g.body.members.length === 1 && g.body.members[0].customerId === '7201' && g.body.members[0].email === 'mere@example.com', g && g.body);
await page.fill('[data-group-add] .sa-pick__input', 'sam');
await page.waitForTimeout(600);
check('the add picker leaves out people already in the group', /Everyone that matches is picked already/.test(await page.textContent('[data-group-add] [data-pick-results]')));
await page.locator('[data-group-people] .sa-person', { hasText: 'Mere' }).locator('[data-group-confirm^="remove:"]').click();
await page.click('[data-group-remove]');
await page.waitForTimeout(400);
const gmem = call('POST', /^\/groups\/gp2\/members$/)[0];
check('POST /groups/:id/members { remove: [customerId] }', gmem && JSON.stringify(gmem.body) === JSON.stringify({ remove: ['7201'] }), gmem && gmem.body);
await page.click('[data-group-issue]');
await page.waitForFunction(() => document.querySelector('[data-pass-group] option:checked')?.value === 'gp2', null, { timeout: 5000 });
await page.click('[data-pass-preset="Warhammer league: 10 sessions"]');
await page.click('[data-pass-new] button[type="submit"]');
await page.waitForSelector('[data-pass-card]');
const p = call('POST', /^\/passes$/)[0];
check('POST /passes { groupId } and no person', p && p.body.groupId === 'gp2' && !('customerId' in p.body) && !('holderName' in p.body), p && p.body);
check('…and the pass reads as the group', /Group\s*QA live club/.test(flat(await page.textContent('[data-pass-card]'))));
await page.click('[data-tab="groups"]');
await page.click('[data-group-confirm="archive"]');
await page.click('[data-group-status-set="archived"]');
await page.waitForTimeout(400);
const gu = call('POST', /^\/groups\/gp2\/update$/)[0];
check('POST /groups/:id/update { status: archived }', gu && JSON.stringify(gu.body) === JSON.stringify({ status: 'archived' }), gu && gu.body);

// loot codes
await page.click('[data-tab="codes"]');
await page.waitForSelector('.sa-code');
check('GET /roll-codes?status=active', call('GET', /^\/roll-codes$/).some((a) => a.search === '?status=active'));
await page.click('[data-code-make]');
await page.fill('#sa-code-code', 'live-loot');
await page.click('[data-code-form] button[type="submit"]');
await page.waitForSelector('.sa-code.is-new');
const rc = call('POST', /^\/roll-codes$/)[0];
check('POST /roll-codes { code in capitals, rolls, limit: null, expires: null }', rc && JSON.stringify(rc.body) === JSON.stringify({ rolls: 1, code: 'LIVE-LOOT', limit: null, expires: null }), rc && rc.body);
const it = page.locator('.sa-code', { hasText: 'LIVE-LOOT' });
await it.locator('.sa-code__edit > summary').click();
await it.locator('[name="status"][value="inactive"]').check({ force: true });
await it.locator('button[type="submit"]').click();
await page.waitForTimeout(400);
const ru = call('POST', /^\/roll-codes\/rc2\/update$/)[0];
check('POST /roll-codes/:id/update { status: inactive } only', ru && JSON.stringify(ru.body) === JSON.stringify({ status: 'inactive' }), ru && ru.body);

// a member's page
await page.click('[data-tab="members"]');
await page.waitForSelector('.staff-mem-row');
await page.click('.staff-mem-row');
await page.waitForSelector('[data-person-profile]:not([hidden])', { timeout: 10000 });
check('GET /members/:customerId for their page, with the profile and gifts in words', call('GET', /^\/members\/7101$/).length >= 1 && /they\/them/.test(await page.textContent('[data-person-profile]')) && /\$20 store credit, 5 rolls/.test(await page.textContent('[data-person-gifts]')));
check('no console or page errors', !errors.length, errors.slice(0, 4));
console.log(`staff-admin live: ${pass} passed, ${fail} failed`);
await ctx.close();
await browser.close();
server.close();
process.exitCode = fail ? 1 : 0;
