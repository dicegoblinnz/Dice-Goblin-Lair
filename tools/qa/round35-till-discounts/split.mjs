// Round 35, "Discount on everything" in dollars (Mo, 11 Nov 2026: "make $ off discount back"): the till shares an amount
// off the whole sale across its things as whole cents off each one. This checks the sharing itself (LairTill.splitOff)
// on thousands of made-up baskets, in the till's own page:
//  - no thing gets more than it can come down by, or less than nothing;
//  - what the shares add up to is never more than what was asked;
//  - it is exactly what was asked whenever some share-out to the cent exists at all (checked against a slow, sure way
//    of finding one), for baskets with up to 12 of a thing; with up to 99 of each, in all but a counted few;
//  - when none exists, it is short by less than the most there are of any one thing (3 of something: 2c at most);
//  - the shares follow each thing's price, up to how far each can come down: there's one rate the things with room
//    left all got (to a few cents), and a thing held by its room got its room, never more than that rate would give;
//  - and it's quick: the slowest basket is timed.
// Usage: DG_THEME=/path/to/theme [PORT=4989] [N=4000] node tools/qa/round35-till-discounts/split.mjs
const lib = await import('../round15/lib.mjs');
const { chromium, m, STAFF } = lib;
const PORT = Number(process.env.PORT || 4989);
const N = Number(process.env.N || 4000);
m.globalSettings.lair_mode = 'demo';
m.mockState.customer = STAFF;
m.mockState.sectionSettings = { 'lair-till': { sales: 'practice', look: 'first' } };
const server = await m.serve(PORT);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto(`http://localhost:${PORT}/pages/till`, { waitUntil: 'networkidle' });
const run = (n, maxQty, seed) => page.evaluate(({ n, maxQty, seed: start }) => {
  const split = customElements.get('lair-till').splitOff;
  if (typeof split !== 'function') return { missing: true };
  // a seeded generator, so a failure can be run again
  let seed = start;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const PRICES = [300, 450, 1100, 1599, 2000, 2500, 3500, 5999, 9000, 10500, 23500, 45000];
  /** The most, no more than `amount`, that whole cents off each one within each thing's room can add up to (slow, sure) */
  const bestUnder = (lines, amount) => {
    const reach = new Uint8Array(amount + 1);
    reach[0] = 1;
    for (const l of lines) {
      const used = new Int32Array(amount + 1);
      for (let c = l.qty; c <= amount; c += 1) {
        if (!reach[c] && reach[c - l.qty] && used[c - l.qty] < l.most) {
          reach[c] = 1;
          used[c] = used[c - l.qty] + 1;
        }
      }
    }
    for (let c = amount; c > 0; c -= 1) if (reach[c]) return c;
    return 0;
  };
  const res = { n: 0, broken: [], overAsked: [], short: 0, missed: 0, missedEg: [], farShort: [], notNearest: 0, skew: [], slowest: 0 };
  for (let i = 0; i < n; i += 1) {
    const count = int(1, 6);
    const multiOnly = rnd() < 0.3;
    const lines = [];
    for (let k = 0; k < count; k += 1) {
      const price = rnd() < 0.7 ? PRICES[int(0, PRICES.length - 1)] : int(100, 30000);
      const full = Math.floor((price * 20) / 100);
      // most: 20% of its price, or less when it's on sale already (never none: those aren't shared across)
      const most = rnd() < 0.8 ? full : Math.max(1, int(1, full));
      lines.push({ key: `l${k}`, qty: multiOnly ? int(2, maxQty) : rnd() < 0.7 ? 1 : int(2, maxQty), price, most });
    }
    const room = lines.reduce((s, l) => s + l.qty * l.most, 0);
    const amount = rnd() < 0.5 ? Math.min(room, int(1, Math.max(1, Math.floor(room / 100))) * 100) : int(1, room);
    if (amount < 1) continue;
    const t0 = performance.now();
    const got = split(lines, amount);
    res.slowest = Math.max(res.slowest, performance.now() - t0);
    res.n += 1;
    let total = 0;
    let bad = false;
    for (const l of lines) {
      const off = got.offs[l.key] || 0;
      if (!Number.isInteger(off) || off < 0 || off > l.most) bad = true;
      total += off * l.qty;
    }
    if (bad || total !== got.total) res.broken.push({ lines, amount, got });
    if (got.total > amount) res.overAsked.push({ lines, amount, got });
    if (got.total < amount) {
      res.short += 1;
      const top = Math.max(...lines.map((l) => l.qty));
      if (amount - got.total >= top && res.farShort.length < 5) res.farShort.push({ lines, amount, got });
      if (amount <= 200000) {
        const best = bestUnder(lines, amount);
        if (best === amount) {
          res.missed += 1;
          if (res.missedEg.length < 5) res.missedEg.push({ lines, amount, got });
        } else if (best > got.total) res.notNearest += 1;
      }
    }
    // the shares against the prices. The things clearly not held by their room set the rate; then every thing has that
    // rate's share of its price, or all its room if that's less, to within the few cents the odd ones are moved by
    const top = Math.max(...lines.map((l) => l.qty));
    const slack = (l) => Math.max(3 + Math.min(24, top), l.price * 0.02);
    const free = lines.filter((l) => (got.offs[l.key] || 0) < l.most - slack(l));
    const freeValue = free.reduce((s, l) => s + l.qty * l.price, 0);
    if (freeValue > 0) {
      const rate = free.reduce((s, l) => s + l.qty * (got.offs[l.key] || 0), 0) / freeValue;
      for (const l of lines) {
        const off = got.offs[l.key] || 0;
        const want = Math.min(l.most, rate * l.price);
        if (Math.abs(off - want) > slack(l) && res.skew.length < 5) res.skew.push({ line: l, off, want: Math.round(want), amount, lines, got });
      }
    }
  }
  return res;
}, { n, maxQty, seed });
// baskets as a shop sells them (up to 6 of a thing), bigger ones (12), and silly ones (99 of each)
const usual = await run(N, 6, 20261111);
const bigger = usual.missing ? usual : await run(N, 12, 7);
const silly = usual.missing ? usual : await run(Math.min(N, 2000), 99, 99);
await browser.close();
server.close?.();
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 700)}`}`);
};
if (usual.missing) check('the till has its sharing function (LairTill.splitOff)', false, 'not there');
else {
  for (const [name, out, missedOk] of [['up to 6 of a thing', usual, 0], ['up to 12 of a thing', bigger, 0], ['up to 99 of a thing', silly, 0.02]]) {
    check(`${name}, ${out.n} baskets: nothing gets more than its room or less than nothing, and the total is the shares added up`, out.broken.length === 0, out.broken[0]);
    check(`${name}: never more comes off than was asked`, out.overAsked.length === 0, out.overAsked[0]);
    check(`${name}: a share-out to the cent is found when there is one (missed ${out.missed} of ${out.n}; ${out.short} had none)`, out.missed <= out.n * missedOk, out.missedEg[0]);
    if (missedOk === 0) {
      check(`${name}: when there's none, it's short by less than the most there are of any one thing, and nothing nearer exists`, out.farShort.length === 0 && out.notNearest === 0, out.farShort[0] || out.notNearest);
      check(`${name}: the shares follow the prices, up to how far each thing can come down`, out.skew.length === 0, out.skew[0]);
    }
    check(`${name}: it's quick (the slowest basket took ${out.slowest.toFixed(1)} ms)`, out.slowest < 250, out.slowest);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
