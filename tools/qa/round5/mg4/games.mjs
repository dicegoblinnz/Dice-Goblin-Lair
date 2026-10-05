// The games board, round 5: a series shows only its next session with a "Weekly" note; a regular's panel (member-code
// ticket, owed, skip, stop saving my seat); "Save my seat every week" (weekly with room, fortnightly, and a full
// flexible game); a one-off seat's ticket. QR codes must decode. Phone and desktop.
import { execFileSync } from 'node:child_process';
import { start, stop, open, report, errors, shot, shotOf, overflow, OUT, customer } from './harness.mjs';
const PREFIX = process.argv[2] || 'games';
const decode = (file) => execFileSync('python3', ['decode.py', file], { cwd: new URL('../booking-qa/', import.meta.url).pathname }).toString();
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const want = (tag, text, list, label) => {
  for (const w of list) {
    const ok = w instanceof RegExp ? w.test(text) : text.toLowerCase().includes(w.toLowerCase());
    if (!ok) errors.push(`${tag} ${label}: missing ${w instanceof RegExp ? w : `"${w}"`} in: ${text.slice(0, 400)}`);
  }
};
const qrIs = async (tag, locator, code, file, label) => {
  await locator.screenshot({ path: `${OUT}${file}.png` });
  const out = decode(`${OUT}${file}.png`);
  if (!out.includes(`'${code}'`)) errors.push(`${tag} ${label}: QR decodes to ${out.trim()}, want ${code}`);
  else console.log(tag, label, 'QR decodes to', code);
};
await start();
const card = (page, title) => page.locator('.gm-card', { hasText: title });
const openGame = async (page, title) => {
  await card(page, title).locator('[data-game]').click();
  await page.waitForSelector('[data-sheet][open]');
  await page.waitForTimeout(350);
};
const sheet = async (page) => flat(await page.locator('[data-sheet]').innerText());
const closeSheet = async (page) => {
  if (await page.locator('[data-sheet][open]').count()) await page.locator('[data-sheet] [data-close]').first().click();
  await page.waitForTimeout(250);
};
for (const size of ['phone', 'desktop']) {
  // My Lair first, so the member code is known (the board seeds the same examples too)
  const { ctx, page, tag } = await open(size, '/pages/my-lair');
  const code = await page.locator('.ml-gcard__code').innerText();
  const b = await open(size, '/pages/gm-games', { ctx, label: 'board' });
  const board = b.page;
  await board.waitForTimeout(500);
  // 1. each series once, with its next session and a note
  const titles = await board.locator('.gm-card__title').allInnerTexts();
  const dupes = titles.filter((x, i) => titles.indexOf(x) !== i);
  if (dupes.length) errors.push(`${b.tag}: a game shows more than once: ${dupes}`);
  const av = flat(await card(board, 'Abomination Vaults').innerText());
  want(b.tag, av, [/Weekly · \d+ regulars?/, 'Full'], 'Abomination Vaults card');
  if (/more date/.test(av)) errors.push(`${b.tag}: Abomination Vaults still says +N more dates: ${av}`);
  want(b.tag, flat(await card(board, 'Blades in the Dark').innerText()), ['Fortnightly'], 'Blades card');
  want(b.tag, flat(await card(board, 'Masks of Nyarlathotep').innerText()), ['Flexible', 'Full'], 'Masks card');
  await card(board, 'Abomination Vaults').scrollIntoViewIfNeeded();
  await shotOf(board, '.gm-card:has-text("Abomination Vaults")', `${PREFIX}-card-weekly-${size}`);
  await shot(board, `${PREFIX}-board-${size}`);
  await overflow(board, b.tag);
  // 2. the regular's own panel
  await openGame(board, 'Abomination Vaults');
  let text = await sheet(board);
  want(b.tag, text, ['Your seat’s saved every week', 'Your Goblin card is your ticket', code, 'Pay at the counter each week', /\$15 to pay from \w{3} \d{1,2} \w{3}\./, 'Skip this week', 'Stop saving my seat', 'regular has a seat saved'], 'regular panel');
  if (/Upcoming dates/.test(text)) errors.push(`${b.tag}: a regular sees every date`);
  await qrIs(b.tag, board.locator('.gm-you .gm-qr'), code, `${PREFIX}-you-qr-${size}`, 'regular ticket');
  await board.locator('.gm-you').scrollIntoViewIfNeeded();
  await shot(board, `${PREFIX}-you-${size}`);
  // 3. skip this week
  await board.click('.gm-you [data-skip]');
  await board.waitForTimeout(300);
  text = await sheet(board);
  want(b.tag, text, ['Skip this week', 'Your seat’s still saved after that', 'Keep my seat'], 'skip sheet');
  await board.click('[data-skip-do]');
  await board.waitForSelector('.gm-flash');
  text = await sheet(board);
  want(b.tag, text, [/Skipped \w+day \d{1,2} \w+\. Your seat’s still saved after that\./, /You’re skipping \w{3} \d{1,2} \w{3}\. Your seat’s saved again after that\./, /There’s room for \d+ players? now/], 'after skip');
  await shot(board, `${PREFIX}-skipped-${size}`);
  // 4. stop saving my seat
  await board.click('.gm-you [data-leave]');
  await board.waitForTimeout(300);
  text = await sheet(board);
  want(b.tag, text, ['Stop saving your seat at Abomination Vaults?', 'Gobgob stops saving you a seat each week', 'You still owe $15. It stays on your account to pay at the counter.', 'Keep my seat saved', 'Stop saving my seat'], 'stop sheet');
  await shot(board, `${PREFIX}-stop-${size}`);
  await board.click('[data-leave-do]');
  await board.waitForSelector('.gm-flash');
  text = await sheet(board);
  want(b.tag, text, ['Done. Gobgob has stopped saving your seat at Abomination Vaults.'], 'after stop');
  if (await board.locator('.gm-you').count()) errors.push(`${b.tag}: the regular's panel is still there after stopping`);
  // 5. save my seat every week again (weekly, with room)
  await board.click('[data-sheet-foot] [data-join]');
  await board.waitForSelector('[data-join-form]');
  text = await sheet(board);
  want(b.tag, text, ['Save my seat every week', 'Your seat’s saved for the next session each week. Your Goblin card is your ticket. Miss one or don’t pay, and it stays on your account to pay next time.'], 'join form');
  await board.check('[name="joinMode"][value="series"]');
  await board.waitForTimeout(150);
  text = await sheet(board);
  want(b.tag, text, ['Nothing to pay now. Pay at the counter each week: $15. Show your Goblin card and we’ll ring it up.'], 'join form, series');
  const button = flat(await board.locator('[data-join-submit]').innerText());
  if (button !== 'Save my seat every week') errors.push(`${b.tag}: join button says "${button}"`);
  await shot(board, `${PREFIX}-join-weekly-${size}`);
  await board.fill('[data-session-join] [name="phone"]', '021 555 0123'); // round 7: a mobile is required (saved to her for next time)
  await board.click('[data-join-submit]');
  await board.waitForSelector('.gm-done');
  await board.waitForTimeout(300);
  text = await sheet(board);
  want(b.tag, text, ['A regular! Gobgob has saved your seat.', 'Your seat’s saved every week', /Next \w+day \d{1,2} \w+/, 'Each week', '$15', 'Your Goblin card is your ticket. Show it at the counter each week.'], 'regular sheet');
  await qrIs(b.tag, board.locator('.gm-done .gm-qr'), code, `${PREFIX}-joined-qr-${size}`, 'regular confirmation');
  await shot(board, `${PREFIX}-joined-weekly-${size}`);
  await closeSheet(board);
  // 6. fortnightly
  await openGame(board, 'Blades in the Dark');
  await board.click('[data-sheet-foot] [data-join]');
  await board.waitForSelector('[data-join-form]');
  await board.check('[name="joinMode"][value="series"]');
  text = await sheet(board);
  want(b.tag, text, ['Save my seat every fortnight', 'each fortnight'], 'fortnightly join');
  await board.fill('[data-session-join] [name="phone"]', '021 555 0123'); // round 7
  await board.click('[data-join-submit]');
  await board.waitForSelector('.gm-done');
  text = await sheet(board);
  want(b.tag, text, ['Your seat’s saved every fortnight', 'Each fortnight', '$20'], 'fortnightly sheet');
  await closeSheet(board);
  // 7. a full flexible game: save my seat, and you're in from the next session with room
  await openGame(board, 'Masks of Nyarlathotep');
  text = await sheet(board);
  want(b.tag, text, ['This session is full.', 'Save your seat at every session and you’re in from the next session with room.', 'Save my seat at every session'], 'full foot');
  await shot(board, `${PREFIX}-full-${size}`);
  await board.click('[data-sheet-foot] [data-join]');
  await board.waitForSelector('[data-join-form]');
  await board.fill('[data-session-join] [name="phone"]', '021 555 0123'); // round 7
  await board.click('[data-join-submit]');
  await board.waitForSelector('.gm-done');
  text = await sheet(board);
  want(b.tag, text, ['You’re a regular, friend. Gobgob saves your seat from the next session with room.', 'is full', 'Your seat’s saved from the session after it.'], 'full regular sheet');
  await qrIs(b.tag, board.locator('.gm-done .gm-qr'), code, `${PREFIX}-full-qr-${size}`, 'full regular confirmation');
  await shot(board, `${PREFIX}-joined-full-${size}`);
  await closeSheet(board);
  // 8. a one-off seat: its ticket is its own code (a one-shot with room where they've no seat yet: the demo puts its
  // example seats wherever there's room at the time, so pick from the data)
  const oneOff = await board.evaluate(() => {
    const el = document.querySelector('gm-board');
    const now = Date.now();
    const mine = new Set((el.seats || []).filter((s) => ['held', 'confirmed', 'seated'].includes(s.status)).map((s) => s.gameId));
    const g = window.Lair.store.data.games
      .filter((x) => !x.seriesId && x.status === 'open' && x.start > now && x.seats - x.taken > 0 && !mine.has(x.id))
      .sort((a, b) => a.start - b.start)[0];
    return g ? g.title : null;
  });
  console.log(b.tag, 'one-off game to join:', oneOff);
  if (!oneOff) errors.push(`${b.tag}: no one-shot with room to join`);
  await openGame(board, oneOff.split(':')[0]);
  await board.click('[data-sheet-foot] [data-join]');
  await board.waitForSelector('[data-join-form]');
  if (await board.locator('[name="joinMode"]').count()) errors.push(`${b.tag}: a one-shot offers to save a seat every week`);
  await board.click('[data-join-submit]');
  await board.waitForSelector('.gm-done');
  const ref = await board.locator('.gm-done .gm-qr__ref').innerText();
  if (ref === code) errors.push(`${b.tag}: a one-off seat's ticket is the member code`);
  await qrIs(b.tag, board.locator('.gm-done .gm-qr'), ref, `${PREFIX}-oneoff-qr-${size}`, 'one-off seat');
  await closeSheet(board);
  await overflow(board, b.tag);
  // 9. My Lair now: two regular cards (weekly and fortnightly) and the flexible one waiting for room
  const after = await open(size, '/pages/my-lair#ml-seats', { ctx, label: 'after' });
  // later sessions are rows that open to their card: open them all, as someone checking each one would
  const rows = after.page.locator('[data-panel="seats"] details.ml-later');
  for (let i = 0; i < (await rows.count()); i += 1) {
    if (!(await rows.nth(i).evaluate((d) => d.open))) await rows.nth(i).locator(':scope > summary').click();
  }
  const cards = await after.page.locator('.ml-ticket--series').allInnerTexts();
  console.log(after.tag, 'series cards:', cards.map((c) => flat(c).slice(0, 120)));
  if (cards.length !== 3) errors.push(`${after.tag}: ${cards.length} series cards, want 3 (weekly, fortnightly, flexible)`);
  const masks = cards.map(flat).find((c) => c.includes('Masks'));
  if (masks) want(after.tag, masks, ['Regular · your seat\'s saved for every session', 'is full, so you\'re not in that one', 'Gobgob saves your seat from the next session with room'], 'flexible card');
  await shotOf(after.page, '#ml-seats', `${PREFIX}-mylair-seats-${size}`);
  await overflow(after.page, after.tag);
  await ctx.close();
}
report(PREFIX);
await stop();
