// Probe the demo backend's round-5 data: GET /me (series, seats, dueNow, gifts, passes) and the floor's games
import { start, stop, open, report } from './harness.mjs';
await start();
const { ctx, page } = await open('phone', '/pages/my-lair');
const out = await page.evaluate(async () => {
  const { store } = window.Lair;
  const me = await store.backend.me();
  const floor = await store.backend.floor();
  const t = store.time;
  const day = (ms) => `${t.key(ms)} ${t.fmtTime(ms)}`;
  return {
    series: me.series,
    seats: me.seats.map((s) => ({ title: s.gameTitle, day: day(s.start), status: s.status, seriesId: s.seriesId, ticketCode: s.ticketCode, ref: s.ref, owed: s.owed, due: s.due })),
    dueNow: me.dueNow.map((d) => ({ ...d, start: day(d.start) })),
    gifts: me.gifts,
    passes: me.passes.map((p) => ({ label: p.label, status: p.status, source: p.source, orderName: p.orderName, note: p.note })),
    member: me.member.code,
    games: floor.games.filter((g) => g.seriesId).map((g) => ({ title: g.title, day: day(g.start), status: g.status, seats: g.seats, taken: g.taken, held: g.held, nextOnly: g.nextOnly || false, series: g.series })),
  };
});
console.log(JSON.stringify(out, null, 1));
await ctx.close();
report('probe');
await stop();
