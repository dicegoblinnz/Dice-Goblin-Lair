// Dice Goblin Lair — talking to Shopify: request signatures, Admin API token and GraphQL calls.
import { eventPayment } from './core.js';

const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * App proxy requests carry a `signature` param: hex HMAC-SHA256 of the other params,
 * each as key=value (repeated keys joined with commas), sorted, joined with nothing.
 */
export async function verifyProxySignature(searchParams, secret, { now = Date.now(), maxAgeSeconds = 3600 } = {}) {
  if (!secret) return false;
  const signature = searchParams.get('signature');
  if (!signature) return false;
  const grouped = new Map();
  for (const [key, value] of searchParams) {
    if (key === 'signature') continue;
    grouped.set(key, [...(grouped.get(key) || []), value]);
  }
  const message = [...grouped.entries()].map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  const expected = toHex(await hmac(secret, message));
  if (!safeEqual(expected, signature)) return false;
  const timestamp = Number(searchParams.get('timestamp'));
  return Number.isFinite(timestamp) && Math.abs(now / 1000 - timestamp) <= maxAgeSeconds;
}

/** Webhooks carry X-Shopify-Hmac-Sha256: base64 HMAC-SHA256 of the raw body. */
export async function verifyWebhook(rawBody, header, secret) {
  if (!secret || !header) return false;
  return safeEqual(toBase64(await hmac(secret, rawBody)), header);
}

const fromBase64Url = (text) => {
  const b64 = String(text).replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/**
 * A Shopify POS session token (the JWT the POS extension gets from shopify.session.getSessionToken()), signed HS256
 * with the app's client secret. Returns its claims when the signature checks out, aud is the app's client ID, dest is
 * the shop, and it's inside exp and nbf (with 60 seconds' leeway for clock drift). Anything else is null.
 */
export async function verifySessionToken(token, { secret, clientId, shop, now = Date.now(), leeway = 60 } = {}) {
  if (!secret || !clientId || !shop || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+={0,2}$/.test(p))) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256' || !claims || typeof claims !== 'object') return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, fromBase64Url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)))) return null;
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || seconds > claims.exp + leeway) return null;
  if (claims.nbf != null && (typeof claims.nbf !== 'number' || seconds < claims.nbf - leeway)) return null;
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(clientId)) return null;
  if (String(claims.dest || '').replace(/\/+$/, '').toLowerCase() !== `https://${String(shop).toLowerCase()}`) return null;
  return claims;
}

export class ShopifyAdmin {
  constructor(env, storage) {
    this.shop = env.SHOP;
    this.version = env.API_VERSION || '2026-07';
    this.clientId = env.SHOPIFY_CLIENT_ID;
    this.clientSecret = env.SHOPIFY_CLIENT_SECRET;
    this.storage = storage;
    this.token = null;
    this.tokenExpires = 0;
  }

  get configured() {
    return Boolean(this.shop && this.clientId && this.clientSecret);
  }

