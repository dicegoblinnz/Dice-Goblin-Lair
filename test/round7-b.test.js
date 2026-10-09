// Round 7, backend-b (contract v7 sections 8 to 15): the customer picker, groups and group passes, the events editor,
// staff TTRPG sessions under the GM rules with GM invites, and the players staff add (weekly regulars, series invites).
// Run with: node --test test/  (under TZ=UTC and TZ=Pacific/Auckland: the dates here are Lair dates either way)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Lair, MIGRATIONS } from '../src/lair.js';
import { LairTime, rulesFromSettings } from '../src/core.js';

const TZ = 'Pacific/Auckland';
const time = new LairTime(TZ);
const HOUR = 3_600_000;
const MIN = 60_000;
// Thursday 1 October 2026, 1:00pm in Auckland (NZDT, UTC+13), as in lair.test.js
const NOW = Date.UTC(2026, 9, 1, 0, 0);
const realNow = Date.now;

/* ---------------- helpers, as in lair.test.js ---------------- */
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      if (/^\s*(select|with)/i.test(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      }
      stmt.run(...bindings);
      return { toArray: () => [], one: () => undefined };
    },
  };
  const kv = new Map();
  return { storage: { sql, get: async (k) => kv.get(k), put: async (k, v) => kv.set(k, v) }, waitUntil: () => {} };
}

const FALLBACK = [
  { id: 'common-room', name: 'Common room', code: 'T', tables: 20, seats: 4, order: 1 },
  { id: 'side-room-1', name: 'Side room 1', code: 'A', tables: 4, seats: 4, order: 2 },
  { id: 'side-room-2', name: 'Side room 2', code: 'B', tables: 4, seats: 4, order: 3 },
  { id: 'fancy-room', name: 'Fancy room', code: 'F', tables: 1, seats: 12, price: 15, minPeople: 4, order: 4 },
];
const TEST_HOURS = 'Mon closed\nTue 12:00-22:00\nWed 12:00-22:00\nThu 12:00-22:00\nFri 12:00-23:00\nSat 10:00-23:00\nSun 10:00-20:00';

let lair;
// Round 7 (backend-a): customer bookings need a mobile, so the helper adds one when a test sends none (as lair.test.js)
const MOBILE_ROUTES = /^(?:bookings|games\/[^/]+\/join-series|events\/[^/]+\/(?:join|reserve))$/;
async function call(method, path, body, customer = '', extraHeaders = {}) {
  const sent = method === 'POST' && body && MOBILE_ROUTES.test(path) && !('phone' in body) ? { ...body, phone: '021 555 0100' } : body;
  const response = await lair.fetch(
    new Request(`https://lair.test/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lair-Customer': customer, ...extraHeaders },
      body: sent ? JSON.stringify(sent) : undefined,
    }),
  );
  return { status: response.status, data: await response.json() };
}
const internal = (path, body) => call('POST', `internal/${path}`, body, '', { 'X-Lair-Internal': '1' });
const at = (day, hh, mm = 0) => time.at(day, hh * 60 + mm);
const useRules = (settings = {}, events = [], rooms = FALLBACK) => {
  lair.rulesCache = rulesFromSettings({ lair_hours: TEST_HOURS, lair_shop_tables: '', ...settings }, rooms, events);
  lair.rulesLoadedAt = NOW + 10 * 365 * 24 * HOUR;
};

function captureEmails(target = lair) {
  target.baseEnv = { ...target.baseEnv, RESEND_API_KEY: 're_test', FROM_EMAIL: 'Dice Goblin <bookings@dicegoblin.test>', STAFF_EMAIL: 'staff@dicegoblin.test' };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    for (const m of Array.isArray(body) ? body : [body]) sent.push({ ...m, to: m.to[0] });
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${i}` })) } : { id: 'e1' }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const member = (id, name, email) => call('POST', 'me/profile', { name, email }, id);
const game = (over = {}, who = 'gm') => call('POST', 'games', {
  title: 'Curse of Strahd', system: 'D&D 5e', gm: 'Ana', blurb: 'Mists and wolves.', seats: 4, tables: ['B1'], start: at('2026-10-01', 18), end: at('2026-10-01', 21), ...over,
}, who);

beforeEach(() => {
  Date.now = () => NOW;
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
  lair.shopify.orderSpend = async () => null;
  lair.shopify.orderBuyer = async () => null;
  useRules();
});
afterEach(() => {
  Date.now = realNow;
});

/* ---------------- a stand-in for the Admin API (shopify.js's real methods run against it) ---------------- */
const EVENT_KEYS = ['title', 'event_type', 'starts_at', 'ends_at', 'repeat', 'repeat_until', 'skip_dates', 'description', 'image', 'capacity', 'price_note',
  'product', 'link', 'tables', 'entry_fee', 'game_tables', 'lock_tables', 'payment', 'game'];
const CHOICES = { event_type: ['tcg', 'rpg', 'wargame', 'market', 'social', 'tournament', 'learn', 'launch', 'other'], repeat: ['weekly', 'fortnightly', 'monthly'], payment: ['In store', 'Online', 'Online or in store'] };

/**
 * Admin API operations by name, like tools/qa/live/fake-admin.mjs: rooms and settings (LairData, so rules reload), the
 * lair_event entries (kept, so later reads see what was written), files, and customers for the picker. Values are checked
 * the way Shopify checks the definition (choices, date formats, the game's 40 characters).
 */
