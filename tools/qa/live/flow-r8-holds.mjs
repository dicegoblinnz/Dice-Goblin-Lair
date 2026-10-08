// Round 8, holds (contract v8 section 1), HTTP only (no browser), on the real Worker and the fake Admin API: staff table
// holds that repeat weekly or fortnightly, the way TTRPG sessions do (Mo, 6 Oct).
//   1. a weekly hold: one hold a date at the same Lair time, up to the booking horizon plus 7 days; the answer (the first
//      hold, the series, clashes [{ ref, start }] across every date); the staff floor's series fields and the public's
//      labels only; a customer can't book a held date
//   2. the messages, staff only, and a one-off as before (series null, clashes { ref, start })
//   3. skip a date: its tables free up, and maintenance (/setup) never makes it again
//   4. stop from a later date (the series ends the day before, earlier dates stay), then from the first date to come
//   5. a fortnightly hold with a last day
//   6. maintenance tops up: a date just past the horizon when the hold is made is made once the horizon reaches it
// Leaves nothing held behind: every series it makes is stopped by the end.
import fs from 'node:fs';
import path from 'node:path';
import { proxy, check, summary, WORKER } from './client.mjs';
import { key, addDays, at, nextDow, sleep, TZ } from './r6-time.mjs';

const STAFF = '7001';
const SAM = '7101';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACTIVE = ['held', 'confirmed', 'seated'];
const run = Date.now() % 100000;
const today = key(Date.now());
// the booking horizon, as the Lair reads it from the theme (the fake Admin API serves DG_THEME's settings)
const settings = (() => {
  try {
    const text = fs.readFileSync(path.join(process.env.DG_THEME || '', 'config/settings_data.json'), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\//, '');
    const json = JSON.parse(text);
    return (typeof json.current === 'string' ? json.presets?.[json.current] : json.current) || {};
  } catch {
    return {};
  }
})();
const AHEAD = (Number(settings.lair_horizon_days ?? 60) + 7) * DAY;
const said = (res) => `${res.status} ${res.data?.error || ''}`.trim();
const maintenance = async () => (await fetch(`${WORKER}/setup?key=test-setup-key`)).json();
const clockOf = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { h: Number(p.hour) % 24, mi: Number(p.minute) };
};
const staffFloor = async (fromDay, toDay) => (await proxy('GET', `floor?from=${at(fromDay, 0)}&to=${at(addDays(toDay, 1), 0)}`, { customer: STAFF })).data;
const datesOf = (floor, seriesId) => (floor.blocks || []).filter((b) => b.seriesId === seriesId).sort((a, b) => a.start - b.start);
const remove = (id, body = {}, customer = STAFF) => proxy('POST', `blocks/${id}/delete`, { customer, body });

/* 1. A weekly hold */
const TUE = nextDow(2, today, 2);
const ask = { tables: 'P3-P4', start: at(TUE, 18), end: at(TUE, 22), label: `Pokémon league (r8 ${run})`, type: 'tournament', game: 'Pokémon', repeat: 'weekly' };
const days = [];
for (let d = TUE; at(d, 18) <= Date.now() + AHEAD; d = addDays(d, 7)) days.push(d);
const last = days[days.length - 1];
// Sam books P3 on the third Tuesday first: the hold doesn't move him, it says so
const third = days[2];
const sams = await proxy('POST', 'bookings', { customer: SAM, body: { kind: 'table', tables: ['P3'], start: at(third, 19), end: at(third, 21), people: 2, name: 'Sam Jones', email: 'sam@example.com', pay: 'day' } });
check('1: Sam books P3 on a Tuesday before the hold is made', sams.status === 200, sams.data.error);
const before = await staffFloor(TUE, last);
/** What the Lair should list as clashes: active bookings on these tables at any of these times, soonest first */
const clashesIn = (tables, windows) => (before.bookings || [])
  .filter((b) => ACTIVE.includes(b.status) && b.tables.some((t) => tables.includes(t)) && windows.some(([s, e]) => b.start < e && s < b.end))
  .map((b) => ({ ref: b.ref, start: b.start }))
  .sort((a, b) => a.start - b.start || a.ref.localeCompare(b.ref));
