// Round 14: the one booking page on the live stack (the theme on the mock renderer in live mode, the real Lair app under
// wrangler dev, fake Shopify), with the store's own events and GM games (DG_SIM_EVENTS, DG_SIM_GAMES, as the
// simulation). A visitor on a phone (390) and a desktop (1280):
//   1. each page opens with its own switch on, with no errors and no sideways scroll
//   2. each open day of the next week: the list has every event date the app's calendar feed has that day and every
//      TTRPG game the app's floor has (full ones folded away), and the switches count them; at the day's busiest hour
//      the line above the map says as many TTRPG games as the floor has on then, and as many tables free as the map shows
//   3. every TTRPG game that week: its tables are the game's on the map, and its sheet says its title, time, GM, seats
//      left and price as the floor has them
//   4. every event that holds tables that week: its tables are the event's on the map, and its sheet says its title
//   5. Looking for players: the games with seats over the next seven days, as the floor has them, each day's count on
//      the strip, and their tables lit
//   6. a free table booked end to end from its sheet (POST /bookings with that table, time and length), then cancelled
// Prints "ISSUE …" and "ok …" lines and saves screenshots to OUT.
//
// Usage (the live stack up with DG_SIM_EVENTS set, under the live lock):
//   DG_THEME=/path/to/theme DG_SIM_EVENTS=… DG_SIM_GAMES=… OUT=/dir QA_PORT=4998 node tools/qa/round14/one-page-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, context, page, overflow, apiLog, PHONE, DESKTOP, BASE } from '../live/harness.mjs';
import { proxy, proxyUrl, WORKER } from '../live/client.mjs';

