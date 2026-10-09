// The theme (dg-theme-t5) on the mock renderer in live mode, behind a stand-in for Shopify's app proxy that signs
// every /apps/liar/* request like Shopify and forwards it to the real Lair app (wrangler dev, :8787).
// Each browser context is "logged in" with a qa_customer cookie: the page's Liquid `customer` and the proxy's
// logged_in_customer_id both come from it, so two people can use the site at once without mixing up.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { proxyUrl, API, forwardedFor } from './client.mjs';

process.env.DG_THEME = process.env.DG_THEME || '/home/claude/dg-theme-t5';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const render = await import('../theme-mock/render.mjs');
export const { mockState, globalSettings } = render;

export const PORT = Number(process.env.QA_PORT || 4180);
export const BASE = `http://localhost:${PORT}`;
export const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

export const CUSTOMERS = {
  7001: { id: 7001, first_name: 'Mo', name: 'Mo Ashgrove', email: 'mo@dicegoblin.test', phone: '', tags: ['staff'] },
  7101: { id: 7101, first_name: 'Sam', name: 'Sam Jones', email: 'sam@example.com', phone: '021 555 0101', tags: [] },
  7102: { id: 7102, first_name: 'Kiri', name: 'Kiri Smith', email: 'kiri@example.com', phone: '', tags: [] },
  7103: { id: 7103, first_name: 'Ana', name: 'Ana Rangi', email: 'ana@example.com', phone: '', tags: ['gm'] },
  7104: { id: 7104, first_name: 'Leo', name: 'Leo Tane', email: 'leo@example.com', phone: '', tags: [] },
  // a brand-new customer: nothing in the Lair app yet
  7105: { id: 7105, first_name: 'Zoë', name: 'Zoë van der Berg', email: 'zoe@example.com', phone: '', tags: [] },
};

globalSettings.lair_mode = 'live';
globalSettings.lair_api = API;
export const apiLog = [];

const customerOf = (req) => {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)qa_customer=(\d+)/);
  return m ? CUSTOMERS[m[1]] || null : null;
};

mockState.before = async (req, res, url) => {
  const who = customerOf(req);
  if (url.pathname.startsWith('/__checkout/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Checkout</title><h1>Fake Shopify checkout ${url.pathname.split('/').pop()}</h1>`);
    return true;
  }
  if (!url.pathname.startsWith(`${API}/`)) {
    mockState.customer = who; // the page renders for this person
    return false;
  }
  const route = `${url.pathname.slice(API.length + 1)}${url.search}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(proxyUrl(route, who ? who.id : ''), {
    method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-Forwarded-For': forwardedFor() },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const text = await upstream.text();
  // whole replies (a member card with owed rows and passes runs past 4 kB), so the flows can parse them
  apiLog.push({ at: Date.now(), who: who?.id || null, method: req.method, route, status: upstream.status, body: chunks.length ? Buffer.concat(chunks).toString('utf8').slice(0, 2000) : null, text: text.slice(0, 200000) });
  // the app's own content type, as Shopify's proxy passes it on (round 13: a followed game's calendar is text/calendar)
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
  res.end(text);
  return true;
};

let server;
let browser;
export async function start({ fakeCamera = false } = {}) {
  server = await render.serve(PORT);
  // fakeCamera: Chromium's test camera (a moving pattern) with camera permission granted, for the scanner sheet
  browser = await chromium.launch(fakeCamera ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } : {});
  return { server, browser };
}
export async function stop() {
  await browser?.close();
  server?.close();
}

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' };
export const DESKTOP = { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' };

/** A browser context logged in as `customerId` (or nobody), phone-sized unless `device` says otherwise */
export async function context(customerId = null, device = PHONE, { camera = false } = {}) {
  const ctx = await browser.newContext({ ...device, permissions: camera ? ['camera'] : [] });
  if (customerId) await ctx.addCookies([{ name: 'qa_customer', value: String(customerId), url: BASE }]);
  return ctx;
}

/** A page that records script errors, console errors and failed requests */
export async function page(ctx, label) {
  const p = await ctx.newPage();
  p.problems = [];
  p.on('pageerror', (e) => p.problems.push(`${label} pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') p.problems.push(`${label} console: ${m.text().slice(0, 300)}`);
  });
  p.on('requestfailed', (r) => {
    if (!/\/__checkout\//.test(r.url())) p.problems.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  p.on('response', (r) => {
    if (r.status() >= 500) p.problems.push(`${label} ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  return p;
}

export async function overflow(p) {
  return p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

export async function shot(p, name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: file, fullPage: opts.fullPage ?? false, ...(opts.clip ? { clip: opts.clip } : {}) });
  return file;
}

export const text = async (p, selector) => ((await p.textContent(selector).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
export const lastApi = (method, re) => [...apiLog].reverse().find((c) => c.method === method && re.test(c.route));
