// A stand-in for Shopify's Admin API (OAuth token + GraphQL), for the Lair app under `wrangler dev`.
// The dev entry (dev/worker-entry.mjs) sends every https://ep0qiq-rp.myshopify.com/... request here instead.
//
// It answers the app's GraphQL operations by name with the same data the theme preview renders:
//   rooms   = the theme's default rooms (T1-T21, P1-P4, G1-G4, F1 at $15)
//   events  = the mock renderer's lair_event metaobjects (events-mock.mjs: round 4 payment / lock_tables included)
//   theme   = dg-theme-t5's config/settings_data.json (hours, shop tables, prices)
// and keeps draft orders, orders (for orders/paid spend and session pass buyers), store credit and discount codes in
// memory. Round 6 adds library copies (VariantCopies), a customer's orders (CustomerOrders: the last 60 days unless
// the scopes include read_all_orders, like Shopify), when accounts were made (CustomersSince), account emails
// (CustomerEmail) and session gift buyers (OrderGiftBuyer).
// Round 9 (team) adds a store credit balance per customer (LairCreditBalance; POST /__fake/set { denyCreditRead } refuses
// it like a store without read_store_credit_accounts) and adding and taking off credit (LairCreditAdd, LairCreditTake).
//
// Control routes for the test scripts (never part of Shopify):
//   GET  /__fake/state                       everything it holds
//   POST /__fake/set { failCheckout, failCredit, failDiscount, failBuyer, failVariant, failOrders, scopes }
//                                            failDiscount: discountCodeBasicCreate answers with a userError;
//                                            failBuyer: OrderBuyer and OrderGiftBuyer fail like a store without protected
//                                            data approval; failVariant: VariantCopies is refused like a store that
//                                            hasn't approved read_products and read_inventory yet; failOrders:
//                                            CustomerOrders fails (Shopify down); scopes: the scopes the app has (null:
//                                            the usual ones, read_products and read_inventory included)
//   POST /__fake/customer { id, tags, name, email, createdAt (ISO), verified (false: the account email isn't verified) }
//   POST /__fake/order { id, customerId, subtotal (cents), source, name ("#1550"), billingName, shippingName, email,
//                        createdAt (ISO, default now), status ('PAID' default), cancelled }
//   POST /__fake/variant { id, quantity, tracked }   a library copy's inventory (round 6)
//   POST /__fake/variant-code { id, productId, handle, productTitle, title, sku, barcode, price ('4.50'), available, image,
//        productImage, status ('ACTIVE'), giftCard, sellingPlan, libraryCode }   round 7: a variant LairVariantByCode finds
//        by its barcode or SKU (library copies have a libraryCode); POST /__fake/set { failVariantCode } refuses that lookup
//        like a store without read_products. POST /__fake/discount-use { code, count }: how often a code was used
//        (LairGiftCodeUse); orders take discountCodes (OrderSpend answers them, with processedAt)
//   POST /__fake/draft-paid { draftId, orderId }  the checkout was paid: the draft order turned into orderId
//   GET  /__fake/calls                       every GraphQL call so far (operation, variables)
//   GET  /__fake/emails                      every email the app sent (Resend stand-in at /resend/emails[/batch])
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lairEvents } from '../theme-mock/events-mock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = process.env.DG_THEME || '/home/claude/dg-theme-t5';
const PORT = Number(process.env.FAKE_PORT || 8799);
const LOG = path.join(HERE, 'fake-admin.calls.jsonl');

const state = {
  failCheckout: false,
  failCredit: false,
  failDiscount: false,
  failBuyer: false,
  failVariant: false,
  failOrders: false,
  scopes: null,
  variants: {}, // round 6: variant id -> { quantity, tracked }
  variantCodes: [], // round 7: variants found by barcode or SKU (LairVariantByCode)
  failVariantCode: false, // round 7: LairVariantByCode refused (read_products not approved)
  discountUses: {}, // round 7: discount code (upper case) -> times used (LairGiftCodeUse)
  customers: {
    7001: ['staff'], // Mo, staff
    7101: [], // Sam Jones, member
    7102: [], // Kiri Smith, a friend who pays a share
    7103: ['gm'], // Ana Rangi, trusted GM
    7104: [], // Leo Tane, player
    7105: [], // Zoë van der Berg, brand new
    7106: [], // Tui Harper, a weekly regular (round 5 flows)
    7107: [], // Ari Moana, buys a pass before ever opening My Lair
  },
  // names and emails for OrderBuyer (protected customer data), the same made-up people as harness.mjs
  people: {
    7001: { name: 'Mo Ashgrove', email: 'mo@dicegoblin.test' },
    7101: { name: 'Sam Jones', email: 'sam@example.com' },
    7102: { name: 'Kiri Smith', email: 'kiri@example.com' },
    7103: { name: 'Ana Rangi', email: 'ana@example.com' },
    7104: { name: 'Leo Tane', email: 'leo@example.com' },
    7105: { name: 'Zoë van der Berg', email: 'zoe@example.com' },
    7106: { name: 'Tui Harper', email: 'tui@example.com' },
    7107: { name: 'Ari Moana', email: 'ari@example.com' },
  },
  drafts: {}, // id -> { id, status, orderId, input }
  orders: {}, // gid -> { customerId, subtotal, source, name, billingName, shippingName }
  credits: [], // { customerId, amount }
  creditBalances: {}, // round 9 (team): customer id -> store credit in cents (every Credit adds to it)
  denyCreditRead: false, // round 9 (team): LairCreditBalance refused, like a store without read_store_credit_accounts
  discounts: [],
  webhooks: [],
  calls: [],
  emails: [], // what the app sent through Resend: { to, subject, text, reply_to }
};
let seq = 1000;

