// Baseline shots: My Lair and the games board, phone and desktop
import { start, stop, open, shot, report, overflow } from './harness.mjs';
const PREFIX = process.argv[2] || 'base';
await start();
for (const size of ['phone', 'desktop']) {
  const a = await open(size, '/pages/my-lair');
  await shot(a.page, `${PREFIX}-mylair-${size}-full`, { fullPage: true });
  await overflow(a.page, a.tag);
  const b = await open(size, '/pages/gm-games', { ctx: a.ctx });
  await shot(b.page, `${PREFIX}-games-${size}-full`, { fullPage: true });
  await overflow(b.page, b.tag);
  await a.ctx.close();
}
report(PREFIX);
await stop();
