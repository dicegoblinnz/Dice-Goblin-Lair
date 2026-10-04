// The one bill in My Lair's tab card, every state: sessions only, sessions + tab, editing, at the counter, a paid tab
// with sessions still due, everything paid, and a tab on its own. The bill's QR must decode to the member code.
// The bill is in My Lair's Tab view (#tab); Home's "To pay at the counter" line says the same total.
import { execFileSync } from 'node:child_process';
import { start, stop, open, report, errors, shotOf, overflow, OUT } from './harness.mjs';
const PREFIX = process.argv[2] || 'bill';
const decode = (file) => execFileSync('python3', ['decode.py', file], { cwd: new URL('../booking-qa/', import.meta.url).pathname }).toString();
await start();
const billText = (page) => page.locator('[data-tab-status]').innerText().then((s) => s.replace(/\s+/g, ' ').trim());
const expect = (tag, text, want, label) => {
  for (const w of [].concat(want)) if (!text.toLowerCase().includes(w.toLowerCase())) errors.push(`${tag} ${label}: missing "${w}" in: ${text.slice(0, 300)}`);
};
const refresh = (page) => page.evaluate(async () => {
  document.querySelector('my-lair').tabTimer && clearTimeout(document.querySelector('my-lair').tabTimer);
  await document.querySelector('my-lair').refreshTab();
});
const demo = (page, fn, arg) => page.evaluate(fn, arg);
const money = (c) => `$${Number.isInteger(c / 100) ? c / 100 : (c / 100).toFixed(2)}`;
const sessions = (n) => `${n} ${n === 1 ? 'session' : 'sessions'}`;
/** What GET /me says is due now: the expectations come from the data, so the test works at any time of day */
const dueNow = (page) => page.evaluate(async () => {
  const me = await window.Lair.store.backend.me();
  const t = window.Lair.store.time;
  return (me.dueNow || []).filter((d) => d.due > 0).map((d) => ({ title: d.title, due: d.due, today: t.key(d.start) === t.today() }));
});
for (const size of ['phone', 'desktop']) {
  // A. sessions only (straight to the Tab view: #tab)
  const { ctx, page, tag } = await open(size, '/pages/my-lair#tab');
  let text = await billText(page);
  const due = await dueNow(page);
  const n = due.length;
  const total = due.reduce((sum, d) => sum + d.due, 0);
  console.log(tag, 'due now:', JSON.stringify(due));
  if (!n || !due.some((d) => !d.today)) errors.push(`${tag}: expected an owed week in the seeded bill`);
  expect(tag, text, ['To pay', sessions(n), money(total), 'Show your code at the counter to pay everything', ...due.map((d) => `${d.today ? 'Your session: ' : ''}${d.title}`), 'Owed from'], 'A sessions only');
  if (/Edit my tab|Clear my tab/.test(text)) errors.push(`${tag} A: tab actions with no tab`);
  await shotOf(page, '[data-tab-card]', `${PREFIX}-A-sessions-${size}`);
  const code = await page.locator('.ml-gcard__code').innerText();
  await page.locator('[data-tab-card] .ml-tabcode__qr').screenshot({ path: `${OUT}${PREFIX}-A-qr-${size}.png` });
  const qr = decode(`${OUT}${PREFIX}-A-qr-${size}.png`);
  if (!qr.includes(`'${code}'`)) errors.push(`${tag} A: bill QR decodes to ${qr.trim()}, want ${code}`);
  else console.log(tag, 'A bill QR decodes to', code);
  // B. add a $3 drink: sessions + tab on one bill
  await page.locator('.ml-menu__group[data-product]').first().locator('[data-menu-toggle]').click().catch(() => {});
  if (!(await page.locator('.ml-menu__item').first().isVisible())) await page.locator('.ml-menu__group[data-product]').first().locator('[data-menu-toggle]').click();
  await page.locator('.ml-menu__item', { hasText: '$3 Drink' }).locator('[data-step="1"]').click();
  await page.click('[data-tab-save]');
  await page.waitForSelector('[data-tab-card] .ml-tabcard__group');
  text = await billText(page);
  expect(tag, text, ['Open tab', `${sessions(n)} · 1 thing`, money(total + 300), 'pay everything', 'Your tab', '1 × $3 Drink', 'Edit my tab', 'Clear my tab'], 'B sessions + tab');
  await shotOf(page, '[data-tab-card]', `${PREFIX}-B-both-${size}`);
  const nav = await page.locator('[data-count="tab"]').innerText();
  if (nav !== String(n + 1)) errors.push(`${tag} B: nav count ${nav}, want ${n + 1} (${sessions(n)} + 1 thing)`);
  // Home's line says the same: what's due and how many things, as a link to the Tab view
  const homeDue = (await page.locator('[data-home-due]').textContent()).replace(/\s+/g, ' ').trim();
  for (const w of ['To pay at the counter', money(total + 300), `${sessions(n)} and 1 thing on your tab`]) if (!homeDue.includes(w)) errors.push(`${tag} B: Home's due line "${homeDue}" lacks "${w}"`);
  // C. editing keeps the sessions and the combined total
  await page.click('[data-tab-edit]');
  await page.locator('[data-qty-box="edit"] [data-step="1"]').click();
  text = await billText(page);
  expect(tag, text, ['Change your tab', 'Owed from', money(total + 600), 'Save my tab'], 'C editing');
  await shotOf(page, '[data-tab-card]', `${PREFIX}-C-editing-${size}`);
  await page.click('[data-tab-edit-cancel]');
  // E. the tab at the counter (staff added everything)
  await demo(page, () => { const b = window.Lair.store.backend; b.state.tabs.forEach((x) => { x.status = 'in-cart'; }); b.save(); });
  await refresh(page);
  text = await billText(page);
  expect(tag, text, ['At the counter', 'At the counter now', money(total + 300), 'Owed from', 'Your tab'], 'E in-cart');
  if (await page.locator('[data-tab-card] .ml-tabcode').count()) errors.push(`${tag} E: QR shown while at the counter`);
  await shotOf(page, '[data-tab-card]', `${PREFIX}-E-counter-${size}`);
  // F. the tab's paid, the sessions aren't
  await demo(page, () => { const b = window.Lair.store.backend; b.state.tabs.forEach((x) => { x.status = 'paid'; }); b.save(); });
  await refresh(page);
  text = await billText(page);
  expect(tag, text, ['To pay', sessions(n), money(total), 'pay everything', "Your tab's paid. Thanks, friend."], 'F paid tab + sessions');
  if (!(await page.locator('[data-tab-card] .ml-tabcode').count())) errors.push(`${tag} F: no QR for the sessions still due`);
  await shotOf(page, '[data-tab-card]', `${PREFIX}-F-tabpaid-${size}`);
  // G. everything paid at the counter
  await demo(page, () => {
    const b = window.Lair.store.backend;
    const id = String(window.Lair.store.cfg.customer.id);
    b.state.bookings.filter((x) => String(x.customerId || '') === id).forEach((x) => { x.paid = true; });
    b.save();
  });
  await refresh(page);
  text = await billText(page);
  expect(tag, text, ['Paid', 'Paid. Thanks, friend.', '1 thing'], 'G all paid (paid tab shows)');
  if (/All paid/.test(text)) errors.push(`${tag} G: "All paid" note on top of the paid tab's own thanks`);
  await shotOf(page, '[data-tab-status]', `${PREFIX}-G-allpaid-${size}`);
  const seatsAfter = await page.locator('[data-panel="seats"]').innerText();
  if (/Pay at the counter/.test(seatsAfter.replace(/Pay at the counter when you arrive[^.]*\./g, ''))) console.log(tag, 'note: seats still say pay at the counter after paying:', seatsAfter.replace(/\s+/g, ' ').slice(0, 200));
  await overflow(page, tag);
  await ctx.close();
  // H. a tab on its own (no sessions due), and "All paid" when sessions get paid with no tab
  const h = await open(size, '/pages/my-lair#tab', { label: 'tab-only' });
  text = await billText(h.page);
  const hDue = await dueNow(h.page);
  if (!text.includes(sessions(hDue.length))) errors.push(`${h.tag} H: expected the seeded sessions first`);
  await demo(h.page, () => {
    const b = window.Lair.store.backend;
    const id = String(window.Lair.store.cfg.customer.id);
    b.state.bookings.filter((x) => String(x.customerId || '') === id).forEach((x) => { x.paid = true; });
    b.save();
  });
  await refresh(h.page);
  text = await billText(h.page);
  expect(h.tag, text, ['All paid. Thanks, friend.'], 'H all paid note');
  if (await h.page.locator('[data-tab-card]').count()) errors.push(`${h.tag} H: a bill card with nothing to pay`);
  await shotOf(h.page, '[data-tab-status]', `${PREFIX}-H-allpaid-${size}`);
  await h.page.locator('.ml-menu__group[data-product]').nth(1).locator('[data-menu-toggle]').click().catch(() => {});
  if (!(await h.page.locator('.ml-menu__item', { hasText: '$4 Snack' }).isVisible())) await h.page.locator('.ml-menu__group[data-product]').nth(1).locator('[data-menu-toggle]').click();
  await h.page.locator('.ml-menu__item', { hasText: '$4 Snack' }).locator('[data-step="1"]').click();
  await h.page.click('[data-tab-save]');
  await h.page.waitForSelector('[data-tab-card]');
  text = await billText(h.page);
  expect(h.tag, text, ['Open tab', '1 thing', '$4', 'Show your code at the counter to pay', 'Edit my tab'], 'H tab only');
  if (/pay everything|session/i.test(text)) errors.push(`${h.tag} H: tab-only card mentions sessions: ${text}`);
  await shotOf(h.page, '[data-tab-card]', `${PREFIX}-H-tabonly-${size}`);
  await overflow(h.page, h.tag);
  await h.ctx.close();
}
report(PREFIX);
await stop();
