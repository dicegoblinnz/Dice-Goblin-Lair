// 27 Oct 2026 (contract v21-tables): a session's new tables for its later sessions too, on the theme mock (demo mode).
// Mo: "I want there to be an option for games when they change Thier table location they keep that location for the
// future sessions".
//  1. The staff page, a weekly game's second session, Edit this session, When and where: picking another table shows
//     "These tables for later sessions too?" with "This and every later session" picked; nothing changed, it's hidden.
//  2. Save: the session and every later one move (seats with them), except the one whose new table is taken that day,
//     which keeps its own; the toast says how many moved, and a note names the one that couldn't (Done puts it away).
//  3. "Just this session": the session moves alone (the second again: later ones are past Coming up's two weeks).
// No sideways scroll and axe at each. Phone and desktop.
// Usage: DG_THEME=/path/to/theme [PORT=4991] [AXE=/path/to/axe.min.js] [OUT=dir] node tools/qa/round21/tables-later.mjs [phone|desktop]
import os from 'node:os';
import path from 'node:path';

process.env.OUT = process.env.OUT || path.join(os.tmpdir(), 'dg-round21-tables');
const lib = await import('../round15/lib.mjs');
const { chromium, m, check, totals, flat, overflowX, axe, shot, context, watch, go, STAFF } = lib;
const PORT = Number(process.env.PORT || 4991);
const BASE = `http://localhost:${PORT}`;
const sizes = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const SERIES = 'sr-r21-tables';
const E = '[data-gm-edit-wrap] lair-session-form';

const server = await m.serve(PORT);
const browser = await chromium.launch();
const settle = (page, ms = 350) => page.waitForTimeout(ms);

/** The demo: a weekly game, five Thursdays 6pm to 10pm from tomorrow on (so the second is in Coming up's two weeks), on
    Table G1; Kai on the third; G3 booked on the fourth */
const seed = (page) => page.evaluate(async (seriesId) => {
  const { store } = window.Lair;
  const be = store.backend;
  const t = store.time;
  let day = t.addDays(t.today(), 1);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 4) day = t.addDays(day, 1);
  be.state.games = be.state.games.filter((g) => g.seriesId !== seriesId);
  be.state.bookings = be.state.bookings.filter((b) => !String(b.id).startsWith('bk-r21t'));
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const key = t.addDays(day, i * 7);
    const start = t.at(key, 18 * 60);
    const end = t.at(key, 22 * 60);
    const id = `gm-r21t-${i + 1}`;
    ids.push(id);
    be.state.games.push({
      id, title: 'Thursday Tables', system: 'D&D 5e', gm: 'Dan', gmCustomerId: 'demo-r21t-dan', gmEmail: 'dan@example.com', blurb: 'A weekly campaign.', tables: ['G1'],
      room: 'gaming-room', seats: 4, start, end, taken: i === 2 ? 1 : 0, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'weekly', seriesId,
      level: 'some', age: '13+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
    });
    be.state.bookings.push({
      id: `bk-r21t-gm-${i + 1}`, ref: `GM-R21T-${i + 1}`, kind: 'gm', gameId: id, tables: ['G1'], start, end, people: 5, name: 'GM Dan', status: 'confirmed', pay: 'day', paid: true,
      activity: 'rpg', extras: [], customerId: 'demo-r21t-dan',
    });
    if (i === 2) {
      be.state.bookings.push({
        id: 'bk-r21t-kai', ref: 'R21T-KAI', kind: 'gm-seat', gameId: id, tables: ['G1'], start, end, people: 1, players: [{ name: 'Kai', character: '' }], name: 'Kai',
        email: 'kai@example.com', phone: '', notes: '', status: 'confirmed', pay: 'day', paid: false, paidAmount: 0, amount: 1500, activity: 'rpg', extras: [], customerId: 'demo-r21t-kai',
      });
    }
    if (i === 3) {
      be.state.bookings.push({
        id: 'bk-r21t-g3', ref: 'R21T-G3', kind: 'table', tables: ['G3'], start: start - 3600000, end: start + 3 * 3600000, people: 4, name: 'Board game night',
        email: 'board@example.com', phone: '', notes: '', status: 'confirmed', pay: 'day', paid: false, amount: 4000, activity: 'board', extras: [],
      });
    }
  }
  be.commit();
  await store.refresh();
  return ids;
}, SERIES);

const tablesOf = (page, ids) => page.evaluate((list) => list.map((id) => window.Lair.store.backend.state.games.find((g) => g.id === id).tables.join('+')), ids);
const tapTable = (page, id) => page.evaluate(({ scope, id }) => document.querySelector(`${scope} gm-floor [data-table="${id}"]`).click(), { scope: E, id });
const laterBox = (page) => page.evaluate((scope) => {
  const box = document.querySelector(`${scope} [data-later-tables]`);
  if (!box) return null;
  const f = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return { hidden: box.hidden, text: f(box.textContent), checked: (box.querySelector('input:checked') || {}).value || null };
}, E);

/** The staff page on a session's Edit this session, at When and where */
async function openEdit(page, id) {
  await page.click('[data-tab="games"]');
  await page.waitForSelector(`.staff-gm-row[data-gm-manage="${id}"]`, { timeout: 15000 });
  await page.click(`.staff-gm-row[data-gm-manage="${id}"]`);
  await page.waitForSelector('[data-panel="games"] .staff-gm__more summary', { timeout: 15000 });
  await settle(page, 200);
  await page.click('[data-panel="games"] .staff-gm__more summary');
  await page.waitForSelector(`${E} [data-host-form]`, { timeout: 15000 });
  await page.click(`${E} [data-sf-step="3"]`);
  await page.waitForSelector(`${E} [data-step="when"]`, { timeout: 15000 });
  await settle(page, 300);
}

