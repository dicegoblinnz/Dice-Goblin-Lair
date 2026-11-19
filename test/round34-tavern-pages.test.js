// Round 34b (contract v34-tavern, section 4a): the Tavern's order page and the staff's drinks list are pages the Lair
// serves through the store's app proxy. Each is the same for everyone: nothing about anyone is in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { TAVERN_ITEMS } from '../src/tavern-menu.js';
import { TAVERN_LOOKS, tavernPageFor, tavernPageHtml } from '../src/tavern-pages.js';

function signedUrl(path, params, secret = 'hush') {
  const search = new URLSearchParams(params);
  const grouped = {};
  for (const [k, v] of search) (grouped[k] ||= []).push(v);
  const message = Object.entries(grouped).map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  search.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return `https://worker.test${path}?${search}`;
}
const asked = [];
const env = {
  SHOP: 'example-shop.myshopify.com', SHOPIFY_CLIENT_SECRET: 'hush',
  LAIR: { idFromName: () => 'id', get: () => ({ fetch: async (request) => { asked.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ lair: true }); } }) },
};
const base = { shop: env.SHOP, path_prefix: '/apps/liar', timestamp: String(Math.floor(Date.now() / 1000)) };
const through = (path, { method = 'GET', params = {} } = {}) =>
  worker.fetch(new Request(signedUrl(`/proxy${path}`, { ...base, ...params }), { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }), env);

test('which address is which page', () => {
  assert.equal(tavernPageFor('/tavern'), 'order');
  assert.equal(tavernPageFor('/tavern/'), 'order');
  assert.equal(tavernPageFor('/tavern/drinks'), 'staff');
  for (const path of ['/tavern/menu', '/tavern/mine', '/tavern/queue', '/tavern/drinks/td_1/done', '/tavernx', '/', '']) assert.equal(tavernPageFor(path), null, path);
});

test('through the store, /tavern and /tavern/drinks are pages, locked down, and the same whoever asks', async () => {
  for (const [path, title] of [['/tavern', 'Tavern: order at the table'], ['/tavern/drinks', 'Tavern: drinks to make']]) {
    asked.length = 0;
    const res = await through(path, { params: { t: 'ABCD2345', logged_in_customer_id: '7001' } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /^text\/html/);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Referrer-Policy'), 'same-origin', "the table's code stays out of other sites' logs");
    assert.ok(html.includes(`<title>${title}</title>`));
    // only this answer's own script and styles run; nothing else loads but the two fonts
    const csp = res.headers.get('Content-Security-Policy');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && nonce.length >= 20, csp);
    assert.ok(csp.includes("default-src 'none'") && csp.includes("connect-src 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes('unsafe'), csp);
    assert.equal(html.match(/<script/g).length, 1);
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.ok(!/\sstyle="/.test(html) && !/\son[a-z]+="/.test(html), 'no inline styles or handlers for the rules to block');
    // nothing about whoever asked, and the Lair itself wasn't troubled
    assert.ok(!html.includes('7001') && !html.includes('ABCD2345') && !html.includes('hush') && !html.includes(env.SHOP));
    assert.deepEqual(asked, []);
    const again = await through(path, { params: { logged_in_customer_id: '7002' } });
    assert.notEqual(/script-src 'nonce-([^']+)'/.exec(again.headers.get('Content-Security-Policy'))[1], nonce, 'a fresh nonce every time');
    assert.equal((await again.text()).replaceAll(/nonce="[^"]+"/g, ''), html.replaceAll(/nonce="[^"]+"/g, ''));
  }
});

test("the pages are only reached through the store, and the Lair's own routes beside them still answer", async () => {
  const bare = await worker.fetch(new Request('https://worker.test/tavern'), env);
  assert.equal(bare.status, 404);
  const forged = await worker.fetch(new Request(`${signedUrl('/proxy/tavern', base)}0`), env);
  assert.equal(forged.status, 401);
  asked.length = 0;
  assert.deepEqual(await (await through('/tavern/menu')).json(), { lair: true });
  assert.deepEqual(await (await through('/tavern/queue')).json(), { lair: true });
  assert.deepEqual(await (await through('/tavern/drinks/td_1/done', { method: 'POST' })).json(), { lair: true });
  assert.deepEqual(await (await through('/tavern', { method: 'POST' })).json(), { lair: true }, 'only a GET is a page');
  assert.deepEqual(asked, ['GET /tavern/menu', 'GET /tavern/queue', 'POST /tavern/drinks/td_1/done', 'POST /tavern']);
});

test("the pages' code: every drink has its drawing, the script can't be ended early, and it never writes HTML", () => {
  for (const item of TAVERN_ITEMS) assert.ok(TAVERN_LOOKS[item.id]?.c, `${item.name} has a colour`);
  assert.deepEqual(Object.keys(TAVERN_LOOKS).filter((id) => !TAVERN_ITEMS.some((x) => x.id === id)), []);
  for (const kind of ['order', 'staff']) {
    const html = tavernPageHtml(kind, 'N0NCE');
    const script = html.slice(html.indexOf('<script nonce="N0NCE">') + 22, html.lastIndexOf('</script>'));
    assert.ok(!/<\/script/i.test(script));
    assert.doesNotThrow(() => new Function(script), 'the script is whole');
    // what members type (names, notes) only ever goes in as text
    for (const risky of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) assert.ok(!script.includes(risky), risky);
  }
});
