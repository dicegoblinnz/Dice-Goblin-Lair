// state.gifts, as My Lair reads it: one array of { id, customerId, at, credit (cents), sessions, passCode, rolls, product, note }
import { m, chromium, open, STAFF, PORT } from './lib.mjs';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, 'phone', '/pages/lair-staff', { query: '?giftfail=rolls' });
const out = await page.evaluate(async () => {
  const be = window.Lair.store.backend;
  const sam = (await be.members({ q: 'sam', sort: 'spend' }))[0];
  const res = await be.giftMember(sam.customerId, { credit: 12.5, sessions: 2, rolls: 3, productVariantId: '123', productTitle: 'Wingspan', note: 'Have a great day', notify: true });
  const again = await be.giftMember(sam.customerId, { productVariantId: '123', productTitle: 'Wingspan' });
  const state = be.state.gifts;
  return {
    isArray: Array.isArray(state),
    keys: state.map((g) => Object.keys(g).join(',')),
    records: state,
    response: res.gift,
    second: again.gift.product,
    birthdaysLast: (await be.birthdays()).filter((x) => x.lastGift).map((x) => `${x.name}: ${JSON.stringify(x.lastGift)}`),
    samRow: (await be.members({ q: sam.customerId, sort: 'spend' }))[0].giftedThisYear,
  };
});
console.log(JSON.stringify(out, null, 1));
console.log('errors', page.errors);
await ctx.close();
await browser.close();
server.close();
