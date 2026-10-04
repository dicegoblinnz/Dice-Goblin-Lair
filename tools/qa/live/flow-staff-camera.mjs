// Staff camera check-in through the shared scanner (lair-scan.js). Chromium's fake camera plays a test pattern, and a
// stand-in BarcodeDetector "reads" whatever window.__qaCode holds, like an iPad looking at a ticket's QR code.
import { start, stop, context, page, shot, text, apiLog, PHONE, DESKTOP, BASE } from './harness.mjs';
import { check, summary, proxy } from './client.mjs';

const DEVICE = process.argv[2] === 'desktop' ? DESKTOP : PHONE;
const L = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const tz = 'Pacific/Auckland';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const at = (h) => Date.parse(`${today}T${String(h).padStart(2, '0')}:00:00+13:00`);
const made = await proxy('POST', 'bookings', { customer: '7001', body: { kind: 'table', tables: [L === 'desktop' ? 'T5' : 'T6'], start: at(18), end: at(19), people: 2, name: `Camera ${L}`, email: `camera.${L}@example.com`, staffOverride: true } });
check(`${L}: a booking to scan`, made.status === 200, made.data.error || made.data.booking.ref);
const ref = made.data.booking.ref;

await start({ fakeCamera: true });
const ctx = await context(7001, DEVICE, { camera: true });
await ctx.addInitScript(() => {
  // what the camera "sees": set window.__qaCode
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['qr_code', 'code_128', 'ean_13']; }
    constructor(opts) { window.__qaFormats = opts && opts.formats; }
    async detect() { return window.__qaCode ? [{ rawValue: window.__qaCode, format: 'qr_code' }] : []; }
  };
});
const p = await page(ctx, `${L}/camera`);
await p.goto(`${BASE}/pages/lair-staff`, { waitUntil: 'networkidle' });
const scripts = await p.evaluate(() => [...document.scripts].map((s) => s.src.split('/').pop()).filter(Boolean));
check(`${L}: the staff page loads lair-scan.js before lair-staff.js`, scripts.indexOf('lair-scan.js') > -1 && scripts.indexOf('lair-scan.js') < scripts.indexOf('lair-staff.js'), scripts.join(' '));
check(`${L}: the Camera button shows`, await p.isVisible('[data-camera]'));
await p.click('[data-camera]');
await p.waitForSelector('dialog.lair-scan[open]', { timeout: 5000 });
check(`${L}: the scanner sheet opens, titled for tickets`, /Scan a ticket or card/.test(await text(p, 'dialog.lair-scan')));
await p.waitForTimeout(800);
const formats = await p.evaluate(() => window.__qaFormats);
check(`${L}: it reads QR codes and Code 128`, Array.isArray(formats) && formats.includes('qr_code') && formats.includes('code_128'), formats);
// a product barcode isn't a Lair code: it says so and keeps looking
await p.evaluate(() => { window.__qaCode = '9300675024235'; });
await p.waitForTimeout(900);
const said = await text(p, 'dialog.lair-scan [data-scan-status]');
check(`${L}: a product barcode: "not one of our codes", the sheet stays open`, /not one of our codes/.test(said) && (await p.$('dialog.lair-scan[open]')) !== null, said);
await shot(p, `staff-camera-sheet-${L}`);
// the ticket's QR
let b = apiLog.length;
await p.evaluate((code) => { window.__qaCode = code; }, ref);
await p.waitForSelector('dialog.lair-scan', { state: 'detached', timeout: 6000 }).catch(() => {});
await p.waitForSelector('.checkin-card:not(.checkin-card--pending)', { timeout: 6000 }).catch(() => {});
await p.waitForTimeout(500);
const call = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('checkin'));
check(`${L}: the ticket's QR checks them in and closes the sheet`, call?.status === 200 && JSON.parse(call.body).code === ref && JSON.parse(call.text).checkedIn === true && !(await p.$('dialog.lair-scan')), call ? call.text.slice(0, 160) : 'no call');
check(`${L}: the check-in card shows them`, (await text(p, '[data-checkin-result]')).includes(ref));
// typed into the sheet: goes through as typed (lower case, no dashes)
await p.evaluate(() => { window.__qaCode = ''; });
await p.click('[data-camera]');
await p.waitForSelector('dialog.lair-scan[open]');
await p.fill('dialog.lair-scan input[name="code"]', ref.toLowerCase().replace(/-/g, ''));
b = apiLog.length;
await p.press('dialog.lair-scan input[name="code"]', 'Enter');
await p.waitForTimeout(1200);
const typed = apiLog.slice(b).find((c) => c.method === 'POST' && c.route.startsWith('checkin'));
check(`${L}: typed into the sheet: checks in (already here)`, typed?.status === 200 && JSON.parse(typed.text).reason === 'already' && !(await p.$('dialog.lair-scan')), typed ? typed.text.slice(0, 160) : 'no call');
// Close leaves it closed and the code box ready
await p.click('[data-camera]');
await p.waitForSelector('dialog.lair-scan[open]');
await p.click('dialog.lair-scan [data-scan-close]');
await p.waitForTimeout(300);
check(`${L}: Close shuts the sheet and turns the camera off`, !(await p.$('dialog.lair-scan')) && !(await p.evaluate(() => document.documentElement.classList.contains('lair-scan-lock'))));
check(`${L}: no script errors`, p.problems.length === 0, p.problems.join(' | '));
await stop();
process.exit(summary() ? 1 : 0);
