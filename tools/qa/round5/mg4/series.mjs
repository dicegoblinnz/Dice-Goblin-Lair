// My Lair's card for a weekly regular: its member-code ticket (QR decodes), add to calendar, skip this week, and
// stop saving my seat (owed stays owed), on phone and desktop
import { execFileSync } from 'node:child_process';
import { start, stop, open, report, errors, shotOf, shot, overflow, openRow, OUT } from './harness.mjs';
const PREFIX = process.argv[2] || 'series';
const decode = (file) => execFileSync('python3', ['decode.py', file], { cwd: new URL('../booking-qa/', import.meta.url).pathname }).toString();
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const want = (tag, text, list, label) => {
  for (const w of list) {
    const ok = w instanceof RegExp ? w.test(text) : text.toLowerCase().includes(w.toLowerCase());
    if (!ok) errors.push(`${tag} ${label}: missing ${w instanceof RegExp ? w : `"${w}"`} in: ${text.slice(0, 400)}`);
  }
};
await start();
for (const size of ['phone', 'desktop']) {
  // Bookings, game seats (the older address #ml-seats), and the regular's row opened to its card
  const { ctx, page, tag } = await open(size, '/pages/my-lair#ml-seats');
  await openRow(page, '.ml-ticket--series');
  const card = page.locator('.ml-ticket--series');
  let text = flat(await card.innerText());
  want(tag, text, ["Weekly · your seat's saved every week", 'Abomination Vaults', 'Next', '5pm to 9pm', 'Owed', '$15', 'To pay', 'Your Goblin card is your ticket', 'Skip this week', 'Stop saving my seat'], 'card');
  const code = await page.locator('.ml-gcard__code').innerText();
  const stubCode = await card.locator('.ml-ticket__ref').innerText();
  if (stubCode !== code) errors.push(`${tag}: the series ticket shows ${stubCode}, not the member code ${code}`);
  await card.locator('.ml-ticket__code svg').screenshot({ path: `${OUT}${PREFIX}-qr-${size}.png` });
  const qr = decode(`${OUT}${PREFIX}-qr-${size}.png`);
  if (!qr.includes(`'${code}'`)) errors.push(`${tag}: series QR decodes to ${qr.trim()}, want ${code}`);
  else console.log(tag, 'series ticket QR decodes to the member code', code);
  await card.scrollIntoViewIfNeeded();
  await shotOf(page, '.ml-ticket--series', `${PREFIX}-card-${size}`);
  // the code, big: it's their Goblin card
  await card.locator('.ml-ticket__code').click();
  await page.waitForSelector('[data-qr-dialog][open]');
  await page.waitForTimeout(450);
  const dlg = flat(await page.locator('[data-qr-dialog]').innerText());
  want(tag, dlg, ['Your Goblin card', code, 'Show this at the counter to check in, stamp your card and pay your tab.'], 'big code');
  await shot(page, `${PREFIX}-bigcode-${size}`);
  await page.locator('[data-qr-dialog] [data-dialog-close]').click();
  // add to calendar
  const [download] = await Promise.all([page.waitForEvent('download'), card.locator('[data-ics]').click()]);
  const ics = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  if (!/Abomination Vaults at Dice Goblin/.test(ics) || !ics.includes(code)) errors.push(`${tag}: calendar file lacks the title or member code: ${ics.slice(0, 300)}`);
  // skip this week
  await card.locator('[data-cancel]').click();
  await page.waitForSelector('[data-cancel-dialog][open]');
  await page.waitForTimeout(450);
  const ask = flat(await page.locator('[data-cancel-dialog]').innerText());
  want(tag, ask, [/Skip \w{3} \d{1,2} \w{3,4}\?/, 'free up your seat', 'Gobgob still saves your seat after that', 'Skip this week', 'Keep my seat'], 'skip dialog');
  await shot(page, `${PREFIX}-skip-dialog-${size}`);
  await page.click('[data-confirm-cancel]');
  await page.waitForSelector('[data-notice]:not([hidden])');
  const notice = await page.locator('[data-notice]').innerText();
  want(tag, notice, [/Skipped \w{3} \d{1,2} \w{3,4}\. Gobgob still saves your seat after that\./], 'skip notice');
  await page.waitForTimeout(300);
  text = flat(await page.locator('.ml-ticket--series').innerText());
  want(tag, text, [/You're skipping \w{3} \d{1,2} \w{3,4}\./, 'Gobgob saves your seat again after that', 'Stop saving my seat'], 'after skipping');
  if (/Skip this week|Add to calendar/.test(text)) errors.push(`${tag}: skip or calendar still offered with no seat: ${text}`);
  await shotOf(page, '.ml-ticket--series', `${PREFIX}-skipped-${size}`);
  // stop saving my seat
  await page.locator('.ml-ticket--series [data-leave]').click();
  await page.waitForSelector('[data-cancel-dialog][open]');
  await page.waitForTimeout(450);
  const leave = flat(await page.locator('[data-cancel-dialog]').innerText());
  want(tag, leave, ['Stop saving your seat?', 'Abomination Vaults', "Weekly · your seat's saved every week", 'You still owe $15. It stays on your account to pay at the counter.', 'Stop saving my seat', 'Keep my seat'], 'leave dialog');
  await shot(page, `${PREFIX}-leave-dialog-${size}`);
  await page.click('[data-confirm-leave]');
  await page.waitForSelector('[data-notice]:not([hidden])');
  await page.waitForTimeout(300);
  want(tag, await page.locator('[data-notice]').innerText(), ['Done. Gobgob has stopped saving your seat at Abomination Vaults. The $15 you owe stays on your account.'], 'leave notice');
  if (await page.locator('.ml-ticket--series').count()) errors.push(`${tag}: the series card is still there after stopping`);
  const bill = flat(await page.locator('[data-tab-status]').innerText());
  want(tag, bill, [/Owed from \w{3} \d{1,2} \w{3,4}:/, 'Abomination Vaults'], 'bill after leaving');
  await page.locator('[data-panel="seats"] details.ml-past').evaluate((d) => { d.open = true; });
  const past = flat(await page.locator('[data-panel="seats"] .ml-past').innerText());
  want(tag, past, ['Abomination Vaults', 'Owed', 'Cancelled'], 'earlier list');
  await shotOf(page, '#ml-seats', `${PREFIX}-after-${size}`);
  await overflow(page, tag);
  await ctx.close();
}
report(PREFIX);
await stop();
