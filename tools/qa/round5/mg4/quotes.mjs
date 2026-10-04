// Quotes: a random one on load, every tap (and the timer) moves to a different random one, the badge shows its number
import { start, stop, open, report, errors, shotOf } from './harness.mjs';
await start();
const starts = new Set();
for (let run = 0; run < 6; run += 1) {
  const { ctx, page, tag } = await open(run % 2 ? 'desktop' : 'phone', '/pages/my-lair', { label: `run${run}` });
  const read = () => page.evaluate(() => {
    const box = document.querySelector('[data-quotes]');
    const list = JSON.parse(box.querySelector('[data-quote-list]').textContent);
    const text = box.querySelector('[data-quote-text]').textContent;
    return { index: list.indexOf(text), face: box.querySelector('[data-quote-face]').textContent, number: box.querySelector('[data-quote-number]').textContent, n: list.length };
  });
  const first = await read();
  starts.add(first.index);
  if (String(first.index + 1) !== first.face || first.face !== first.number) errors.push(`${tag}: badge ${first.face}/${first.number} for quote ${first.index + 1}`);
  let prev = first.index;
  const seen = [first.index + 1];
  for (let i = 0; i < 25; i += 1) {
    await page.click('[data-quote-next]');
    await page.waitForTimeout(380);
    const now = await read();
    if (now.index === prev) errors.push(`${tag}: tap ${i} showed the same quote twice (${now.index + 1})`);
    if (String(now.index + 1) !== now.face || now.face !== now.number) errors.push(`${tag}: badge ${now.face}/${now.number} for quote ${now.index + 1}`);
    prev = now.index;
    seen.push(now.index + 1);
  }
  // the timer: call the queued rotation directly a few times
  for (let i = 0; i < 15; i += 1) {
    const before = (await read()).index;
    await page.evaluate(() => { const el = document.querySelector('my-lair'); el.showQuote(el.randomQuote()); });
    await page.waitForTimeout(380);
    const after = (await read()).index;
    if (after === before) errors.push(`${tag}: rotation showed the same quote twice (${after + 1})`);
  }
  console.log(tag, 'start', first.index + 1, 'sequence', seen.join(' '));
  if (run === 0) await shotOf(page, '[data-quotes]', 'quote-phone');
  await ctx.close();
}
console.log('distinct starting quotes over 6 loads:', starts.size);
if (starts.size < 2) errors.push('the starting quote never changed');
report('quotes');
await stop();