const rooms = [
  { handle: 'main-room', name: 'Main room', code: 'T', table_count: '21', seats: '4', sort_order: '1' },
  { handle: 'party-room', name: 'Party room', code: 'P', table_count: '4', seats: '4', sort_order: '2' },
  { handle: 'gaming-room', name: 'Gaming room', code: 'G', table_count: '4', seats: '4', sort_order: '3' },
  { handle: 'fancy-room', name: 'Fancy room', code: 'F', table_count: '1', seats: '12', price: '15.0', min_people: '4', sort_order: '4' },
].map(({ handle, ...f }) => ({ handle, capabilities: { publishable: { status: 'ACTIVE' } }, fields: Object.entries(f).map(([key, value]) => ({ key, value })) }));

/**
 * The renderer's Liquid-shaped events as Admin API metaobject nodes (every value a string, like Shopify sends). Round 7:
 * with the events editor's writes on top (r7.eventEdits), so the Lair's own rules (LairData) see what it wrote.
 */
function eventNodes() {
  return editedEvents(lairEvents().map((e) => {
    const out = [];
    for (const [key, v] of Object.entries(e)) {
      if (key === 'system' || key === 'image' || key === 'product' || key === 'link') continue;
      const value = v?.value;
      if (value == null || value === '') continue;
      let text;
      if (Array.isArray(value)) text = JSON.stringify(value);
      else if (typeof value === 'boolean') text = value ? 'true' : 'false';
      else if (typeof value === 'number') text = key === 'entry_fee' ? value.toFixed(1) : String(value);
      else text = String(value);
      out.push({ key, value: text });
    }
    return { handle: e.system.handle, capabilities: { publishable: { status: 'ACTIVE' } }, fields: out };
  }));
}

/* ---------- round 7 (backend-b): the events editor's entries, event pictures and the staged upload target ----------
   Operations: LairCustomers (the staff picker), LairEventsAdmin(Plain), LairEventHandle, LairEventCreate/Update/Delete,
   LairStagedUpload and LairFileCreate (contract v7 section 13). Control routes:
     POST /__fake/set { denyCustomers, denyEventRefs, denyEventWrites, denyFiles }   like a store that hasn't approved
                                    protected customer data, read_files/read_products, write_metaobjects or write_files
     GET  /__fake/events            every lair_event entry as the Admin API keeps it now
     GET  /__fake/uploads           what was posted to the staged upload target (/__upload)                            */
const r7 = {
  // handle -> { id, fields: { key: value }, updatedAt, created, deleted }: what the editor wrote over the renderer's events
  eventEdits: new Map(),
  // MediaImage gid -> { url, alt, filename }; staged upload key -> { filename, size, type, names (the form's fields, in order) }
  files: new Map(),
  uploads: new Map(),
  // ticket products an event can name
  products: new Map([['gid://shopify/Product/9990001', { handle: 'riftbound-store-championship-ticket', title: 'Riftbound store championship ticket' }]]),
};
const EVENT_KEYS = ['title', 'event_type', 'starts_at', 'ends_at', 'repeat', 'repeat_until', 'skip_dates', 'description', 'image', 'capacity', 'price_note',
  'product', 'link', 'tables', 'entry_fee', 'game_tables', 'lock_tables', 'payment', 'game'];
