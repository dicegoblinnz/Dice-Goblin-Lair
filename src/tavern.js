// Round 34a and 34b: the Tavern's orders (contract v34-tavern).
//
// A member at a table scans its QR card, picks drinks and orders. The Lair checks the table's code, opening hours and
// every option, prices the order from its own menu (src/tavern-menu.js) and puts it on today's tab as locked lines: the
// member can't take them off, staff can until the drink is made. Each drink then sits on the staff's list with its
// recipe card until someone taps Done.
//
// Drinks are counter-only Shopify products (SKUs TAVERN-…), so the tab's lines are real variants the till can sell. A
// drink whose product is missing, or priced differently from the menu, can't be ordered: nobody is charged a price the
// menu didn't show.
//
// These are Lair methods (lair.js copies them onto Lair.prototype). The same rule holds: every await first, then one
// synchronous read-check-write.
import { LairTime, RuleError, makeId, tableIndex, windowAt } from './core.js';
import { tavernMenuView, tavernPrice, tavernRecipe } from './tavern-menu.js';

const TZ = 'Pacific/Auckland';
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** Shopify's Tavern products are asked for at most this often */
const VARIANTS_TTL = 5 * 60_000;
/** A table's code: 8 letters and numbers nobody mixes up (no I, O, 0 or 1) */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
/** The staff's list holds an order this long: one nobody ever made mustn't ring the next day (a night past midnight still fits) */
const QUEUE_KEEPS = 12 * 60 * 60_000;

export const TAVERN_WORDS = {
  login: 'Log in to order, so your drinks go on your tab.',
  staffLogin: 'Log in with your staff account.',
  team: "The drinks list is for the Lair's team.",
  table: "Scan the code on your table's card again: that one didn't match a table.",
  closed: "The Tavern's closed right now. Order when the Lair's open.",
  notReady: "The Tavern can't take that order from here right now. Order at the counter and we'll sort you out.",
  atCounter: 'Your tab is at the counter already. Pay for that one, then order again.',
  gone: "That drink isn't on the list any more.",
  madeAlready: "That one's made already, so it stays on their tab. Take it off at the till if it shouldn't be there.",
  cancelled: "That one was cancelled, so there's nothing to make.",
  cancelAtCounter: 'Their tab is at the counter already, so take that drink off at the till.',
  cancelPaid: "Their tab is paid already. Refund that drink at the till if it wasn't made.",
};
const W = TAVERN_WORDS;