for (const size of sizes) {
  const tag = `[${size}]`;
  m.globalSettings.lair_mode = 'demo';
  const ctx = await context(browser, size);
  const page = watch(await ctx.newPage());
  await go(page, BASE, '/pages/lair-staff', STAFF);
  await page.waitForSelector('#checkin-code', { timeout: 20000 });
  const ids = await seed(page);
  const [first, second, third, fourth, fifth] = ids;

  /* ---------- 1. the choice shows once the tables are new ---------- */
  await openEdit(page, second);
  let box = await laterBox(page);
  check(`${tag} Edit this session, a weekly game's session: no question while the tables are the same`, box && box.hidden, box);
  await tapTable(page, 'G1');
  await tapTable(page, 'G3');
  await settle(page, 250);
  box = await laterBox(page);
  check(`${tag} Picking G3: "These tables for later sessions too?", "This and every later session" picked, naming G3`,
    box && !box.hidden && box.checked === 'series' && /These tables for later sessions too\?/.test(box.text) && /This and every later session/.test(box.text)
    && /Just this session/.test(box.text) && /moves to G3 where it’s free that day/.test(box.text), box);
  await shot(page, `${size}-1-choice`, `${E} [data-later-tables]`);
  await axe(page, `${tag} Edit this session with the later-sessions choice`, `${E} [data-host-form]`);
  check(`${tag} Edit: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));

  /* ---------- 2. this and every later session ---------- */
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  const toast = flat(await page.locator('.toast').innerText().catch(() => ''));
  let tables = await tablesOf(page, ids);
  check(`${tag} Save: the session and every later one move to G3, but the fourth (G3 taken that day) keeps G1; the first is untouched`,
    JSON.stringify(tables) === JSON.stringify(['G1', 'G3', 'G3', 'G1', 'G3']), tables);
  const kai = await page.evaluate(() => window.Lair.store.backend.state.bookings.find((b) => b.id === 'bk-r21t-kai').tables.join('+'));
  const holds = await page.evaluate(() => window.Lair.store.backend.state.bookings.filter((b) => /^bk-r21t-gm-/.test(b.id)).map((b) => b.tables.join('+')));
  check(`${tag} Save: Kai's seat and each GM hold went with their session`, kai === 'G3' && JSON.stringify(holds) === JSON.stringify(['G1', 'G3', 'G3', 'G1', 'G3']), { kai, holds });
  check(`${tag} Save: the toast says 2 later sessions moved, the game keeps G3, and 1 couldn't move`,
    /^Saved\. The GM and every player moved with it\. 2 later sessions moved to G3 too, and the game keeps it from now on\. 1 session couldn’t move: see the note\./.test(toast), toast);
  // (on the game's own page, where the edit was; and on the list of games)
  const note = flat(await page.locator('[data-gm-head] .staff-card--decide').first().innerText().catch(() => ''));
  check(`${tag} The note: Thursday Tables, 1 session couldn't move to G3, the fourth's date, kept G1, and why`,
    /Thursday Tables: 1 session couldn’t move to G3/.test(note) && /kept G1/.test(note) && /Table G3 is already taken at that time/.test(note) && !/Pick another/.test(note), note);
  await shot(page, `${size}-2-note`, '[data-gm-head] .staff-card--decide');
  await axe(page, `${tag} the game's page with the note`, '[data-panel="games"]');
  await page.click('[data-gm-back]');
  await settle(page, 300);
  const listNote = flat(await page.locator('[data-panel="games"] .staff-card--decide').first().innerText().catch(() => ''));
  check(`${tag} The note is on the list of games too`, /Thursday Tables: 1 session couldn’t move to G3/.test(listNote), listNote);
  await page.click('[data-tables-note-done]');
  await settle(page, 300);
  check(`${tag} Done puts the note away`, (await page.locator('[data-tables-note-done]').count()) === 0);

  /* ---------- 3. just this session ---------- */
  await openEdit(page, second);
  await tapTable(page, 'G3');
  await tapTable(page, 'G4');
  await settle(page, 250);
  await page.click(`${E} [name="laterTables"][value="session"]`);
  await settle(page, 150);
  box = await laterBox(page);
  check(`${tag} Picking "Just this session"`, box && !box.hidden && box.checked === 'session', box);
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  const toast2 = flat(await page.locator('.toast').innerText().catch(() => ''));
  tables = await tablesOf(page, ids);
  check(`${tag} Just this session: only the second moves (to G4); the later ones stay on G3`, JSON.stringify(tables) === JSON.stringify(['G1', 'G4', 'G3', 'G1', 'G3']), tables);
  check(`${tag} Just this session: the toast says nothing of later sessions`, /^Saved\. The GM and every player moved with it\.$/.test(toast2), toast2);
  check(`${tag} Staff page: no sideways scroll`, (await overflowX(page)) <= 0, await overflowX(page));
  check(`${tag} No errors`, !page.errors.length, page.errors);
  void first;
  void third;
  void fourth;
  void fifth;
  await ctx.close();
}

await browser.close();
server.close();
const { pass, fail } = totals();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