const expected = clashesIn(['P3', 'P4'], days.map((d) => [at(d, 18), at(d, 22)]));
const made = await proxy('POST', 'blocks', { customer: STAFF, body: ask });
const series = made.data.series || {};
check('1: staff make a weekly hold', made.status === 200 && series.id, made.data.error);
check('1: the answer\'s block is the first hold, as asked', JSON.stringify(made.data.block) === JSON.stringify({ id: made.data.block?.id, tables: ['P3', 'P4'], start: at(TUE, 18), end: at(TUE, 22), label: ask.label, type: 'tournament', game: 'Pokémon' }), made.data.block);
check('1: the series: weekly, "Weekly · Tuesdays 6pm", 6pm for 4 hours from the first Tuesday, no last day, active',
  series.repeat === 'weekly' && series.repeatTag === 'Weekly · Tuesdays 6pm' && series.startTime === '18:00' && series.minutes === 240 && series.firstDay === TUE
  && series.until === null && series.status === 'active' && JSON.stringify(series.tables) === '["P3","P4"]' && JSON.stringify(series.skipDays) === '[]',
  { repeat: series.repeat, tag: series.repeatTag, startTime: series.startTime, firstDay: series.firstDay, status: series.status });
check('1: its next six dates, a week apart', JSON.stringify((series.next || []).map((x) => key(x.start))) === JSON.stringify(days.slice(0, 6)), (series.next || []).map((x) => key(x.start)));
check('1: clashes: every active booking on P3 or P4 at any date, { ref, start }, Sam\'s among them',
  JSON.stringify(made.data.clashes) === JSON.stringify(expected) && made.data.clashes.some((c) => c.ref === sams.data.booking?.ref && c.start === at(third, 19)), { got: made.data.clashes, expected });
const floor1 = await staffFloor(TUE, last);
const dates1 = datesOf(floor1, series.id);
check(`1: the staff floor has a hold every Tuesday up to the horizon plus 7 days (${days.length})`, JSON.stringify(dates1.map((b) => key(b.start))) === JSON.stringify(days), dates1.map((b) => key(b.start)));
check('1: each 6pm to 10pm Lair time', dates1.every((b) => b.start === at(key(b.start), 18) && b.end === at(key(b.start), 22)));
check('1: each says its series to staff (repeat, repeatTag, until)', dates1.every((b) => b.repeat === 'weekly' && b.repeatTag === 'Weekly · Tuesdays 6pm' && b.until === null && b.label === ask.label));
check('1: Sam is still on P3, not moved', (floor1.bookings || []).find((b) => b.id === sams.data.booking?.id)?.tables?.join() === 'P3');
const pub = (await proxy('GET', `floor?from=${at(TUE, 0)}&to=${at(addDays(last, 1), 0)}`)).data.blocks || [];
const pubDates = pub.filter((b) => dates1.some((x) => x.id === b.id));
check('1: the public see the same holds, labelled Tournament, with nothing about the series',
  pubDates.length === days.length && pubDates.every((b) => b.label === 'Tournament' && !['seriesId', 'repeat', 'repeatTag', 'until'].some((k) => k in b)), pubDates[0]);
check('1: a customer can\'t book P4 on a held Tuesday (409)', said(await proxy('POST', 'bookings', { customer: SAM, body: { kind: 'table', tables: ['P4'], start: at(days[3], 19), end: at(days[3], 21), people: 2, name: 'Sam Jones', email: 'sam@example.com', pay: 'day' } })) === '409 Table P4 is already taken then. Pick another.');

