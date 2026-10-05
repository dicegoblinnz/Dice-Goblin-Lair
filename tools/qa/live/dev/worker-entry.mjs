// Dev-only entry for `wrangler dev`: the real Lair app (this repo's src, unchanged), with every call to the shop's
// Admin API sent to the local fake (../fake-admin.mjs) instead of Shopify, and email (Resend) to the fake's recorder.
// Nothing else may leave the machine, so a test run can never touch the real store.
import worker, { Lair } from '../../../../src/index.js';

const FAKE = 'http://127.0.0.1:8799';
const SHOP_HOST = 'ep0qiq-rp.myshopify.com';
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.host === SHOP_HOST) return realFetch(new Request(`${FAKE}${url.pathname}${url.search}`, request));
  if (url.host === 'api.resend.com') return realFetch(new Request(`${FAKE}/resend${url.pathname}`, request));
  // Round 7: Shopify's staged upload target for event pictures, which the Worker posts to itself
  if (url.host === 'shopify-staged-uploads.storage.googleapis.com') return realFetch(new Request(`${FAKE}/__upload${url.pathname}`, request));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(request);
  console.warn(`dev entry: refused an outbound request to ${url.host}`);
  return new Response(JSON.stringify({ message: `refused in dev: ${url.host}` }), { status: 503, headers: { 'Content-Type': 'application/json' } });
};

export { Lair };
export default worker;
