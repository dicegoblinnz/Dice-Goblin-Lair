// The staff page against contract-only responses (what the live Lair app promises, nothing more): /checkin returns
// { row, pass: { code, label, used, left, covered }, notice, customer } with no use id, round 3 fields or member and
// pass lookups (those 404); the undo route returns { ok: true }. The page must still check in, undo a pass (finding
// the use on the pass), show a member code from the members search and the floor, and show a scanned pass.
import { m, chromium, open, text, overflow, STAFF } from './lib.mjs';
const server = await m.serve(4311);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, 'phone', '/pages/lair-staff');
const log = (...a) => console.log(...a);
await page.evaluate(() => {
  const be = window.Lair.store.backend;
  const checkin = be.checkin.bind(be);
  be.checkin = async (input) => {
    const r = await checkin(input);
    if (r.kind === 'member' || r.kind === 'pass') throw Object.assign(new Error('No booking, member or pass with that code.'), { status: 404 });
    const pass = r.pass ? { code: r.pass.code, label: r.pass.label, used: r.pass.used, left: r.pass.left, covered: r.pass.covered } : null;
    const row = { ...r.row };
    delete row.kind; // the contract's row has type, not kind
    return { row, pass, notice: r.notice, customer: r.customer };
  };
  const undo = be.undoPassUse.bind(be);
  be.undoPassUse = async (id) => {
    await undo(id);
    return { ok: true };
  };
});
const card = () => text(page, '[data-checkin-result]');
const type = async (code) => {
  await page.fill('#checkin-code', code);
  await page.press('#checkin-code', 'Enter');
  await page.waitForTimeout(600);
};
const rangi = await page.evaluate(() => window.Lair.store.data.bookings.find((b) => b.name === 'Rangi Parata').ref);
await type(rangi);
log('contract-only check-in:', await card());
await page.click('[data-pass-undo]');
await page.waitForTimeout(700);
log('undo (use found on the pass):', await card());
log('  floor:', JSON.stringify(await page.evaluate((r) => { const b = window.Lair.store.data.bookings.find((x) => x.ref === r); return { due: b.due, covered: b.covered }; }, rangi)));
const sam = await page.evaluate(() => window.Lair.store.backend.staffMembers().find((x) => x.firstName === 'Sam').code);
await type(sam.toLowerCase());
log('member code via the members search:', await card());
const league = await page.evaluate(() => window.Lair.store.backend.passList().find((p) => p.label === 'Warhammer league').code);
await type(league);
log('pass code via the passes search:', await card());
await type('ZZ-NOPE-4');
log('unknown code:', await card());
log('overflow', await overflow(page), 'errors', page.errors);
await ctx.close();
await browser.close();
server.close();