/* 2. The messages, staff only, and a one-off as before */
check('2: repeat must be weekly or fortnightly (422)', said(await proxy('POST', 'blocks', { customer: STAFF, body: { ...ask, repeat: 'monthly' } })) === '422 Pick how often it repeats: weekly or fortnightly. Or leave it as a one-off.');
check('2: the last date can\'t be before the first (422)', said(await proxy('POST', 'blocks', { customer: STAFF, body: { ...ask, until: addDays(TUE, -1) } })) === "422 'Repeat until' has to be a date on or after the first one.");
check('2: members can\'t hold tables (403)', (await proxy('POST', 'blocks', { customer: SAM, body: ask })).status === 403);
check('2: …or stop a hold (403)', (await remove(dates1[1]?.id, { later: true }, SAM)).status === 403);
const once = await proxy('POST', 'blocks', { customer: STAFF, body: { tables: 'P3', start: at(third, 18), end: at(third, 20), label: `Quick hold (r8 ${run})`, type: 'impromptu' } });
const onceClashes = clashesIn(['P3'], [[at(third, 18), at(third, 20)]]);
check('2: a one-off: series null, clashes { ref, start } (Sam\'s among them)', once.status === 200 && once.data.series === null && JSON.stringify(once.data.clashes) === JSON.stringify(onceClashes)
  && onceClashes.some((c) => c.ref === sams.data.booking?.ref), { got: once.data, expected: onceClashes });
const onceView = (await staffFloor(third, third)).blocks?.find((b) => b.id === once.data.block?.id);
check('2: …and the staff floor says it doesn\'t repeat', onceView && onceView.seriesId === null && onceView.repeat === null && onceView.repeatTag === null && onceView.until === null, onceView);
check('2: …and it goes as before (removed: 1)', JSON.stringify((await remove(once.data.block?.id)).data) === '{"ok":true,"removed":1}');

/* 3. Skip a date */
const second = dates1[1];
check('3: skip the second Tuesday: { ok, removed: 1 }', JSON.stringify((await remove(second?.id)).data) === '{"ok":true,"removed":1}');
check('3: a second tap isn\'t an error: { ok, removed: 0 }', JSON.stringify((await remove(second?.id)).data) === '{"ok":true,"removed":0}');
const samSkipped = await proxy('POST', 'bookings', { customer: SAM, body: { kind: 'table', tables: ['P4'], start: at(days[1], 19), end: at(days[1], 21), people: 2, name: 'Sam Jones', email: 'sam@example.com', pay: 'day' } });
check('3: P4 is free that night: Sam books it', samSkipped.status === 200, samSkipped.data.error);
const setup3 = await maintenance();
const dates3 = datesOf(await staffFloor(TUE, last), series.id);
check('3: maintenance never makes the skipped date again', JSON.stringify(dates3.map((b) => key(b.start))) === JSON.stringify(days.filter((d) => d !== days[1])), { days: dates3.map((b) => key(b.start)), holdSeries: setup3.holdSeries || null });

/* 4. Stop repeating */
const fifth = dates3.find((b) => key(b.start) === days[4]);
const stopLater = await remove(fifth?.id, { later: true });
check(`4: stop from the fifth Tuesday: it and every later date go (${days.length - 4})`, stopLater.status === 200 && stopLater.data.removed === days.length - 4, stopLater.data);
const dates4 = datesOf(await staffFloor(TUE, last), series.id);
check('4: the earlier dates stay, and say the series ends the day before', JSON.stringify(dates4.map((b) => key(b.start))) === JSON.stringify([days[0], days[2], days[3]]) && dates4.every((b) => b.until === addDays(days[4], -1)), dates4.map((b) => [key(b.start), b.until]));
await maintenance();
check('4: maintenance adds nothing past its last day', datesOf(await staffFloor(TUE, last), series.id).length === 3);
const stopAll = await remove(dates4[0]?.id, { later: true });
check('4: stop from the first date to come: the rest go too', stopAll.status === 200 && stopAll.data.removed === 3, stopAll.data);
await maintenance();
check('4: …and maintenance leaves it stopped', datesOf(await staffFloor(TUE, last), series.id).length === 0);
check('4: Sam\'s booking is still there', ((await staffFloor(third, third)).bookings || []).some((b) => b.id === sams.data.booking?.id && ACTIVE.includes(b.status)));

