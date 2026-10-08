// Quotes: gone (round 9, Mo, 9 Oct: "Remove the quotes from gobgob inside the account the 20 options just completely
// remove them"). My Lair's Home has no quote box, no quote list and no "tap for another", on a phone and a desktop,
// and the page still has no errors.
import { start, stop, open, report, errors } from './harness.mjs';
await start();
for (const size of ['phone', 'desktop']) {
  const { ctx, page, tag } = await open(size, '/pages/my-lair', { label: 'no-quotes' });
  const left = await page.evaluate(() => ({
    box: document.querySelectorAll('[data-quotes], [data-quote-list], [data-quote-next], .ml-quote').length,
    tap: /tap for another/i.test(document.body.innerText),
    method: typeof document.querySelector('my-lair')?.showQuote,
  }));
  if (left.box) errors.push(`${tag}: ${left.box} quote element(s) still on My Lair`);
  if (left.tap) errors.push(`${tag}: "tap for another" is still on the page`);
  if (left.method !== 'undefined') errors.push(`${tag}: my-lair still has showQuote`);
  console.log(tag, 'quote elements', left.box, 'tap text', left.tap, 'showQuote', left.method);
  await ctx.close();
}
report('quotes');
await stop();