  /** Client credentials grant: the app and the store are in the same organization. Tokens last 24h. */
  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 5 * 60_000) return this.token;
    const saved = await this.storage?.get?.('admin-token');
    if (saved && saved.clientId === this.clientId && Date.now() < saved.expires - 5 * 60_000) {
      this.token = saved.token;
      this.tokenExpires = saved.expires;
      return this.token;
    }
    const response = await fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }),
    });
    if (!response.ok) {
      const body = await response.text();
      // Shopify answers with an HTML error page; its title says what's wrong (e.g. "Oauth error app_not_installed").
      const reason = body.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/^\d+\s*-\s*/, '') || body.slice(0, 200);
      throw new Error(`Shopify login failed (${response.status}): ${reason}`);
    }
    const { access_token: token, expires_in: expiresIn } = await response.json();
    this.token = token;
    this.tokenExpires = Date.now() + (expiresIn || 86399) * 1000;
    await this.storage?.put?.('admin-token', { token, expires: this.tokenExpires, clientId: this.clientId });
    return token;
  }

  async graphql(query, variables = {}, retried = false) {
    const response = await fetch(`https://${this.shop}/admin/api/${this.version}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
      body: JSON.stringify({ query, variables }),
    });
    if ((response.status === 401 || response.status === 403) && !retried) {
      // The saved token was revoked or is missing a newly added scope: get a fresh one and try once more.
      this.token = null;
      this.tokenExpires = 0;
      await this.storage?.delete?.('admin-token');
      return this.graphql(query, variables, true);
    }
    if (!response.ok) throw new Error(`Shopify API error ${response.status}`);
    const { data, errors } = await response.json();
    if (errors?.length) {
      // A scope added after the token was issued shows up as ACCESS_DENIED: a fresh token picks it up.
      if (!retried && errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
        this.token = null;
        this.tokenExpires = 0;
        await this.storage?.delete?.('admin-token');
        return this.graphql(query, variables, true);
      }
      throw new Error(`Shopify API: ${errors.map((e) => e.message).join('; ')}`);
    }
    return data;
  }

  /**
   * Rooms, events and the Lair settings from the theme. The live theme wins once it has the booking settings (so
   * publishing the new theme needs no config change); before that, THEME_ID names the preview theme to read.
   */
  async loadLairData(themeId) {
    const fields = (node) => Object.fromEntries(node.fields.map((f) => [f.key, f.value]));
    const settingsFile = 'files(filenames: ["config/settings_data.json"]) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } }';
    const id = String(themeId || '').trim();
    const previewQuery = /^\d+$/.test(id) ? `preview: theme(id: "gid://shopify/OnlineStoreTheme/${id}") { id name ${settingsFile} }` : '';
    const data = await this.graphql(`query LairData {
      rooms: metaobjects(type: "lair_room", first: 50) { nodes { handle capabilities { publishable { status } } fields { key value } } }
      events: metaobjects(type: "lair_event", first: 250, sortKey: "id", reverse: true) { nodes { handle capabilities { publishable { status } } fields { key value } } }
      main: themes(roles: [MAIN], first: 1) { nodes { id name ${settingsFile} } }
      shop { name shopAddress { address1 address2 city zip } }
      ${previewQuery}
    }`);
    // Entries saved as drafts don't show on the website, so they don't count here either.
    const live = (n) => n.capabilities?.publishable?.status !== 'DRAFT';
    const textOf = (theme) => theme?.files?.nodes?.[0]?.body?.content || null;
    const main = data.main?.nodes?.[0] || null;
    const hasLairSettings = (theme) => /"lair_[a-z_]+"\s*:/.test(textOf(theme) || '');
    const themeNode = hasLairSettings(main) ? main : data.preview && textOf(data.preview) ? data.preview : main;
    const settingsText = textOf(themeNode);
    const theme = themeNode ? { id: String(themeNode.id || '').split('/').pop(), name: themeNode.name, live: themeNode === main } : null;
    const rooms = data.rooms.nodes.filter(live).map((n) => {
      const f = fields(n);
      return {
        id: n.handle, name: f.name, code: f.code, tables: Number(f.table_count || 0), seats: Number(f.seats || 4),
        price: f.price ? Number(f.price) : null, order: Number(f.sort_order || 0), bookable: f.bookable !== 'false', layout: f.layout || null,
        minPeople: Number(f.min_people || 0),
      };
    });
    const list = (value) => {
      try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    const events = data.events.nodes
      .filter(live)
      .map((n) => {
        const f = fields(n);
        const start = Date.parse(f.starts_at);
        const fee = Math.round(Number(f.entry_fee || 0) * 100);
        return {
          id: n.handle, title: f.title, start, end: f.ends_at ? Date.parse(f.ends_at) : start + 3 * 3_600_000, tables: f.tables || '',
          repeat: f.repeat || '', repeatUntil: f.repeat_until || null, skipDates: list(f.skip_dates), capacity: f.capacity ? Number(f.capacity) : null,
          // entry_fee: NZD a person (cents here). game_tables: bookable game spots like "T14+T15, T16+T17".
          entryFee: Number.isFinite(fee) && fee > 0 ? fee : 0, gameTables: f.game_tables || '',
          // payment: "In store" (or empty), "Online" or "Online or in store". tables ("Tables reserved") are only marked
          // for the event unless lock_tables ("Lock these tables") is on.
          payment: eventPayment(f.payment), lockTables: String(f.lock_tables || '').trim().toLowerCase() === 'true',
        };
      })
      .filter((e) => Number.isFinite(e.start));
    // The store address (Settings → Store details), the same one the theme's footer shows: for email footers.
    const a = data.shop?.shopAddress || {};
    const address = [a.address1, a.address2, [a.city, a.zip].filter(Boolean).join(' ')].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
    return { rooms, events, settingsText, theme, shop: { name: data.shop?.name || null, address } };
  }

  /** Which permissions the store granted the app, for the health check. */
  async appInfo() {
    const data = await this.graphql('query Scopes { currentAppInstallation { accessScopes { handle } app { title } } shop { name ianaTimezone } }');
    return {
      app: data.currentAppInstallation?.app?.title || null,
      scopes: (data.currentAppInstallation?.accessScopes || []).map((s) => s.handle),
      shop: data.shop?.name || null,
      shopTimezone: data.shop?.ianaTimezone || null,
    };
  }

  /**
   * Round 7, the staff customer picker: Shopify's own customer search (name and email), most recently updated first, up
   * to 10. read_customers, plus protected customer data approval for names and emails: without it this throws.
   * Returns [{ customerId, name, firstName, email }].
   */
  async searchCustomers(query) {
    const data = await this.graphql(
      'query LairCustomers($query: String!) { customers(first: 10, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { id displayName firstName lastName verifiedEmail defaultEmailAddress { emailAddress } } } }',
      { query },
    );
    return (data.customers?.nodes || []).map((c) => {
      const display = String(c.displayName || '').trim();
      const name = [c.firstName, c.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || (display.includes('@') ? '' : display);
      return { customerId: String(c.id || '').split('/').pop(), name: name.slice(0, 80), firstName: String(c.firstName || '').trim().slice(0, 40), email: String(c.defaultEmailAddress?.emailAddress || '').trim() };
    });
  }

  /**
   * Round 7, the events editor: every lair_event entry with all its fields, newest change first, 100 a page. refs asks
   * for the picture's and ticket product's details too (read_files and read_products); without them, the plain query
   * gives those as ids only. Returns [{ id, handle, updatedAt, fields: [{ key, type, value, reference }] }].
   */
  async lairEventsAdmin({ refs = true } = {}) {
    const reference = refs ? ' reference { __typename ... on MediaImage { id alt image { url width height } } ... on Product { id handle title } }' : '';
    const query = refs
      ? `query LairEventsAdmin($after: String) { metaobjects(type: "lair_event", first: 100, after: $after, sortKey: "updated_at", reverse: true) { nodes { id handle updatedAt fields { key type value${reference} } } pageInfo { hasNextPage endCursor } } }`
      : 'query LairEventsAdminPlain($after: String) { metaobjects(type: "lair_event", first: 100, after: $after, sortKey: "updated_at", reverse: true) { nodes { id handle updatedAt fields { key type value } } pageInfo { hasNextPage endCursor } } }';
    const nodes = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const data = await this.graphql(query, { after });
      nodes.push(...(data.metaobjects?.nodes || []));
      if (!data.metaobjects?.pageInfo?.hasNextPage) break;
      after = data.metaobjects.pageInfo.endCursor;
    }
    return nodes;
  }

  /** One lair_event entry by its handle (is a handle taken; the event before a change), or null. read_metaobjects. */
  async lairEventByHandle(handle) {
    const data = await this.graphql(
      'query LairEventHandle($handle: MetaobjectHandleInput!) { metaobjectByHandle(handle: $handle) { id handle updatedAt fields { key type value } } }',
      { handle: { type: 'lair_event', handle } },
    );
    return data.metaobjectByHandle || null;
  }

  /** A new lair_event entry: { metaobject, userErrors }. fields: [{ key, value }]. write_metaobjects. */
  async createLairEvent(handle, fields) {
    const data = await this.graphql(
      'mutation LairEventCreate($metaobject: MetaobjectCreateInput!) { metaobjectCreate(metaobject: $metaobject) { metaobject { id handle updatedAt fields { key type value } } userErrors { field message code } } }',
      { metaobject: { type: 'lair_event', handle, fields } },
    );
    return { metaobject: data.metaobjectCreate?.metaobject || null, userErrors: data.metaobjectCreate?.userErrors || [] };
  }

  /** Change a lair_event entry's fields (only those sent; value "" clears one): { metaobject, userErrors }. write_metaobjects. */
  async updateLairEvent(id, fields) {
    const data = await this.graphql(
      'mutation LairEventUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $metaobject) { metaobject { id handle updatedAt fields { key type value } } userErrors { field message code } } }',
      { id, metaobject: { fields } },
    );
    return { metaobject: data.metaobjectUpdate?.metaobject || null, userErrors: data.metaobjectUpdate?.userErrors || [] };
  }

  /** Delete a lair_event entry: { deletedId, userErrors }. write_metaobjects. */
  async deleteLairEvent(id) {
    const data = await this.graphql('mutation LairEventDelete($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { field message code } } }', { id });
    return { deletedId: data.metaobjectDelete?.deletedId || null, userErrors: data.metaobjectDelete?.userErrors || [] };
  }

  /**
   * An event picture into Shopify's Files (round 7): a staged upload target (stagedUploadsCreate), the file posted to it
   * by the Worker itself (a multipart form: every parameter Shopify gave, in order, then the file), then fileCreate.
   * write_files. Returns { image: { id, url, alt, status } } or { problem } with what went wrong.
   */
  async uploadEventPicture({ bytes, mimeType, filename, alt }) {
    const staged = await this.graphql(
      'mutation LairStagedUpload($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }',
      { input: [{ resource: 'IMAGE', filename, mimeType, httpMethod: 'POST', fileSize: String(bytes.length) }] },
    );
    const problems = staged.stagedUploadsCreate?.userErrors || [];
    const target = staged.stagedUploadsCreate?.stagedTargets?.[0];
    if (problems.length || !target?.url) return { problem: problems.map((e) => e.message).join('; ') || 'no upload address' };
    const form = new FormData();
    for (const p of target.parameters || []) form.append(p.name, p.value);
    form.append('file', new Blob([bytes], { type: mimeType }), filename);
    const sent = await fetch(target.url, { method: 'POST', body: form });
    await sent.arrayBuffer().catch(() => null);
    if (!sent.ok) return { problem: `the upload answered ${sent.status}` };
    const made = await this.graphql(
      'mutation LairFileCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus alt ... on MediaImage { image { url width height } } } userErrors { field message code } } }',
      { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt }] },
    );
    const errors = made.fileCreate?.userErrors || [];
    const file = made.fileCreate?.files?.[0];
    if (errors.length || !file?.id) return { problem: errors.map((e) => e.message).join('; ') || 'no file came back' };
    return { image: { id: file.id, url: file.image?.url || null, alt: file.alt ?? alt ?? '', status: file.fileStatus || null } };
  }

  async customerTags(customerId) {
    const data = await this.graphql('query C($id: ID!) { customer(id: $id) { id tags } }', { id: `gid://shopify/Customer/${customerId}` });
    return data.customer ? data.customer.tags.map((t) => t.toLowerCase()) : [];
  }

  /**
   * The email on a customer's own Shopify account, and whether Shopify says it's verified (round 6: a guest's bookings
   * join the account with that email). read_customers, and protected customer data approval for the email field.
   * Returns { email, verified } or null when there's no such customer.
   */
  async customerEmail(customerId) {
    const data = await this.graphql('query CustomerEmail($id: ID!) { customer(id: $id) { id verifiedEmail defaultEmailAddress { emailAddress } } }', { id: `gid://shopify/Customer/${customerId}` });
    const c = data.customer;
    return c ? { email: String(c.defaultEmailAddress?.emailAddress || '').trim(), verified: c.verifiedEmail === true } : null;
  }

  /**
   * When each customer's Shopify account was made (round 6: years with Dice Goblin), for up to 100 customer IDs in one
   * call. read_customers. Returns a Map of customer ID → ms, or null for a customer Shopify doesn't have.
   */
  async customersSince(customerIds) {
    const ids = [...new Set(customerIds.map(String))].slice(0, 100);
    if (!ids.length) return new Map();
    const data = await this.graphql('query CustomersSince($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id createdAt } } }', { ids: ids.map((id) => `gid://shopify/Customer/${id}`) });
    const found = new Map((data.nodes || []).filter((n) => n?.id).map((n) => [String(n.id).split('/').pop(), Date.parse(n.createdAt)]));
    return new Map(ids.map((id) => [id, Number.isFinite(found.get(id)) ? found.get(id) : null]));
  }

  /**
   * How many copies of each library game there are (round 6: library holds): each product variant's inventory quantity,
   * for up to 60 variant IDs in one call. Needs read_products and read_inventory (Mo approves them once in Shopify admin);
   * until then Shopify refuses and this throws. Returns a Map of variant ID → { quantity, tracked }, or null for a
   * variant Shopify doesn't have.
   */
  async variantCopies(variantIds) {
    const ids = [...new Set(variantIds.map(String))].slice(0, 60);
    if (!ids.length) return new Map();
    const data = await this.graphql(
      'query VariantCopies($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryQuantity inventoryItem { tracked } } } }',
      { ids: ids.map((id) => `gid://shopify/ProductVariant/${id}`) },
    );
    const found = new Map((data.nodes || []).filter((n) => n?.id).map((n) => [String(n.id).split('/').pop(), n]));
    return new Map(ids.map((id) => {
      const n = found.get(id);
      return [id, n ? { quantity: Number.isFinite(Number(n.inventoryQuantity)) ? Number(n.inventoryQuantity) : null, tracked: n.inventoryItem?.tracked !== false } : null];
    }));
  }

  /** A draft order with one custom line; its invoice URL is a normal Shopify checkout. */
  async createCheckout({ ref, title, unitPrice, quantity, email, currency, attributes }) {
    const data = await this.graphql(
      `mutation Draft($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } } }`,
      {
        input: {
          email: email || undefined,
          tags: ['lair-booking'],
          note: `Lair booking ${ref}`,
          customAttributes: [{ key: '_booking', value: ref }],
          lineItems: [
            {
              title,
              quantity,
              originalUnitPriceWithCurrency: { amount: (unitPrice / 100).toFixed(2), currencyCode: currency },
              requiresShipping: false,
              taxable: true,
              customAttributes: [...Object.entries(attributes), ['_booking', ref]].map(([key, value]) => ({ key, value: String(value) })),
            },
          ],
        },
      },
    );
    const result = data.draftOrderCreate;
    if (result.userErrors.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
    return { draftOrderId: result.draftOrder.id, checkoutUrl: result.draftOrder.invoiceUrl };
  }

  /**
   * Who paid for an order and its subtotal after discounts (in cents), for members' spend, and the order's name
   * ("#1550"). customerId is null when the order has no customer.
   */
  async orderSpend(orderId) {
    const data = await this.graphql(
      'query OrderSpend($id: ID!) { order(id: $id) { id name sourceName customer { id } currentSubtotalPriceSet { shopMoney { amount currencyCode } } } }',
      { id: orderId },
    );
    const order = data.order;
    if (!order) return null;
    const amount = Math.round(Number(order.currentSubtotalPriceSet?.shopMoney?.amount || 0) * 100);
    return {
      customerId: order.customer?.id ? String(order.customer.id).split('/').pop() : null,
      amount: Number.isFinite(amount) ? amount : 0,
      source: order.sourceName || null,
      name: order.name || null,
    };
  }

  /**
   * A customer's paid orders, for the spend report's backfill (round 6), with when their Shopify account was made. Each
   * order: { id, name, at (processed, else created), source, amount (subtotal after discounts, before returns: the same
   * "no clawback" rule as orders/paid), paid (it was paid at some point and isn't cancelled) }.
   * Scopes: read_orders gives Shopify's last 60 days of orders; with read_all_orders granted it's every order. Up to
   * `pages` pages of 100, oldest first.
   */
  async customerOrders(customerId, { pages = 10 } = {}) {
    const orders = [];
    let createdAt = null;
    let after = null;
    for (let page = 0; page < pages; page += 1) {
      const data = await this.graphql(
        `query CustomerOrders($id: ID!, $after: String) { customer(id: $id) { id createdAt
          orders(first: 100, after: $after, sortKey: CREATED_AT) {
            nodes { id name createdAt processedAt sourceName cancelledAt displayFinancialStatus subtotalPriceSet { shopMoney { amount currencyCode } } }
            pageInfo { hasNextPage endCursor } } } }`,
        { id: `gid://shopify/Customer/${customerId}`, after },
      );
      const customer = data.customer;
      if (!customer) break;
      createdAt = Date.parse(customer.createdAt) || null;
      for (const o of customer.orders?.nodes || []) {
        const amount = Math.round(Number(o.subtotalPriceSet?.shopMoney?.amount || 0) * 100);
        orders.push({
          id: o.id, name: o.name || null, at: Date.parse(o.processedAt || o.createdAt) || null, source: o.sourceName || null,
          amount: Number.isFinite(amount) ? amount : 0,
          paid: !o.cancelledAt && ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.displayFinancialStatus),
        });
      }
      if (!customer.orders?.pageInfo?.hasNextPage) break;
      after = customer.orders.pageInfo.endCursor;
    }
    return { createdAt, orders };
  }

  /**
   * Who bought an order, for the session passes on it: the billing and shipping names, and the customer's name and
   * email. These are protected customer data: without Shopify's approval for names and emails this throws, and the
   * pass is made with what the Lair already knows.
   */
  async orderBuyer(orderId) {
    const data = await this.graphql(
      'query OrderBuyer($id: ID!) { order(id: $id) { id name billingAddress { name } shippingAddress { name } customer { id displayName defaultEmailAddress { emailAddress } } } }',
      { id: orderId },
    );
    const order = data.order;
    if (!order) return null;
    return {
      name: order.name || null,
      billingName: String(order.billingAddress?.name || '').trim(),
      shippingName: String(order.shippingAddress?.name || '').trim(),
      customerId: order.customer?.id ? String(order.customer.id).split('/').pop() : null,
      customerName: String(order.customer?.displayName || '').trim(),
      customerEmail: String(order.customer?.defaultEmailAddress?.emailAddress || '').trim(),
    };
  }

  /**
   * Who bought a session gift (round 6), to email them its codes: the order's email (or the customer's), and the buyer's
   * first name for the pass note. Protected customer data (name and email), like orderBuyer: without Shopify's approval
   * this throws, and staff get the codes instead. Returns { name, email, firstName } or null.
   */
  async orderGiftBuyer(orderId) {
    const data = await this.graphql(
      'query OrderGiftBuyer($id: ID!) { order(id: $id) { id name email billingAddress { firstName name } customer { id firstName displayName defaultEmailAddress { emailAddress } } } }',
      { id: orderId },
    );
    const order = data.order;
    if (!order) return null;
    // displayName falls back to the email when the customer has no name: that's never a first name.
    const fallback = String(order.customer?.displayName || order.billingAddress?.name || '').trim().split(/\s+/)[0] || '';
    const first = String(order.customer?.firstName || order.billingAddress?.firstName || '').trim() || (fallback.includes('@') ? '' : fallback);
    return {
      name: order.name || null,
      email: String(order.email || order.customer?.defaultEmailAddress?.emailAddress || '').trim(),
      firstName: first.slice(0, 40),
    };
  }

  /** The order a draft order turned into once it was paid (null while unpaid). */
  async draftOrderOrderId(id) {
    const data = await this.graphql('query DraftStatus($id: ID!) { draftOrder(id: $id) { id status order { id } } }', { id });
    return data.draftOrder?.order?.id || null;
  }

  /** Delete a draft order unless it has already been paid (completed). */
  async deleteDraftIfOpen(id) {
    const data = await this.graphql('query DraftOpen($id: ID!) { draftOrder(id: $id) { id status } }', { id });
    if (!data.draftOrder || data.draftOrder.status === 'COMPLETED') return false;
    await this.deleteDraftOrder(id);
    return true;
  }

  async deleteDraftOrder(id) {
    await this.graphql('mutation D($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }', { input: { id } });
  }

  async creditCustomer(customerId, cents, currency) {
    const data = await this.graphql(
      `mutation Credit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) { storeCreditAccountTransaction { amount { amount } } userErrors { field message code } }
      }`,
      { id: `gid://shopify/Customer/${customerId}`, creditInput: { creditAmount: { amount: (cents / 100).toFixed(2), currencyCode: currency }, notify: true } },
    );
    const result = data.storeCreditAccountCredit;
    if (result.userErrors.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
    return result.storeCreditAccountTransaction;
  }

  /**
   * A one-use discount code (dice prizes, birthday codes), valid until endsAt. percent: 0-1 off everything, or 1 off
   * the given variant only, with an optional minimum subtotal. customerId makes it that customer's own code.
   * combinesWith: { productDiscounts, orderDiscounts, shippingDiscounts }; all false means it works on its own only.
   */
  async createPrizeCode({ title, code, percent, variantId = null, minSubtotalCents = 0, endsAt, customerId = null, combinesWith = null }) {
    const data = await this.graphql(
      `mutation Prize($discount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $discount) { codeDiscountNode { id } userErrors { field message code } }
      }`,
      {
        discount: {
          title, code, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(endsAt).toISOString(),
          usageLimit: 1, appliesOncePerCustomer: true,
          context: customerId ? { customers: { add: [`gid://shopify/Customer/${customerId}`] } } : { all: 'ALL' },
          customerGets: {
            value: { percentage: percent },
            items: variantId ? { products: { productVariantsToAdd: [`gid://shopify/ProductVariant/${variantId}`] } } : { all: true },
          },
          ...(minSubtotalCents > 0 ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: (minSubtotalCents / 100).toFixed(2) } } } : {}),
          combinesWith: combinesWith || { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true },
        },
      },
    );
    const result = data.discountCodeBasicCreate;
    if (result.userErrors.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
    return result.codeDiscountNode.id;
  }

  /** Where Shopify currently sends orders/paid for this app */
  async webhookUris() {
    const data = await this.graphql('query Hooks { webhookSubscriptions(first: 25, topics: [ORDERS_PAID]) { nodes { id uri } } }');
    return data.webhookSubscriptions.nodes.map((n) => n.uri);
  }

  async registerWebhook(callbackUrl) {
    const data = await this.graphql(
      `mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
      }`,
      {
        topic: 'ORDERS_PAID',
        // Only the fields the Lair needs, so customer details don't pass through the Worker.
        sub: { uri: callbackUrl, format: 'JSON', includeFields: ['id', 'admin_graphql_api_id', 'source_name', 'note', 'note_attributes', 'line_items', 'tags'] },
      },
    );
    return data.webhookSubscriptionCreate;
  }
}