/* 5. A fortnightly hold with a last day */
const WED = nextDow(3, today, 2);
const fort = await proxy('POST', 'blocks', { customer: STAFF, body: { tables: 'G3-G4', start: at(WED, 17), end: at(WED, 20), label: `Kill Team league (r8 ${run})`, type: 'event', game: 'Kill Team', repeat: 'fortnightly', until: addDays(WED, 42) } });
const fortSeries = fort.data.series || {};
check('5: a fortnightly hold until six weeks on', fort.status === 200 && fortSeries.repeat === 'fortnightly' && fortSeries.repeatTag === 'Fortnightly · Wednesdays 5pm' && fortSeries.until === addDays(WED, 42), fort.data.error || fortSeries);
const fortDates = datesOf(await staffFloor(WED, addDays(WED, 60)), fortSeries.id);
check('5: every second Wednesday up to its last day, included (4 dates)', JSON.stringify(fortDates.map((b) => key(b.start))) === JSON.stringify([WED, addDays(WED, 14), addDays(WED, 28), addDays(WED, 42)]) && fortDates.every((b) => b.until === addDays(WED, 42) && b.end - b.start === 3 * HOUR), fortDates.map((b) => key(b.start)));

/* 6. Maintenance tops up at the horizon */
// a weekly hold whose date just past the horizon (now plus the horizon and 7 days) can't be made yet, at a whole minute
const target = Math.ceil((Date.now() + AHEAD + 3000) / 60000) * 60000;
const edgeDay = key(target);
const { h, mi } = clockOf(target);
let firstDay = edgeDay;
while (addDays(firstDay, -7) > today) firstDay = addDays(firstDay, -7);
const edge = await proxy('POST', 'blocks', { customer: STAFF, body: { tables: 'F1', start: at(firstDay, h, mi), end: at(firstDay, h, mi) + 2 * HOUR, label: `Late league (r8 ${run})`, type: 'event', repeat: 'weekly' } });
const edgeId = edge.data.series?.id;
const edgeBefore = datesOf(await staffFloor(firstDay, edgeDay), edgeId).map((b) => key(b.start));
check('6: made up to the week before the date at the horizon\'s edge', edge.status === 200 && edgeBefore.length > 0 && edgeBefore[edgeBefore.length - 1] === addDays(edgeDay, -7), { edgeDay, got: edgeBefore.slice(-2), error: edge.data.error });
await sleep(Math.max(0, target - AHEAD - Date.now()) + 1500);
const setup6 = await maintenance();
const edgeAfter = datesOf(await staffFloor(firstDay, edgeDay), edgeId);
check('6: once the horizon reaches it, maintenance makes it (holdSeries in its answer)', (setup6.holdSeries || []).some((x) => x.series === edgeId && x.created === 1) && edgeAfter.map((b) => key(b.start)).at(-1) === edgeDay, { holdSeries: setup6.holdSeries || null, last: edgeAfter.map((b) => key(b.start)).at(-1) });
check('6: at the same Lair time and length', edgeAfter.at(-1)?.start === at(edgeDay, h, mi) && edgeAfter.at(-1)?.end - edgeAfter.at(-1)?.start === 2 * HOUR);
const setup6b = await maintenance();
check('6: and never twice', !(setup6b.holdSeries || []).some((x) => x.series === edgeId) && datesOf(await staffFloor(firstDay, edgeDay), edgeId).length === edgeAfter.length);

// leave nothing held: stop the two still going from their first date to come
for (const [first, name] of [[fortDates[0], 'the fortnightly hold'], [datesOf(await staffFloor(firstDay, edgeDay), edgeId)[0], 'the late league']]) {
  const res = await remove(first?.id, { later: true });
  check(`clean up: ${name} stopped`, res.status === 200 && res.data.removed > 0, res.data);
}
process.exit(summary() ? 1 : 0);
