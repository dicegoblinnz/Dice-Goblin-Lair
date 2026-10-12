// Ruby's round 15 scenario, made inside the demo backend (run in the page with page.evaluate(SEED)).
// Ruby pays each visit. She has: a table more than 24 hours away (T4, in 3 days) and one inside 24 hours (T5 tonight),
// an owed no-show (T8 two days ago, unpaid), a seat at a TTRPG game more than 24 hours away (from the demo's own
// examples, or one made here), a sign-up more than 24 hours away (Pokémon league or D&D at the weekend), one inside 24
// hours (tonight's D&D), and an owed sign-up from last week (unpaid, she didn't come).
export const SEED = `(() => {
  const be = window.Lair.store.backend;
  const t = be.time;
  const c = be.cfg.customer;
  const id = String(c.id);
  const HOUR = 3600000;
  const now = Date.now();
  if (be.state.r15Seeded === id + ':' + t.today()) return { already: true };
  be.demoBilling('visit');
  const name = c.fullName || c.name || 'Ruby Tane';
  const email = c.email || '';
  const priceOf = (table) => { const room = be.cfg.rooms.find((r) => r.tables.some((tb) => tb.id === table)); return room ? room.price : 1000; };
  const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 9);
  const st = be.state;
  const day = (d, mins) => t.at(t.addDays(t.today(), d), mins);
  const add = (b) => {
    const x = { id: uid('bk'), ref: be.newRef(name), kind: 'table', status: 'confirmed', pay: 'day', paid: false, amount: 0, covered: 0, paidAmount: 0,
      email, phone: '', notes: '', activity: 'board', extras: [], name, createdAt: now - 2 * 24 * HOUR, customerId: id, ...b };
    st.bookings.push(x);
    return x;
  };
  const out = {};
  out.far = add({ tables: ['T4'], start: day(3, 18 * 60), end: day(3, 21 * 60), people: 2, amount: 2 * priceOf('T4') }).id;
  out.soonTable = add({ tables: ['T5'], start: day(0, 20 * 60), end: day(0, 23 * 60), people: 3, amount: 3 * priceOf('T5') }).id;
  out.noshow = add({ tables: ['T8'], start: day(-2, 17 * 60), end: day(-2, 20 * 60), people: 2, amount: 2 * priceOf('T8'), status: 'noshow', createdAt: day(-5, 12 * 60) }).id;
  // a seat more than 24 hours away: the first open game after tomorrow
  const game = st.games.filter((g) => g.start > now + 30 * HOUR && g.status === 'open' && g.seats - g.taken >= 1 && String(g.gmCustomerId || '') !== id).sort((a, b) => a.start - b.start)[0];
  if (game) {
    out.seat = add({ kind: 'gm-seat', gameId: game.id, tables: game.tables, start: game.start, end: game.end, people: 1, activity: 'rpg', amount: game.seatPrice || be.cfg.prices.gmSeat, players: [{ name, character: 'Kahu the Bold' }] }).id;
    game.taken += 1;
  }
  const occ = be.occurrences().filter((o) => o.capacity);
  const future = occ.filter((o) => o.startMs > now + 30 * HOUR).sort((a, b) => a.startMs - b.startMs);
  const soon = occ.filter((o) => o.startMs > now && o.startMs < now + 24 * HOUR).sort((a, b) => a.startMs - b.startMs);
  const past = occ.filter((o) => o.endMs < now && o.endMs > now - 20 * 24 * HOUR).sort((a, b) => b.startMs - a.startMs);
  const join = (o, extra = {}) => {
    const j = { id: uid('ej'), ref: be.newRef(name), occurrenceId: o.id, people: 1, name, email, note: '', customerId: id, pay: 'day', paid: false,
      amount: 1000, paidAmount: 0, status: 'confirmed', createdAt: now - 3 * 24 * HOUR, ...extra };
    st.joins = [...(st.joins || []), j];
    st.eventJoins = { ...(st.eventJoins || {}), [o.id]: ((st.eventJoins || {})[o.id] || 0) + j.people };
    return j;
  };
  // entry fees: the demo keeps them in cents on the occurrence (entryFee), so take that as it is
  const fee = (o) => (Number(o.entryFee) > 0 ? Number(o.entryFee) : 1000);
  if (future[0]) out.farJoin = join(future[0], { amount: fee(future[0]) }).id;
  if (soon[0]) out.soonJoin = join(soon[0], { amount: fee(soon[0]) }).id;
  if (past[0]) out.owedJoin = join(past[0], { amount: fee(past[0]), createdAt: past[0].startMs - 3 * 24 * HOUR }).id;
  out.titles = { farJoin: future[0] && future[0].title, soonJoin: soon[0] && soon[0].title, owedJoin: past[0] && past[0].title, game: game && game.title };
  st.r15Seeded = id + ':' + t.today();
  be.commit();
  return out;
})()`;