/** Optional emails through Resend (set RESEND_API_KEY and FROM_EMAIL; STAFF_EMAIL gets staff alerts). */
export const emailReady = (env) => Boolean(env.RESEND_API_KEY && env.FROM_EMAIL);

/** One email as Resend wants it: an HTML version and a plain-text copy. */
const resendEmail = (env, { to, subject, text, html = null, replyTo = null }) => ({
  from: env.FROM_EMAIL, to: [to], subject, text, ...(html ? { html } : {}), ...(replyTo || env.REPLY_TO ? { reply_to: replyTo || env.REPLY_TO } : {}),
});

async function postToResend(env, path, body) {
  try {
    const response = await fetch(`https://api.resend.com/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true, attempted: true, status: response.status, message: 'Sent.' };
    const text = await response.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).message || message;
    } catch {
      // not JSON: keep the raw text
    }
    console.error('Lair: email failed', response.status, message);
    return { ok: false, attempted: true, status: response.status, message };
  } catch (error) {
    console.error('Lair: email failed', error);
    return { ok: false, attempted: true, status: 0, message: String(error.message || error).slice(0, 300) };
  }
}

/** Send one email through Resend. Never throws; returns { ok, attempted, status, message }. */
export async function sendEmail(env, message) {
  if (!emailReady(env) || !message?.to) return { ok: false, attempted: false, status: 0, message: 'Email is not set up.' };
  return postToResend(env, 'emails', resendEmail(env, message));
}

/**
 * Send several emails (players of a cancelled game, a GM's message) in one call to Resend's batch endpoint, up to
 * 100 at a time, so a big send doesn't trip Resend's limit of a couple of requests a second. Never throws; returns
 * { ok, attempted, status, message, sent }.
 */
export async function sendEmails(env, messages) {
  const todo = (messages || []).filter((m) => m?.to);
  if (!emailReady(env)) return { ok: false, attempted: false, status: 0, message: 'Email is not set up.', sent: 0 };
  if (!todo.length) return { ok: true, attempted: false, status: 0, message: 'Nobody to email.', sent: 0 };
  if (todo.length === 1) {
    const result = await sendEmail(env, todo[0]);
    return { ...result, sent: result.ok ? 1 : 0 };
  }
  let sent = 0;
  let last = null;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const result = await postToResend(env, 'emails/batch', chunk.map((m) => resendEmail(env, m)));
    if (result.ok) sent += chunk.length;
    else last = result;
  }
  return last ? { ...last, sent } : { ok: true, attempted: true, status: 200, message: 'Sent.', sent };
}
