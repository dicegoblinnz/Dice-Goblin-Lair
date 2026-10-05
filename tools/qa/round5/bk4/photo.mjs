// Round 5, GM games on the staff page: "New game for a GM" and "Edit this session" frame a picture with the shared
// picker (lair-photo.js): pick a photo, drag and zoom it, the labels follow the system and schedule, and it uploads
// after the game is saved. Usage: node photo.mjs phone|desktop
// Round 7: "New game for a GM" is "Make a session", the GMs' own steps (<lair-session-form>, assets/lair-session-form.js),
// so making one goes through the steps (makeSession below) instead of filling one form; the picture is on step 1.
import { m, chromium, open, shot, text, overflow, smallTargets, wideOnes, STAFF, PORT } from './lib.mjs';
const tag = process.argv[2] || 'phone';
const server = await m.serve(PORT);
const browser = await chromium.launch();
m.mockState.customer = STAFF;
const { ctx, page } = await open(browser, tag, '/pages/lair-staff');
const log = (...a) => console.log(tag, '|', ...a);
const sleep = (ms) => page.waitForTimeout(ms);
const check = async (label, root) => {
  log(`${label}: overflow ${await overflow(page)}, small targets ${JSON.stringify(await smallTargets(page, root))}`);
  const wide = await wideOnes(page);
  if (wide.length) log('  wide:', JSON.stringify(wide));
};
// a test photo: 1600×1000 with stripes and a circle, so moving and zooming show
const photo = async (hue) => {
  const url = await page.evaluate((h) => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1000;
    const x = c.getContext('2d');
    for (let i = 0; i < 16; i += 1) {
      x.fillStyle = `hsl(${h + i * 12}, 70%, ${35 + (i % 2) * 20}%)`;
      x.fillRect(i * 100, 0, 100, 1000);
    }
    x.fillStyle = '#fff';
    x.beginPath();
    x.arc(800, 500, 220, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#000';
    x.font = 'bold 120px sans-serif';
    x.fillText('GOB', 680, 545);
    return c.toDataURL('image/png');
  }, hue);
  return { name: `test-${hue}.png`, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
};

/** Round 7: steps 2 to 5 of Make a session (the GMs' own form): players, at the table, when and where on the map,
    and the GM picked from the customers */
const F = '[data-games] lair-session-form';
const makeSession = async ({ day, tables, schedule = 'one-shot', gm }) => {
  await page.click(`${F} [data-step-next]`);
  await page.waitForSelector(`${F} [data-step="players"]`);
  await page.click(`${F} label.chip:has-text("All ages")`);
  await page.click(`${F} [data-step-next]`);
  await page.waitForSelector(`${F} [data-step="table"]`);
  await page.click(`${F} label.pay-option:has-text("Pre-generated")`);
  await page.click(`${F} [data-step-next]`);
  await page.waitForSelector(`${F} [data-step="when"]`);
  if (schedule !== 'one-shot') await page.click(`${F} label.chip:has(input[name="schedule"][value="${schedule}"])`);
  await page.click(`${F} [data-day="${day}"]`);
  await page.click(`${F} [data-stepper="hours"] [data-step-down]`);
  await page.click(`${F} [data-slot="${18 * 60}"]`);
  for (const id of tables) await page.evaluate(({ F, id }) => document.querySelector(`${F} gm-floor [data-table="${id}"]`).click(), { F, id });
  await page.click(`${F} [data-step-next]`);
  await page.waitForSelector(`${F} [data-step="gm"]`);
  await page.fill(`${F} [data-sf-search]`, gm);
  await page.waitForSelector(`${F} [data-sf-pick]`);
  await page.click(`${F} [data-sf-pick]`);
};

// ---------- 1. New game for a GM (round 7: Make a session), with a picture ----------
await page.click('[data-tab="games"]');
await sleep(400);
await page.click('[data-gm-new]');
await sleep(400);
log('create form picture field:', await text(page, '[data-gm-photo="create"]'));
const pick = await page.evaluate(() => {
  const { store } = window.Lair;
  const t = store.time;
  const day = t.addDays(t.today(), 3);
  const start = t.at(day, 18 * 60);
  const end = t.at(day, 21 * 60);
  for (const room of store.cfg.rooms) {
    if (!room.bookable) continue;
    const free = room.tables.filter((tb) => store.isFree(tb.id, start, end) && !store.isShopTable(tb.id));
    if (free.length >= 2) return { day, tables: free.slice(0, 2).map((tb) => tb.id) };
  }
  return null;
});
log('free then:', JSON.stringify(pick));
await page.fill(`${F} [name="title"]`, 'Picture test: the Owlbear’s Lair');
await page.click(`${F} label.chip:has-text("Daggerheart")`);
await page.fill(`${F} [name="blurb"]`, 'A short pitch for the picture test.');
await page.setInputFiles('[data-gm-photo-input="create"]', await photo(20));
await sleep(900);
const frame = await page.evaluate(() => {
  const f = document.querySelector('[data-gm-photo="create"] [data-crop-frame]');
  const c = f && f.querySelector('canvas');
  const sys = document.querySelector('[data-gm-photo="create"] [data-crop-system]');
  const sched = document.querySelector('[data-gm-photo="create"] [data-crop-sched]');
  return f ? { w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height), canvas: `${c.width}x${c.height}`, system: sys.textContent, hidden: sys.hidden, sched: sched.textContent, accent: f.closest('[data-crop]').dataset.accent } : null;
});
log('frame:', JSON.stringify(frame));
// the labels follow the form (round 7: the system on this step; how often it runs is step 4's)
await page.click(`${F} label.chip:has-text("Call of Cthulhu")`);
await sleep(200);
log('labels now:', await page.evaluate(() => {
  const crop = document.querySelector('[data-gm-photo="create"] [data-crop]');
  return `${crop.querySelector('[data-crop-system]').textContent} / ${crop.querySelector('[data-crop-sched]').textContent} / ${crop.dataset.accent}`;
}));
// drag it and zoom it
const box = await page.$eval('[data-gm-photo="create"] [data-crop-frame]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.w / 2 - 60, box.y + box.h / 2 + 10, { steps: 6 });
await page.mouse.up();
await page.$eval('[data-gm-photo="create"] [data-crop-zoom]', (el) => {
  el.value = String(Math.min(Number(el.max), 1.6));
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
log('zoom:', await page.$eval('[data-gm-photo="create"] [data-crop-zoom]', (el) => `${el.value} of ${el.max}, ${el.getAttribute('aria-valuetext')}`));
await page.$eval('[data-gm-photo="create"]', (el) => el.scrollIntoView({ block: 'center' }));
await sleep(200);
await shot(page, `${tag}-p1-create-framed`, '[data-gm-photo="create"]');
await check('create form', '[data-gm-create]');
await makeSession({ day: pick.day, tables: pick.tables, schedule: 'weekly', gm: 'rangi' });
await page.click(`${F} [data-step-next]`);
await sleep(1500);
log('toast:', await text(page, '.toast'));
const made = await page.evaluate(() => {
  const g = window.Lair.store.data.games.find((x) => x.title.startsWith('Picture test'));
  return g ? { id: g.id, image: g.image ? `${g.image.slice(0, 23)}… ${Math.round(g.image.length / 1024)} KB` : null, series: g.seriesId } : null;
});
log('listed:', JSON.stringify(made));
const size = await page.evaluate(async () => {
  const g = window.Lair.store.data.games.find((x) => x.title.startsWith('Picture test'));
  if (!g || !g.image) return null;
  const img = new Image();
  img.src = g.image;
  await img.decode();
  return `${img.naturalWidth}x${img.naturalHeight}`;
});
log('uploaded picture size:', size);

// ---------- 2. Edit this session: the picture now, then another one, then keep the old one ----------
await page.click('.staff-gm summary.staff-gm__summary');
await sleep(300);
log('edit picture field:', await text(page, '[data-gm-photo^="edit:"]'));
await page.$eval('[data-gm-photo^="edit:"]', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-p2-edit-current`, '[data-gm-photo^="edit:"]');
await page.setInputFiles('[data-gm-photo^="edit:"] [data-gm-photo-input]', await photo(200));
await sleep(900);
log('edit framed:', await text(page, '[data-gm-photo^="edit:"]'));
await page.$eval('[data-gm-photo^="edit:"]', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-p3-edit-framed`, '[data-gm-photo^="edit:"]');
await check('edit form', '[data-gm-edit]');
await page.click('[data-gm-photo-remove]');
await sleep(300);
log('kept the old one:', await text(page, '[data-gm-photo^="edit:"]'));
await page.setInputFiles('[data-gm-photo^="edit:"] [data-gm-photo-input]', await photo(200));
await sleep(900);
const before = await page.evaluate(() => window.Lair.store.data.games.find((x) => x.title.startsWith('Picture test')).image.length);
await page.click('[data-gm-edit] button[type="submit"]');
await sleep(1500);
log('saved toast:', await text(page, '.toast'));
const after = await page.evaluate(() => window.Lair.store.data.games.find((x) => x.title.startsWith('Picture test')).image.length);
log('picture changed:', before !== after, before, after);
// every session of the series shows it
log('series sessions with the picture:', await page.evaluate(() => {
  const g = window.Lair.store.data.games.find((x) => x.title.startsWith('Picture test'));
  const all = window.Lair.store.data.games.filter((x) => x.seriesId && x.seriesId === g.seriesId);
  return `${all.filter((x) => x.image === g.image).length} of ${all.length}`;
}));

// ---------- 3. a picture that won't upload: it waits under Edit this session ----------
await page.click('[data-gm-back]');
await sleep(300);
await page.click('[data-gm-new]');
await sleep(300);
await page.fill(`${F} [name="title"]`, 'Picture test 2');
await page.click(`${F} label.chip:has-text("D&D 5e")`);
await page.fill(`${F} [name="blurb"]`, 'Upload fails.');
const free2 = await page.evaluate((day) => {
  const { store } = window.Lair;
  const t = store.time;
  const start = t.at(day, 18 * 60);
  const end = t.at(day, 21 * 60);
  for (const room of store.cfg.rooms) {
    if (!room.bookable) continue;
    const free = room.tables.filter((tb) => store.isFree(tb.id, start, end) && !store.isShopTable(tb.id));
    if (free.length >= 2) return free.slice(0, 2).map((tb) => tb.id);
  }
  return [];
}, pick.day);
await page.setInputFiles('[data-gm-photo-input="create"]', await photo(100));
await sleep(900);
await page.evaluate(() => {
  const be = window.Lair.store.backend;
  be.uploadGameImage = async () => { throw Object.assign(new Error('That picture is too big. Try a smaller one.'), { status: 413 }); };
});
await makeSession({ day: pick.day, tables: free2, gm: 'kiri' });
await page.click(`${F} [data-step-next]`);
await sleep(1500);
log('failed upload toast:', await text(page, '.toast'));
log('edit open with it waiting:', await page.evaluate(() => {
  const d = document.querySelector('.staff-gm details.staff-gm__more');
  return `${d && d.open} | ${document.querySelector('[data-gm-photo^="edit:"] [data-crop-frame]') ? 'frame shown' : 'no frame'}`;
}));
await page.$eval('[data-gm-photo^="edit:"]', (el) => el.scrollIntoView({ block: 'center' }));
await shot(page, `${tag}-p4-upload-waiting`, '[data-gm-photo^="edit:"]');
log('errors', JSON.stringify(page.errors));
await ctx.close();
await browser.close();
server.close();
