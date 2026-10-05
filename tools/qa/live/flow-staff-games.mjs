// Staff page, GM games tab, live: approve a game a new GM listed, then manage a game: its players and what they owe,
// add a player from the members, edit the session (title, GM fee), cancel a session.
import { start, stop, context, page, overflow, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy } from './client.mjs';

const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const tz = 'Pacific/Auckland';
const key = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let TUE = addDays(key(Date.now()), 1);
while (new Date(`${TUE}T12:00:00Z`).getUTCDay() !== 2) TUE = addDays(TUE, 1);
const at = (k, h) => Date.parse(`${k}T${String(h).padStart(2, '0')}:00:00+13:00`);
const tables = L === 'desktop' ? ['G3', 'G4'] : ['G1', 'G2'];

// Leo isn't a trusted GM: his game waits for staff. A player takes a seat once it's live.
const listed = await proxy('POST', 'games', {
  customer: '7104',
  body: { title: `Leo's Mothership (${L} ${Date.now() % 1000})`, system: 'Mothership', gm: 'Leo', email: 'leo@example.com', blurb: 'Space horror in a rusty tug.', seats: 3, tables, start: at(TUE, 18), end: at(TUE, 21), schedule: 'one-shot', gmFee: 500 },
});
check(`${L} setup: Leo's game waits for staff (not a trusted GM)`, listed.status === 200 && listed.data.pending === true, listed.data.error || listed.data.game?.status);
const g = listed.data.game;

await start();
const ctx = await context(7001, DEVICE);
const p = await page(ctx, `${L}/staff-gm`);
await p.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await p.click('[data-tab="games"]');
await p.waitForSelector(`[data-act="approve"][data-id="${g.id}"]`, { timeout: 8000 });
let b = apiLog.length;
await p.click(`[data-act="approve"][data-id="${g.id}"]`);
await p.waitForTimeout(1200);
let call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `games/${g.id}/update`);
check(`${L}: approve: the game goes live`, call?.status === 200 && JSON.parse(call.body).status === 'open' && JSON.parse(call.text).game.status === 'open', call ? call.text.slice(0, 160) : 'no call');
const seat = await proxy('POST', 'bookings', { customer: '7102', body: { kind: 'gm-seat', gameId: g.id, people: 1, name: 'Kiri Smith', email: 'kiri@example.com', players: [{ name: 'Kiri', character: 'Captain Reyes' }] } });
check(`${L} setup: Kiri takes a seat`, seat.status === 200, seat.data.error);

// manage it
await p.goto('about:blank');
await p.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
await p.click('[data-tab="games"]');
await p.waitForSelector(`.staff-gm-row[data-gm-manage="${g.id}"]`, { timeout: 8000 });
await p.click(`.staff-gm-row[data-gm-manage="${g.id}"]`);
await p.waitForSelector('[data-gm-players]');
const players = await text(p, '[data-gm-players]');
check(`${L}: the players list: Kiri as Captain Reyes, $15 to pay`, /Kiri/.test(players) && /Captain Reyes/.test(players) && /Unpaid, \$15 to pay/.test(players), players.slice(0, 200));
// add a player from the members
await p.fill('[data-gm-add] [data-member-search="add"]', 'sam');
await p.waitForSelector('[data-gm-add] [data-member-results="add"] [data-member-pick]', { timeout: 6000 }).catch(() => {});
await p.click('[data-gm-add] [data-member-results="add"] [data-member-pick]');
await p.fill('[data-gm-add] [name="character"]', 'Dr Okafor');
b = apiLog.length;
await p.click('[data-gm-add] [type="submit"]');
await p.waitForTimeout(1200);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `games/${g.id}/players`);
const sent = call ? JSON.parse(call.body) : {};
check(`${L}: add a player from the members (linked to their account)`, call?.status === 200 && sent.customerId === '7101' && JSON.parse(call.text).booking?.customerId === '7101', call ? `${call.body} → ${call.text.slice(0, 160)}` : 'no call');
check(`${L}: Sam shows in the players`, /Dr Okafor/.test(await text(p, '[data-gm-players]')));
await shot(p, `staff-gm-manage-${L}`);
// edit: a new title and no GM fee. Round 7: Edit this session is the GMs' own form (<lair-session-form>), a part at a
// time: the title on The game, the fee on Who's running it. Leo listed his game without saying how characters are
// made, so the form asks for it, as it asks GMs.
await p.click('[data-gm-edit-wrap] >> xpath=..');
await p.evaluate(() => { const d = document.querySelector('[data-gm-edit-wrap]').closest('details'); d.open = true; });
await p.fill('[data-gm-edit] [name="title"]', `${g.title} (edited)`);
await p.click('[data-gm-edit-wrap] [data-sf-step="2"]');
await p.locator('[data-gm-edit] label.pay-option', { has: p.locator('input[name="characters"][value="pregens"]') }).click();
await p.click('[data-gm-edit-wrap] [data-sf-step="4"]');
// tap "$0" as a person would (its label: the radio itself is hidden), then make sure it took
await p.locator('[data-gm-edit] label.pay-option', { has: p.locator('input[name="gmFee"][value="0"]') }).click();
if (!(await p.$eval('[data-gm-edit] input[name="gmFee"][value="0"]', (i) => i.checked))) throw new Error('The $0 fee did not select');
b = apiLog.length;
await p.click('[data-gm-edit] [type="submit"]');
await p.waitForTimeout(1200);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `games/${g.id}/edit`);
const edited = call ? JSON.parse(call.text) : {};
check(`${L}: edit the session: new title, no GM fee, $10 a seat`, call?.status === 200 && edited.game?.title === `${g.title} (edited)` && edited.game.gmFee === 0 && edited.game.seatPrice === 1000, call ? call.text.slice(0, 200) : 'no call');
const head = await text(p, '[data-gm-head]');
check(`${L}: the manager shows it`, /\(edited\)/.test(head) && /\$10 a seat/.test(head), head);
// cancel this session (two taps)
await p.evaluate(() => { const d = document.querySelector('[data-gm-cancel-wrap]'); d.open = true; });
await p.click(`[data-gm-cancel="session"][data-id="${g.id}"]`);
b = apiLog.length;
await p.click(`[data-gm-cancel="session"][data-id="${g.id}"]`);
await p.waitForTimeout(1500);
call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route === `games/${g.id}/update`);
const res = call ? JSON.parse(call.text) : {};
check(`${L}: cancel: two taps, the game and both seats are cancelled, nobody had paid`, call?.status === 200 && res.game?.status === 'cancelled' && res.affected === 2 && res.refunds === 0, call ? call.text.slice(-120) : 'no call');
const toast = await text(p, '.toast');
check(`${L}: the toast says what happened, and no refunds are due`, /Session cancelled, along with 2 player bookings\./.test(toast) && !/refund/i.test(toast), toast);
check(`${L}: no sideways scroll`, (await overflow(p)) <= 0, await overflow(p));
check(`${L}: no script errors`, p.problems.length === 0, p.problems.join(' | '));
await stop();
process.exit(summary() ? 1 : 0);
