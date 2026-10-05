// Birthday gifts (the line, the code, Copy the code with and without the clipboard) and where passes came from;
// tap targets across My Lair; the logged-out My Lair
import { start, stop, open, report, errors, shotOf, overflow, smallTargets, view } from './harness.mjs';
const PREFIX = process.argv[2] || 'gifts';
const flat = (s) => s.replace(/\s+/g, ' ').trim();
await start();
for (const size of ['phone', 'desktop']) {
  // Gifts and passes are in the Wallet (#wallet), the birthday in Profile (round 7)
  const { ctx, page, tag } = await open(size, '/pages/my-lair#wallet');
  const code = await page.locator('.ml-gcard__code').innerText();
  const hbd = `HBD-${code.replace(/[^A-Z0-9]/gi, '')}`;
  const gift = flat(await page.locator('[data-gifts]').innerText());
  // round 7: a gift says what it was in the contract's words (staff see the same line), its code to copy under them
  const line = new RegExp(`Birthday gift from Gobgob: \\$5 store credit, 2 sessions on pass [A-Z]{2}-[A-Z]+-\\d+, Pokémon booster pack \\(code ${hbd}, until \\d{1,2} \\w{3,4}\\)`);
  if (!line.test(gift)) errors.push(`${tag}: gift line is "${gift}"`);
  if (!/Use the code by \w{3} \d+ \w+, online at checkout or at the counter\. Your 2 sessions are in My passes\./.test(gift)) errors.push(`${tag}: gift hints: ${gift}`);
  // Copy the code: with the clipboard
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${process.env.QA_PORT || 4312}` });
  await page.click('[data-copy]');
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== hbd) errors.push(`${tag}: clipboard has "${copied}", want ${hbd}`);
  if ((await page.locator('[data-copy]').innerText()) !== 'Copied') errors.push(`${tag}: the copy button doesn't say Copied`);
  await shotOf(page, '#ml-gifts', `${PREFIX}-gifts-${size}`);
  // and without one: the code is selected
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('no')) }, configurable: true }); });
  await page.waitForTimeout(2700);
  await page.click('[data-copy]');
  await page.waitForTimeout(150);
  const selected = await page.evaluate(() => String(window.getSelection()));
  if (selected !== hbd) errors.push(`${tag}: without a clipboard, "${selected}" is selected, want ${hbd}`);
  console.log(tag, 'copy fallback says:', await page.locator('[data-copy]').innerText());
  // passes: where they came from
  const sources = await page.locator('.ml-pass').evaluateAll((cards) => cards.map((c) => [c.querySelector('.ml-pass__label').textContent, c.querySelector('.ml-pass__from')?.textContent || '']));
  console.log(tag, 'pass sources:', JSON.stringify(sources));
  const bought = sources.find(([label]) => label.startsWith('Session pass'));
  if (!bought || bought[1] !== 'Bought online #1550') errors.push(`${tag}: the bought pass says "${bought && bought[1]}"`);
  if (sources.some(([label, from]) => /Birthday gift/.test(label) && from)) errors.push(`${tag}: the birthday pass repeats its source`);
  if (sources.some(([label, from]) => /Gift pack|School|Painting/.test(label) && from)) errors.push(`${tag}: a staff pass shows a source`);
  // tap targets, in every view
  const small = [];
  for (const name of ['home', 'bookings', 'wallet', 'library', 'tab', 'profile']) {
    await view(page, name);
    if (name === 'profile') await shotOf(page, '#ml-birthday', `${PREFIX}-bday-${size}`);
    small.push(...(await smallTargets(page)).filter((x) => !/^a\.text-link|^button\.text-link/.test(x)).map((x) => `${name}: ${x}`));
  }
  console.log(tag, 'small targets:', JSON.stringify(small));
  await overflow(page, tag);
  await ctx.close();
  // logged out
  const out = await open(size, '/pages/my-lair', { customer: null, label: 'out' });
  const text = flat(await out.page.locator('.ml--out').innerText());
  if (!/Log in/.test(text)) errors.push(`${out.tag}: logged-out page: ${text.slice(0, 200)}`);
  await overflow(out.page, out.tag);
  await out.ctx.close();
}
report(PREFIX);
await stop();