export const TAVERN_ORDER_TABLES = [
  'CREATE TABLE IF NOT EXISTS tavern_tables (table_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, made_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tavern_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS tavern_orders (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT, table_id TEXT NOT NULL, day TEXT NOT NULL, total INTEGER NOT NULL,
    tab_id TEXT, at INTEGER NOT NULL, on_it_by TEXT, on_it_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS tavern_orders_day ON tavern_orders (day, at)',
  'CREATE INDEX IF NOT EXISTS tavern_orders_customer ON tavern_orders (customer_id, day)',
  `CREATE TABLE IF NOT EXISTS tavern_drinks (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, n INTEGER NOT NULL, line TEXT NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL,
    done_at INTEGER, done_by TEXT, cancelled_at INTEGER, cancelled_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS tavern_drinks_order ON tavern_drinks (order_id, n)',
  'CREATE INDEX IF NOT EXISTS tavern_drinks_status ON tavern_drinks (status)',
];

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

export const tavernMethods = {
  /** The drinks list is for anyone the staff page lets in: the owner or a helper, whatever their permissions */
  tavernGate(who) {
    if (!who?.customerId) throw new RuleError(W.staffLogin, 401);
    if (!who.staff) throw new RuleError(W.team, 403);
  },

  tavernDay(rules, now) {
    return new LairTime(rules?.tz || TZ).key(now);
  },

  /** Ordering is open inside the day's opening hours (a night that runs past midnight counts until it closes) */
  tavernOpen(rules, now) {
    const win = windowAt(rules, new LairTime(rules.tz || TZ), now);
    return Boolean(win && now >= win.open && now < win.close);
  },

  /** The Rush sign is out today: only the quick drinks. It comes in by itself when the day changes. No awaits. */
  tavernRush(rules, now) {
    const row = this.sql.exec("SELECT value FROM tavern_state WHERE key = 'rush'").toArray()[0];
    return Boolean(row && row.value === this.tavernDay(rules, now));
  },

  /** A table as pages show it, or null when the floor has no such table */
  tavernTableView(id, rules) {
    const t = tableIndex(rules.rooms).get(id);
    return t ? { id: t.id, room: t.roomObj?.name || '' } : null;
  },

  /** The table a QR card's code belongs to, or null. No awaits. */
  tavernTableByCode(code, rules) {
    const text = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,16}$/.test(text)) return null;
    const row = this.sql.exec('SELECT table_id FROM tavern_tables WHERE code = ?', text).toArray()[0];
    return row ? this.tavernTableView(row.table_id, rules) : null;
  },

  /**
   * Shopify's Tavern variants by SKU (kept 5 minutes), or null when Shopify can't answer. Awaits Shopify: call it
   * before a handler's no-await part.
   */
  async tavernVariants(skus) {
    const now = Date.now();
    const kept = this.tavernVariantCache;
    if (kept && now - kept.at < VARIANTS_TTL && skus.every((s) => kept.map.has(s))) return kept.map;
    try {
      const map = await this.shopify.tavernVariants(skus);
      this.tavernVariantCache = { at: now, map };
      return map;
    } catch (error) {
      console.error('Lair: Shopify could not find the Tavern products', error);
      return null;
    }
  },

  /** An order as its member sees it (no recipes). No awaits. */
  tavernOrderView(order, { staff = false, now = Date.now() } = {}) {
    const drinks = this.sql.exec('SELECT * FROM tavern_drinks WHERE order_id = ? ORDER BY n', order.id).toArray().map((d) => {
      const line = parse(d.line, {});
      return {
        id: d.id, item: line.item, no: line.no ?? null, name: line.name, fantasy: line.fantasy || null, words: line.words || '',
        price: d.price, status: d.status, caffeine: Boolean(line.caffeine),
        ...(staff ? { recipe: tavernRecipe(line) } : {}),
      };
    });
    return {
      id: order.id, table: order.table_id, at: order.at, total: drinks.filter((d) => d.status !== 'cancelled').reduce((sum, d) => sum + d.price, 0), drinks,
      ...(staff ? { name: order.name || 'Member', waited: Math.max(0, now - order.at), onIt: order.on_it_at ? { by: order.on_it_by || null, at: order.on_it_at } : null } : {}),
    };
  },

  /** GET /tavern/menu[?t=code] (anyone): the menu, whether ordering is open, the Rush sign, and the code's table */
  async tavernMenu(url) {
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    return {
      ...tavernMenuView(), open: this.tavernOpen(rules, now), rush: this.tavernRush(rules, now),
      table: this.tavernTableByCode(url.searchParams.get('t'), rules),
    };
  },

  /**
   * POST /tavern/orders { table, lines } (logged in): the drinks go on today's tab, locked, and onto the staff's list.
   * Returns { order }.
   */
  async tavernOrder(body, who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    const rules = await this.rules();
    const table = this.tavernTableByCode(body?.table, rules);
    if (!table) throw new RuleError(W.table);
    const rush = this.tavernRush(rules, Date.now());
    const { lines } = tavernPrice(body?.lines, { rush });
    if (!this.tavernOpen(rules, Date.now())) throw new RuleError(W.closed, 409);
    const variants = await this.tavernVariants([...new Set(lines.flatMap((l) => l.parts.map((p) => p.sku)))]);
    if (!variants) throw new RuleError(W.notReady, 503);
    for (const line of lines) {
      for (const part of line.parts) {
        const v = variants.get(part.sku);
        // the till charges Shopify's price, so it must be the menu's
        if (!v || !v.sellable || v.price !== part.price || !/^\d{1,20}$/.test(String(v.variantId))) {
          console.error(`Lair: the Tavern product ${part.sku} is missing or out of step with the menu`);
          throw new RuleError(W.notReady, 503);
        }
        part.variantId = String(v.variantId);
      }
    }
    // --- no awaits from here on ---
    const now = Date.now();
    if (!this.tavernOpen(rules, now)) throw new RuleError(W.closed, 409);
    const parts = lines.flatMap((l) => l.parts);
    const tabId = this.tavernTabAdd(who.customerId, parts, rules, now);
    const id = makeId('tv');
    const member = this.memberRow(who.customerId);
    const name = String(member?.first_name || member?.name || '').split(/\s+/)[0].slice(0, 40) || null;
    this.write(
      'INSERT INTO tavern_orders (id, customer_id, name, table_id, day, total, tab_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, String(who.customerId), name, table.id, this.tavernDay(rules, now), lines.reduce((sum, l) => sum + l.price, 0), tabId, now,
    );
    lines.forEach((line, n) => {
      this.write(
        "INSERT INTO tavern_drinks (id, order_id, n, line, price, status) VALUES (?, ?, ?, ?, ?, 'waiting')",
        makeId('td'), id, n, JSON.stringify(line), line.price,
      );
    });
    return { order: this.tavernOrderView(this.tavernOrderRow(id)) };
  },

  tavernOrderRow(id) {
    return this.sql.exec('SELECT * FROM tavern_orders WHERE id = ?', String(id)).toArray()[0] || null;
  },

  /**
   * An order's parts onto today's tab as locked lines ({ variantId, title, variantTitle, price, qty, locked: true }),
   * the same variant counted up on one line. Returns the tab's id. No awaits.
   */
  tavernTabAdd(customerId, parts, rules, now) {
    const current = this.todayTabRow(customerId, rules, now);
    const open = current && current.status !== 'paid' ? current : null;
    if (open?.status === 'in-cart') throw new RuleError(W.atCounter, 409);
    const items = open ? parse(open.items, []) : [];
    let added = 0;
    for (const part of parts) {
      const line = items.find((x) => x.locked && x.variantId === part.variantId);
      if (line) line.qty += 1;
      else items.push({ variantId: part.variantId, title: part.title, variantTitle: 'Default Title', price: part.price, qty: 1, locked: true });
      added += part.price;
    }
    const total = items.reduce((sum, x) => sum + x.price * x.qty, 0);
    // on a monthly account, drinks can't take it over its credit limit (as for anything else on a tab)
    this.checkAccountLimit(customerId, added, rules, now, 'tab');
    let id = open?.id;
    if (open) {
      this.write("UPDATE tabs SET items = ?, total = ?, updated_at = ? WHERE id = ? AND status = 'open'", JSON.stringify(items), total, now, id);
      this.reconcileBills(rules, now);
    } else {
      id = makeId('tb');
      this.write(
        "INSERT INTO tabs (id, customer_id, day, items, total, status, order_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)",
        id, String(customerId), this.tavernDay(rules, now), JSON.stringify(items), total, now, now,
      );
    }
    this.touchMember(customerId, {}, now);
    return id;
  },

  /** A cancelled drink's parts off its tab, which must still be open. No awaits. */
  tavernTabRemove(order, parts, rules, now) {
    const tab = order.tab_id ? this.sql.exec('SELECT * FROM tabs WHERE id = ?', order.tab_id).toArray()[0] : null;
    if (!tab) return;
    if (tab.status === 'paid') throw new RuleError(W.cancelPaid, 409);
    if (tab.status !== 'open') throw new RuleError(W.cancelAtCounter, 409);
    const items = parse(tab.items, []);
    for (const part of parts) {
      const line = items.find((x) => x.locked && x.variantId === part.variantId);
      if (line) line.qty -= 1;
    }
    const left = items.filter((x) => x.qty > 0);
    if (left.length) {
      this.write("UPDATE tabs SET items = ?, total = ?, updated_at = ? WHERE id = ? AND status = 'open'", JSON.stringify(left), left.reduce((sum, x) => sum + x.price * x.qty, 0), now, tab.id);
    } else {
      this.write("DELETE FROM tabs WHERE id = ? AND status = 'open'", tab.id);
    }
    this.reconcileBills(rules, now);
  },

  /** GET /tavern/mine (logged in): today's orders, newest first, and where each drink is */
  async tavernMine(who) {
    if (!who?.customerId) throw new RuleError(W.login, 401);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const orders = this.sql
      .exec('SELECT * FROM tavern_orders WHERE customer_id = ? AND day = ? ORDER BY at DESC, rowid DESC', String(who.customerId), this.tavernDay(rules, now))
      .toArray();
    return { orders: orders.map((o) => this.tavernOrderView(o)) };
  },

  /**
   * GET /tavern/queue (staff): the orders with a drink still to make, oldest first, each drink with its recipe card.
   * ringing: how many of them nobody has tapped On it for (the pages and phones ring while it's above 0).
   */
  async tavernQueue(who) {
    this.tavernGate(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT o.* FROM tavern_orders o WHERE o.at > ? AND EXISTS (SELECT 1 FROM tavern_drinks d WHERE d.order_id = o.id AND d.status IN ('waiting', 'making'))
         ORDER BY o.at, o.rowid LIMIT 60`,
        now - QUEUE_KEEPS,
      )
      .toArray();
    const orders = rows.map((o) => {
      const view = this.tavernOrderView(o, { staff: true, now });
      const started = view.drinks.some((d) => d.status === 'done' || d.status === 'making');
      return { ...view, drinks: view.drinks.filter((d) => ['waiting', 'making'].includes(d.status)), ringing: !o.on_it_at && !started };
    });
    return { now, rush: this.tavernRush(rules, now), ringing: orders.filter((o) => o.ringing).length, orders };
  },

  tavernStaffName(who) {
    const member = this.memberRow(who?.customerId);
    return String(member?.first_name || member?.name || '').split(/\s+/)[0].slice(0, 40) || null;
  },

  /** POST /tavern/orders/:id/on-it (staff): someone's making it, so the ring stops and its drinks show as being made */
  tavernOnIt(id, who) {
    this.tavernGate(who);
    // --- no awaits ---
    const order = this.tavernOrderRow(id);
    if (!order) throw new RuleError(W.gone, 404);
    const now = Date.now();
    if (!order.on_it_at) this.write('UPDATE tavern_orders SET on_it_by = ?, on_it_at = ? WHERE id = ? AND on_it_at IS NULL', this.tavernStaffName(who), now, order.id);
    this.write("UPDATE tavern_drinks SET status = 'making' WHERE order_id = ? AND status = 'waiting'", order.id);
    return { order: this.tavernOrderView(this.tavernOrderRow(order.id), { staff: true, now }) };
  },

  tavernDrinkRow(id) {
    return this.sql.exec('SELECT * FROM tavern_drinks WHERE id = ?', String(id)).toArray()[0] || null;
  },

  /** POST /tavern/drinks/:id/done (staff): it's made (and on its way). Done twice is fine. */
  tavernDone(id, who) {
    this.tavernGate(who);
    // --- no awaits ---
    const drink = this.tavernDrinkRow(id);
    if (!drink) throw new RuleError(W.gone, 404);
    if (drink.status === 'cancelled') throw new RuleError(W.cancelled, 409);
    const now = Date.now();
    if (drink.status !== 'done') {
      this.write("UPDATE tavern_drinks SET status = 'done', done_at = ?, done_by = ? WHERE id = ? AND status IN ('waiting', 'making')", now, this.tavernStaffName(who), drink.id);
    }
    return { order: this.tavernOrderView(this.tavernOrderRow(drink.order_id), { staff: true, now }) };
  },

  /** POST /tavern/drinks/:id/cancel (staff): a drink not made yet comes off the list and off the member's tab */
  async tavernCancel(id, who) {
    this.tavernGate(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const drink = this.tavernDrinkRow(id);
    if (!drink) throw new RuleError(W.gone, 404);
    if (drink.status === 'done') throw new RuleError(W.madeAlready, 409);
    const now = Date.now();
    const order = this.tavernOrderRow(drink.order_id);
    if (drink.status !== 'cancelled') {
      this.tavernTabRemove(order, parse(drink.line, {}).parts || [], rules, now);
      this.write(
        "UPDATE tavern_drinks SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status IN ('waiting', 'making')",
        now, this.tavernStaffName(who), drink.id,
      );
    }
    return { order: this.tavernOrderView(order, { staff: true, now }) };
  },

  /** POST /tavern/rush { on } (staff): the Rush sign out, or back in */
  async tavernSetRush(body, who) {
    this.tavernGate(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const on = body?.on === true || body?.on === 'true' || body?.on === 1;
    if (on) this.write("INSERT INTO tavern_state (key, value) VALUES ('rush', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", this.tavernDay(rules, now));
    else this.write("DELETE FROM tavern_state WHERE key = 'rush'");
    return { rush: this.tavernRush(rules, now) };
  },

  /** GET /tavern/tables (staff): every table on the floor with its code, for the QR cards. A table gets its code once. */
  async tavernTables(who) {
    this.tavernGate(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const have = new Map(this.sql.exec('SELECT table_id, code FROM tavern_tables').toArray().map((r) => [r.table_id, r.code]));
    const taken = new Set(have.values());
    const tables = [];
    for (const [id, t] of tableIndex(rules.rooms)) {
      let code = have.get(id);
      if (!code) {
        do code = newCode();
        while (taken.has(code));
        taken.add(code);
        this.write('INSERT INTO tavern_tables (table_id, code, made_at) VALUES (?, ?, ?)', id, code, now);
      }
      tables.push({ id, room: t.roomObj?.name || '', code });
    }
    return { tables };
  },
};