const FIELD_TYPES = { event_type: 'single_line_text_field', starts_at: 'date_time', ends_at: 'date_time', repeat_until: 'date', skip_dates: 'list.date', description: 'multi_line_text_field', image: 'file_reference', capacity: 'number_integer', product: 'product_reference', link: 'url', entry_fee: 'number_decimal', lock_tables: 'boolean' };
const BASE_UPDATED = '2026-10-05T08:05:47Z';
/** A made-up metaobject gid that stays the same for a handle */
const eventGid = (handle) => `gid://shopify/Metaobject/${611300000000 + [...handle].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 9999991, 7)}`;
function editedEvents(base) {
  const out = [];
  for (const n of base) {
    const edit = r7.eventEdits.get(n.handle);
    if (edit?.deleted) continue;
    out.push(edit ? { ...n, fields: Object.entries(edit.fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) } : n);
  }
  for (const [handle, edit] of r7.eventEdits) {
    if (edit.created && !edit.deleted && !base.some((n) => n.handle === handle)) {
      out.push({ handle, capabilities: { publishable: { status: 'ACTIVE' } }, fields: Object.entries(edit.fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
    }
  }
  return out;
}
/** Every lair_event entry as the Admin API keeps it: { id, handle, updatedAt, fields: { key: value | null } } */
const adminEvents = () => eventNodes().map((n) => {
  const edit = r7.eventEdits.get(n.handle);
  return { id: edit?.id || eventGid(n.handle), handle: n.handle, updatedAt: edit?.updatedAt || BASE_UPDATED, fields: Object.fromEntries(n.fields.map((f) => [f.key, f.value])) };
});
/** An entry as a metaobject node: every field of the definition (null when empty), with the picture's and product's details when asked */
function adminNode(e, refs) {
  return {
    id: e.id, handle: e.handle, updatedAt: e.updatedAt,
    fields: EVENT_KEYS.map((key) => {
      const value = e.fields[key] ?? null;
      const field = { key, type: FIELD_TYPES[key] || 'single_line_text_field', value };
      if (refs && (key === 'image' || key === 'product')) {
        const file = key === 'image' && value ? r7.files.get(value) : null;
        const product = key === 'product' && value ? r7.products.get(value) : null;
        field.reference = file ? { __typename: 'MediaImage', id: value, alt: file.alt, image: { url: file.url, width: 800, height: 450 } }
          : product ? { __typename: 'Product', id: value, ...product } : null;
      }
      return field;
    }),
  };
}
/** What Shopify would say about a value the lair_event definition doesn't take, or null */
function eventValueError(key, value) {
  if (!EVENT_KEYS.includes(key)) return `Field definition "${key}" does not exist`;
  if (value === '') return null;
  const choices = { event_type: ['tcg', 'rpg', 'wargame', 'market', 'social', 'tournament', 'learn', 'launch', 'other'], repeat: ['weekly', 'fortnightly', 'monthly'], payment: ['In store', 'Online', 'Online or in store'] }[key];
  if (choices && !choices.includes(value)) return `Value does not exist in provided choices: ${choices.join(', ')}`;
  if ((key === 'starts_at' || key === 'ends_at') && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value)) return 'Value must be in YYYY-MM-DDTHH:MM:SS format';
  if (key === 'repeat_until' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Value must be in YYYY-MM-DD format';
  if (key === 'skip_dates') {
    try {
      const list = JSON.parse(value);
      if (!Array.isArray(list) || !list.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return 'Value must be a list of dates';
    } catch {
      return 'Value must be a list of dates';
    }
  }
  if (key === 'capacity' && !(/^\d+$/.test(value) && Number(value) >= 1)) return 'Value must be greater than or equal to 1';
  if (key === 'entry_fee' && !/^\d+(\.\d{1,2})?$/.test(value)) return 'Value must have at most 2 decimal places';
  if (key === 'lock_tables' && !['true', 'false'].includes(value)) return 'Value must be true or false';
  if (key === 'image' && !r7.files.has(value)) return 'Value must be a file reference string';
  if (key === 'product' && !/^gid:\/\/shopify\/Product\/\d+$/.test(value)) return 'Value must be a product reference string';
  if (key === 'game' && value.length > 40) return 'Value has a maximum length of 40';
  if (key === 'link' && !/^https?:\/\/\S+$/.test(value)) return 'Value must be a valid URL';
  return null;
}
const denied = (what, scope) => ({ __errors: [{ message: `Access denied for ${what} field. Required access: \`${scope}\` access scope.`, extensions: { code: 'ACCESS_DENIED' } }] });

const settingsText = () => fs.readFileSync(path.join(THEME, 'config/settings_data.json'), 'utf8');

function answer(op, query, v) {
  switch (op) {
    case 'LairData':
      return {
        rooms: { nodes: rooms },
        events: { nodes: eventNodes() },
        main: { nodes: [{ id: 'gid://shopify/OnlineStoreTheme/150000000001', name: 'Dice Goblin (t5 preview)', files: { nodes: [{ body: { content: settingsText() } }] } }] },
        shop: { name: 'Dice Goblin NZ', shopAddress: { address1: '56/691 Manukau Road', address2: 'Royal Oak', city: 'Auckland', zip: '1023' } },
      };
    // Round 7 (backend-b): the staff customer picker, Shopify's own search over names and emails (protected customer
    // data: denyCustomers answers like a store without that approval)
    case 'LairCustomers': {
      if (state.denyCustomers) return denied('customers', 'read_customers');
      const q = String(v.query || '').replace(/"/g, '').trim().toLowerCase();
      const nodes = Object.entries(state.people)
        .filter(([, p]) => [p.name, p.email].some((x) => String(x || '').toLowerCase().includes(q)))
        .slice(0, 10)
        .map(([id, p]) => {
          const [first, ...rest] = String(p.name || '').split(/\s+/);
          return { id: `gid://shopify/Customer/${id}`, displayName: p.name || p.email, firstName: first || null, lastName: rest.join(' ') || null, verifiedEmail: p.verified !== false, defaultEmailAddress: p.email ? { emailAddress: p.email } : null };
        });
      return { customers: { nodes } };
    }
    // Round 7 (backend-b): the events editor reads and writes the entries above (r7.eventEdits). denyEventRefs: no
    // read_files or read_products yet (the Lair reads again without references); denyEventWrites: write_metaobjects not
    // approved yet. Values are checked the way the definition checks them.
    case 'LairEventsAdmin':
    case 'LairEventsAdminPlain':
      if (op === 'LairEventsAdmin' && state.denyEventRefs) return denied('reference', 'read_files');
      return { metaobjects: { nodes: adminEvents().map((e) => adminNode(e, op === 'LairEventsAdmin')), pageInfo: { hasNextPage: false, endCursor: null } } };
    case 'LairEventHandle': {
      const e = v.handle?.type === 'lair_event' ? adminEvents().find((x) => x.handle === v.handle?.handle) : null;
      return { metaobjectByHandle: e ? adminNode(e, false) : null };
    }
    case 'LairEventCreate':
    case 'LairEventUpdate': {
      const name = op === 'LairEventCreate' ? 'metaobjectCreate' : 'metaobjectUpdate';
      if (state.denyEventWrites) return denied(name, 'write_metaobjects');
      const existing = op === 'LairEventUpdate' ? adminEvents().find((x) => x.id === v.id) : null;
      if (op === 'LairEventUpdate' && !existing) return { [name]: { metaobject: null, userErrors: [{ field: ['id'], message: 'Record not found', code: 'RECORD_NOT_FOUND' }] } };
      const handle = existing ? existing.handle : String(v.metaobject?.handle || '');
      const errors = [];
      if (!existing && v.metaobject?.type !== 'lair_event') errors.push({ field: ['type'], message: 'Type is invalid', code: 'INVALID' });
      if (!existing && !/^[a-z0-9][a-z0-9-]*$/.test(handle)) errors.push({ field: ['handle'], message: 'Handle is invalid', code: 'INVALID' });
      if (!existing && adminEvents().some((x) => x.handle === handle)) errors.push({ field: ['handle'], message: 'Handle has already been taken', code: 'TAKEN' });
      const fields = { ...(existing?.fields || {}) };
      for (const f of v.metaobject?.fields || []) {
        const problem = eventValueError(f.key, f.value);
        if (problem) errors.push({ field: ['fields', f.key], message: problem, code: 'INVALID_VALUE' });
        fields[f.key] = f.value === '' ? null : f.value;
      }
      if (!fields.title) errors.push({ field: ['fields', 'title'], message: "Title can't be blank", code: 'BLANK' });
      if (!fields.starts_at) errors.push({ field: ['fields', 'starts_at'], message: "Starts can't be blank", code: 'BLANK' });
      if (errors.length) return { [name]: { metaobject: null, userErrors: errors } };
      const before = r7.eventEdits.get(handle);
      r7.eventEdits.set(handle, { id: existing?.id || eventGid(handle), fields, updatedAt: new Date().toISOString(), created: existing ? Boolean(before?.created) : true, deleted: false });
      return { [name]: { metaobject: adminNode(adminEvents().find((x) => x.handle === handle), false), userErrors: [] } };
    }
    case 'LairEventDelete': {
      if (state.denyEventWrites) return denied('metaobjectDelete', 'write_metaobjects');
      const e = adminEvents().find((x) => x.id === v.id);
      if (!e) return { metaobjectDelete: { deletedId: null, userErrors: [{ field: ['id'], message: 'Record not found', code: 'RECORD_NOT_FOUND' }] } };
      r7.eventEdits.set(e.handle, { ...(r7.eventEdits.get(e.handle) || { fields: e.fields }), id: e.id, deleted: true });
      return { metaobjectDelete: { deletedId: e.id, userErrors: [] } };
    }
    // Round 7 (backend-b): event pictures. The upload target is this fake (/__upload, where the dev entry sends Shopify's
    // storage host), and fileCreate only takes a file that was uploaded there. denyFiles: write_files not approved yet.
    case 'LairStagedUpload': {
      if (state.denyFiles) return denied('stagedUploadsCreate', 'write_files');
      const [input] = v.input || [];
      const key = `tmp/${(seq += 1)}/products/${input?.filename}`;
      const ok = input?.resource === 'IMAGE' && input.httpMethod === 'POST' && /^image\/(jpeg|png|webp)$/.test(input.mimeType || '') && /^\d+$/.test(String(input.fileSize || ''));
      if (!ok) return { stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ['input'], message: 'Fake: that staged upload input is not what the Lair should send' }] } };
      return {
        stagedUploadsCreate: {
          stagedTargets: [{
            url: 'https://shopify-staged-uploads.storage.googleapis.com/', resourceUrl: `https://shopify-staged-uploads.storage.googleapis.com/${key}`,
            parameters: [['Content-Type', input.mimeType], ['success_action_status', '201'], ['acl', 'private'], ['key', key], ['x-goog-date', '20261006T000000Z'], ['x-goog-credential', 'fake'], ['x-goog-algorithm', 'GOOG4-RSA-SHA256'], ['x-goog-signature', 'fake'], ['policy', 'ZmFrZQ==']]
              .map(([n, value]) => ({ name: n, value })),
          }],
          userErrors: [],
        },
      };
    }
    case 'LairFileCreate': {
      if (state.denyFiles) return denied('fileCreate', 'write_files');
      const [file] = v.files || [];
      const upload = r7.uploads.get(String(file?.originalSource || '').replace('https://shopify-staged-uploads.storage.googleapis.com/', ''));
      if (!upload || file.contentType !== 'IMAGE') return { fileCreate: { files: [], userErrors: [{ field: ['files', '0', 'originalSource'], message: 'Image URL is invalid', code: 'INVALID' }] } };
      const id = `gid://shopify/MediaImage/${(seq += 1)}`;
      r7.files.set(id, { url: `https://cdn.shopify.com/s/files/1/0000/0001/files/${upload.filename}?v=${seq}`, alt: file.alt || '', filename: upload.filename });
      // Shopify makes the picture in the background: no image yet in this answer
      return { fileCreate: { files: [{ id, fileStatus: 'UPLOADED', alt: file.alt || '', image: null }], userErrors: [] } };
    }
    case 'Scopes':
      return {
        currentAppInstallation: {
          accessScopes: (state.scopes || ['read_customers', 'read_metaobjects', 'read_themes', 'read_orders', 'write_draft_orders', 'write_store_credit_account_transactions', 'write_discounts', 'read_products', 'read_inventory']).map((handle) => ({ handle })),
          app: { title: 'Dice Goblin Lair (fake)' },
        },
        shop: { name: 'Dice Goblin NZ', ianaTimezone: 'Pacific/Auckland' },
      };
    case 'C': {
      const id = String(v.id || '').split('/').pop();
      const tags = state.customers[id];
      return { customer: tags ? { id: v.id, tags } : null };
    }
    // Round 6: the account email guest bookings are matched to, and when accounts were made (years with us)
    case 'CustomerEmail': {
      const id = String(v.id || '').split('/').pop();
      const person = state.people[id];
      if (!state.customers[id] && !person) return { customer: null };
      return { customer: { id: v.id, verifiedEmail: person?.verified !== false, defaultEmailAddress: person?.email ? { emailAddress: person.email } : null } };
    }
    case 'CustomersSince':
      return {
        nodes: (v.ids || []).map((gid) => {
          const id = String(gid).split('/').pop();
          return state.customers[id] || state.people[id] ? { id: gid, createdAt: state.people[id]?.createdAt || '2025-02-01T00:00:00Z' } : null;
        }),
      };
    // Round 6: library copies need read_products and read_inventory; failVariant answers like a store that hasn't
    // approved them yet
    case 'VariantCopies':
      if (state.failVariant) return { __errors: [{ message: 'Access denied for inventoryQuantity field. Required access: `read_inventory` access scope.', extensions: { code: 'ACCESS_DENIED' } }] };
      return {
        nodes: (v.ids || []).map((gid) => {
          const x = state.variants[String(gid).split('/').pop()];
          return x ? { id: gid, inventoryQuantity: x.quantity, inventoryItem: { tracked: x.tracked !== false } } : null;
        }),
      };
    // Round 7: the variants whose barcode or SKU is a scanned code (library scans, the tab's scanner)
    case 'LairVariantByCode': {
      if (state.failVariantCode) return { __errors: [{ message: 'Access denied for productVariants field. Required access: `read_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }] };
      const wanted = [...String(v.query || '').matchAll(/(barcode|sku):"([^"]*)"/g)].map((m) => [m[1], m[2].toUpperCase()]);
      return {
        productVariants: {
          nodes: state.variantCodes.filter((x) => wanted.some(([field, value]) => String(x[field] || '').toUpperCase() === value)).slice(0, 5).map((x) => ({
            id: `gid://shopify/ProductVariant/${x.id}`, title: x.title || 'Default Title', sku: x.sku || null, barcode: x.barcode || null, price: x.price || '0.00',
            availableForSale: x.available !== false, media: { nodes: x.image ? [{ preview: { image: { url: x.image } } }] : [] },
            product: {
              id: `gid://shopify/Product/${x.productId}`, handle: x.handle || '', title: x.productTitle || '', status: x.status || 'ACTIVE', isGiftCard: Boolean(x.giftCard),
              requiresSellingPlan: Boolean(x.sellingPlan), featuredMedia: x.productImage ? { preview: { image: { url: x.productImage } } } : null,
              libraryCode: x.libraryCode ? { value: x.libraryCode } : null,
            },
          })),
        },
      };
    }
    // Round 7: a birthday gift's product code as Shopify sees it: made (discountCodeBasicCreate) and how often it's been used
    case 'LairGiftCodeUse': {
      const made = state.discounts.find((d) => String(d.code || '').toUpperCase() === String(v.code || '').toUpperCase());
      if (!made) return { codeDiscountNodeByCode: null };
      return {
        codeDiscountNodeByCode: {
          id: `gid://shopify/DiscountCodeNode/${made.code}`,
          codeDiscount: { __typename: 'DiscountCodeBasic', status: 'ACTIVE', endsAt: made.endsAt || null, asyncUsageCount: state.discountUses[String(made.code).toUpperCase()] || 0 },
        },
      };
    }
    // Round 6: a customer's orders for the spend report's backfill. Without read_all_orders, Shopify shows the last
    // 60 days only, so this does too.
    case 'CustomerOrders': {
      if (state.failOrders) return { __errors: [{ message: 'Fake: Shopify is having a moment (CustomerOrders)' }] };
      const id = String(v.id || '').split('/').pop();
      if (!state.customers[id] && !state.people[id]) return { customer: null };
      const all = (state.scopes || []).includes('read_all_orders');
      const nodes = Object.entries(state.orders)
        .filter(([, o]) => o.customerId === id && (all || Date.parse(o.createdAt) > Date.now() - 60 * 86400000))
        .sort(([, a], [, b]) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(([gid, o]) => ({
          id: gid, name: o.name, createdAt: o.createdAt, processedAt: o.createdAt, sourceName: o.source || 'web', cancelledAt: o.cancelled ? o.createdAt : null,
          displayFinancialStatus: o.status || 'PAID', subtotalPriceSet: { shopMoney: { amount: (o.subtotal / 100).toFixed(2), currencyCode: 'NZD' } },
        }));
      return { customer: { id: v.id, createdAt: state.people[id]?.createdAt || '2025-02-01T00:00:00Z', orders: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    case 'Draft': {
      if (state.failCheckout) return { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input'], message: 'Fake: checkout is switched off' }] } };
      const id = `gid://shopify/DraftOrder/${(seq += 1)}`;
      const n = id.split('/').pop();
      state.drafts[id] = { id, status: 'OPEN', orderId: null, input: v.input };
      return { draftOrderCreate: { draftOrder: { id, invoiceUrl: `http://localhost:${process.env.QA_PORT || 4180}/__checkout/${n}` }, userErrors: [] } };
    }
    // round 9: a member's Lair bill, a draft order for that customer (purchasingEntity), every line tagged _bill.
    // POST /__fake/set { failBill: true } makes Shopify say no.
    case 'LairBill': {
      if (state.failBill) return { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input'], message: 'Fake: bills are switched off' }] } };
      const id = `gid://shopify/DraftOrder/${(seq += 1)}`;
      const n = id.split('/').pop();
      state.drafts[id] = { id, status: 'OPEN', orderId: null, input: v.input, bill: true };
      const cents = (m) => Math.round(Number(m?.amount || 0) * 100);
      const total = (v.input?.lineItems || []).reduce((sum, l) => sum + cents(l.priceOverride || l.originalUnitPriceWithCurrency) * (Number(l.quantity) || 1), 0);
      return {
        draftOrderCreate: {
          draftOrder: { id, invoiceUrl: `http://localhost:${process.env.QA_PORT || 4180}/__checkout/${n}`, totalPriceSet: { shopMoney: { amount: (total / 100).toFixed(2), currencyCode: 'NZD' } } },
          userErrors: [],
        },
      };
    }
    case 'DraftStatus':
    case 'DraftOpen': {
      const d = state.drafts[v.id];
      if (!d) return { draftOrder: null };
      return { draftOrder: { id: d.id, status: d.status, ...(op === 'DraftStatus' ? { order: d.orderId ? { id: d.orderId } : null } : {}) } };
    }
    case 'D': {
      const d = state.drafts[v.input?.id];
      if (d && d.status !== 'COMPLETED') d.status = 'DELETED';
      return { draftOrderDelete: { deletedId: v.input?.id || null, userErrors: [] } };
    }
    case 'OrderSpend': {
      const o = state.orders[v.id];
      if (!o) return { order: null };
      return {
        order: {
          id: v.id, name: o.name, sourceName: o.source || 'web', customer: o.customerId ? { id: `gid://shopify/Customer/${o.customerId}` } : null,
          currentSubtotalPriceSet: { shopMoney: { amount: (o.subtotal / 100).toFixed(2), currencyCode: 'NZD' } },
          // round 7: a birthday gift's product code on an order is noticed from these
          discountCodes: o.discountCodes || [], processedAt: o.createdAt || null,
        },
      };
    }
    case 'OrderBuyer': {
      if (state.failBuyer) return { __errors: [{ message: 'Access denied for customer field. This app is not approved to access protected customer data.' }] };
      const o = state.orders[v.id];
      if (!o) return { order: null };
      const person = o.customerId ? state.people[o.customerId] || {} : {};
      return {
        order: {
          id: v.id, name: o.name,
          billingAddress: o.billingName ? { name: o.billingName } : null,
          shippingAddress: o.shippingName ? { name: o.shippingName } : null,
          customer: o.customerId
            ? { id: `gid://shopify/Customer/${o.customerId}`, displayName: person.name || '', defaultEmailAddress: person.email ? { emailAddress: person.email } : null }
            : null,
        },
      };
    }
    // Round 6: who bought a session gift (the order's email and the buyer's first name: protected customer data)
    case 'OrderGiftBuyer': {
      if (state.failBuyer) return { __errors: [{ message: 'Access denied for email field. This app is not approved to access protected customer data.' }] };
      const o = state.orders[v.id];
      if (!o) return { order: null };
      const person = o.customerId ? state.people[o.customerId] || {} : {};
      return {
        order: {
          id: v.id, name: o.name, email: o.email || person.email || null,
          billingAddress: o.billingName ? { firstName: o.billingName.split(/\s+/)[0], name: o.billingName } : null,
          customer: o.customerId
            ? { id: `gid://shopify/Customer/${o.customerId}`, firstName: (person.name || '').split(/\s+/)[0] || null, displayName: person.name || '', defaultEmailAddress: person.email ? { emailAddress: person.email } : null }
            : null,
        },
      };
    }
    case 'Credit': {
      if (state.failCredit) return { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [{ field: ['id'], message: 'Fake: store credit is switched off', code: 'FAKE' }] } };
      const customerId = String(v.id || '').split('/').pop();
      const amount = Math.round(Number(v.creditInput?.creditAmount?.amount || 0) * 100);
      state.credits.push({ customerId, amount, at: Date.now() });
      state.creditBalances[customerId] = (state.creditBalances[customerId] || 0) + amount; // round 9
      return { storeCreditAccountCredit: { storeCreditAccountTransaction: { amount: { amount: (amount / 100).toFixed(2) } }, userErrors: [] } };
    }
    // Round 9 (team): a member's store credit on the staff page: the balance (denyCreditRead: no
    // read_store_credit_accounts yet), adding (no email) and taking off (never below zero: INSUFFICIENT_FUNDS)
    case 'LairCreditBalance': {
      if (state.denyCreditRead) return denied('storeCreditAccounts', 'read_store_credit_accounts');
      const customerId = String(v.id || '').split('/').pop();
      const cents = state.creditBalances[customerId] || 0;
      return { customer: { id: v.id, storeCreditAccounts: { nodes: cents ? [{ id: `gid://shopify/StoreCreditAccount/${customerId}`, balance: { amount: (cents / 100).toFixed(2), currencyCode: 'NZD' } }] : [] } } };
    }
    case 'LairCreditAdd':
    case 'LairCreditTake': {
      const take = op === 'LairCreditTake';
      const key = take ? 'storeCreditAccountDebit' : 'storeCreditAccountCredit';
      if (state.failCredit) return { [key]: { storeCreditAccountTransaction: null, userErrors: [{ field: ['id'], message: 'Fake: store credit is switched off', code: 'FAKE' }] } };
      const customerId = String(v.id || '').split('/').pop();
      const amount = Math.round(Number((take ? v.debitInput?.debitAmount : v.creditInput?.creditAmount)?.amount || 0) * 100);
      const now = state.creditBalances[customerId] || 0;
      if (take && amount > now) return { [key]: { storeCreditAccountTransaction: null, userErrors: [{ field: ['debitInput', 'debitAmount'], message: 'Insufficient funds', code: 'INSUFFICIENT_FUNDS' }] } };
      state.creditBalances[customerId] = now + (take ? -amount : amount);
      state.credits.push({ customerId, amount: take ? -amount : amount, at: Date.now(), notify: take ? null : v.creditInput?.notify ?? null });
      const money = (c) => ({ amount: (c / 100).toFixed(2), currencyCode: 'NZD' });
      return { [key]: { storeCreditAccountTransaction: { id: `gid://shopify/StoreCreditAccountDebitTransaction/${(seq += 1)}`, amount: money(take ? -amount : amount), balanceAfterTransaction: money(state.creditBalances[customerId]) }, userErrors: [] } };
    }
    case 'Prize':
      if (state.failDiscount) return { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount'], message: 'Fake: discounts are switched off', code: 'FAKE' }] } };
      state.discounts.push(v.discount);
      return { discountCodeBasicCreate: { codeDiscountNode: { id: `gid://shopify/DiscountCodeNode/${(seq += 1)}` }, userErrors: [] } };
    case 'Hooks':
      return { webhookSubscriptions: { nodes: state.webhooks.map((uri, i) => ({ id: `gid://shopify/WebhookSubscription/${i + 1}`, uri })) } };
    case 'Hook':
      state.webhooks.push(v.sub?.uri);
      return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${state.webhooks.length}` }, userErrors: [] } };
    default:
      return null;
  }
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  // round 7: the staged upload's multipart form, as bytes
  req.rawBuffer = Buffer.concat(chunks);
  return req.rawBuffer.toString('utf8');
}
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const raw = await body(req);
  try {
    if (url.pathname === '/admin/oauth/access_token' && req.method === 'POST') {
      const p = new URLSearchParams(raw);
      if (p.get('client_secret') !== 'hush') return send(res, 400, { error: 'invalid_client' });
      return send(res, 200, { access_token: 'fake-admin-token', scope: 'read_customers', expires_in: 86399 });
    }
    if (/^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname) && req.method === 'POST') {
      if (req.headers['x-shopify-access-token'] !== 'fake-admin-token') return send(res, 401, { errors: 'Unauthorized' });
      const { query, variables } = JSON.parse(raw || '{}');
      const op = (String(query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1] || '?';
      const entry = { at: new Date().toISOString(), op, variables };
      state.calls.push(entry);
      fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
      if (op === 'Draft' && state.failCheckout === 'http') return send(res, 500, { errors: 'boom' });
      const data = answer(op, query, variables || {});
      if (!data) return send(res, 200, { errors: [{ message: `Fake Admin API: unknown operation ${op}` }] });
      if (data.__errors) return send(res, 200, { errors: data.__errors });
      return send(res, 200, { data });
    }
    // Resend's API: the app's emails land here (the dev entry sends api.resend.com/* to /resend/*)
    if ((url.pathname === '/resend/emails' || url.pathname === '/resend/emails/batch') && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer re_fake') return send(res, 401, { message: 'API key is invalid' });
      const list = url.pathname.endsWith('/batch') ? JSON.parse(raw || '[]') : [JSON.parse(raw || '{}')];
      for (const m of list) state.emails.push({ at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text, reply_to: m.reply_to || null });
      return send(res, 200, url.pathname.endsWith('/batch') ? { data: list.map(() => ({ id: `em_${(seq += 1)}` })) } : { id: `em_${(seq += 1)}` });
    }
    // Round 7 (backend-b): Shopify's staged upload target for event pictures (the dev entry sends
    // shopify-staged-uploads.storage.googleapis.com here). Every parameter the target gave must come first, in order,
    // then the file, as Google Cloud Storage wants.
    if (url.pathname.startsWith('/__upload') && req.method === 'POST') {
      const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: req.rawBuffer }).formData();
      const names = [...form.keys()];
      const file = form.get('file');
      const key = form.get('key');
      if (!key || names.at(-1) !== 'file' || !file || typeof file === 'string' || form.get('policy') !== 'ZmFrZQ==') return send(res, 400, { errors: `Fake upload: fields ${names.join(', ')}` });
      r7.uploads.set(key, { filename: file.name, size: file.size, type: file.type, names });
      res.writeHead(201, { 'Content-Type': 'application/xml' });
      return res.end(`<PostResponse><Key>${key}</Key></PostResponse>`);
    }
    if (url.pathname === '/__fake/events') return send(res, 200, adminEvents());
    if (url.pathname === '/__fake/uploads') return send(res, 200, Object.fromEntries(r7.uploads));
    if (url.pathname === '/__fake/emails') return send(res, 200, state.emails);
    if (url.pathname === '/__fake/state') return send(res, 200, { ...state, calls: state.calls.length, emails: state.emails.length });
    if (url.pathname === '/__fake/calls') return send(res, 200, state.calls);
    if (url.pathname === '/__fake/set' && req.method === 'POST') {
      Object.assign(state, JSON.parse(raw || '{}'));
      return send(res, 200, {
        ok: true, failCheckout: state.failCheckout, failCredit: state.failCredit, failDiscount: state.failDiscount, failBuyer: state.failBuyer, failVariant: state.failVariant,
        failOrders: state.failOrders, scopes: state.scopes,
      });
    }
    if (url.pathname === '/__fake/customer' && req.method === 'POST') {
      const { id, tags, name, email, createdAt, verified } = JSON.parse(raw || '{}');
      state.customers[String(id)] = tags || [];
      if (name || email || createdAt || verified != null) {
        state.people[String(id)] = { name: name || '', email: email || '', ...(createdAt ? { createdAt } : {}), ...(verified != null ? { verified } : {}) };
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__fake/variant' && req.method === 'POST') {
      const { id, quantity, tracked } = JSON.parse(raw || '{}');
      state.variants[String(id)] = { quantity: Number(quantity), tracked: tracked !== false };
      return send(res, 200, { ok: true, variant: state.variants[String(id)] });
    }
    if (url.pathname === '/__fake/variant-code' && req.method === 'POST') {
      const x = JSON.parse(raw || '{}');
      state.variantCodes = [...state.variantCodes.filter((y) => String(y.id) !== String(x.id)), x];
      return send(res, 200, { ok: true, variant: x });
    }
    if (url.pathname === '/__fake/discount-use' && req.method === 'POST') {
      const { code, count } = JSON.parse(raw || '{}');
      state.discountUses[String(code || '').toUpperCase()] = Number(count) || 0;
      return send(res, 200, { ok: true, uses: state.discountUses });
    }
    if (url.pathname === '/__fake/order' && req.method === 'POST') {
      const o = JSON.parse(raw || '{}');
      const gid = String(o.id).startsWith('gid://') ? o.id : `gid://shopify/Order/${o.id}`;
      state.orders[gid] = {
        customerId: o.customerId ? String(o.customerId) : null, subtotal: Number(o.subtotal || 0), source: o.source || 'web',
        name: o.name || `#${String(gid).split('/').pop()}`, billingName: o.billingName || '', shippingName: o.shippingName || '',
        // round 6: the order's email (session gifts), when it was made, its financial status and whether it was cancelled
        email: o.email || '', createdAt: o.createdAt || new Date().toISOString(), status: o.status || 'PAID', cancelled: Boolean(o.cancelled),
        // round 7: the discount codes used on it
        discountCodes: Array.isArray(o.discountCodes) ? o.discountCodes.map(String) : [],
      };
      return send(res, 200, { ok: true, gid });
    }
    if (url.pathname === '/__fake/draft-paid' && req.method === 'POST') {
      const { draftId, orderId } = JSON.parse(raw || '{}');
      const d = state.drafts[draftId];
      if (!d) return send(res, 404, { error: 'no such draft' });
      d.status = 'COMPLETED';
      d.orderId = orderId;
      return send(res, 200, { ok: true, draft: d });
    }
    return send(res, 404, { errors: `Fake Admin API: nothing at ${req.method} ${url.pathname}` });
  } catch (error) {
    return send(res, 500, { errors: String(error.stack || error) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake Admin API on http://127.0.0.1:${PORT} (theme ${THEME})`));