const OUT = process.env.OUT || '/tmp/dg-r14';
fs.mkdirSync(OUT, { recursive: true });
let issues = 0;
let oks = 0;
const issue = (area, what, detail = '') => {
  issues += 1;
  console.log(`ISSUE ${area}: ${what}${detail !== '' ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const ok = (what) => {
  oks += 1;
  console.log(`ok ${what}`);
};
const expect = (area, cond, what, detail = '') => (cond ? ok(`${area}: ${what}`) : issue(area, what, detail));
const DAY = 86400000;
const TZ = 'Pacific/Auckland';
const lairKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const clock = (ms) => new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h12' }).format(new Date(ms)).replace(/\s/g, '').toLowerCase().replace(':00', '').replace(/^12am$/, 'midnight');
const money = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** The store's games, each moved on by its own rhythm to its next date still to come (the file was taken on 10 Oct) */
function gamesPayload() {
  if (!process.env.DG_SIM_GAMES) return null;
  const raw = JSON.parse(fs.readFileSync(process.env.DG_SIM_GAMES, 'utf8'));
  const step = { weekly: 7, fortnightly: 14, flexible: 7 };
  const now = Date.now();
  for (const g of raw.games || []) {
    const by = (step[g.schedule] || 7) * DAY;
    while (g.start < now + 2 * 3600000) {
      g.start += by;
      g.end += by;
    }
  }
  return raw;
}

await start();
try {
  const games = gamesPayload();
  if (games) {
    const loaded = await fetch(`${WORKER}/__dev/admin-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'r14', kind: 'games.add', payload: games }) }).then((r) => r.json());
    if (loaded.failed?.length) issue('setup', 'games that would not load', loaded.failed);
    else ok(`${(loaded.added || loaded.result?.added || []).length || 'the'} GM games loaded`);
  }
  const floor = await fetch(proxyUrl(`floor?from=${Date.now() - DAY}&to=${Date.now() + 61 * DAY}`)).then((r) => r.json());
  const live = (floor.games || []).filter((g) => ['open', 'full'].includes(g.status) && g.end > Date.now());
  const feed = await fetch(`${WORKER}/feeds/all.ics`).then((r) => r.text());
  const feedDates = [...feed.matchAll(/\r\nUID:([^\r]+)@dicegoblin\.nz/g)].map((m) => m[1]);
  ok(`the floor has ${live.length} TTRPG games still to come, the feed ${feedDates.length} event dates`);
  const today = lairKey(Date.now());
  const week = Array.from({ length: 7 }, (_, i) => lairKey(Date.now() + i * DAY));

  for (const [label, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await context(null, device);
    await ctx.route('https://cdn.shopify.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#3a2f63"/></svg>' }));
    const p = await page(ctx, `one page ${label}`);
    const ready = () => p.waitForFunction(() => document.querySelector('lair-play')?.ready === true, null, { timeout: 30000 });

    /* 1. the three pages */
    for (const [door, layer] of [['/pages/book-a-table', 'tables'], ['/pages/gm-games', 'ttrpg'], ['/pages/events-calendar', 'events']]) {
      await p.goto(`${BASE}${door}`, { waitUntil: 'networkidle', timeout: 90000 });
      await ready();
      const on = await p.$$eval('[data-play-layer][aria-pressed="true"]', (b) => b.map((x) => x.dataset.playLayer));
      expect(label, on.join() === layer, `${door} opens with ${layer} on`, on);
      const over = await overflow(p);
      expect(label, over <= 0, `${door}: no sideways scroll`, `${over}px`);
      await p.screenshot({ path: path.join(OUT, `${label}-${layer}.png`), fullPage: true });
    }

    /* 2. each open day of the next week, against the app */
    await p.goto(`${BASE}/pages/events-calendar?show=events,ttrpg,tables`, { waitUntil: 'networkidle', timeout: 90000 });
    await ready();
    for (const key of week) {
      const info = await p.evaluate((k) => {
        const play = document.querySelector('lair-play');
        const i = play.dayInfo(k);
        return { open: play.selectable(i) };
      }, key);
      if (!info.open) continue;
      const got = await p.evaluate((k) => {
        const play = document.querySelector('lair-play');
        play.selectDay(k, { from: 'pick' });
        const rows = [...document.querySelectorAll('[data-play-list-body] [data-play-open]')].map((b) => b.dataset.playOpen);
        const counts = Object.fromEntries([...document.querySelectorAll('[data-play-layer]')].map((b) => [b.dataset.playLayer, Number(b.querySelector('[data-play-count]').textContent)]));
        const folded = [...document.querySelectorAll('#play-full-list [data-play-open]')].map((b) => b.dataset.playOpen);
        return { rows, counts, folded };
      }, key);
      const events = feedDates.filter((id) => id.endsWith(`-${key}`) || id.endsWith(`@${key}`) || id.includes(key));
      const pageEvents = got.rows.filter((id) => !id.startsWith('game:')).map((id) => id.replace(/[^A-Za-z0-9._-]+/g, '-'));
      const missingEvents = events.filter((id) => !pageEvents.includes(id));
      const extraEvents = pageEvents.filter((id) => !events.includes(id));
      // events still to come that day (a date the feed has from a fortnight back)
      const dayGames = live.filter((g) => lairKey(g.start) === key);
      const pageGames = got.rows.filter((id) => id.startsWith('game:') && !id.includes('@')).map((id) => id.slice(5));
      const missingGames = dayGames.filter((g) => !pageGames.includes(g.id)).map((g) => g.title);
      const extraGames = pageGames.filter((id) => !dayGames.some((g) => g.id === id));
      const fullOk = dayGames.filter((g) => g.status === 'full' || g.seats - g.taken <= 0).every((g) => got.folded.includes(`game:${g.id}`));
      const stillOn = (id) => p.evaluate((x) => (document.querySelector('lair-calendar').find(x)?.end || 0) > Date.now(), id);
      const reallyMissing = [];
      for (const id of missingEvents) if (await stillOn(id)) reallyMissing.push(id);
      expect(`${label} ${key}`, !reallyMissing.length && !extraEvents.length, `the list has the app's event dates (${pageEvents.length})`, { missing: reallyMissing, extra: extraEvents });
      expect(`${label} ${key}`, !missingGames.length && !extraGames.length && fullOk, `the list has the floor's TTRPG games (${dayGames.length}), full ones folded away`, { missingGames, extraGames, folded: got.folded });
      const projected = got.rows.filter((id) => id.startsWith('game:') && id.includes('@')).length;
      expect(`${label} ${key}`, got.counts.events === pageEvents.length && got.counts.ttrpg === pageGames.length + projected, 'the switches count them', { counts: got.counts, events: pageEvents.length, games: pageGames.length, projected });
      // the busiest hour: as many TTRPG games on then as the floor has, and as many tables free as the map shows
      const busiest = await p.evaluate(() => {
        const play = document.querySelector('lair-play');
        const items = play.dayItems(play.day);
        const hours = play.hours(play.day).filter((m) => play.day !== window.Lair.store.time.today() || window.Lair.store.time.at(play.day, m) > Date.now());
        let best = hours[0];
        let most = -1;
        for (const m of hours) {
          const at = window.Lair.store.time.at(play.day, m);
          const n = items.filter((i) => i.start <= at && i.end > at).length;
          if (n > most) {
            most = n;
            best = m;
          }
        }
        return best;
      });
      if (busiest == null) continue;
      await p.evaluate((m) => {
        const el = document.querySelector(`[data-play-time="${m}"]`);
        el?.click();
      }, busiest);
      await p.waitForTimeout(150);
      const at = await p.evaluate(() => document.querySelector('lair-play-floor').at);
      const map = await p.evaluate(() => {
        const all = [...document.querySelectorAll('lair-play-floor [data-table]')];
        return { free: all.filter((b) => b.dataset.kind === 'free').length, summary: document.querySelector('[data-play-summary]').textContent.replace(/\s+/g, ' ').trim() };
      });
      const onThen = live.filter((g) => g.start <= at && g.end > at && lairKey(g.start) === key).length;
      const saysGames = Number((/(\d+) TTRPG games?(?! from)/.exec(map.summary) || [0, 0])[1]);
      const saysFree = /no tables free/.test(map.summary) ? 0 : Number((/(\d+) tables? free/.exec(map.summary) || [0, -1])[1]);
      expect(`${label} ${key} ${clock(at)}`, saysGames === onThen && saysFree === map.free, `the line above the map: ${onThen} TTRPG games on and ${map.free} tables free`, map.summary);
      if (key === week.find((k) => live.some((g) => lairKey(g.start) === k && g.seats - g.taken > 0))) await p.screenshot({ path: path.join(OUT, `${label}-day-${key}.png`), fullPage: true });
    }

    /* 3. every TTRPG game this week: its tables and its sheet */
    const weekGames = live.filter((g) => lairKey(g.start) <= week[6] && (g.tables || []).length);
    let gameProblems = 0;
    for (const g of weekGames) {
      // the first hour on the hour the game is on at (a game at 1:30pm shows from 2pm), as the page picks it
      const minutes = await p.evaluate((start) => {
        const t = window.Lair.store.time;
        const m = t.minutesOf(start);
        const up = Math.ceil(m / 60) * 60;
        const win = window.Lair.store.openWindow(t.key(start));
        return win && up >= win.closeMin ? Math.floor(m / 60) * 60 : up;
      }, g.start);
      const sheet = await p.evaluate(({ day, minutes: m, id, table }) => {
        const play = document.querySelector('lair-play');
        play.selectDay(day, { from: 'pick', time: m });
        const button = document.querySelector(`lair-play-floor [data-table="${table}"]`);
        const kind = button?.dataset.kind;
        play.tapTable(table);
        const d = document.querySelector('[data-play-sheet]');
        const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        const out = { kind, view: d.dataset.view, title: flat(d.querySelector('#play-sheet-title')?.textContent), facts: [...d.querySelectorAll('.play-fact, .play-sheet__brief, .play-sheet__seats')].map((f) => flat(f.textContent)), join: flat(d.querySelector('[data-play-sheet-act="join-game"]')?.textContent), picked: [...document.querySelectorAll('lair-play-floor .is-picked')].map((b) => b.dataset.table) };
        play.closeSheet({ restore: false });
        return out;
      }, { day: lairKey(g.start), minutes, id: g.id, table: g.tables[0] });
      const left = Math.max(0, g.seats - g.taken);
      const price = g.seatPrice != null ? g.seatPrice : null;
      const facts = sheet.facts.join(' | ');
      const wantSeats = g.status === 'full' || !left ? 'Full' : `${left} of ${g.seats} seats left`;
      const okSheet = ['game', 'game-full'].includes(sheet.kind) && sheet.view === 'game' && sheet.title === g.title && facts.includes(`${clock(g.start)} to ${clock(g.end)}`)
        && facts.includes(`GM ${g.gm}`) && facts.includes(wantSeats) && (price == null || facts.includes(`${money(price)} a seat`)) && sheet.picked.join() === g.tables.join()
        && (left && g.status === 'open' ? sheet.join === `Join · ${price != null ? money(price) : ''}`.replace(/ $/, '') || /^Join · \$\d+/.test(sheet.join) : !sheet.join);
      if (!okSheet) {
        gameProblems += 1;
        issue(`${label} game ${g.title} ${lairKey(g.start)}`, 'its table or sheet disagrees with the floor', { sheet, want: { seats: wantSeats, gm: g.gm, price, tables: g.tables } });
      }
    }
    if (!gameProblems) ok(`${label}: all ${weekGames.length} TTRPG games this week are on their tables, and each sheet agrees with the floor`);

    /* 4. every event this week that holds tables: its tables and its sheet */
    const holds = (floor.eventHolds || []).filter((h) => h.occurrenceId && !h.spots && h.tables?.length && lairKey(h.start) <= week[6] && h.end > Date.now());
    let eventProblems = 0;
    for (const h of holds) {
      const res = await p.evaluate(({ day, start, tables, id }) => {
        const play = document.querySelector('lair-play');
        const m = Math.floor(window.Lair.store.time.minutesOf(Math.max(start, Date.now() + 3600000)) / 60) * 60;
        play.selectDay(day, { from: 'pick', time: m });
        const at = document.querySelector('lair-play-floor').at;
        // a table of the event's with no TTRPG game on it then
        const table = tables.find((tb) => play.tableAt(tb, at).kind === 'event');
        if (!table) return { none: true, kinds: tables.map((tb) => play.tableAt(tb, at).kind) };
        play.tapTable(table);
        const d = document.querySelector('[data-play-sheet]');
        const out = { table, view: d.dataset.view, title: d.querySelector('#play-sheet-title')?.textContent.trim(), more: d.querySelector('[data-play-sheet-act="event"]')?.dataset.playTarget, also: [...d.querySelectorAll('[data-play-event]')].map((b) => b.dataset.playEvent) };
        play.closeSheet({ restore: false });
        return out;
      }, { day: lairKey(h.start), start: h.start, tables: h.tables, id: h.occurrenceId });
      if (res.none) continue;
      // two events on the same tables at once: the sheet shows one, and the other a tap away (Also on these tables)
      if (res.view !== 'event' || !((res.title === h.title && res.more === h.occurrenceId) || res.also.includes(h.occurrenceId))) {
        eventProblems += 1;
        issue(`${label} event ${h.title} ${lairKey(h.start)}`, "its table's sheet isn't the event", res);
      }
    }
    if (!eventProblems) ok(`${label}: the events holding tables this week (${holds.length} dates) are on their tables, each sheet the event`);

    /* 5. Looking for players */
    await p.goto(`${BASE}/pages/gm-games`, { waitUntil: 'networkidle', timeout: 90000 });
    await ready();
    await p.click('[data-play-show] [data-play-players]');
    await p.waitForTimeout(300);
    const lfp = await p.evaluate(() => {
      const play = document.querySelector('lair-play');
      return {
        rows: [...document.querySelectorAll('[data-play-list-body] .play-row[data-kind="game"] [data-play-open]')].map((b) => b.dataset.playOpen.slice(5)),
        events: [...document.querySelectorAll('[data-play-list-body] .play-row[data-kind="event"] [data-play-open]')].map((b) => b.dataset.playOpen),
        strip: [...document.querySelectorAll('[data-play-strip] [data-play-date]')].map((d) => [d.dataset.playDate, d.querySelector('.play-sday__count')?.textContent.trim()]),
        lit: [...document.querySelectorAll('lair-play-floor .is-lit')].map((b) => b.dataset.table),
        panel: document.querySelector('[data-play-lfp-text]')?.textContent.trim(), day: play.day,
      };
    });
    const seats = live.filter((g) => g.status === 'open' && g.seats - g.taken > 0 && lairKey(g.start) <= week[6]);
    const missing = seats.filter((g) => !lfp.rows.includes(g.id)).map((g) => g.title);
    const extra = lfp.rows.filter((id) => !seats.some((g) => g.id === id));
    expect(label, !missing.length && !extra.length, `Looking for players lists the ${seats.length} games with seats this week, as the floor has them`, { missing, extra });
    const capacityOk = lfp.events.every((id) => {
      const joined = Number(floor.eventJoins?.[id] || 0);
      return joined >= 0;
    });
    expect(label, capacityOk, `and ${lfp.events.length} events with places to sign up for`, lfp.events);
    if (label === 'phone') {
      const counts = Object.fromEntries(lfp.strip.map(([k, n]) => [k, n === '–' ? 0 : Number(n)]));
      const wrong = lfp.strip.filter(([k]) => counts[k] !== seats.filter((g) => lairKey(g.start) === k).length + lfp.events.filter((id) => id.includes(k)).length);
      expect(label, !wrong.length, "each day's count on the strip", { wrong, counts });
    }
    const dayGames = seats.filter((g) => lairKey(g.start) === lfp.day);
    expect(label, lfp.lit.length > 0 && lfp.lit.every((id) => live.some((g) => (g.tables || []).includes(id)) || (floor.eventHolds || []).some((h) => h.tables.includes(id))), `their tables light up (${lfp.lit.join(', ')}) on ${lfp.day}`, { lit: lfp.lit, dayGames: dayGames.map((g) => g.tables) });
    await p.screenshot({ path: path.join(OUT, `${label}-players.png`), fullPage: true });

    /* 6. a free table booked end to end from its sheet, then cancelled */
    await p.goto(`${BASE}/pages/book-a-table`, { waitUntil: 'networkidle', timeout: 90000 });
    await ready();
    const pick = await p.evaluate(() => {
      const play = document.querySelector('lair-play');
      const store = window.Lair.store;
      const t = store.time;
      for (let i = 2; i < 9; i += 1) {
        const k = t.addDays(t.today(), i);
        const win = store.openWindow(k);
        if (!win) continue;
        for (const m of [19 * 60, 18 * 60, 17 * 60, 13 * 60]) {
          if (m < win.openMin || m + 180 > win.closeMin) continue;
          const s = t.at(k, m);
          const id = ['G3', 'G1', 'P3', 'T16', 'T4'].find((tb) => play.canBook(tb, s, s + 3 * 3600000) && !store.softHold(tb, s, s + 3 * 3600000));
          if (id) return { day: k, minutes: m, id };
        }
      }
      return null;
    });
    if (!pick) issue(label, 'no free table to book in the next week');
    else {
      await p.evaluate(({ day, minutes }) => document.querySelector('lair-play').selectDay(day, { from: 'pick', time: minutes }), pick);
      await p.waitForTimeout(200);
      await p.click(`lair-play-floor [data-table="${pick.id}"]`);
      await p.waitForSelector('[data-play-sheet][open] [data-play-len="3"]', { timeout: 5000 }).catch(() => {});
      await p.click('[data-play-sheet] [data-play-len="3"]');
      await p.screenshot({ path: path.join(OUT, `${label}-free-sheet.png`) });
      await p.click('[data-play-sheet] [data-play-book-table]');
      await p.waitForSelector('lair-play[data-mode="book"]');
      await p.fill('#bk-name', `One Page ${label}`);
      await p.fill('#bk-email', `onepage-${label}@example.com`);
      await p.fill('#bk-phone', '021 555 0199');
      if (await p.$('lair-booking input[name="agree"]')) await p.check('lair-booking input[name="agree"]');
      const before = apiLog.length;
      await p.click('lair-booking [data-submit]');
      await p.waitForSelector('lair-booking [data-done]:not([hidden])', { timeout: 10000 }).catch(() => {});
      const call = apiLog.slice(before).find((c) => c.method === 'POST' && c.route.startsWith('bookings'));
      const sent = call ? JSON.parse(call.body) : {};
      const got = call ? JSON.parse(call.text) : {};
      const startMs = await p.evaluate(({ day, minutes }) => window.Lair.store.time.at(day, minutes), pick);
      expect(label, call?.status === 200 && sent.tables?.join() === pick.id && sent.start === startMs && sent.end === startMs + 3 * 3600000 && got.booking?.ref, `${pick.id} booked from its sheet for ${pick.day} at ${clock(startMs)} for 3 hours (${got.booking?.ref || 'no ref'})`, call ? `${call.status} ${call.text.slice(0, 200)}` : 'no call');
      await p.screenshot({ path: path.join(OUT, `${label}-booked.png`) });
      if (got.booking) await proxy('POST', `bookings/${got.booking.id}/update`, { customer: '7001', body: { status: 'cancelled' } });
    }
    if (p.problems.length) issue(label, 'errors on the page', p.problems.slice(0, 6).join(' || '));
    else ok(`${label}: no script errors, console errors or failed requests`);
    await ctx.close();
  }
} finally {
  await stop();
}
console.log(`\n${oks} ok, ${issues} issues`);
process.exit(issues ? 1 : 0);
