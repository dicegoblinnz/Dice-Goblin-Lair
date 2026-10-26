// 27 Oct 2026 (contract v21-tables): a session's new tables for its later sessions too, on the theme mock (demo mode).
// Mo: "I want there to be an option for games when they change Thier table location they keep that location for the
// future sessions".
//  1. The staff page, a weekly game's second session, Edit this session, When and where: picking another table shows
//     "These tables for later sessions too?" with "This and every later session" picked; nothing changed, it's hidden.
//  2. Save: the session and every later one move (seats with them), except the one whose new table is taken that day,
//     which keeps its own; the toast says how many moved, and a note names the one that couldn't (Done puts it away).
//  3. "Just this session": the session moves alone (the second again: later ones are past Coming up's two weeks).
//  4. After the review: a save that never touches the tables moves nothing (the session set apart stays apart, later
//     ones stay); the note's Manage opens the one that couldn't move, its choice starts on "Just this session", and once
//     it has its own table it's off the note.
//  5. After the second check: a game whose sessions were all moved by hand (the game still keeping its old tables)
//     starts on "This and every later session"; its note sits beside the other game's, and Done puts away its own.
//  6. After the third check: the first of a run of sessions at the end that couldn't move, given its own table, starts
//     on "Just this session" (the game's tables are still on its sessions to come).
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
const FRIDAY = 'sr-r21-friday';
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
  // Friday Quest: five Fridays from tomorrow on, every one moved by hand to G2 while the game still keeps G1 (from
  // before Edit session could carry tables on), and G4 booked on the fourth
  let friday = t.addDays(t.today(), 1);
  while (new Date(`${friday}T12:00:00Z`).getUTCDay() !== 5) friday = t.addDays(friday, 1);
  be.state.games = be.state.games.filter((g) => g.seriesId !== 'sr-r21-friday');
  for (let i = 0; i < 5; i += 1) {
    const key = t.addDays(friday, i * 7);
    const start = t.at(key, 18 * 60);
    const end = t.at(key, 22 * 60);
    const id = `gm-r21f-${i + 1}`;
    be.state.games.push({
      id, title: 'Friday Quest', system: 'Pathfinder 2E', gm: 'Ana', gmCustomerId: 'demo-r21f-ana', gmEmail: 'ana@example.com', blurb: 'A weekly quest.', tables: ['G2'],
      room: 'gaming-room', seats: 4, start, end, taken: 0, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'weekly', seriesId: 'sr-r21-friday',
      level: 'some', age: '13+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
    });
    be.state.bookings.push({
      id: `bk-r21t-fgm-${i + 1}`, ref: `GM-R21F-${i + 1}`, kind: 'gm', gameId: id, tables: ['G2'], start, end, people: 5, name: 'GM Ana', status: 'confirmed', pay: 'day', paid: true,
      activity: 'rpg', extras: [], customerId: 'demo-r21f-ana',
    });
    if (i === 3) {
      be.state.bookings.push({
        id: 'bk-r21t-g4', ref: 'R21T-G4', kind: 'table', tables: ['G4'], start, end, people: 4, name: 'Warhammer night',
        email: 'war@example.com', phone: '', notes: '', status: 'confirmed', pay: 'day', paid: false, amount: 4000, activity: 'wargame', extras: [],
      });
    }
  }
  be.state.seriesTables = { ...(be.state.seriesTables || {}), 'sr-r21-friday': ['G1'] };
  // Saturday Sorcery: four Saturdays from tomorrow on, on G1, with G3 booked on the third and fourth
  let saturday = t.addDays(t.today(), 1);
  while (new Date(`${saturday}T12:00:00Z`).getUTCDay() !== 6) saturday = t.addDays(saturday, 1);
  be.state.games = be.state.games.filter((g) => g.seriesId !== 'sr-r21-saturday');
  for (let i = 0; i < 4; i += 1) {
    const key = t.addDays(saturday, i * 7);
    const start = t.at(key, 14 * 60);
    const end = t.at(key, 18 * 60);
    const id = `gm-r21s-${i + 1}`;
    be.state.games.push({
      id, title: 'Saturday Sorcery', system: 'D&D 5e', gm: 'Ria', gmCustomerId: 'demo-r21s-ria', gmEmail: 'ria@example.com', blurb: 'A weekly spellslinging game.', tables: ['G1'],
      room: 'gaming-room', seats: 4, start, end, taken: 0, status: 'open', credited: null, gmFee: 500, seatPrice: 1500, schedule: 'weekly', seriesId: 'sr-r21-saturday',
      level: 'some', age: '13+', tags: [], safety: [], characters: 'pregens', bring: '', contentNotes: '', sessionZero: '', image: null, gmFeeApproved: true,
    });
    be.state.bookings.push({
      id: `bk-r21t-sgm-${i + 1}`, ref: `GM-R21S-${i + 1}`, kind: 'gm', gameId: id, tables: ['G1'], start, end, people: 5, name: 'GM Ria', status: 'confirmed', pay: 'day', paid: true,
      activity: 'rpg', extras: [], customerId: 'demo-r21s-ria',
    });
    if (i >= 2) {
      be.state.bookings.push({
        id: `bk-r21t-sg3-${i + 1}`, ref: `R21T-SG3-${i + 1}`, kind: 'table', tables: ['G3'], start, end, people: 4, name: 'Board game club',
        email: 'club@example.com', phone: '', notes: '', status: 'confirmed', pay: 'day', paid: false, amount: 4000, activity: 'board', extras: [],
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

/** The staff page's list of GM games (back from a game's own page, if that's open) */
async function toList(page) {
  await page.click('[data-tab="games"]');
  await settle(page, 200);
  if (await page.locator('[data-panel="games"] [data-gm-back]').count()) {
    await page.click('[data-panel="games"] [data-gm-back]');
    await settle(page, 250);
  }
}

/** The staff page on a session's Edit this session, at When and where */
async function openEdit(page, id) {
  await toList(page);
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
  check(`${tag} The note: Thursday Tables, 1 session couldn't move to G3, the fourth's date and time, kept G1, why, and Manage`,
    /Thursday Tables: 1 session couldn’t move to G3/.test(note) && /at 6/.test(note) && /kept G1/.test(note) && /Table G3 is already taken at that time/.test(note) && !/Pick another/.test(note)
    && (await page.locator(`[data-gm-head] .staff-tables-note [data-gm-manage="${fourth}"]`).count()) === 1, note);
  await shot(page, `${size}-2-note`, '[data-gm-head] .staff-card--decide');
  await axe(page, `${tag} the game's page with the note`, '[data-panel="games"]');
  await page.click('[data-gm-back]');
  await settle(page, 300);
  const listNote = flat(await page.locator('[data-panel="games"] .staff-card--decide').first().innerText().catch(() => ''));
  check(`${tag} The note is on the list of games too`, /Thursday Tables: 1 session couldn’t move to G3/.test(listNote), listNote);
  // (Done comes last: the note's Manage is checked first, in part 4)

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

  /* ---------- 4. after the review ---------- */
  // the second is set apart now (G4, the game keeps G3): a save that never opens When and where moves nothing
  const sent = [];
  await page.exposeFunction('r21tSent', (body) => sent.push(body)).catch(() => {});
  await page.evaluate(() => {
    const be = window.Lair.store.backend;
    const real = be.editGame.bind(be);
    be.editGame = (id, input) => {
      window.r21tSent(JSON.parse(JSON.stringify(input)));
      return real(id, input);
    };
  });
  await toList(page);
  await page.waitForSelector(`.staff-gm-row[data-gm-manage="${second}"]`, { timeout: 15000 });
  await page.click(`.staff-gm-row[data-gm-manage="${second}"]`);
  await page.waitForSelector('[data-panel="games"] .staff-gm__more summary', { timeout: 15000 });
  await settle(page, 200);
  await page.click('[data-panel="games"] .staff-gm__more summary');
  await page.waitForSelector(`${E} [data-host-form]`, { timeout: 15000 });
  await page.fill(`${E} #gm-edit-title`, 'Thursday Tables (new name)');
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  tables = await tablesOf(page, ids);
  check(`${tag} A save that only renames moves no tables, and sends none`, JSON.stringify(tables) === JSON.stringify(['G1', 'G4', 'G3', 'G1', 'G3']) && sent.length === 1 && !('tables' in sent[0]) && !('tablesScope' in sent[0]), { tables, sent });
  /* ---------- 5. a game whose sessions were all moved by hand ---------- */
  const fridays = ['gm-r21f-1', 'gm-r21f-2', 'gm-r21f-3', 'gm-r21f-4', 'gm-r21f-5'];
  await openEdit(page, fridays[1]);
  await tapTable(page, 'G2');
  await tapTable(page, 'G4');
  await settle(page, 250);
  box = await laterBox(page);
  check(`${tag} Friday Quest (every session on G2 by hand, the game keeping G1), given G4: the choice starts on This and every later session`, box && !box.hidden && box.checked === 'series', box);
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  const fridayTables = await tablesOf(page, fridays);
  check(`${tag} Friday Quest: the second and later ones on G4, except the fourth (G4 booked); the first stays on G2`, JSON.stringify(fridayTables) === JSON.stringify(['G2', 'G4', 'G4', 'G2', 'G4']), fridayTables);
  await toList(page);
  const notes = await page.evaluate(() => [...document.querySelectorAll('[data-panel="games"] .staff-tables-note')].map((n) => String(n.textContent || '').replace(/\s+/g, ' ').trim()));
  check(`${tag} Both games' notes on the list: Thursday's still there beside Friday's`, notes.length === 2 && notes.some((n) => /^Thursday Tables/.test(n)) && notes.some((n) => /^Friday Quest/.test(n)), notes);

  // the note's Manage opens the fourth (past Coming up's two weeks); its choice starts on Just this session (it's set apart)
  await toList(page);
  await page.waitForSelector(`[data-panel="games"] .staff-tables-note [data-gm-manage="${fourth}"]`, { timeout: 15000 });
  await page.click(`[data-panel="games"] .staff-tables-note [data-gm-manage="${fourth}"]`);
  await page.waitForSelector('[data-panel="games"] .staff-gm__more summary', { timeout: 15000 });
  await settle(page, 200);
  await page.click('[data-panel="games"] .staff-gm__more summary');
  await page.waitForSelector(`${E} [data-host-form]`, { timeout: 15000 });
  await page.click(`${E} [data-sf-step="3"]`);
  await page.waitForSelector(`${E} [data-step="when"]`, { timeout: 15000 });
  await settle(page, 300);
  // (a gaming room table free then, other than G1 and G3)
  const spare = await page.evaluate((id) => {
    const { store } = window.Lair;
    const g = store.data.games.find((x) => x.id === id);
    const map = [...document.querySelectorAll('[data-gm-edit-wrap] lair-session-form gm-floor [data-table]')].map((b) => [b.dataset.table, b.dataset.status || b.className]);
    const free = ['G2', 'G4'].find((t) => store.isFree(t, g.start, g.end));
    return { free, map: map.filter(([t]) => /^G/.test(t)) };
  }, fourth);
  await tapTable(page, 'G1');
  await tapTable(page, spare.free);
  await settle(page, 250);
  box = await laterBox(page);
  check(`${tag} The one that couldn't move, given ${spare.free}: the choice shows, starting on Just this session`, box && !box.hidden && box.checked === 'session', { box, spare });
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  tables = await tablesOf(page, ids);
  check(`${tag} It moves alone to ${spare.free}; the later ones stay on G3`, JSON.stringify(tables) === JSON.stringify(['G1', 'G4', 'G3', spare.free, 'G3']), tables);
  check(`${tag} And it's off its note (Thursday's is gone: it was the only one)`, (await page.locator('.staff-tables-note').filter({ hasText: 'Thursday Tables' }).count()) === 0);
  await toList(page);
  check(`${tag} Friday's note is still on the list`, (await page.locator('[data-panel="games"] .staff-tables-note').filter({ hasText: 'Friday Quest' }).count()) === 1);
  await page.click(`[data-panel="games"] [data-tables-note-done="${FRIDAY}"]`);
  await settle(page, 300);
  check(`${tag} Done puts Friday's note away`, (await page.locator('.staff-tables-note').count()) === 0);

  /* ---------- 6. the first of a run of sessions at the end that couldn't move ---------- */
  const saturdays = ['gm-r21s-1', 'gm-r21s-2', 'gm-r21s-3', 'gm-r21s-4'];
  await openEdit(page, saturdays[1]);
  await tapTable(page, 'G1');
  await tapTable(page, 'G3');
  await settle(page, 250);
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  let satTables = await tablesOf(page, saturdays);
  check(`${tag} Saturday Sorcery to G3 from its second: the third and fourth (G3 booked) keep G1`, JSON.stringify(satTables) === JSON.stringify(['G1', 'G3', 'G1', 'G1']), satTables);
  await toList(page);
  await page.click(`[data-panel="games"] .staff-tables-note [data-gm-manage="${saturdays[2]}"]`);
  await page.waitForSelector('[data-panel="games"] .staff-gm__more summary', { timeout: 15000 });
  await settle(page, 200);
  await page.click('[data-panel="games"] .staff-gm__more summary');
  await page.waitForSelector(`${E} [data-host-form]`, { timeout: 15000 });
  await page.click(`${E} [data-sf-step="3"]`);
  await page.waitForSelector(`${E} [data-step="when"]`, { timeout: 15000 });
  await settle(page, 300);
  const satSpare = await page.evaluate((id) => {
    const { store } = window.Lair;
    const g = store.data.games.find((x) => x.id === id);
    return ['G4', 'G2'].find((tb) => store.isFree(tb, g.start, g.end));
  }, saturdays[2]);
  await tapTable(page, 'G1');
  await tapTable(page, satSpare);
  await settle(page, 250);
  box = await laterBox(page);
  check(`${tag} The first of the two that couldn't move, given ${satSpare}: the choice starts on Just this session`, box && !box.hidden && box.checked === 'session', box);
  await page.click(`${E} [data-sf-save]`);
  await settle(page, 900);
  satTables = await tablesOf(page, saturdays);
  const satKept = await page.evaluate(() => window.Lair.store.backend.seriesTablesDemo('sr-r21-saturday'));
  check(`${tag} It moves alone; the fourth stays on G1, and the game still keeps G3`, JSON.stringify(satTables) === JSON.stringify(['G1', 'G3', satSpare, 'G1']) && JSON.stringify(satKept) === JSON.stringify(['G3']), { satTables, satKept });
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