function fakeAdmin({ events = [], customers = [] } = {}) {
  const state = {
    events: new Map(), files: new Map(), products: new Map([['gid://shopify/Product/8001', { handle: 'quiz-ticket', title: 'Quiz night ticket' }]]),
    customers, calls: [], denyRefs: false, denyWrites: false, denyFiles: false, down: false, failCustomers: false, rejectNext: null, notReady: 0, seq: 100,
  };
  const valueError = (key, value) => {
    if (!EVENT_KEYS.includes(key)) return `${key} is not a field`;
    if (value === '') return null;
    if (CHOICES[key] && !CHOICES[key].includes(value)) return `${key} must be one of the choices`;
    if (['starts_at', 'ends_at'].includes(key) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value)) return `${key} is not a date and time`;
    if (key === 'repeat_until' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'repeat_until is not a date';
    if (key === 'skip_dates' && !(Array.isArray(JSON.parse(value)) && JSON.parse(value).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))) return 'skip_dates is not a list of dates';
    if (key === 'capacity' && !(/^\d+$/.test(value) && Number(value) >= 1)) return 'capacity must be at least 1';
    if (key === 'entry_fee' && !/^\d+(\.\d{1,2})?$/.test(value)) return 'entry_fee is not a number with 2 places';
    if (key === 'lock_tables' && !['true', 'false'].includes(value)) return 'lock_tables is not true or false';
    if (key === 'image' && !/^gid:\/\/shopify\/MediaImage\/\d+$/.test(value)) return 'image is not a file';
    if (key === 'product' && !/^gid:\/\/shopify\/Product\/\d+$/.test(value)) return 'product is not a product';
    if (key === 'game' && value.length > 40) return 'game is too long';
    if (key === 'link' && !/^https?:\/\//.test(value)) return 'link is not a url';
    return null;
  };
  const node = (e, refs) => ({
    id: e.id, handle: e.handle, updatedAt: new Date(e.updatedAt).toISOString(),
    fields: EVENT_KEYS.map((key) => {
      const value = e.fields[key] ?? null;
      const field = { key, type: 'x', value };
      if (refs) {
        const file = key === 'image' && value ? state.files.get(value) : null;
        const product = key === 'product' && value ? state.products.get(value) : null;
        field.reference = file ? { __typename: 'MediaImage', id: value, alt: file.alt, image: file.url ? { url: file.url, width: 800, height: 450 } : null }
          : product ? { __typename: 'Product', id: value, handle: product.handle, title: product.title } : null;
      }
      return field;
    }),
  });
  const save = (handle, fields, existing = null) => {
    const errors = fields.map((f) => valueError(f.key, f.value)).filter(Boolean);
    if (state.rejectNext) errors.push(state.rejectNext);
    state.rejectNext = null;
    if (state.notReady > 0 && fields.some((f) => f.key === 'image' && f.value)) {
      state.notReady -= 1;
      errors.push('Image file is not ready yet');
    }
    if (!existing && state.events.has(handle)) errors.push('Handle has already been taken');
    const merged = { ...(existing?.fields || {}) };
    for (const f of fields) merged[f.key] = f.value === '' ? null : f.value;
    if (!merged.title) errors.push('Title can\'t be blank');
    if (!merged.starts_at) errors.push('Starts can\'t be blank');
    if (errors.length) return { userErrors: errors.map((message) => ({ field: ['fields'], message, code: 'INVALID' })) };
    const e = existing || { id: `gid://shopify/Metaobject/${(state.seq += 1)}`, handle };
    e.fields = merged;
    e.updatedAt = Date.now();
    state.events.set(e.handle, e);
    return { e };
  };
  const deny = (what) => { throw new Error(`Shopify API: Access denied for ${what} field. Required access: \`write_metaobjects\` access scope.`); };
  for (const e of events) state.events.set(e.handle, { id: `gid://shopify/Metaobject/${(state.seq += 1)}`, handle: e.handle, fields: { ...e.fields }, updatedAt: NOW - 24 * HOUR });
  const settingsText = JSON.stringify({ current: { lair_hours: TEST_HOURS, lair_shop_tables: '' } });
  const roomNodes = FALLBACK.map((r) => ({
    handle: r.id, capabilities: { publishable: { status: 'ACTIVE' } },
    fields: [['name', r.name], ['code', r.code], ['table_count', String(r.tables)], ['seats', String(r.seats)], ['sort_order', String(r.order)], ['price', r.price ? String(r.price) : null], ['min_people', r.minPeople ? String(r.minPeople) : null]]
      .filter(([, v]) => v != null).map(([key, value]) => ({ key, value })),
  }));
  lair.shopify.graphql = async (query, variables = {}) => {
    const op = (String(query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1];
    state.calls.push({ op, variables });
    if (state.down) throw new Error('Shopify API error 500');
    switch (op) {
      case 'LairData':
        return {
          rooms: { nodes: roomNodes },
          events: { nodes: [...state.events.values()].map((e) => ({ handle: e.handle, capabilities: null, fields: Object.entries(e.fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) })) },
          main: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/1', name: 'Test theme', files: { nodes: [{ body: { content: settingsText } }] } }] },
          shop: { name: 'Dice Goblin', shopAddress: {} },
        };
      case 'LairEventsAdmin':
        if (state.denyRefs) throw new Error('Shopify API: Access denied for reference field. Required access: `read_files` access scope.');
        return { metaobjects: { nodes: [...state.events.values()].map((e) => node(e, true)), pageInfo: { hasNextPage: false, endCursor: null } } };
      case 'LairEventsAdminPlain':
        return { metaobjects: { nodes: [...state.events.values()].map((e) => node(e, false)), pageInfo: { hasNextPage: false, endCursor: null } } };
      case 'LairEventHandle': {
        const e = state.events.get(variables.handle?.handle);
        return { metaobjectByHandle: e && variables.handle?.type === 'lair_event' ? node(e, false) : null };
      }
      case 'LairEventCreate': {
        if (state.denyWrites) deny('metaobjectCreate');
        const { type, handle, fields } = variables.metaobject;
        assert.equal(type, 'lair_event');
        const done = save(handle, fields);
        return { metaobjectCreate: done.e ? { metaobject: node(done.e, false), userErrors: [] } : { metaobject: null, userErrors: done.userErrors } };
      }
      case 'LairEventUpdate': {
        if (state.denyWrites) deny('metaobjectUpdate');
        const e = [...state.events.values()].find((x) => x.id === variables.id);
        if (!e) return { metaobjectUpdate: { metaobject: null, userErrors: [{ field: ['id'], message: 'Record not found', code: 'RECORD_NOT_FOUND' }] } };
        const done = save(e.handle, variables.metaobject.fields, e);
        return { metaobjectUpdate: done.e ? { metaobject: node(done.e, false), userErrors: [] } : { metaobject: null, userErrors: done.userErrors } };
      }
      case 'LairEventDelete': {
        if (state.denyWrites) deny('metaobjectDelete');
        const e = [...state.events.values()].find((x) => x.id === variables.id);
        if (e) state.events.delete(e.handle);
        return { metaobjectDelete: { deletedId: e ? e.id : null, userErrors: e ? [] : [{ field: ['id'], message: 'Record not found', code: 'RECORD_NOT_FOUND' }] } };
      }
      case 'LairStagedUpload': {
        if (state.denyFiles) throw new Error('Shopify API: Access denied for stagedUploadsCreate field. Required access: `write_files` access scope.');
        const [input] = variables.input;
        state.staged = input;
        const key = `tmp/1/products/${input.filename}`;
        return {
          stagedUploadsCreate: {
            stagedTargets: [{ url: 'https://shopify-staged-uploads.storage.googleapis.com/', resourceUrl: `https://shopify-staged-uploads.storage.googleapis.com/${key}`, parameters: [{ name: 'Content-Type', value: input.mimeType }, { name: 'success_action_status', value: '201' }, { name: 'key', value: key }, { name: 'policy', value: 'p0licy' }] }],
            userErrors: [],
          },
        };
      }
      case 'LairFileCreate': {
        const [file] = variables.files;
        const id = `gid://shopify/MediaImage/${(state.seq += 1)}`;
        state.files.set(id, { url: null, alt: file.alt, source: file.originalSource });
        return { fileCreate: { files: [{ id, fileStatus: 'UPLOADED', alt: file.alt, image: null }], userErrors: [] } };
      }
      case 'LairCustomers': {
        if (state.failCustomers) throw new Error('Shopify API: This app is not approved to access the Customer object. See https://partners.shopify.com for more details.');
        const q = String(variables.query || '').replace(/"/g, '').toLowerCase();
        const nodes = state.customers.filter((c) => [c.firstName, c.lastName, c.email].some((v) => String(v || '').toLowerCase().includes(q)))
          .map((c) => ({ id: c.id, displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email, firstName: c.firstName || null, lastName: c.lastName || null, verifiedEmail: true, defaultEmailAddress: c.email ? { emailAddress: c.email } : null }));
        return { customers: { nodes } };
      }
      default:
        throw new Error(`Fake Admin API: unknown operation ${op}`);
    }
  };
  Object.defineProperty(lair.shopify, 'configured', { value: true });
  return state;
}

/* ---------------- section 8: finding a customer ---------------- */
test('GET /customers (round 7): staff only, 2 letters at least; Lair members first, then Shopify customers the Lair hasn\'t met, 20 at most', async () => {
  await member('1001', 'Sam Jones', 'sam@example.com');
  await member('1002', 'Samira Patel', 'samira@example.com');
  await member('1003', 'Kiri Smith', 'kiri@example.com');
  const admin = fakeAdmin({
    customers: [
      { id: 'gid://shopify/Customer/1001', firstName: 'Sam', lastName: 'Jones', email: 'sam@example.com' },
      { id: 'gid://shopify/Customer/5005', firstName: 'Sammy', lastName: 'Lee', email: 'sammy@example.com' },
      { id: 'gid://shopify/Customer/5006', email: 'samoa.fan@example.com' },
    ],
  });
  assert.equal((await call('GET', 'customers?q=sam', null, '1001')).status, 403);
  assert.deepEqual(await call('GET', 'customers?q=s', null, 'staff').then((r) => [r.status, r.data.error]), [422, 'Type at least 2 letters to search.']);
  const found = (await call('GET', 'customers?q=sam', null, 'staff')).data;
  const sam = lair.memberRow('1001');
  assert.deepEqual(found.customers, [
    { customerId: '1001', name: 'Sam Jones', firstName: 'Sam', email: 'sam@example.com', code: sam.code, member: true },
    { customerId: '1002', name: 'Samira Patel', firstName: 'Samira', email: 'samira@example.com', code: lair.memberRow('1002').code, member: true },
    { customerId: '5005', name: 'Sammy Lee', firstName: 'Sammy', email: 'sammy@example.com', code: null, member: false },
    { customerId: '5006', name: '', firstName: '', email: 'samoa.fan@example.com', code: null, member: false },
  ]);
  assert.equal(found.shopify, true);
  assert.deepEqual(admin.calls.filter((c) => c.op === 'LairCustomers').map((c) => c.variables.query), ['"sam"'], 'the search is quoted');
  // A member code (any way it's typed) or a customer ID finds the member; Shopify only ever gets letters, numbers and @ . _ - + '
  assert.equal((await call('GET', `customers?q=${encodeURIComponent(sam.code.toLowerCase().replace(/-/g, ' '))}`, null, 'staff')).data.customers[0].customerId, '1001');
  await call('GET', `customers?q=${encodeURIComponent('kiri"); DROP <x>')}`, null, 'staff');
  assert.equal(admin.calls.filter((c) => c.op === 'LairCustomers').at(-1).variables.query, '"kiri DROP x"');
  // Shopify refuses (protected customer data not approved yet): Lair members only, and Shopify isn't asked again for 10 minutes
  admin.failCustomers = true;
  const fallback = (await call('GET', 'customers?q=sam', null, 'staff')).data;
  assert.deepEqual([fallback.shopify, fallback.customers.map((c) => c.customerId)], [false, ['1001', '1002']]);
  const asked = admin.calls.filter((c) => c.op === 'LairCustomers').length;
  admin.failCustomers = false;
  assert.equal((await call('GET', 'customers?q=sam', null, 'staff')).data.shopify, false);
  assert.equal(admin.calls.filter((c) => c.op === 'LairCustomers').length, asked, 'not asked again yet');
  Date.now = () => NOW + 11 * MIN;
  assert.equal((await call('GET', 'customers?q=sam', null, 'staff')).data.shopify, true);
  // 10 members at most, then Shopify's, 20 in all
  for (let i = 0; i < 12; i += 1) await member(String(2000 + i), `Tama Walker ${i}`, `tama${i}@example.com`);
  admin.customers = Array.from({ length: 15 }, (_, i) => ({ id: `gid://shopify/Customer/${3000 + i}`, firstName: 'Tama', lastName: `Other ${i}`, email: `t.other${i}@example.com` }));
  const many = (await call('GET', 'customers?q=tama', null, 'staff')).data.customers;
  assert.deepEqual([many.length, many.filter((c) => c.member).length, many.filter((c) => !c.member).length], [20, 10, 10]);
  // Without Shopify at all: members only
  lair = new Lair(fakeCtx(), { CURRENCY: 'NZD' });
  lair.person = async (id) => ({ customerId: id || null, staff: id === 'staff', gm: id === 'gm' });
  useRules();
  assert.deepEqual((await call('GET', 'customers?q=zz', null, 'staff')).data, { customers: [], shopify: false });
});

test('picking a customer the Lair hasn\'t met (round 7): their member record is made from the picker\'s name and email, with a code and no welcome roll', async () => {
  const made = await call('POST', 'groups', {
    name: 'Warhammer League', organiser: { customerId: '5005', name: 'Sammy Lee', email: 'sammy@example.com' }, members: [{ customerId: '5006', name: 'Ana Rangi', email: 'not an email' }],
  }, 'staff');
  assert.equal(made.status, 200, made.data.error);
  const sammy = lair.memberRow('5005');
  assert.deepEqual([sammy.name, sammy.first_name, sammy.email, sammy.last_seen], ['Sammy Lee', 'Sammy', 'sammy@example.com', null]);
  assert.match(sammy.code, /^SL-[A-Z]+-\d{1,2}$/);
  assert.equal(lair.memberRow('5006').email, null, 'an email that isn\'t one is left out');
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM loyalty_grants WHERE customer_id IN ('5005', '5006')").one().n, 0, 'no welcome roll (those are loot codes now)');
  assert.equal(lair.findCode(sammy.code)?.item.customer_id, '5005', 'the code works at the counter');
  // A customer ID the Lair doesn't know, sent with no name: nothing is made
  const unknown = await call('POST', 'groups', { name: 'Paint Club', members: [{ customerId: '7777' }] }, 'staff');
  assert.deepEqual([unknown.status, unknown.data.error], [404, 'That customer could not be found. Pick them from the search again.']);
  assert.equal((await call('POST', 'groups', { name: 'Paint Club', members: [{ customerId: 'abc', name: 'Not A Customer' }] }, 'staff')).status, 404, 'a customer ID is digits');
  assert.deepEqual([lair.memberRow('7777'), lair.sql.exec("SELECT COUNT(*) AS n FROM lair_groups WHERE name = 'Paint Club'").one().n], [null, 0]);
  // A member keeps their own name and email, whatever the picker sends
  await member('1001', 'Sam Jones', 'sam@example.com');
  await call('POST', 'groups', { name: 'Paint Club', members: [{ customerId: '1001', name: 'Someone Else', email: 'else@example.com' }] }, 'staff');
  assert.deepEqual([lair.memberRow('1001').name, lair.memberRow('1001').email], ['Sam Jones', 'sam@example.com']);
});

/* ---------------- section 9: groups and their passes ---------------- */
test('groups (round 7): a name (2 to 60 characters, one active group per name), an organiser who is always a member, up to 200 people; find, change, archive', async () => {
  await member('1001', 'Sam Jones', 'sam@example.com');
  await member('1002', 'Kiri Smith', 'kiri@example.com');
  await member('1003', 'Leo Tane', 'leo@example.com');
  assert.equal((await call('POST', 'groups', { name: 'Nope' }, '1001')).status, 403);
  assert.equal((await call('GET', 'groups', null, '1001')).status, 403);
  for (const name of ['', ' x ', 'y'.repeat(61)]) {
    assert.deepEqual(await call('POST', 'groups', { name }, 'staff').then((r) => [r.status, r.data.error]), [422, 'Give the group a name (up to 60 characters).']);
  }
  const league = await call('POST', 'groups', { name: '  Warhammer   League ', organiser: { customerId: '1001' }, members: [{ customerId: '1002' }, { customerId: '1002' }], note: 'Thursdays' }, 'staff');
  assert.equal(league.status, 200, league.data.error);
  const g = league.data.group;
  assert.deepEqual([g.name, g.organiser.customerId, g.members.map((m) => m.customerId), g.note, g.status, g.passes, g.createdAt, g.updatedAt], ['Warhammer League', '1001', ['1002', '1001'], 'Thursdays', 'active', [], NOW, NOW]);
  assert.deepEqual(g.members.find((m) => m.customerId === '1001'), { customerId: '1001', name: 'Sam Jones', email: 'sam@example.com', code: lair.memberRow('1001').code });
  assert.deepEqual(await call('POST', 'groups', { name: 'warhammer league' }, 'staff').then((r) => [r.status, r.data.error]), [409, "There's already a group called Warhammer League."]);
  const club = (await call('POST', 'groups', { name: 'Paint Club', members: ['1003'] }, 'staff')).data.group;
  assert.equal(club.organiser, null, 'an organiser is optional');
  // Find: by the group's name, or its members' names, emails and codes; by name; archived ones on request
  const names = async (q) => (await call('GET', `groups${q}`, null, 'staff')).data.groups.map((x) => x.name);
  assert.deepEqual(await names(''), ['Paint Club', 'Warhammer League']);
  assert.deepEqual(await names('?q=kiri'), ['Warhammer League']);
  assert.deepEqual(await names('?q=leo%40example'), ['Paint Club']);
  assert.deepEqual(await names(`?q=${encodeURIComponent(lair.memberRow('1003').code.toLowerCase().replace(/-/g, ' '))}`), ['Paint Club']);
  assert.deepEqual(await names('?q=hammer'), ['Warhammer League']);
  // Change: name (still one per active name), note, organiser (who joins), status
  assert.deepEqual(await call('POST', `groups/${club.id}/update`, { name: 'WARHAMMER LEAGUE' }, 'staff').then((r) => [r.status, r.data.error]), [409, "There's already a group called Warhammer League."]);
  assert.deepEqual(await call('POST', `groups/${club.id}/update`, { status: 'closed' }, 'staff').then((r) => [r.status, r.data.error]), [422, 'A group is active or archived.']);
  assert.deepEqual(await call('POST', 'groups/gr_nope/update', { note: 'x' }, 'staff').then((r) => [r.status, r.data.error]), [404, 'That group could not be found.']);
  Date.now = () => NOW + HOUR;
  const moved = (await call('POST', `groups/${club.id}/update`, { name: 'Brush Club', organiser: { customerId: '1002' }, note: '' }, 'staff')).data.group;
  assert.deepEqual([moved.name, moved.organiser.customerId, moved.members.map((m) => m.customerId).sort(), moved.note, moved.updatedAt], ['Brush Club', '1002', ['1002', '1003'], '', NOW + HOUR]);
  const archived = (await call('POST', `groups/${g.id}/update`, { status: 'archived' }, 'staff')).data.group;
  assert.equal(archived.status, 'archived');
  assert.deepEqual([await names(''), await names('?status=archived'), await names('?status=all')], [['Brush Club'], ['Warhammer League'], ['Brush Club', 'Warhammer League']]);
  // An archived group's name is free again; bringing it back checks the name
  const again = (await call('POST', 'groups', { name: 'Warhammer League' }, 'staff')).data.group;
  assert.deepEqual(await call('POST', `groups/${g.id}/update`, { status: 'active' }, 'staff').then((r) => [r.status, r.data.error]), [409, "There's already a group called Warhammer League."]);
  await call('POST', `groups/${again.id}/update`, { name: 'Warhammer League 2027' }, 'staff');
  assert.equal((await call('POST', `groups/${g.id}/update`, { status: 'active' }, 'staff')).data.group.status, 'active');
  // Members: add and remove; the organiser stays until there's a new one
  const removeOrganiser = await call('POST', `groups/${g.id}/members`, { remove: ['1001'] }, 'staff');
  assert.deepEqual([removeOrganiser.status, removeOrganiser.data.error], [409, "That's the organiser. Pick a new organiser first."]);
  const changed = (await call('POST', `groups/${g.id}/members`, { add: [{ customerId: '1003' }], remove: ['1002'] }, 'staff')).data.group;
  assert.deepEqual(changed.members.map((m) => m.customerId).sort(), ['1001', '1003']);
  assert.deepEqual(await call('POST', 'groups/gr_nope/members', { add: ['1003'] }, 'staff').then((r) => r.status), 404);
  // Up to 200 people
  const crowd = Array.from({ length: 199 }, (_, i) => ({ customerId: String(9000 + i), name: `Player ${i}` }));
  assert.equal((await call('POST', `groups/${g.id}/members`, { add: crowd }, 'staff')).status, 422);
  assert.equal((await call('POST', `groups/${g.id}/members`, { add: crowd.slice(0, 198) }, 'staff')).data.group.members.length, 200);
  assert.deepEqual(await call('POST', `groups/${g.id}/members`, { add: [{ customerId: '1002' }] }, 'staff').then((r) => [r.status, r.data.error]), [422, 'A group can have up to 200 people.']);
  assert.equal((await call('POST', 'groups', { name: 'Huge', members: [...crowd, { customerId: '1001' }, { customerId: '1002' }] }, 'staff')).status, 422);
});

test('session passes (round 7): one owner each (a group, a customer or a typed name); a group\'s code comes from its name and its holder reads as the group', async () => {
  await member('1001', 'Sam Jones', 'sam@example.com');
  const league = (await call('POST', 'groups', { name: 'Warhammer League', organiser: { customerId: '1001' } }, 'staff')).data.group;
  const refused = async (body, status, error) => {
    const res = await call('POST', 'passes', { label: 'League: 10 sessions', sessions: 10, ...body }, 'staff');
    assert.deepEqual([res.status, res.data.error], [status, error], JSON.stringify(body));
  };
  await refused({}, 422, 'Pick a group, pick a customer, or type a name.');
  await refused({ groupId: league.id, holderName: 'Sam' }, 422, 'A pass belongs to a group or a person, not both.');
  await refused({ groupId: league.id, customerId: '1001' }, 422, 'A pass belongs to a group or a person, not both.');
  await refused({ groupId: 'gr_nope' }, 404, 'That group could not be found.');
  const pass = (await call('POST', 'passes', { label: 'League: 10 sessions', sessions: 10, groupId: league.id, customerId: '', holderName: '', holderEmail: '' }, 'staff')).data.pass;
  assert.match(pass.code, /^WL-[A-Z]+-\d{1,2}$/, 'Warhammer League: WL-…');
  assert.deepEqual([pass.holder, pass.group], [{ customerId: null, name: 'Warhammer League', email: '' }, { id: league.id, name: 'Warhammer League' }]);
  assert.deepEqual((await call('GET', `groups?q=warhammer`, null, 'staff')).data.groups[0].passes, [{ id: pass.id, code: pass.code, label: 'League: 10 sessions', sessionsLeft: 10, sessionsTotal: 10, status: 'active' }]);
  // GET /passes finds it by the group's name; a person's pass has group: null
  assert.deepEqual((await call('GET', 'passes?q=league', null, 'staff')).data.passes.map((p) => p.code), [pass.code]);
  const sams = (await call('POST', 'passes', { label: 'Gift', sessions: 2, customerId: '1001' }, 'staff')).data.pass;
  assert.deepEqual([sams.group, sams.holder.customerId], [null, '1001']);
  // A customer the Lair hasn't met comes with their name and email from the picker
  const picked = (await call('POST', 'passes', { label: 'Gift', sessions: 2, customerId: '5005', holderName: 'Sammy Lee', holderEmail: 'sammy@example.com' }, 'staff')).data.pass;
  assert.deepEqual(picked.holder, { customerId: '5005', name: 'Sammy Lee', email: 'sammy@example.com' });
  assert.match(lair.memberRow('5005').code, /^SL-/);
  // Moving a pass: to a person needs the group taken off; back to a group clears the person; off a group needs an owner
  assert.deepEqual(await call('POST', `passes/${pass.id}/update`, { customerId: '1001' }, 'staff').then((r) => [r.status, r.data.error]), [422, 'A pass belongs to a group or a person, not both.']);
  assert.deepEqual(await call('POST', `passes/${pass.id}/update`, { groupId: null }, 'staff').then((r) => [r.status, r.data.error]), [422, 'Pick a group, pick a customer, or type a name.']);
  const toSam = (await call('POST', `passes/${pass.id}/update`, { groupId: null, customerId: '1001' }, 'staff')).data.pass;
  assert.deepEqual([toSam.group, toSam.holder.customerId, toSam.code], [null, '1001', pass.code]);
  const back = (await call('POST', `passes/${pass.id}/update`, { groupId: league.id }, 'staff')).data.pass;
  assert.deepEqual([back.group?.id, back.holder], [league.id, { customerId: null, name: 'Warhammer League', email: '' }]);
  assert.deepEqual({ ...lair.sql.exec('SELECT customer_id, holder_name, holder_email FROM passes WHERE id = ?', pass.id).one() }, { customer_id: null, holder_name: null, holder_email: null });
  // An archived group takes no new passes
  await call('POST', `groups/${league.id}/update`, { status: 'archived' }, 'staff');
  await refused({ groupId: league.id }, 409, 'That group is archived. Pick another, or bring it back first.');
});

test('a group\'s pass (round 7): any member of the active group uses it when they book, in their Wallet, at check-in and at the POS; it can\'t be claimed; archived or removed, they can\'t', async () => {
  await member('1001', 'Sam Jones', 'sam@example.com');
  await member('1002', 'Kiri Smith', 'kiri@example.com');
  await member('1003', 'Leo Tane', 'leo@example.com');
  const league = (await call('POST', 'groups', { name: 'Warhammer League', organiser: { customerId: '1001' }, members: ['1002'] }, 'staff')).data.group;
  const pass = (await call('POST', 'passes', { label: 'League: 10 sessions', sessions: 10, groupId: league.id }, 'staff')).data.pass;
  const table = (over = {}, who = '1002') => call('POST', 'bookings', { kind: 'table', tables: ['T5'], start: at('2026-10-01', 18), end: at('2026-10-01', 20), people: 2, name: 'Kiri', email: 'kiri@example.com', usePass: pass.code, ...over }, who);
  const booked = await table();
  assert.equal(booked.status, 200, booked.data.error);
  assert.equal(booked.data.booking.pass.code, pass.code, "Kiri saves the league's pass on her booking");
  assert.deepEqual(await table({ tables: ['T6'], email: 'leo@example.com' }, '1003').then((r) => [r.status, r.data.error]), [403, "That pass isn't yours. Ask us at the counter."], 'Leo isn\'t in the group');
  // Each member's Wallet shows it, with the group
  const wallet = (await call('GET', 'me', null, '1001')).data.passes;
  assert.deepEqual(wallet.map((p) => [p.code, p.group]), [[pass.code, { id: league.id, name: 'Warhammer League' }]]);
  assert.deepEqual((await call('GET', 'me', null, '1003')).data.passes, []);
  // At check-in (a member code) and at the POS (scanning the member code), the member's passes include the group's
  const kiriCode = lair.memberRow('1002').code;
  Date.now = () => at('2026-10-01', 17, 45);
  const card = (await call('POST', 'checkin', { code: kiriCode }, 'staff')).data;
  assert.deepEqual(card.passes.map((p) => [p.code, p.group?.name, p.holder.name]), [[pass.code, 'Warhammer League', 'Warhammer League']]);
  const scan = (await internal('pos/scan', { code: kiriCode })).data;
  assert.deepEqual(scan.passes.map((p) => [p.code, p.group?.id]), [[pass.code, league.id]]);
  assert.deepEqual((await internal('pos/member', { code: kiriCode })).data.passes.map((p) => p.code), [pass.code]);
  // Checking in uses it, like any saved pass
  const checked = (await call('POST', 'checkin', { code: booked.data.booking.ref }, 'staff')).data;
  assert.deepEqual([checked.pass.code, checked.pass.used, checked.due], [pass.code, 2, 0]);
  // A group's pass can't be claimed (or redeemed)
  assert.deepEqual(await call('POST', 'me/passes/claim', { code: pass.code }, '1003').then((r) => [r.status, r.data.error]), [409, 'That pass belongs to a group. Ask us at the counter.']);
  // Removed from the group: Kiri can't use it, and it leaves her Wallet
  await call('POST', `groups/${league.id}/members`, { remove: ['1002'] }, 'staff');
  assert.deepEqual([(await call('GET', 'me', null, '1002')).data.passes, (await table({ start: at('2026-10-02', 18), end: at('2026-10-02', 20) })).status], [[], 403]);
  // Archived: nobody uses it any more, but staff still can by its code
  await call('POST', `groups/${league.id}/update`, { status: 'archived' }, 'staff');
  assert.deepEqual([(await call('GET', 'me', null, '1001')).data.passes, (await table({ start: at('2026-10-02', 18), end: at('2026-10-02', 20), email: 'sam@example.com' }, '1001')).status], [[], 403]);
  assert.deepEqual((await call('POST', 'checkin', { code: lair.memberRow('1001').code }, 'staff')).data.passes, []);
  const staffBooked = await table({ tables: ['T7'], start: at('2026-10-02', 18), end: at('2026-10-02', 20), name: 'Walk-up', email: 'walkup@example.com' }, 'staff');
  assert.equal(staffBooked.data.booking.pass.code, pass.code, 'staff may use any active pass');
});

/* ---------------- section 10: the events editor ---------------- */
const QUIZ = {
  handle: 'weekly-quiz',
  fields: {
    title: 'Quiz night', event_type: 'social', starts_at: '2026-09-03T18:00:00+12:00', ends_at: '2026-09-03T21:00:00+12:00', repeat: 'weekly', capacity: '20', entry_fee: '5.0',
    payment: 'Online or in store', description: 'Bring your brain.', image: 'gid://shopify/MediaImage/9001', product: 'gid://shopify/Product/8001', link: 'https://example.com/quiz', game: '',
  },
};
const LAUNCH = { handle: 'one-off-launch', fields: { title: 'Riftbound launch', event_type: 'launch', starts_at: '2026-10-10T11:00:00+13:00', game: 'Riftbound', tables: 'T4-T6' } };
const OLD = { handle: 'old-market', fields: { title: 'Oddity Alley (September)', event_type: 'market', starts_at: '2026-09-19T11:00:00+12:00', ends_at: '2026-09-19T15:00:00+12:00' } };
const editor = (extra = {}) => {
  const admin = fakeAdmin({ events: [QUIZ, LAUNCH, OLD], ...extra });
  admin.files.set('gid://shopify/MediaImage/9001', { url: 'https://cdn.shopify.com/s/files/1/0001/files/quiz.png?v=1', alt: 'Quiz cards' });
  lair.rulesLoadedAt = 0;
  return admin;
};
const newEvent = (over = {}) => ({ title: 'Trivia night', type: 'social', start: at('2026-10-15', 18), end: at('2026-10-15', 21), capacity: 10, payment: 'store', ...over });

test('GET /events (round 7): every entry with its fields, dates, repeat tag, sign-ups and config; dates to come first; pictures and products by id when Shopify won\'t say more', async () => {
  editor();
  assert.equal((await call('GET', 'events', null, '1001')).status, 403);
  // A sign-up and a game spot on the quiz's 8 October
  const joined = await call('POST', 'events/weekly-quiz@2026-10-08/join', { name: 'Sam', email: 'sam@example.com', people: 3 }, '1001');
  assert.equal(joined.status, 200, joined.data.error);
  await call('POST', 'events/weekly-quiz@2026-10-15/join', { name: 'Gone', email: 'gone@example.com', people: 2 });
  await call('POST', `events/joins/${(await call('POST', 'events/weekly-quiz@2026-10-22/join', { name: 'Kiri', email: 'kiri@example.com', people: 1 })).data.join.id}/cancel`, {}, 'staff');
  const list = await call('GET', 'events', null, 'staff');
  assert.equal(list.status, 200, list.data.error);
  assert.deepEqual(list.data.events.map((e) => e.handle), ['weekly-quiz', 'one-off-launch', 'old-market'], 'soonest next first, then the ones done');
  const [quiz, launch, old] = list.data.events;
  assert.deepEqual(
    { ...quiz, config: undefined, booked: undefined, updatedAt: undefined },
    {
      id: quiz.id, handle: 'weekly-quiz', title: 'Quiz night', type: 'social', game: '', start: Date.parse('2026-09-03T18:00:00+12:00'), end: Date.parse('2026-09-03T21:00:00+12:00'),
      repeat: 'weekly', repeatUntil: null, skipDates: [], description: 'Bring your brain.',
      image: { id: 'gid://shopify/MediaImage/9001', url: 'https://cdn.shopify.com/s/files/1/0001/files/quiz.png?v=1', alt: 'Quiz cards' }, capacity: 20, priceNote: '', entryFee: 500,
      payment: 'either', tables: '', gameTables: '', lockTables: false, link: 'https://example.com/quiz',
      product: { id: 'gid://shopify/Product/8001', handle: 'quiz-ticket', title: 'Quiz night ticket' }, repeatTag: 'Weekly · Thursdays 6pm', next: at('2026-10-01', 18), last: null,
      config: undefined, booked: undefined, updatedAt: undefined,
    },
  );
  assert.deepEqual(quiz.booked, [{ occurrenceId: 'weekly-quiz@2026-10-08', start: at('2026-10-08', 18), people: 3, spots: 0 }, { occurrenceId: 'weekly-quiz@2026-10-15', start: at('2026-10-15', 18), people: 2, spots: 0 }]);
  assert.equal(quiz.updatedAt, NOW - 24 * HOUR);
  // config: the event exactly as lair-config.liquid writes it
  assert.deepEqual(quiz.config, {
    id: 'weekly-quiz', title: 'Quiz night', type: 'social', game: '', start: '2026-09-03T18:00:00+12:00', end: '2026-09-03T21:00:00+12:00', repeat: 'weekly', repeatUntil: null,
    skipDates: [], capacity: 20, tables: null, entryFee: 500, gameTables: null, payment: 'either', lockTables: false, price: null, url: '/products/quiz-ticket',
    link: 'https://example.com/quiz', product: { url: '/products/quiz-ticket', title: 'Quiz night ticket', price: null, available: null, stock: null }, blurb: 'Bring your brain.',
    image: 'https://cdn.shopify.com/s/files/1/0001/files/quiz.png?v=1&width=800', imageAlt: 'Quiz cards',
  });
  assert.deepEqual([launch.repeatTag, launch.next, launch.last, launch.end, launch.config.end, launch.config.type, launch.config.tables, launch.booked], [null, at('2026-10-10', 11), at('2026-10-10', 11), null, null, 'launch', 'T4-T6', []]);
  assert.deepEqual([old.next, old.last], [null, null]);
  // Without read_files or read_products yet: the plain read, ids only
  const admin = editor();
  admin.denyRefs = true;
  lair.eventRefs = null;
  const plain = (await call('GET', 'events', null, 'staff')).data.events.find((e) => e.handle === 'weekly-quiz');
  assert.deepEqual([plain.image, plain.product, plain.config.product, plain.config.url, plain.config.image], [
    { id: 'gid://shopify/MediaImage/9001', url: null, alt: null }, { id: 'gid://shopify/Product/8001', handle: null, title: null }, null, 'https://example.com/quiz', null,
  ]);
  assert.deepEqual(admin.calls.slice(-2).map((c) => c.op), ['LairEventsAdmin', 'LairEventsAdminPlain']);
});

test('repeat tags (round 7): weekly, fortnightly and monthly, with times as Mo says them', async () => {
  const rules = lair.rulesCache;
  const tag = (repeat, starts) => lair.repeatTag(lair.eventRule('x', { starts_at: starts, repeat }), rules);
  assert.equal(tag('weekly', '2026-10-08T18:00:00+13:00'), 'Weekly · Thursdays 6pm');
  assert.equal(tag('fortnightly', '2026-10-08T18:30:00+13:00'), 'Fortnightly · Thursdays 6:30pm');
  assert.equal(tag('monthly', '2026-10-17T11:00:00+13:00'), 'Monthly · Third Saturday 11am');
  assert.equal(tag('monthly', '2026-10-29T12:00:00+13:00'), 'Monthly · Fifth Thursday 12pm');
  assert.equal(tag('', '2026-10-08T18:00:00+13:00'), null);
});

test('POST /events (round 7): every field checked with its own message, then written the way Shopify keeps it; the handle comes from the title', async () => {
  const admin = editor();
  const refused = async (over, error) => {
    const res = await call('POST', 'events', newEvent(over), 'staff');
    assert.deepEqual([res.status, res.data.error], [422, error], JSON.stringify(over));
  };
  assert.equal((await call('POST', 'events', newEvent(), '1001')).status, 403);
  await refused({ title: ' ' }, 'Give the event a title.');
  await refused({ type: 'party' }, 'Pick what kind of event it is.');
  await refused({ type: undefined }, 'Pick what kind of event it is.');
  await refused({ start: '' }, 'Pick when it starts.');
  await refused({ start: 'soon' }, 'Pick when it starts.');
  await refused({ end: at('2026-10-15', 18) }, 'It has to finish after it starts.');
  await refused({ end: at('2026-10-16', 19) }, 'Keep an event to 24 hours or less. Use Repeats for more dates.');
  await refused({ repeat: 'daily' }, 'Pick how often it repeats: weekly, fortnightly or monthly. Or leave it as a one-off.');
  await refused({ repeat: 'weekly', repeatUntil: '2026-10-14' }, "'Repeat until' has to be on or after the first date.");
  await refused({ repeat: 'weekly', repeatUntil: 'next year' }, "'Repeat until' has to be on or after the first date.");
  await refused({ repeat: 'weekly', skipDates: ['2026-02-30'] }, 'Skip dates have to be real dates, on or after the first date.');
  await refused({ repeat: 'weekly', skipDates: ['2026-10-08'] }, 'Skip dates have to be real dates, on or after the first date.');
  await refused({ repeat: 'weekly', skipDates: Array.from({ length: 53 }, (_, i) => time.key(at('2026-10-15', 18) + i * 7 * 24 * HOUR)) }, 'Skip dates have to be real dates, on or after the first date.');
  for (const capacity of [0, 501, 2.5, 'lots']) await refused({ capacity }, 'Capacity is a number of people, from 1 to 500.');
  await refused({ priceNote: 'x'.repeat(61) }, 'Keep the price note short: 60 characters at most.');
  for (const entryFee of [-1, 1001, 'free']) await refused({ entryFee }, 'The entry fee is in dollars, from $0 to $1000.');
  await refused({ payment: 'card' }, 'Pick how people pay: in store, online, or either.');
  for (const tables of ['T99', 'T14 - T21', 'T21-T14', 'Nowhere room', 'T1-A2']) await refused({ tables }, "Some of those tables don't exist. Use table codes like T20-T21, a room's name, or all.");
  for (const gameTables of ['T14+X1', 'T1+A1', 'T14+T15, nope']) await refused({ gameTables }, 'Game tables are pairs like T14+T15, T16+T17, with tables that exist.');
  for (const link of ['ftp://example.com', 'www.example.com', `https://example.com/${'x'.repeat(300)}`]) await refused({ link }, 'Links start with https://.');
  await refused({ game: 'g'.repeat(41) }, "The game's name is 40 characters at most.");
  await refused({ productId: 'gid://shopify/Collection/1' }, "That ticket product doesn't look right. Pick it again.");
  await refused({ imageId: 'cat.png' }, 'Pick a JPEG, PNG or WebP picture.');
  assert.equal(admin.calls.filter((c) => c.op === 'LairEventCreate').length, 0, 'nothing reached Shopify');
  await call('GET', 'events', null, 'staff'); // the staff page lists the events first, so the Lair knows their pictures

  const made = await call('POST', 'events', newEvent({
    title: 'Pokémon Pre-release!', type: 'tcg', game: 'Pokémon', start: at('2026-10-24', 11), end: at('2026-10-24', 16), description: 'Line one\r\nLine two  ', capacity: 24,
    priceNote: '$40 entry', entryFee: 40, payment: 'online', tables: 'T4-T13, Side room 2', gameTables: '', lockTables: true, link: 'https://www.dicegoblin.nz/pokemon',
    productId: '8001', imageId: '9001', repeat: '', repeatUntil: '2026-12-01', skipDates: [],
  }), 'staff');
  assert.equal(made.status, 200, made.data.error);
  const create = admin.calls.filter((c) => c.op === 'LairEventCreate').at(-1).variables.metaobject;
  assert.equal(create.handle, 'pokemon-pre-release');
  assert.deepEqual(Object.fromEntries(create.fields.map((f) => [f.key, f.value])), {
    title: 'Pokémon Pre-release!', event_type: 'tcg', game: 'Pokémon', starts_at: '2026-10-24T11:00:00+13:00', ends_at: '2026-10-24T16:00:00+13:00', description: 'Line one\nLine two',
    image: 'gid://shopify/MediaImage/9001', capacity: '24', price_note: '$40 entry', entry_fee: '40.00', payment: 'Online', tables: 'T4-T13, Side room 2', lock_tables: 'true',
    link: 'https://www.dicegoblin.nz/pokemon', product: 'gid://shopify/Product/8001',
  }, 'empty fields are left out of a new entry, and a one-off keeps no Repeat until');
  const e = made.data.event;
  assert.deepEqual([e.handle, e.title, e.type, e.start, e.end, e.entryFee, e.payment, e.lockTables, e.repeatTag, e.next, e.booked, made.data.notice], ['pokemon-pre-release', 'Pokémon Pre-release!', 'tcg', at('2026-10-24', 11), at('2026-10-24', 16), 4000, 'online', true, null, at('2026-10-24', 11), [], null]);
  assert.deepEqual([e.image, e.config.image, e.config.start, e.config.payment, e.config.entryFee], [{ id: 'gid://shopify/MediaImage/9001', url: 'https://cdn.shopify.com/s/files/1/0001/files/quiz.png?v=1', alt: 'Quiz cards' }, 'https://cdn.shopify.com/s/files/1/0001/files/quiz.png?v=1&width=800', '2026-10-24T11:00:00+13:00', 'online', 4000]);
  // Handles: -2 when taken, never a route's name, at most 50 characters
  assert.equal((await call('POST', 'events', newEvent({ title: 'Pokémon pre-release' }), 'staff')).data.event.handle, 'pokemon-pre-release-2');
  assert.equal((await call('POST', 'events', newEvent({ title: 'Joins' }), 'staff')).data.event.handle, 'joins-2');
  assert.equal((await call('POST', 'events', newEvent({ title: 'Pictures' }), 'staff')).data.event.handle, 'pictures-2');
  const long = (await call('POST', 'events', newEvent({ title: 'A very long name for an event that goes on and on and on forever' }), 'staff')).data.event.handle;
  assert.deepEqual([long, long.length <= 50], ['a-very-long-name-for-an-event-that-goes-on-and-on', true]);
  // Winter time: the offset of that date (+12:00)
  await call('POST', 'events', newEvent({ title: 'Matariki games', start: at('2027-07-09', 18), end: at('2027-07-09', 21) }), 'staff');
  assert.equal(admin.events.get('matariki-games').fields.starts_at, '2027-07-09T18:00:00+12:00');
  // A weekly event with skip dates: kept sorted, without repeats
  await call('POST', 'events', newEvent({ title: 'Paint night', repeat: 'weekly', repeatUntil: '2026-12-31', skipDates: ['2026-10-29', '2026-10-22', '2026-10-29'] }), 'staff');
  assert.deepEqual([admin.events.get('paint-night').fields.skip_dates, admin.events.get('paint-night').fields.repeat_until], ['["2026-10-22","2026-10-29"]', '2026-12-31']);
});

test('events editor (round 7): writes drop the cached events, so sign-ups follow at once; Shopify\'s refusals and a missing permission answer plainly', async () => {
  const admin = editor();
  assert.equal((await call('POST', 'events/trivia-night@2026-10-15/join', { name: 'Sam', email: 'sam@example.com', people: 1 })).status, 404, 'no such event yet');
  const made = await call('POST', 'events', newEvent(), 'staff');
  assert.equal(made.status, 200, made.data.error);
  assert.equal(lair.rulesLoadedAt, 0, 'the cached events are dropped');
  const joined = await call('POST', 'events/trivia-night@2026-10-15/join', { name: 'Sam', email: 'sam@example.com', people: 2 });
  assert.equal(joined.status, 200, 'the new event takes sign-ups at once');
  await call('POST', 'events/trivia-night/update', { capacity: 2 }, 'staff');
  assert.deepEqual(await call('POST', 'events/trivia-night@2026-10-15/join', { name: 'Kiri', email: 'kiri@example.com', people: 1 }).then((r) => [r.status, r.data.error]), [409, 'This one is full.'], 'and the new capacity counts at once');
  // Shopify's userErrors
  admin.rejectNext = 'Value is invalid for the field';
  assert.deepEqual(await call('POST', 'events', newEvent({ title: 'Rejected' }), 'staff').then((r) => [r.status, r.data.error]), [422, 'Shopify said no: Value is invalid for the field']);
  // write_metaobjects not approved yet
  admin.denyWrites = true;
  const denied = "Shopify hasn't let the Lair change events yet. Approve the app's new permissions in Shopify admin (Apps › Dice Goblin Lair), then try again.";
  assert.deepEqual(await call('POST', 'events', newEvent({ title: 'Denied' }), 'staff').then((r) => [r.status, r.data.error]), [503, denied]);
  assert.deepEqual(await call('POST', 'events/trivia-night/update', { title: 'x' }, 'staff').then((r) => [r.status, r.data.error]), [503, denied]);
  assert.deepEqual(await call('POST', 'events/old-market/delete', {}, 'staff').then((r) => [r.status, r.data.error]), [503, denied]);
  admin.denyWrites = false;
  // Shopify down
  admin.down = true;
  assert.deepEqual(await call('GET', 'events', null, 'staff').then((r) => [r.status, r.data.error]), [502, "Shopify didn't answer just now. Try again in a minute."]);
  admin.down = false;
  // A picture still being processed: Shopify says so, and the Lair tries once more a second later
  admin.notReady = 1;
  const tries = admin.calls.filter((c) => c.op === 'LairEventUpdate').length;
  const pictured = await call('POST', 'events/trivia-night/update', { imageId: 'gid://shopify/MediaImage/9001' }, 'staff');
  assert.equal(pictured.status, 200, pictured.data.error);
  assert.equal(admin.calls.filter((c) => c.op === 'LairEventUpdate').length, tries + 2, 'refused once (not ready), then saved a second later');
});

test('POST /events/:handle/update (round 7): only what changes goes to Shopify; a date people signed up for can\'t move or go; a lower capacity only says so', async () => {
  const admin = editor();
  assert.deepEqual(await call('POST', 'events/no-such-event/update', { title: 'x' }, 'staff').then((r) => [r.status, r.data.error]), [404, 'That event could not be found.']);
  await call('POST', 'events/weekly-quiz@2026-10-08/join', { name: 'Sam', email: 'sam@example.com', people: 3 });
  await call('POST', 'events/weekly-quiz@2026-10-08/join', { name: 'Leo', email: 'leo@example.com', people: 2 });
  const update = (body) => call('POST', 'events/weekly-quiz/update', body, 'staff');
  const writes = () => admin.calls.filter((c) => c.op === 'LairEventUpdate');
  // The same start, and a title: only the title is written
  const renamed = await update({ title: 'Quiz night!', start: Date.parse('2026-09-03T18:00:00+12:00'), entryFee: 5, payment: 'either' });
  assert.equal(renamed.status, 200, renamed.data.error);
  assert.deepEqual(writes().at(-1).variables, { id: renamed.data.event.id, metaobject: { fields: [{ key: 'title', value: 'Quiz night!' }] } });
  assert.equal((await update({ title: 'Quiz night!' })).status, 200);
  assert.equal(writes().length, 1, 'nothing changed, nothing written');
  // Clearing a field sends ""
  await update({ link: '', game: '' });
  assert.deepEqual(writes().at(-1).variables.metaobject.fields, [{ key: 'link', value: '' }]);
  assert.equal(admin.events.get('weekly-quiz').fields.link, null);
  // 8 October has sign-ups: it can't move (a new time, a new end), be skipped, or be cut off by Repeat until
  const blocked = "People have signed up for Thu 8 Oct, so that date can't move or go. Cancel their sign-ups on the staff page first, or make the change from a date nobody's signed up for.";
  for (const body of [
    { start: Date.parse('2026-09-03T19:00:00+12:00'), end: Date.parse('2026-09-03T22:00:00+12:00') }, { end: Date.parse('2026-09-03T22:00:00+12:00') },
    { skipDates: ['2026-10-08'] }, { repeatUntil: '2026-10-07' }, { repeat: 'fortnightly' }, { repeat: '' },
  ]) {
    assert.deepEqual(await update(body).then((r) => [r.status, r.data.error]), [409, blocked], JSON.stringify(body));
  }
  const before = writes().length;
  // Dates nobody signed up for can change
  assert.equal((await update({ skipDates: ['2026-10-15'], repeatUntil: '2026-12-31', description: 'New words' })).status, 200);
  assert.deepEqual(writes().at(-1).variables.metaobject.fields.map((f) => f.key), ['repeat_until', 'skip_dates', 'description']);
  assert.equal(writes().length, before + 1);
  // A cancelled sign-up doesn't hold a date
  const kiri = (await call('POST', 'events/weekly-quiz@2026-10-22/join', { name: 'Kiri', email: 'kiri@example.com', people: 1 })).data.join;
  await call('POST', `events/joins/${kiri.id}/cancel`, {}, 'staff');
  assert.equal((await update({ skipDates: ['2026-10-15', '2026-10-22'] })).status, 200);
  // A lower capacity is fine: nobody is cancelled, and the notice says so
  const lower = await update({ capacity: 4 });
  assert.deepEqual([lower.status, lower.data.notice], [200, "Thu 8 Oct already has 5 people, more than the new capacity. Nobody's been cancelled."]);
  assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM event_joins WHERE occurrence_id = 'weekly-quiz@2026-10-08' AND status != 'cancelled'").one().n, 2);
  // Game spots hold a date too
  await call('POST', 'events', { title: 'Warhammer night', type: 'wargame', start: at('2026-10-03', 18), end: at('2026-10-03', 22), repeat: 'weekly', gameTables: 'T14+T15, T16+T17' }, 'staff');
  const spot = await call('POST', 'events/warhammer-night@2026-10-10/reserve', { name: 'Leo', email: 'leo@example.com', people: 1 });
  assert.equal(spot.status, 200, spot.data.error);
  assert.deepEqual(await call('POST', 'events/warhammer-night/update', { start: at('2026-10-03', 17), end: at('2026-10-03', 22) }, 'staff').then((r) => [r.status, r.data.error]), [409, blocked.replace('Thu 8 Oct', 'Sat 10 Oct')]);
  const events = (await call('GET', 'events', null, 'staff')).data.events;
  assert.deepEqual(events.find((x) => x.handle === 'warhammer-night').booked, [{ occurrenceId: 'warhammer-night@2026-10-10', start: at('2026-10-10', 18), people: 0, spots: 1 }]);
  // A one-off keeps no repeat leftovers: making the quiz a one-off would lose its signed-up dates, but a new event can
  await call('POST', 'events', newEvent({ title: 'Book club', repeat: 'monthly', repeatUntil: '2027-06-30', skipDates: ['2026-11-19'] }), 'staff');
  assert.equal((await call('POST', 'events/book-club/update', { repeat: '' }, 'staff')).status, 200);
  assert.deepEqual(writes().at(-1).variables.metaobject.fields, [{ key: 'repeat', value: '' }, { key: 'repeat_until', value: '' }, { key: 'skip_dates', value: '' }]);
});

test('POST /events/:handle/delete (round 7): not while a date to come has people on it; then it\'s gone from Shopify and the Lair\'s events', async () => {
  const admin = editor();
  assert.deepEqual(await call('POST', 'events/no-such-event/delete', {}, 'staff').then((r) => [r.status, r.data.error]), [404, 'That event could not be found.']);
  assert.equal((await call('POST', 'events/old-market/delete', {}, '1001')).status, 403);
  await call('POST', 'events/weekly-quiz@2026-10-15/join', { name: 'Sam', email: 'sam@example.com', people: 1 });
  assert.deepEqual(await call('POST', 'events/weekly-quiz/delete', {}, 'staff').then((r) => [r.status, r.data.error]), [409, 'People have signed up for Thu 15 Oct. Cancel their sign-ups first, or end the event after that date with Repeat until.']);
  assert.ok(admin.events.has('weekly-quiz'));
  const gone = await call('POST', 'events/one-off-launch/delete', {}, 'staff');
  assert.deepEqual(gone.data, { ok: true, handle: 'one-off-launch' });
  assert.deepEqual([admin.events.has('one-off-launch'), lair.rulesLoadedAt], [false, 0]);
  assert.ok(!(await call('GET', 'events', null, 'staff')).data.events.some((e) => e.handle === 'one-off-launch'));
  assert.equal((await call('POST', 'events/one-off-launch@2026-10-10/join', { name: 'Late', email: 'late@example.com', people: 1 })).status, 404, 'the Lair\'s rules follow');
});

test('POST /events/pictures (round 7): the Worker posts the picture to Shopify\'s upload target itself, then makes the file; its id is the event\'s imageId', async () => {
  const admin = editor();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', 'events/pictures', { dataUrl: png }, '1001')).status, 403);
  assert.deepEqual(await call('POST', 'events/pictures', { dataUrl: 'data:text/html;base64,PGI+' }, 'staff').then((r) => [r.status, r.data.error]), [422, 'Pick a JPEG, PNG or WebP picture.']);
  const big = `data:image/jpeg;base64,${Buffer.alloc(700 * 1024 + 1).toString('base64')}`;
  assert.deepEqual(await call('POST', 'events/pictures', { dataUrl: big }, 'staff').then((r) => [r.status, r.data.error]), [413, 'That picture is too big. Try a smaller one.']);
  const realFetch = globalThis.fetch;
  const posted = [];
  let answer = 201;
  globalThis.fetch = async (url, init) => {
    const form = init.body;
    posted.push({ url: String(url), method: init.method, names: [...form.keys()], file: form.get('file') });
    return new Response('<PostResponse/>', { status: answer });
  };
  try {
    const up = await call('POST', 'events/pictures', { dataUrl: png, alt: 'Quiz night in the Lair' }, 'staff');
    assert.equal(up.status, 200, up.data.error);
    assert.match(up.data.image.id, /^gid:\/\/shopify\/MediaImage\/\d+$/);
    assert.deepEqual([up.data.image.url, up.data.image.alt, up.data.image.status], [null, 'Quiz night in the Lair', 'UPLOADED']);
    assert.deepEqual([admin.staged.resource, admin.staged.mimeType, admin.staged.httpMethod, admin.staged.fileSize], ['IMAGE', 'image/png', 'POST', '70']);
    assert.match(admin.staged.filename, /^lair-event-[a-z0-9]{12}\.png$/);
    assert.deepEqual([posted[0].url, posted[0].method, posted[0].names], ['https://shopify-staged-uploads.storage.googleapis.com/', 'POST', ['Content-Type', 'success_action_status', 'key', 'policy', 'file']], 'every parameter in order, then the file');
    assert.equal(posted[0].file.size, 70);
    assert.equal(admin.files.get(up.data.image.id).source, `https://shopify-staged-uploads.storage.googleapis.com/tmp/1/products/${admin.staged.filename}`);
    // Saved on an event; the editor shows the picture once Shopify has it
    await call('POST', 'events/old-market/update', { imageId: up.data.image.id }, 'staff');
    admin.files.get(up.data.image.id).url = 'https://cdn.shopify.com/s/files/1/0001/files/market.png?v=2';
    const shown = (await call('GET', 'events', null, 'staff')).data.events.find((e) => e.handle === 'old-market');
    assert.deepEqual(shown.image, { id: up.data.image.id, url: 'https://cdn.shopify.com/s/files/1/0001/files/market.png?v=2', alt: 'Quiz night in the Lair' });
    // The upload refused, or write_files not approved yet
    answer = 403;
    assert.deepEqual(await call('POST', 'events/pictures', { dataUrl: png }, 'staff').then((r) => [r.status, r.data.error]), [502, "Shopify didn't take the picture (the upload answered 403). Try again."]);
    admin.denyFiles = true;
    assert.deepEqual(await call('POST', 'events/pictures', { dataUrl: png }, 'staff').then((r) => r.status), 503);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------------- section 11: staff TTRPG sessions ---------------- */
test('staff-made sessions follow the GM rules (round 7): hours, whole hours, lead time, horizon, locked event tables, rooms not bookable online; shop tables are open to staff', async () => {
  useRules({ lair_shop_tables: 'T1-T3' }, [{ id: 'paint', title: 'Painting tables', start: at('2026-10-01', 17), end: at('2026-10-01', 22), tables: 'A1-A2', lockTables: true }],
    [...FALLBACK, { id: 'office', name: 'Office', code: 'O', tables: 1, seats: 4, order: 5, bookable: false }]);
  const refused = async (over, status, error) => {
    const res = await game({ tables: ['T5'], ...over }, 'staff');
    assert.deepEqual([res.status, res.data.error], [status, error], JSON.stringify(over));
  };
  await refused({ start: at('2026-10-01', 20), end: at('2026-10-01', 23) }, 422, 'That time is outside opening hours.');
  await refused({ start: at('2026-10-05', 18), end: at('2026-10-05', 21) }, 422, "We're closed at that time.");
  await refused({ start: at('2026-10-01', 18, 30), end: at('2026-10-01', 21, 30) }, 422, 'Bookings start on the hour.');
  await refused({ start: at('2026-10-01', 18), end: at('2026-10-01', 20, 30) }, 422, 'Bookings are in one-hour blocks.');
  await refused({ start: at('2026-10-01', 13), end: at('2026-10-01', 16) }, 422, 'That time is too soon to book online. Walk in instead.');
  await refused({ start: at('2026-12-03', 18), end: at('2026-12-03', 21) }, 422, 'That date is too far ahead to book yet.');
  await refused({ tables: ['A1'] }, 409, 'Table A1 is already taken at that time. Pick another.');
  await refused({ tables: ['O1'] }, 422, "Office can't be booked online.");
  await refused({ seats: 6 }, 422, '6 people need more tables (these seat 4).');
  // The shop tables: staff yes, GMs no
  const gmShop = await game({ tables: ['T1'] }, 'gm');
  assert.deepEqual([gmShop.status, gmShop.data.error], [422, "T1 is a shop table, kept for the team's own games. Pick another table."]);
  const staffShop = await game({ tables: ['T1'], schedule: 'weekly' }, 'staff');
  assert.equal(staffShop.status, 200, staffShop.data.error);
  assert.deepEqual([staffShop.data.game.status, staffShop.data.skipped], ['open', []], 'open at once, and a staff series takes the shop tables every week too');
  assert.ok(staffShop.data.sessions.length >= 8);
  // A staff series tops itself up the same way
  Date.now = () => NOW + 7 * 24 * HOUR;
  lair.seriesDay = null;
  lair.extendSeries(lair.rulesCache, Date.now());
  assert.equal(lair.sql.exec('SELECT COUNT(*) AS n FROM games WHERE series_id = ?', staffShop.data.game.seriesId).one().n, staffShop.data.sessions.length + 1);
  // Staff adding a date: the GM rules and the shop tables
  Date.now = () => NOW;
  const added = await call('POST', `games/${staffShop.data.game.id}/sessions`, { start: at('2026-10-02', 18), end: at('2026-10-02', 21) }, 'staff');
  assert.equal(added.status, 200, added.data.error);
  assert.equal((await call('POST', `games/${staffShop.data.game.id}/sessions`, { start: at('2026-10-02', 18, 30), end: at('2026-10-02', 21, 30) }, 'staff')).status, 422);
});

test('staff edits (round 7): a move skips only the lead time and the horizon; hours, whole hours, locked event tables and bookings still apply', async () => {
  useRules({}, [{ id: 'paint', title: 'Painting tables', start: at('2026-10-01', 12), end: at('2026-10-01', 22), tables: 'A3', lockTables: true }]);
  const listed = await game({ tables: ['B2'], start: at('2026-10-01', 14), end: at('2026-10-01', 17) });
  assert.equal(listed.status, 200, listed.data.error);
  const id = listed.data.game.id;
  Date.now = () => at('2026-10-01', 13, 45);
  const edit = (body) => call('POST', `games/${id}/edit`, body, 'staff');
  const moved = await edit({ tables: ['B3'] });
  assert.equal(moved.status, 200, `tonight's session can still move: ${moved.data.error}`);
  assert.deepEqual(await edit({ tables: ['A3'] }).then((r) => [r.status, r.data.error]), [409, 'Table A3 is already taken at that time. Pick another.'], 'a locked event table blocks staff too');
  await call('POST', 'bookings', { kind: 'table', tables: ['B4'], start: at('2026-10-01', 16), end: at('2026-10-01', 17), people: 2, name: 'Mia', email: 'mia@example.com', staffOverride: true }, 'staff');
  assert.equal((await edit({ tables: ['B4'] })).status, 409, 'and so does a booking');
  assert.deepEqual(await edit({ start: at('2026-10-01', 14, 30), end: at('2026-10-01', 17, 30) }).then((r) => [r.status, r.data.error]), [422, 'Bookings start on the hour.']);
  assert.deepEqual(await edit({ start: at('2026-10-01', 20), end: at('2026-10-01', 23) }).then((r) => [r.status, r.data.error]), [422, 'That time is outside opening hours.']);
  assert.equal((await edit({ start: at('2027-01-07', 14), end: at('2027-01-07', 17) })).status, 200, 'beyond the booking horizon is fine for an edit');
});

test('a GM who isn\'t a customer (round 7): invited by email; the game waits on that email and joins their account when they log in with it', async () => {
  const mail = captureEmails();
  try {
    const listed = await game({ title: 'Mothership', gm: 'Rua', gmEmail: 'Rua.T@example.com', schedule: 'weekly', tables: ['B3'] }, 'staff');
    assert.equal(listed.status, 200, listed.data.error);
    assert.deepEqual([listed.data.invited, listed.data.notice, listed.data.emailed], [true, 'Gobgob emailed Rua.T@example.com to make an account. The game joins their account when they log in with that email.', true]);
    const seriesId = listed.data.game.seriesId;
    assert.deepEqual([lair.game(listed.data.game.id).gmCustomerId, lair.sql.exec('SELECT gm_customer_id FROM series WHERE id = ?', seriesId).one().gm_customer_id], [null, null]);
    await settle();
    const invite = mail.sent.filter((m) => m.to === 'Rua.T@example.com');
    assert.deepEqual(invite.map((m) => m.subject), ["You're running Mothership at the Dice Goblin Lair"], 'only the invite, not "Your game is live"');
    const text = invite[0].text;
    for (const words of [
      'YOUR GAME IS ON THE BOARD!', 'Kia ora Rua, the Dice Goblin team has put Mothership on the games board for you.', 'First session:', 'Tables:', 'B3', 'Player seats:', '4',
      'Your credit:', '$5.00 store credit for each paying player, after the session',
      "Make your Dice Goblin account with this email (Rua.T@example.com), or log in at dicegoblin.nz with it, and the game joins your account. From My Lair you can see who's coming, message your players and add dates. Your store credit goes onto your account after each session.",
      'Players can book already. Gobgob will email you each time someone joins.', 'Open My Lair: https://www.dicegoblin.nz/pages/my-lair', 'Happy GMing!\nGobgob',
    ]) assert.ok(text.includes(words), words);
    // Staff see who it's waiting for
    const staffGames = (await call('GET', 'floor', null, 'staff')).data.games.filter((g) => g.seriesId === seriesId);
    assert.ok(staffGames.length > 1 && staffGames.every((g) => g.gmAccount === 'invited' && g.gmEmail === 'Rua.T@example.com'));
    assert.equal((await call('GET', 'floor')).data.games.find((g) => g.seriesId === seriesId).gmAccount, undefined, 'the public never sees it');
    // A player joins: the GM hears at that address
    mail.sent.length = 0;
    await call('POST', 'bookings', { kind: 'gm-seat', gameId: listed.data.game.id, people: 1, name: 'Mia', email: 'mia@example.com' });
    await settle();
    assert.ok(mail.sent.some((m) => m.to === 'Rua.T@example.com' && /^New player for Mothership/.test(m.subject)));
    // Someone with another email gets nothing; Rua logging in with that email (any case) gets the lot
    lair.accountEmail = async (id) => ({ email: id === '6001' ? 'rua.t@EXAMPLE.com' : 'other@example.com', fetched: false });
    await call('GET', 'me', null, '6002');
    assert.equal(lair.game(listed.data.game.id).gmCustomerId, null);
    const me = (await call('GET', 'me', null, '6001')).data;
    assert.ok(me.games.length > 1 && me.games.every((g) => g.seriesId === seriesId), 'every session is in Games I run');
    assert.equal(lair.sql.exec('SELECT gm_customer_id FROM series WHERE id = ?', seriesId).one().gm_customer_id, '6001');
    assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM bookings b JOIN games g ON g.id = b.game_id WHERE g.series_id = ? AND b.kind = 'gm' AND (b.customer_id IS NULL OR b.customer_id != '6001')", seriesId).one().n, 0, "the GM's own table holds are theirs");
    assert.ok((await call('GET', 'floor', null, 'staff')).data.games.filter((g) => g.seriesId === seriesId).every((g) => g.gmAccount === 'linked'));
    // Later dates of the series are theirs too
    Date.now = () => NOW + 14 * 24 * HOUR;
    lair.seriesDay = null;
    lair.extendSeries(lair.rulesCache, Date.now());
    assert.equal(lair.sql.exec('SELECT gm_customer_id FROM games WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1', seriesId).one().gm_customer_id, '6001');
  } finally {
    mail.restore();
  }
});

test('a GM picked from the customers (round 7): linked at once, with their member record made when the Lair hadn\'t met them, and "Your game is live"', async () => {
  const mail = captureEmails();
  try {
    const listed = await game({ title: 'Blades', gm: 'Sammy', gmCustomerId: '5005', gmCustomerName: 'Sammy Lee', gmEmail: 'sammy@example.com', tables: ['B4'] }, 'staff');
    assert.equal(listed.status, 200, listed.data.error);
    assert.deepEqual([lair.game(listed.data.game.id).gmCustomerId, lair.game(listed.data.game.id).gmEmail, listed.data.invited, listed.data.notice], ['5005', 'sammy@example.com', undefined, undefined]);
    assert.equal(lair.memberRow('5005').name, 'Sammy Lee');
    await settle();
    assert.deepEqual(mail.sent.filter((m) => m.to === 'sammy@example.com').map((m) => m.subject), ['Your game is live: Blades']);
    const staffGame = (await call('GET', 'floor', null, 'staff')).data.games.find((g) => g.id === listed.data.game.id);
    assert.deepEqual([staffGame.gmAccount, staffGame.gmEmail], ['linked', 'sammy@example.com']);
    // A member's email links them, as before (no invite)
    await member('1001', 'Sam Jones', 'sam@example.com');
    const byEmail = await game({ title: 'Masks', gm: 'Sam', gmEmail: 'SAM@example.com', tables: ['B2'] }, 'staff');
    assert.deepEqual([lair.game(byEmail.data.game.id).gmCustomerId, byEmail.data.invited], ['1001', undefined]);
    assert.deepEqual(await game({ title: 'Typo', gm: 'Sam', gmEmail: 'sam at example', tables: ['B1'] }, 'staff').then((r) => [r.status, r.data.error]), [422, "That email address doesn't look right."]);
  } finally {
    mail.restore();
  }
});

/* ---------------- section 12: players staff add ---------------- */
test('staff add a customer every week (round 7): a regular from now on, as "Save my seat every week" makes one, with "You\'re a regular" from the team; staff can stop them', async () => {
  await member('1001', 'Sam Jones', 'sam@example.com');
  const mail = captureEmails();
  try {
    const listed = await game({ schedule: 'weekly' });
    const [first, second] = listed.data.sessions;
    const add = (id, body) => call('POST', `games/${id}/players`, { people: 1, ...body }, 'staff');
    const sam = await add(first.id, { customerId: '1001', name: 'Sam Jones', email: '', weekly: true });
    assert.equal(sam.status, 200, sam.data.error);
    assert.deepEqual([sam.data.regular, sam.data.invite, sam.data.booking.customerId], [{ seriesId: listed.data.game.seriesId, customerId: '1001' }, null, '1001']);
    const seat = lair.booking(sam.data.booking.id);
    assert.deepEqual([seat.seriesId, seat.email, seat.notes], [listed.data.game.seriesId, 'sam@example.com', 'Added by staff'], "a regular's first seat, with the member's email");
    assert.equal(lair.seriesMember(listed.data.game.seriesId, '1001').status, 'active');
    assert.equal((await call('GET', 'floor', null, 'staff')).data.games.find((g) => g.id === second.id).held, 1, 'the next session holds their seat');
    await settle();
    const regular = mail.sent.find((m) => m.subject === "You're a regular: Curse of Strahd");
    assert.ok(regular && regular.to === 'sam@example.com' && regular.text.includes('Kia ora Sam Jones, the Dice Goblin team has saved your seat at Curse of Strahd with GM Ana every week.') && regular.text.includes(lair.memberRow('1001').code), regular?.text);
    assert.ok(mail.sent.some((m) => m.to === 'sam@example.com' && /^Seat saved: Curse of Strahd/.test(m.subject)), 'and the seat confirmation');
    // A one-off can't save a seat every week; a fortnightly game says fortnight
    const oneOff = await game({ title: 'One-shot', tables: ['B2'] });
    assert.deepEqual(await add(oneOff.data.game.id, { customerId: '1001', name: 'Sam Jones', weekly: true }).then((r) => [r.status, r.data.error]), [422, "This game is a one-off, so a seat can't be saved every week."]);
    const fortnightly = await game({ title: 'Fortnightly Blades', tables: ['B3'], schedule: 'fortnightly' });
    mail.sent.length = 0;
    await add(fortnightly.data.game.id, { customerId: '5005', customerName: 'Sammy Lee', name: 'Sammy', email: 'sammy@example.com', weekly: true });
    await settle();
    assert.ok(mail.sent.some((m) => m.subject === "You're a regular: Fortnightly Blades" && m.text.includes('saved your seat at Fortnightly Blades with GM Ana every fortnight.')));
    // Staff stop a regular: their upcoming seats are freed and the GM hears, as when they leave
    mail.sent.length = 0;
    const stop = await call('POST', `series/${listed.data.game.seriesId}/leave`, { customerId: '1001' }, 'staff');
    assert.deepEqual([stop.status, stop.data.cancelled], [200, 1]);
    assert.equal(lair.seriesMember(listed.data.game.seriesId, '1001').status, 'left');
    assert.deepEqual(await call('POST', `series/${listed.data.game.seriesId}/leave`, { customerId: '1001' }, 'staff').then((r) => [r.status, r.data.error]), [404, "They're not a regular at that game."]);
    // Members still leave as before
    await call('POST', `games/${first.id}/join-series`, { people: 1, name: 'Sam Jones', email: 'sam@example.com' }, '1001');
    assert.equal((await call('POST', `series/${listed.data.game.seriesId}/leave`, {}, '1001')).status, 200);
    assert.equal((await call('POST', `series/${listed.data.game.seriesId}/leave`, { customerId: '5005' }, '1001')).status, 404, 'only staff stop someone else');
  } finally {
    mail.restore();
  }
});

test('staff reserve a weekly seat for someone without an account (round 7): an invite, taken up when they log in with that email, cancelled if the game has ended', async () => {
  const mail = captureEmails();
  try {
    const listed = await game({ schedule: 'weekly' });
    const [first, second] = listed.data.sessions;
    const seriesId = listed.data.game.seriesId;
    const add = (body) => call('POST', `games/${first.id}/players`, { people: 1, ...body }, 'staff');
    assert.deepEqual(await add({ name: 'Mere', weekly: true }).then((r) => [r.status, r.data.error]), [422, 'Add their email, so Gobgob can invite them to keep the seat.']);
    const mere = await add({ name: 'Mere Tawhiri', email: 'Mere@example.com', phone: ' 021  555  0142 ', weekly: true, people: 2, players: [{ name: 'Mere' }, { name: 'Hemi' }] });
    assert.equal(mere.status, 200, mere.data.error);
    assert.deepEqual([mere.data.regular, mere.data.invite?.email, mere.data.booking.customerId], [null, 'Mere@example.com', null]);
    assert.equal(lair.booking(mere.data.booking.id).phone, '021 555 0142');
    await settle();
    const confirmation = mail.sent.find((m) => m.to === 'Mere@example.com');
    assert.ok(confirmation.text.includes("It's a weekly game: make your Dice Goblin account with this email and Gobgob will save your seat every week.") && !confirmation.text.includes('Make an account with this email any time'));
    // Staff and the GM see it waiting (the GM without the email); it holds nothing in later sessions until it's taken up
    const staffView = (await call('GET', 'floor', null, 'staff')).data.games;
    assert.deepEqual(staffView.find((g) => g.id === first.id).invites, [{ id: mere.data.invite.id, name: 'Mere Tawhiri', email: 'Mere@example.com', people: 2 }]);
    assert.equal(staffView.find((g) => g.id === second.id).held, 0);
    assert.deepEqual((await call('GET', 'floor', null, 'gm')).data.games.find((g) => g.id === first.id).invites, [{ id: mere.data.invite.id, name: 'Mere Tawhiri', email: '', people: 2 }]);
    assert.equal((await call('GET', 'floor')).data.games.find((g) => g.id === first.id).invites, undefined);
    // The same email again: the one invite, brought up to date
    const again = await call('POST', `games/${second.id}/players`, { name: 'Mere Tawhiri', email: 'mere@EXAMPLE.com', weekly: true }, 'staff');
    assert.equal(again.data.invite.id, mere.data.invite.id);
    assert.equal(lair.sql.exec("SELECT COUNT(*) AS n FROM series_invites WHERE status = 'waiting'").one().n, 1);
    // Staff cancel an invite: the reserved seat stays
    const cancelled = await call('POST', `series/${seriesId}/leave`, { inviteId: mere.data.invite.id }, 'staff');
    assert.deepEqual([cancelled.status, cancelled.data.invite.status], [200, 'cancelled']);
    assert.equal(lair.booking(mere.data.booking.id).status, 'confirmed');
    assert.deepEqual(await call('POST', `series/${seriesId}/leave`, { inviteId: mere.data.invite.id }, 'staff').then((r) => [r.status, r.data.error]), [404, 'That invite could not be found.']);
    // Invited again; Mere makes her account with that email and opens My Lair: she's a regular, queued from when she was invited
    Date.now = () => NOW + HOUR;
    const invite = (await add({ name: 'Mere Tawhiri', email: 'mere@example.com', weekly: true })).data.invite;
    Date.now = () => NOW + 2 * HOUR;
    lair.accountEmail = async () => ({ email: 'MERE@example.com', fetched: false });
    const me = (await call('GET', 'me', null, '8001')).data;
    assert.deepEqual(me.series.map((s) => s.seriesId), [seriesId]);
    const regular = lair.seriesMember(seriesId, '8001');
    assert.deepEqual([regular.status, regular.created_at, regular.people], ['active', NOW + HOUR, 1]);
    assert.deepEqual({ ...lair.sql.exec('SELECT status, customer_id FROM series_invites WHERE id = ?', invite.id).one() }, { status: 'joined', customer_id: '8001' });
    assert.equal(lair.booking(mere.data.booking.id).customerId, '8001', 'her reserved seats are hers too');
    assert.equal((await call('GET', 'floor', null, 'staff')).data.games.find((g) => g.id === first.id).invites.length, 0);
    // An invite to a game that has ended is cancelled when they log in
    const other = await game({ title: 'Ended game', tables: ['B2'], schedule: 'weekly' });
    const late = (await call('POST', `games/${other.data.game.id}/players`, { name: 'Hemi', email: 'hemi@example.com', weekly: true }, 'staff')).data.invite;
    await call('POST', `games/${other.data.game.id}/update`, { status: 'cancelled', scope: 'series' }, 'staff');
    lair.accountEmail = async () => ({ email: 'hemi@example.com', fetched: false });
    await call('GET', 'me', null, '8002');
    assert.deepEqual([lair.sql.exec('SELECT status FROM series_invites WHERE id = ?', late.id).one().status, lair.seriesMember(other.data.game.seriesId, '8002')], ['cancelled', null]);
  } finally {
    mail.restore();
  }
});

/* ---------------- section 14: the migration ---------------- */
test('round 7 (backend-b) migration: only new tables, columns and indexes; a round 6 database moves across with every row kept', async () => {
  const mine = MIGRATIONS.find((m) => m.some((s) => s.includes('lair_groups')));
  assert.ok(mine, 'the groups migration is in the list');
  assert.ok(mine.every((s) => /^\s*(ALTER TABLE \w+ ADD COLUMN|CREATE (UNIQUE )?INDEX IF NOT EXISTS|CREATE TABLE IF NOT EXISTS)/.test(s)), 'only new columns, tables and indexes');
  // A database as round 6 left it (every migration up to round 6's), with a pass and a game in it
  const r6 = MIGRATIONS.findIndex((m) => m.some((s) => s.includes('loyalty_grants')));
  const ctx = fakeCtx();
  const { sql } = ctx.storage;
  sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const statement of MIGRATIONS.slice(0, r6 + 1).flat()) sql.exec(statement);
  sql.exec("INSERT INTO meta (key, value) VALUES ('schema', ?)", String(r6 + 1));
  sql.exec("INSERT INTO passes (id, code, label, sessions_total, sessions_used, cover, customer_id, holder_name, status, created_at) VALUES ('ps_old', 'SJ-RUNE-6', 'League', 10, 1, 1000, '1001', 'Sam Jones', 'active', 1)");
  sql.exec("INSERT INTO games (id, title, gm, gm_email, tables, starts_at, ends_at, seats, status) VALUES ('gm_old', 'Old game', 'Ana', 'ana@example.com', '[\"B1\"]', 1, 2, 4, 'open')");
  const fresh = new Lair(ctx, { CURRENCY: 'NZD' });
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
  assert.deepEqual({ ...sql.exec('SELECT code, customer_id, group_id, sessions_used FROM passes WHERE id = ?', 'ps_old').one() }, { code: 'SJ-RUNE-6', customer_id: '1001', group_id: null, sessions_used: 1 });
  assert.equal(fresh.game('gm_old').gmEmail, 'ana@example.com');
  for (const table of ['lair_groups', 'lair_group_members', 'series_invites']) assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().n, 1, table);
  for (const index of ['lair_group_members_customer', 'passes_group', 'series_invites_email', 'games_gm_email']) assert.equal(sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?", index).one().n, 1, index);
  // Running the migrations again changes nothing
  new Lair(ctx, { CURRENCY: 'NZD' });
  assert.equal(sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value, String(MIGRATIONS.length));
});
