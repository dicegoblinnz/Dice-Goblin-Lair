/* Dice Goblin — My Lair (sections/my-lair.liquid)
   <my-lair>: the logged-in customer's corner, from the Lair app (GET /me, see lair-core.js). From the top:
   - The Goblin card: their member code (like SJ-OWLBEAR-17) as a QR code, drawn by qr.js. Staff scan it at the
     counter to check them in, ring up their tab and count their spend towards rolls.
   - The self-serve tab: a small menu (the section's "Tab menu" products, written out as JSON by Liquid) with
     quantity steppers, a scanner for barcodes and QR codes (lair-scan.js), and a bar to add them to today's tab
     (POST /tab, which replaces the tab's items). Then the tab and where it's up to: open (show your code at the
     counter to pay), at the counter, or paid. An open tab can be edited, or cleared (POST /tab/clear).
   - Dice: one roll for every $20 spent (POST /roll { kind: 'spend' }). Each 1 on the face pays $1 store credit, 11
     pays $2 and a natural 20 pays $20. The last 10 prizes show whether they're added or waiting at the counter.
   - Session passes, claiming one with its code (POST /me/passes/claim), and the birthday (POST /me/profile).
   - Tables, GM seats and event sign-ups as tickets with a QR code of their code: paid at the counter (or online for
     some events), with the pass saved for check-in, what it covered, a split bill and refunds. Then the games they run.
   Gobgob's 20 quotes come up at random in the header. Orders, store credit and the library membership are drawn in Liquid.
   Needs lair-core.js (window.Lair), qr.js (window.DGQR) and lair-scan.js (window.LairScan) before it. */
(() => {
  'use strict';
  const { store, esc, money, plural, icsFile, codeKey, HOUR } = window.Lair;
  const t = store.time;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const shop = () => window.DiceGoblin || null;
  const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const smooth = () => (reduceMotion.matches ? 'auto' : 'smooth');
  const QUOTE_EVERY = 7000; // a new quote every 7 seconds
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 29 February is a birthday too
  const ACTIVE = new Set(['held', 'confirmed', 'seated']);
  const GAME_STATUS = {
    pending: ['Waiting for approval', 'badge--gold'],
    open: ['Open', 'badge--new'],
    full: ['Full', 'badge--ruby'],
    cancelled: ['Cancelled', 'badge--muted'],
  };
  const SCHEDULE = { weekly: 'Every week', fortnightly: 'Every two weeks', flexible: 'You set the dates', 'one-shot': 'One-shot' };
  const ACCENT = { 'D&D 5e': 'ruby', 'Pathfinder 2e': 'gold', Daggerheart: 'potion', 'Call of Cthulhu': 'mana' };

  /* the Lair app's words, so the page and the app say the same thing */
  const PAY_AT_COUNTER = "Pay at the counter when you arrive. Show your code and we'll ring it up.";
  const SPLIT_NOTE = 'Splitting the bill? Each friend can pay their share at the counter.';
  const REFUND = { ask: 'Have a chat with us about a refund', due: 'Refund on its way', done: 'Refunded' };
  const UNKNOWN_CODE = "Gobgob doesn't know that one. Pick it from the menu instead.";
  const NO_ROLLS = 'No rolls yet, friend. Every $20 you spend earns one.';
  const PER_ROLL = 2000;
  const PASS_STATUS = {
    active: ['Active', 'badge--new'],
    used: ['All used', 'badge--muted'],
    expired: ['Expired', 'badge--muted'],
    void: ['Cancelled', 'badge--muted'],
  };

  /* the self-serve tab: what the scanner reads, and the Lair app's limits */
  const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
  const MAX_EACH = 20;
  const MAX_LINES = 30;
  const TAB_LOOK = {
    open: ['Open tab', 'badge--gold'],
    'in-cart': ['At the counter', 'badge--potion'],
    paid: ['Paid', 'badge--new'],
  };

  /* ---------- words for times and tables ---------- */
  const longDay = (ms) => t.fmtLong(t.key(ms)).replace(',', '');
  const dayLabel = (ms) => {
    const rel = t.relativeDay(t.key(ms));
    return rel === 'Today' || rel === 'Tomorrow' ? `${rel}, ${longDay(ms)}` : longDay(ms);
  };
  const shortDay = (ms) => t.fmtDate(t.key(ms)).replace(',', '');
  const span = (start, end) => `${t.fmtTime(start)} to ${t.fmtTime(end)}`;
  const endOf = (item) => Number(item.end) || Number(item.start) + 3 * HOUR;
  const isUpcoming = (item) => endOf(item) > Date.now() && ACTIVE.has(item.status || 'confirmed');
  const byStart = (a, b) => a.start - b.start;
  const tablesText = (ids) => {
    if (!Array.isArray(ids) || !ids.length) return '';
    const names = ids.map((id) => {
      const table = store.table(id);
      const room = table ? store.room(table.room) : null;
      return room ? `${room.code}${table.label}` : id;
    });
    const room = store.roomOf(ids[0]);
    return `${names.join(', ')}${room ? ` (${room.name})` : ''}`;
  };
  const pastLabel = (item) => {
    if (item.status === 'cancelled') return ['Cancelled', 'badge--muted'];
    if (item.status === 'noshow') return ['Missed', 'badge--muted'];
    if (item.status === 'held') return ['Not paid', 'badge--muted'];
    return ['Done', ''];
  };

  /* ---------- codes and products ---------- */
  /** Same barcode? Digits ignore leading zeros (a UPC-A read as EAN-13 gains one); anything else ignores case */
  const sameCode = (a, b) => {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y) return false;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return x.replace(/^0+/, '') === y.replace(/^0+/, '');
    return x.toUpperCase() === y.toUpperCase();
  };
  /** A product link in a QR code (https://…/products/poweraid?variant=…, or just /products/poweraid): its handle and variant */
  const productLink = (code) => {
    const text = String(code || '').trim();
    if (!/\/products\/[^\s/?#]+/i.test(text)) return null;
    try {
      const url = new URL(text, window.location.origin);
      const match = url.pathname.match(/\/products\/([^/?#]+)/i);
      if (!match) return null;
      return { handle: decodeURIComponent(match[1]).toLowerCase(), variant: url.searchParams.get('variant') || '' };
    } catch {
      return null;
    }
  };
  /** A Shopify CDN picture at a small size (protocol-relative links get https) */
  const smallImage = (src) => {
    if (!src) return null;
    const url = String(src).startsWith('//') ? `https:${src}` : String(src);
    return `${url}${url.includes('?') ? '&' : '?'}width=160`;
  };
  /** One product the tab can take: from the Liquid menu, or from /products/<handle>.js after a scan */
  const tidyProduct = (p) => ({
    id: String(p.id || p.handle || ''),
    handle: String(p.handle || ''),
    title: String(p.title || ''),
    image: p.image || null,
    variants: (Array.isArray(p.variants) ? p.variants : [])
      .map((v) => ({
        id: String(v.id || ''),
        title: String(v.title || ''),
        price: Math.max(0, Math.round(Number(v.price) || 0)),
        barcode: String(v.barcode || ''),
        sku: String(v.sku || ''),
        available: v.available !== false,
      }))
      .filter((v) => /^\d{1,20}$/.test(v.id)),
  });
  /** What a variant is called on the tab: its own title, or the product's when it's the only one */
  const variantName = (product, variant) => (!variant.title || /^default title$/i.test(variant.title) ? product.title : variant.title);

  class MyLair extends HTMLElement {
    connectedCallback() {
      this.refundHours = Number(this.dataset.refundHours) || store.cfg.refundHours || 24;
      this.items = new Map();
      this.result = null; // the latest roll on this visit
      this.prizes = [];
      this.draft = new Map(); // variant id → { product, variant, qty }: picked, not on the tab yet
      this.extra = []; // products found by scanning that aren't on the menu
      this.tab = null;
      this.editing = null; // variant id → qty while an open tab is being edited
      this.catalogue = this.readCatalogue();
      this.dialog = this.querySelector('[data-cancel-dialog]');
      this.qrDialog = this.querySelector('[data-qr-dialog]');
      this.addEventListener('click', (event) => this.onClick(event));
      this.addEventListener('submit', (event) => this.onSubmit(event));
      this.querySelector('[data-birthday]')?.addEventListener('change', (event) => {
        event.currentTarget.dataset.touched = '1';
      });
      // Back on the page after paying at the counter: show where the tab's up to
      this.onVisible = () => {
        if (!document.hidden && this.tab) this.refreshTab();
      };
      document.addEventListener('visibilitychange', this.onVisible);
      this.renderMenu();
      this.startQuotes();
      this.loading = this.load();
    }

    disconnectedCallback() {
      window.clearTimeout(this.quoteTimer);
      window.clearTimeout(this.fadeTimer);
      window.clearTimeout(this.tabTimer);
      document.removeEventListener('visibilitychange', this.onVisible);
    }

    panel(name) {
      return this.querySelector(`[data-panel="${name}"]`);
    }

    empty(name) {
      const template = this.querySelector(`template[data-empty="${name}"]`);
      return template ? template.innerHTML : '';
    }

    icon(name) {
      const template = this.querySelector(`template[data-icon="${name}"]`);
      return template ? template.innerHTML.trim() : '';
    }

    count(name, n) {
      const el = this.querySelector(`[data-count="${name}"]`);
      if (el) el.textContent = n ? String(n) : '';
    }

    /** A QR code with each module a whole number of CSS pixels, about `target` px across, so it scans crisply */
    qr(text, target, label) {
      if (!text || !window.DGQR || typeof window.DGQR.svg !== 'function') return '';
      const svg = window.DGQR.svg(String(text), { size: target, label: label || String(text) });
      const modules = Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1]) || 0;
      if (!modules) return svg;
      const size = modules * Math.max(3, Math.floor(target / modules));
      return svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    }

    async load() {
      const error = this.querySelector('[data-error]');
      try {
        if (typeof store.backend.me !== 'function') throw new Error('My Lair needs a newer lair-core.js.');
        this.data = (await store.backend.me()) || {};
        if (error) error.hidden = true;
        this.render();
        // Game tables at events say which event once the calendar has loaded
        if ((this.data.bookings || []).some((b) => b.occurrenceId) && store.ready) {
          store.ready.then(() => this.renderBookings(this.data.bookings || [])).catch(() => {});
        }
      } catch (err) {
        this.fail(err);
      }
    }

    fail(err) {
      const box = this.querySelector('[data-error]');
      const login = store.cfg.pages.login || '/account/login';
      if (box) {
        box.innerHTML = err.status === 401
          ? `The Lair didn't recognise you, so your card, tab and bookings can't show. <a class="text-link" href="${esc(login)}">Log in again</a>`
          : 'Gobgob couldn\'t reach the Lair just now, so your card, tab and bookings can\'t show. They\'re safe, friend. <button class="text-link ml-retry" type="button" data-retry>Try again</button>';
        box.hidden = false;
      }
      for (const name of ['bookings', 'seats', 'joins', 'games']) {
        const panel = this.panel(name);
        if (!panel) continue;
        panel.removeAttribute('aria-busy');
        panel.innerHTML = '<p class="ml-loading ml-loading--failed">Not loaded</p>';
      }
      const card = this.querySelector('[data-card-qr]');
      if (card && !card.dataset.drawn) card.innerHTML = '<span class="ml-gcard__wait">Your code didn\'t load. Try again in a moment, or give us your name at the counter.</span>';
      const ready = this.querySelector('[data-rolls-ready]');
      if (ready) ready.textContent = 'Rolls ready: Gobgob can\'t check right now';
      const slots = this.querySelector('[data-roll-slots]');
      if (slots) slots.innerHTML = '<p class="ml-loading ml-loading--failed">Not loaded</p>';
      const passes = this.querySelector('[data-passes]');
      if (passes) passes.innerHTML = '<p class="ml-loading ml-loading--failed">Not loaded</p>';
    }

    render() {
      const data = this.data || {};
      this.member = data.member || null;
      this.tab = data.tab || null;
      this.editing = null;
      this.renderCard();
      this.renderTab();
      this.renderDice();
      this.renderPasses();
      this.renderGifts();
      this.fillBirthday(this.member);
      this.items.clear();
      this.renderBookings(data.bookings || []);
      this.renderSeats(data.seats || []);
      this.renderJoins(data.joins || []);
      this.renderGames(data);
      for (const panel of this.querySelectorAll('[data-panel]')) panel.removeAttribute('aria-busy');
    }

    /* ---------- the Goblin card ---------- */
    /** Their member code as a big QR. A tap shows it bigger still. */
    renderCard() {
      const box = this.querySelector('[data-card-qr]');
      const label = this.querySelector('[data-card-code]');
      if (!box) return;
      const code = this.member && this.member.code ? String(this.member.code) : '';
      if (!code) {
        box.innerHTML = '<span class="ml-gcard__wait">Your code is on its way. Give us your name at the counter for now.</span>';
        delete box.dataset.drawn;
        if (label) label.textContent = '';
        return;
      }
      if (label) label.textContent = code;
      if (box.dataset.drawn === code) return;
      const svg = this.qr(code, 208, `Goblin card ${code}`);
      box.innerHTML = svg
        ? `<button class="ml-gcard__show" type="button" data-qr-show="${esc(code)}" data-qr-kind="card" aria-label="Show my code ${esc(code)} bigger">${svg}</button>`
        : '';
      box.dataset.drawn = code;
    }

    /* ---------- the self-serve tab ---------- */
    readCatalogue() {
      const script = this.querySelector('[data-tab-catalogue]');
      let list = [];
      try {
        list = JSON.parse(script ? script.textContent : '[]');
      } catch {
        list = [];
      }
      return (Array.isArray(list) ? list : []).map(tidyProduct).filter((p) => p.variants.length);
    }

    products() {
      return [...this.extra, ...this.catalogue];
    }

    findVariant(id) {
      for (const product of this.products()) {
        const variant = product.variants.find((v) => v.id === String(id));
        if (variant) return { product, variant };
      }
      return null;
    }

    /** How many of a variant are on the open tab already */
    onTab(id) {
      if (!this.tab || this.tab.status !== 'open') return 0;
      const line = (this.tab.items || []).find((x) => String(x.variantId) === String(id));
      return line ? Number(line.qty) || 0 : 0;
    }

    renderMenu() {
      const box = this.querySelector('[data-tab-menu]');
      if (!box) return;
      const products = this.products();
      if (!products.length) {
        box.innerHTML = '<p class="ml-menu__none">The menu is empty right now. Scan the item\'s barcode instead, or ask us at the counter.</p>';
        return;
      }
      // Two columns' worth of room: every product starts open. On a phone each opens with a tap, so the menu stays
      // short. They stay as they were left when the menu redraws.
      if (!this.menuOpen) {
        const wide = (this.querySelector('.ml-tab')?.clientWidth || 0) >= 544;
        this.menuOpen = new Set(wide ? products.map((p) => p.id) : []);
      }
      box.innerHTML = `<ul class="ml-menu__groups" role="list">${products.map((p) => this.menuGroup(p)).join('')}</ul>`;
      this.syncMenu();
    }

    /** Open or close one product's list */
    toggleGroup(id, open = !this.menuOpen.has(id)) {
      const group = this.querySelector(`.ml-menu__group[data-product="${CSS.escape(id)}"]`);
      if (!group) return;
      if (open) this.menuOpen.add(id);
      else this.menuOpen.delete(id);
      group.classList.toggle('is-open', open);
      group.querySelector('[data-menu-toggle]').setAttribute('aria-expanded', String(open));
      group.querySelector('.ml-menu__list').hidden = !open;
    }

    menuGroup(product) {
      const scanned = this.extra.includes(product);
      const art = product.image
        ? `<img class="ml-menu__img" src="${esc(product.image)}" alt="" width="48" height="48" loading="lazy">`
        : `<span class="ml-menu__img ml-menu__img--none" aria-hidden="true">${this.icon('pouch')}</span>`;
      const rows = product.variants
        .map((v) => {
          const name = variantName(product, v);
          const price = name.includes(money(v.price)) ? '' : `<span class="ml-menu__price">${esc(money(v.price))}</span>`;
          return `<li class="ml-menu__item" data-variant="${esc(v.id)}" data-qty="0">
            <span class="ml-menu__name">${esc(name)}${price}${v.available ? '' : '<span class="ml-menu__out">Sold out</span>'}</span>
            ${this.qtyControl('menu', v.id, name)}
          </li>`;
        })
        .join('');
      const open = this.menuOpen.has(product.id);
      const prices = product.variants.map((v) => v.price);
      const low = Math.min(...prices);
      const from = prices.every((x) => x === low) ? money(low) : `from ${money(low)}`;
      const list = `ml-menu-${product.id}`;
      return `<li class="ml-menu__group${scanned ? ' ml-menu__group--scanned' : ''}${open ? ' is-open' : ''}" data-product="${esc(product.id)}">
        <h4 class="ml-menu__heading">
          <button class="ml-menu__head" type="button" aria-expanded="${open}" aria-controls="${esc(list)}" data-menu-toggle="${esc(product.id)}">
            ${art}
            <span class="ml-menu__title">${esc(product.title)}${scanned ? ' <span class="badge badge--gold">Scanned</span>' : ''}</span>
            <span class="ml-menu__from">${esc(from)}</span>
            <span class="ml-menu__picked" data-picked></span>
            <span class="ml-menu__chev" aria-hidden="true"></span>
          </button>
        </h4>
        <ul class="ml-menu__list" id="${esc(list)}" role="list"${open ? '' : ' hidden'}>${rows}</ul>
      </li>`;
    }

    /** − 2 + for one thing. At 0 only the + shows (Add). scope: 'menu' (this round) or 'edit' (changing the tab). */
    qtyControl(scope, id, name) {
      return `<div class="ml-qty" data-qty-box="${scope}" data-id="${esc(id)}" data-name="${esc(name)}" role="group" aria-label="${esc(name)}">
        <button class="ml-qty__btn ml-qty__btn--less" type="button" data-step="-1" aria-label="One less ${esc(name)}">${this.icon('minus')}</button>
        <span class="ml-qty__value" data-qty-value>0</span>
        <button class="ml-qty__btn ml-qty__btn--more" type="button" data-step="1" aria-label="Add ${esc(name)}">${this.icon('plus')}</button>
      </div>`;
    }

    /** Set a quantity control: the number, which buttons show, and whether there's room for one more */
    setQty(box, qty, max, available = true) {
      if (!box) return;
      const name = box.dataset.name || '';
      const value = box.querySelector('[data-qty-value]');
      const less = box.querySelector('[data-step="-1"]');
      const more = box.querySelector('[data-step="1"]');
      box.dataset.qty = String(qty);
      const row = box.parentElement && box.parentElement.closest('[data-qty]');
      if (row) row.dataset.qty = String(qty);
      value.textContent = String(qty);
      value.hidden = qty < 1;
      if (qty < 1 && less === document.activeElement) more.focus();
      less.hidden = qty < 1;
      more.disabled = !available || qty >= max;
      more.setAttribute('aria-label', qty ? `One more ${name}` : `Add ${name}`);
    }

    syncMenu() {
      const tabFull = this.lineCount() >= MAX_LINES;
      for (const row of this.querySelectorAll('.ml-menu__item[data-variant]')) {
        const id = row.dataset.variant;
        const found = this.findVariant(id);
        const picked = this.draft.get(id);
        const qty = picked ? picked.qty : 0;
        const room = MAX_EACH - this.onTab(id);
        // A new line on a full tab can't be added; more of something already on it can
        const max = tabFull && !qty && !this.onTab(id) ? 0 : room;
        this.setQty(row.querySelector('[data-qty-box]'), qty, max, found ? found.variant.available : true);
      }
      for (const group of this.querySelectorAll('.ml-menu__group[data-product]')) {
        const product = this.products().find((p) => p.id === group.dataset.product);
        const n = product ? product.variants.reduce((sum, v) => sum + ((this.draft.get(v.id) || {}).qty || 0), 0) : 0;
        const picked = group.querySelector('[data-picked]');
        if (picked) picked.innerHTML = n ? `${n}<span class="visually-hidden"> picked</span>` : '';
      }
      this.syncBar();
    }

    /** Different things the tab would hold after adding this round */
    lineCount() {
      const ids = new Set(this.tab && this.tab.status === 'open' ? (this.tab.items || []).map((x) => String(x.variantId)) : []);
      for (const id of this.draft.keys()) ids.add(id);
      return ids.size;
    }

    syncBar() {
      const bar = this.querySelector('[data-tab-bar]');
      if (!bar) return;
      let count = 0;
      let total = 0;
      for (const { variant, qty } of this.draft.values()) {
        count += qty;
        total += variant.price * qty;
      }
      const atCounter = Boolean(this.tab && this.tab.status === 'in-cart');
      // One change at a time: while the tab is being edited, this round waits
      bar.hidden = !count || atCounter || Boolean(this.editing);
      const label = this.querySelector('[data-tab-count]');
      const sum = this.querySelector('[data-tab-total]');
      if (label) label.textContent = `${plural(count, 'thing', 'things')} to add`;
      if (sum) sum.textContent = money(total);
    }

    /** Change this round's quantity of one thing. Returns false when there's no room for more. */
    step(id, delta) {
      const found = this.findVariant(id);
      if (!found) return false;
      const picked = this.draft.get(found.variant.id);
      const qty = (picked ? picked.qty : 0) + delta;
      if (delta > 0) {
        if (!found.variant.available) return false;
        if (qty + this.onTab(found.variant.id) > MAX_EACH) return false;
        if (!picked && !this.onTab(found.variant.id) && this.lineCount() >= MAX_LINES) return false;
      }
      if (qty < 1) this.draft.delete(found.variant.id);
      else this.draft.set(found.variant.id, { ...found, qty });
      this.tabError('');
      this.syncMenu();
      return true;
    }

    renderTab() {
      const status = this.tab ? this.tab.status : null;
      const add = this.querySelector('[data-tab-add]');
      const title = this.querySelector('[data-tab-add-title]');
      if (add) add.hidden = status === 'in-cart';
      if (title) title.textContent = status === 'open' ? 'Add more' : status === 'paid' ? 'Start a fresh tab' : 'Start a tab';
      const onIt = this.tab && status !== 'paid' ? (this.tab.items || []).reduce((sum, x) => sum + (Number(x.qty) || 0), 0) : 0;
      this.count('tab', onIt + this.dueItems().length);
      this.renderTabCard();
      this.syncMenu();
      this.queueTabCheck();
    }

    /** The rest of the bill at the counter (GET /me dueNow): today's sessions, then weekly sessions still owed from
        earlier days, each with what's left to pay. Today's come first; the oldest owed one is next. */
    dueItems() {
      const list = Array.isArray(this.data && this.data.dueNow) ? this.data.dueNow : [];
      const today = t.today();
      return list
        .filter((d) => d && Number.isFinite(Number(d.start)) && Number(d.due) > 0)
        .map((d) => ({ ...d, start: Number(d.start), due: Math.round(Number(d.due)), today: t.key(Number(d.start)) === today }))
        .sort((a, b) => (a.today === b.today ? a.start - b.start : a.today ? -1 : 1));
    }

    /** "Your session: Abomination Vaults, 5pm" or "Owed from Tue 29 Sept: Abomination Vaults", with what's left of it */
    dueLine(d) {
      const what = d.today
        ? `<span class="ml-tabline__kind">Your session:</span> ${esc(d.title || 'Your booking')}, ${esc(t.fmtTime(d.start))}`
        : `<span class="ml-tabline__kind">Owed from ${esc(shortDay(d.start))}:</span> ${esc(d.title || 'A weekly session')}`;
      const covered = Number(d.covered) || 0;
      const paid = Number(d.paidAmount) || 0;
      const sub = [covered ? `Your pass covered ${money(covered)}` : '', paid ? `${money(paid)} paid so far` : ''].filter(Boolean).join(' · ');
      return `<li class="ml-tabline ml-tabline--due${d.today ? '' : ' ml-tabline--owed'}">
          <span class="ml-tabline__name">${what}${sub ? `<span class="ml-tabline__from">${esc(sub)}</span>` : ''}</span>
          <span class="ml-tabline__price">${esc(money(d.due))}</span>
        </li>`;
    }

    /** The bill: today's sessions and owed weekly sessions (dueNow) above the tab's snacks, with one total and the
        member code that pays for everything at the counter. Still makes sense with sessions and no tab, or a tab alone. */
    renderTabCard() {
      const box = this.querySelector('[data-tab-status]');
      if (!box) return;
      const tab = this.tab;
      const due = this.dueItems();
      const said = this.tabNote;
      const note = said && said.text
        ? `<p class="form-message form-message--${said.tone === 'error' ? 'error' : 'success'} ml-tab__note" role="${said.tone === 'error' ? 'alert' : 'status'}">${esc(said.text)}</p>`
        : '';
      if (!tab && !due.length) {
        box.innerHTML = note;
        box.hidden = !note;
        return;
      }
      box.hidden = false;
      const status = tab ? tab.status : null;
      const editing = Boolean(this.editing) && status === 'open';
      // An open tab, or one at the counter, is on the bill. A paid one only shows when nothing else is left to pay.
      const showTab = Boolean(tab) && (status !== 'paid' || !due.length);
      const lines = showTab && Array.isArray(tab.items) ? tab.items : [];
      const qtyOf = (line) => (editing ? this.editing.get(String(line.variantId)) || 0 : Number(line.qty) || 0);
      const count = lines.reduce((sum, line) => sum + qtyOf(line), 0);
      const tabTotal = !showTab ? 0 : editing ? lines.reduce((sum, line) => sum + qtyOf(line) * (Number(line.price) || 0), 0) : Number(tab.total) || 0;
      const total = tabTotal + due.reduce((sum, d) => sum + d.due, 0);
      const [badge, cls] = tab && status !== 'paid' ? TAB_LOOK[status] || [status, ''] : due.length ? ['To pay', 'badge--gold'] : TAB_LOOK.paid;
      const counted = [due.length ? plural(due.length, 'session', 'sessions') : '', count || !due.length ? plural(count, 'thing', 'things') : ''].filter(Boolean);
      const code = this.member && this.member.code ? String(this.member.code) : '';
      let heading = due.length ? 'Show your code at the counter to pay everything' : 'Show your code at the counter to pay';
      let body = '';
      if (!editing && (status === 'open' || (due.length && status !== 'in-cart'))) {
        const svg = code ? this.qr(code, 112, `Goblin card ${code}`) : '';
        body = code
          ? `<button class="ml-tabcode" type="button" data-qr-show="${esc(code)}" data-qr-kind="tab" aria-label="Show my code ${esc(code)} bigger">
              <span class="ml-tabcode__qr">${svg}</span>
              <span class="ml-tabcode__text"><span class="ml-tabcode__code">${esc(code)}</span><span class="ml-tabcode__hint">Tap to make it bigger</span></span>
            </button>`
          : `<p class="small">Give us your name at the counter and we'll find your ${due.length ? 'bill' : 'tab'}.</p>`;
      } else if (editing) {
        heading = 'Change your tab';
        body = '<p class="small ml-tabcard__lede">Take things off or add more of them, then save.</p>';
      } else if (status === 'in-cart') {
        heading = 'At the counter now';
        body = '<p class="small ml-tabcard__lede">Staff are ringing it up. Once it\'s paid you can start a fresh one.</p>';
      } else if (status === 'paid') {
        heading = 'Paid. Thanks, friend.';
        body = '<p class="small ml-tabcard__lede">Fancy something else? Start a fresh tab below.</p>';
      }
      const dueRows = due.map((d) => this.dueLine(d)).join('');
      const rows = lines
        .map((line) => {
          const qty = qtyOf(line);
          const name = line.variantTitle && !/^default title$/i.test(line.variantTitle) ? line.variantTitle : line.title;
          const from = name !== line.title ? `<span class="ml-tabline__from">${esc(line.title)}</span>` : '';
          if (editing) {
            return `<li class="ml-tabline ml-tabline--edit${qty ? '' : ' is-gone'}" data-qty="${qty}">
              <span class="ml-tabline__name">${esc(name)}${from}${qty ? '' : '<span class="ml-tabline__gone">Coming off</span>'}</span>
              <span class="ml-tabline__price">${esc(money((Number(line.price) || 0) * qty))}</span>
              ${this.qtyControl('edit', String(line.variantId), name)}
            </li>`;
          }
          return `<li class="ml-tabline">
            <span class="ml-tabline__qty">${esc(qty)} ×</span>
            <span class="ml-tabline__name">${esc(name)}${from}</span>
            <span class="ml-tabline__price">${esc(money((Number(line.price) || 0) * qty))}</span>
          </li>`;
        })
        .join('');
      let actions = '';
      if (status === 'open' && editing) {
        actions = `<div class="cluster ml-tabcard__actions">
          <button class="button button--small" type="button" data-tab-edit-save>Save my tab</button>
          <button class="button button--ghost button--small" type="button" data-tab-edit-cancel>Cancel</button>
        </div>`;
      } else if (status === 'open' && this.askClear) {
        actions = `<div class="ml-tabcard__ask" role="group" aria-labelledby="ml-tab-ask">
          <p class="ml-tabcard__ask-text" id="ml-tab-ask"><strong>Clear everything off your tab?</strong></p>
          <div class="cluster">
            <button class="button button--ruby button--small" type="button" data-tab-clear-yes>Yes, clear it</button>
            <button class="button button--ghost button--small" type="button" data-tab-clear-no>Keep it</button>
          </div>
        </div>`;
      } else if (status === 'open') {
        actions = `<div class="cluster ml-tabcard__actions">
          <button class="button button--ghost button--small" type="button" data-tab-edit>Edit my tab</button>
          <button class="button button--ghost button--small ml-tabcard__clear" type="button" data-tab-clear>Clear my tab</button>
        </div>`;
      }
      // Sessions first, then the tab's things under their own label (or the paid tab, said in a line)
      const tabPart = rows
        ? `${dueRows ? '<p class="ml-tabcard__group">Your tab</p>' : ''}<ul class="ml-tabcard__lines" role="list">${rows}</ul>`
        : status === 'paid' && due.length
          ? '<p class="small ml-tabcard__lede ml-tabcard__paid">Your tab\'s paid. Thanks, friend.</p>'
          : '';
      box.innerHTML = `${note}<article class="ml-tabcard ml-tabcard--${esc(showTab ? status : 'due')}" aria-labelledby="ml-tabcard-title" tabindex="-1" data-tab-card>
        <div class="ml-tabcard__top">
          <p class="ml-tabcard__kicker"><span class="badge ${cls}">${esc(badge)}</span><span>${esc(counted.join(' · '))}</span></p>
          <p class="ml-tabcard__total" data-tab-card-total><span class="visually-hidden">Total </span>${esc(money(total))}</p>
        </div>
        <h3 class="ml-tabcard__title" id="ml-tabcard-title">${esc(heading)}</h3>
        ${body}
        ${dueRows ? `<ul class="ml-tabcard__lines ml-tabcard__lines--due" role="list">${dueRows}</ul>` : ''}
        ${tabPart}
        <p class="form-message form-message--error ml-tabcard__error" data-tab-card-error role="alert" hidden></p>
        ${actions}
      </article>`;
      if (editing) {
        for (const boxEl of box.querySelectorAll('[data-qty-box="edit"]')) {
          const qty = this.editing.get(boxEl.dataset.id) || 0;
          this.setQty(boxEl, qty, MAX_EACH);
        }
      }
    }

    /** One quantity on the tab being edited */
    stepEdit(id, delta) {
      if (!this.editing || !this.editing.has(id)) return;
      const qty = Math.min(MAX_EACH, Math.max(0, (this.editing.get(id) || 0) + delta));
      this.editing.set(id, qty);
      const focusLess = delta < 0 && qty > 0;
      this.renderTabCard();
      const control = this.querySelector(`[data-qty-box="edit"][data-id="${CSS.escape(id)}"]`);
      const target = control && control.querySelector(focusLess ? '[data-step="-1"]' : '[data-step="1"]');
      if (target) target.focus();
    }

    tabError(text, inCard = false) {
      const el = this.querySelector(inCard ? '[data-tab-card-error]' : '[data-tab-error]');
      if (!el) return;
      el.textContent = text;
      el.hidden = !text;
    }

    /** Today's tab as the Lair has it right now (GET /me), so nothing goes on a tab that's been paid, or is at the
        counter, since this page loaded. Throws when the Lair can't be reached. */
    async latestTab() {
      const data = await store.backend.me();
      if (data && data.member) {
        const changed = !this.member || this.member.code !== data.member.code;
        this.member = data.member;
        if (changed) this.renderCard();
      }
      // the rest of the bill comes with it: sessions paid at the counter come off, newly owed ones go on
      if (data && this.data && Array.isArray(data.dueNow)) {
        this.fresh = data;
        this.data.dueNow = data.dueNow;
      }
      return data ? data.tab || null : null;
    }

    /** Show the tab as the Lair has it, with a note saying why when it's not what this page showed */
    takeTab(tab, note = null) {
      this.tab = tab;
      if (this.data) this.data.tab = tab;
      this.editing = null;
      this.askClear = false;
      this.tabNote = note;
      this.renderTab();
    }

    /** POST /tab, which replaces the tab's items. Returns the new tab, or undefined when it didn't save (and says why).
        A tab that's at the counter already comes back as a 409: then it shows as it is now. */
    async sendTab(items, inCard = false) {
      if (typeof store.backend.saveTab !== 'function') {
        this.tabError('Saving a tab needs a newer lair-core.js.', inCard);
        return undefined;
      }
      try {
        const result = await store.backend.saveTab({ items });
        return result ? result.tab || null : null;
      } catch (err) {
        if (err.status === 409) {
          try {
            this.takeTab(await this.latestTab(), { text: err.message, tone: 'error' });
          } catch {
            this.tabError(err.message, inCard);
          }
        } else {
          this.tabError(err.message || 'That didn\'t save. Check your connection and try again.', inCard);
        }
        return undefined;
      }
    }

    /** What the Lair has for today's tab now: when the page comes back into view, and every few seconds while the tab
        is at the counter, so it says "Paid. Thanks, friend." once it's paid */
    async refreshTab() {
      if (this.tabBusy || this.editing || this.askClear || !this.data) return;
      try {
        const before = JSON.stringify(this.dueItems());
        const tab = await this.latestTab();
        const due = this.dueItems();
        const dueChanged = JSON.stringify(due) !== before;
        if (dueChanged || JSON.stringify(tab) !== JSON.stringify(this.tab)) {
          const tabPaid = Boolean(tab && tab.status === 'paid' && this.tab && this.tab.status !== 'paid');
          const allPaid = before !== '[]' && !due.length && !(tab && tab.status !== 'paid');
          // Sessions paid with no tab today: say so, or the bill just vanishes (a paid tab's card says it already)
          this.takeTab(tab, allPaid && !tab ? { text: 'All paid. Thanks, friend.', tone: 'ok' } : null);
          if (dueChanged) this.renderTickets(this.fresh);
          if (tabPaid || allPaid) shop()?.announce(allPaid ? 'All paid. Thanks, friend.' : 'Your tab is paid. Thanks, friend.');
        }
      } catch {
        /* keep what we had */
      }
      this.queueTabCheck();
    }

    /** Tickets as the Lair has them now (after paying at the counter, say), keeping any open "Earlier" lists open */
    renderTickets(data) {
      if (!data || this.dialog?.open || this.qrDialog?.open) return;
      const open = [...this.querySelectorAll('[data-panel] details.ml-past[open]')].map((d) => d.closest('[data-panel]').dataset.panel);
      for (const key of ['bookings', 'seats', 'joins', 'series']) if (Array.isArray(data[key])) this.data[key] = data[key];
      this.items.clear();
      this.renderBookings(this.data.bookings || []);
      this.renderSeats(this.data.seats || []);
      this.renderJoins(this.data.joins || []);
      for (const name of open) {
        const details = this.querySelector(`[data-panel="${name}"] details.ml-past`);
        if (details) details.open = true;
      }
    }

    queueTabCheck() {
      window.clearTimeout(this.tabTimer);
      if (this.tab && this.tab.status === 'in-cart') this.tabTimer = window.setTimeout(() => this.refreshTab(), 12000);
    }

    /** "Add to my tab": this round goes on today's open tab, or starts one (a fresh one once the last is paid) */
    async addToTab(button) {
      if (this.tabBusy || !this.draft.size) return;
      this.tabBusy = true;
      button.setAttribute('aria-busy', 'true');
      this.tabError('');
      try {
        let latest;
        try {
          latest = await this.latestTab();
        } catch {
          this.tabError('Gobgob couldn\'t reach the Lair just now, so nothing was added. Try again in a moment.');
          return;
        }
        if (latest && latest.status === 'in-cart') {
          this.takeTab(latest, { text: 'Your tab is at the counter already. Pay for that one, then start a fresh one.', tone: 'error' });
          return;
        }
        const lines = new Map();
        if (latest && latest.status === 'open') {
          for (const line of latest.items || []) lines.set(String(line.variantId), { ...line, variantId: String(line.variantId) });
        }
        for (const { product, variant, qty } of this.draft.values()) {
          const line = lines.get(variant.id);
          if (line) line.qty += qty;
          else {
            lines.set(variant.id, {
              variantId: variant.id, title: product.title, variantTitle: variantName(product, variant) === product.title ? '' : variant.title, price: variant.price, qty,
            });
          }
        }
        const items = [...lines.values()];
        if (items.some((x) => x.qty > MAX_EACH)) {
          this.tabError('Pick 1 to 20 of each thing.');
          return;
        }
        if (items.length > MAX_LINES) {
          this.tabError('A tab holds up to 30 different things. Pay for this lot, then start a fresh one.');
          return;
        }
        const wasPaid = Boolean(latest && latest.status === 'paid' && this.tab && this.tab.status === 'open');
        const fresh = !latest || latest.status !== 'open';
        const tab = await this.sendTab(items);
        if (tab === undefined) return;
        const added = [...this.draft.values()].reduce((sum, x) => sum + x.qty, 0);
        this.draft.clear();
        let text = `Added ${plural(added, 'thing', 'things')} to your tab.`;
        if (wasPaid) text = 'Your last tab was paid at the counter, so Gobgob started a fresh one.';
        else if (fresh) text = 'Your tab is open. Show your code at the counter when you\'re ready to pay.';
        this.takeTab(tab, { text, tone: 'ok' });
        this.showTabCard();
        shop()?.announce(`${text} Total ${money(tab ? tab.total : 0)}.`);
      } finally {
        this.tabBusy = false;
        button.removeAttribute('aria-busy');
      }
    }

    /** Bring the tab into view (it's above the menu) and put focus on it for screen readers */
    showTabCard() {
      const card = this.querySelector('[data-tab-card]') || this.querySelector('[data-tab-status]');
      if (!card) return;
      card.focus({ preventScroll: true });
      const top = card.getBoundingClientRect().top;
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) * 16 || 72;
      if (top < header || top > window.innerHeight * 0.6) {
        window.scrollBy({ top: top - header - 16, behavior: smooth() });
      }
    }

    startEdit() {
      if (!this.tab || this.tab.status !== 'open') return;
      this.editing = new Map((this.tab.items || []).map((x) => [String(x.variantId), Number(x.qty) || 0]));
      this.askClear = false;
      this.tabNote = null;
      this.renderTabCard();
      this.syncBar();
      this.querySelector('[data-qty-box="edit"] [data-step="1"]')?.focus();
    }

    /** Save the edited quantities, unless the tab moved on at the counter in the meantime */
    async saveEdit(button) {
      if (this.tabBusy || !this.editing || !this.tab) return;
      this.tabBusy = true;
      button.setAttribute('aria-busy', 'true');
      try {
        let latest;
        try {
          latest = await this.latestTab();
        } catch {
          this.tabError('Gobgob couldn\'t reach the Lair just now, so your tab hasn\'t changed. Try again in a moment.', true);
          return;
        }
        if (!latest || latest.status !== 'open' || latest.id !== this.tab.id) {
          const atCounter = latest && latest.status === 'in-cart';
          this.takeTab(latest, {
            text: atCounter ? 'Your tab is at the counter already. Pay for that one, then start a fresh one.' : 'Your tab changed at the counter, so here it is as it stands now.',
            tone: 'error',
          });
          return;
        }
        const items = (latest.items || [])
          .map((x) => {
            const id = String(x.variantId);
            return { ...x, variantId: id, qty: this.editing.has(id) ? this.editing.get(id) : Number(x.qty) || 0 };
          })
          .filter((x) => x.qty > 0);
        const tab = await this.sendTab(items, true);
        if (tab === undefined) return;
        const text = items.length ? 'Saved. Your tab is up to date.' : 'Your tab is empty now, so Gobgob put it away.';
        this.takeTab(tab, { text, tone: 'ok' });
        this.showTabCard();
        shop()?.announce(text);
      } finally {
        this.tabBusy = false;
        button.removeAttribute('aria-busy');
      }
    }

    async clearTab(button) {
      if (this.tabBusy) return;
      if (typeof store.backend.clearTab !== 'function') {
        this.tabError('Clearing a tab needs a newer lair-core.js.', true);
        return;
      }
      this.tabBusy = true;
      button.setAttribute('aria-busy', 'true');
      try {
        const result = await store.backend.clearTab();
        const text = 'Tab cleared. Start a fresh one any time.';
        this.takeTab(result ? result.tab || null : null, { text, tone: 'ok' });
        this.showTabCard();
        shop()?.announce(text);
      } catch (err) {
        if (err.status === 409) {
          try {
            this.takeTab(await this.latestTab(), { text: err.message, tone: 'error' });
          } catch {
            this.tabError(err.message, true);
          }
        } else {
          this.tabError(err.message || 'That didn\'t clear. Try again, or ask us at the counter.', true);
        }
      } finally {
        this.tabBusy = false;
        button.removeAttribute('aria-busy');
      }
    }

    /* scanning: the camera sheet (lair-scan.js), then the code is matched to something the shop sells */
    openScanner() {
      this.tabError('');
      if (!window.LairScan || typeof window.LairScan.open !== 'function') {
        this.tabNote = { text: 'The scanner didn\'t load. Pick it from the menu instead, friend.', tone: 'error' };
        this.renderTabCard();
        return;
      }
      window.LairScan.open({
        formats: SCAN_FORMATS,
        title: 'Scan an item',
        hint: 'Point the camera at the barcode or QR code.',
        inputLabel: 'Type the barcode',
        inputMode: 'numeric',
        submitLabel: 'Add',
        onCode: (code) => this.scanned(code),
      });
    }

    /** What the scanner says after a code: added, pick which one, sold out, or unknown */
    async scanned(code) {
      let hit;
      try {
        hit = await this.findCode(code);
      } catch {
        return { message: 'Gobgob couldn\'t check that one just now. Try again, or pick it from the menu.', tone: 'error' };
      }
      if (!hit) return { message: UNKNOWN_CODE, tone: 'error' };
      if (hit.product.notForTab === 'library') return { message: 'That\'s one of our library games. Borrow it at the counter, friend. It doesn\'t go on a tab.', tone: 'error' };
      if (hit.product.notForTab) return { message: 'That one can\'t go on a tab. Ask us at the counter, friend.', tone: 'error' };
      this.keep(hit.product);
      this.toggleGroup(hit.product.id, true);
      if (!hit.variant) {
        this.flash(this.querySelector(`[data-product="${CSS.escape(hit.product.id)}"]`));
        return { message: `Found ${hit.product.title}. Pick which one from the menu.`, tone: 'ok', close: true, closeAfter: 1400 };
      }
      const name = variantName(hit.product, hit.variant);
      if (!hit.variant.available) return { message: `${name} is sold out, sorry friend. Pick something else from the menu.`, tone: 'error' };
      if (!this.step(hit.variant.id, 1)) return { message: 'Pick 1 to 20 of each thing.', tone: 'error' };
      this.flash(this.querySelector(`.ml-menu__item[data-variant="${CSS.escape(hit.variant.id)}"]`));
      return { message: `Added ${name}. Tap “Add to my tab” to save it.`, tone: 'ok', close: true, closeAfter: 1100 };
    }

    /** A product found by scanning that isn't on the menu goes at the top of it, so its quantity can change */
    keep(product) {
      if (this.products().some((p) => p.id === product.id || (product.handle && p.handle === product.handle))) return;
      this.extra = [product, ...this.extra];
      if (this.menuOpen) this.menuOpen.add(product.id);
      this.renderMenu();
    }

    flash(el) {
      if (!el) return;
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
      window.setTimeout(() => el.classList.remove('is-flash'), 1600);
    }

    /** A scanned or typed code: the menu's barcodes and SKUs first, then a product link in a QR code, then the
        shop's search by barcode. Returns { product, variant } ({ product } when it can't tell which), or null. */
    async findCode(raw) {
      const code = String(raw || '').trim();
      if (!code) return null;
      for (const product of this.products()) {
        const variant = product.variants.find((v) => sameCode(v.barcode, code) || sameCode(v.sku, code));
        if (variant) return { product, variant };
      }
      const link = productLink(code);
      if (link) {
        const product = this.products().find((p) => p.handle === link.handle) || (await this.fetchProduct(link.handle));
        if (!product) return null;
        const variant = product.variants.find((v) => v.id === link.variant) || (product.variants.length === 1 ? product.variants[0] : null);
        return { product, variant };
      }
      return this.searchCode(code);
    }

    /** /products/<handle>.js: the product with each variant's price, barcode and SKU, or null */
    async fetchProduct(handle) {
      const response = await fetch(`${root}products/${encodeURIComponent(handle)}.js`, { headers: { Accept: 'application/json' } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Product ${handle}: ${response.status}`);
      const p = await response.json();
      if (!p || !Array.isArray(p.variants)) return null;
      const product = tidyProduct({
        id: p.id, handle: p.handle || handle, title: p.title, image: smallImage(p.featured_image),
        variants: p.variants.map((v) => ({ id: v.id, title: v.title, price: v.price, barcode: v.barcode, sku: v.sku, available: v.available })),
      });
      // Library copies (borrowed with the barcode on the box), gift cards and the library membership aren't for a tab
      const tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((x) => String(x).trim().toLowerCase());
      if (tags.includes('board game rental')) product.notForTab = 'library';
      else if (/gift card/i.test(p.type || p.product_type || '') || p.requires_selling_plan) product.notForTab = 'other';
      return product;
    }

    /** The shop's predictive search, by barcode or SKU, then each product's variants for the one with that barcode */
    async searchCode(code) {
      const url = `${root}search/suggest.json?q=${encodeURIComponent(code)}&resources[type]=product&resources[limit]=4&resources[options][fields]=variants.barcode,variants.sku`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Search: ${response.status}`);
      const data = await response.json();
      const found = (data && data.resources && data.resources.results && data.resources.results.products) || [];
      for (const hit of found.slice(0, 4)) {
        const handle = hit.handle || (productLink(hit.url || '') || {}).handle;
        if (!handle) continue;
        const product = await this.fetchProduct(handle);
        const variant = product && (product.variants.find((v) => sameCode(v.barcode, code)) || product.variants.find((v) => sameCode(v.sku, code)));
        if (variant) return { product, variant };
      }
      return null;
    }

    /* ---------- dice: one roll for every $20 spent ---------- */
    renderDice() {
      const rolls = this.data && this.data.rolls && typeof this.data.rolls === 'object' ? this.data.rolls : null;
      this.rolls = rolls
        ? {
            available: Math.max(0, Math.floor(Number(rolls.available ?? rolls.bonus) || 0)),
            toNext: Math.max(0, Math.round(Number(rolls.toNext) || 0)),
            per: Number(rolls.per) || PER_ROLL,
          }
        : null;
      this.prizes = Array.isArray(this.data && this.data.prizes) ? this.data.prizes.slice(0, 10) : [];
      this.renderRolls();
      this.renderPrizes();
    }

    /** "Rolls ready: 3", how far it is to the next one, then the latest result and the button */
    renderRolls() {
      const ready = this.querySelector('[data-rolls-ready]');
      const next = this.querySelector('[data-rolls-next]');
      const slots = this.querySelector('[data-roll-slots]');
      if (!ready || !slots) return;
      const rolls = this.rolls;
      if (!rolls) {
        ready.textContent = 'Rolls ready: back soon';
        if (next) next.hidden = true;
        slots.innerHTML = '<p class="ml-roll__none">Gobgob is still setting out the dice. Check back soon, friend.</p>';
        return;
      }
      ready.innerHTML = `Rolls ready: <strong>${rolls.available}</strong>`;
      this.count('rolls', rolls.available);
      if (next) {
        const text = next.querySelector('[data-rolls-next-text]');
        const bar = next.querySelector('[data-rolls-bar]');
        const toNext = Math.min(rolls.toNext, rolls.per);
        if (text) text.textContent = toNext > 0 ? `${money(toNext)} more to your next roll` : '';
        if (bar) bar.style.width = `${Math.round(((rolls.per - toNext) / rolls.per) * 100)}%`;
        next.hidden = !(toNext > 0);
      }
      let html = this.result ? this.resultCard(this.result) : '';
      if (rolls.available) {
        this.rollError = '';
        html += `<button class="button button--gold ml-roll__button" type="button" data-roll>
          ${this.icon('d20')}<span data-roll-label>${this.result ? 'Roll again' : 'Roll the d20'}</span><span class="ml-roll__count">${rolls.available} ready</span>
        </button>`;
      } else if (this.rollError) {
        // The Lair said there are none left (the page thought there was one): its words say it all
        html += `<p class="form-message form-message--error ml-roll__error" role="alert">${esc(this.rollError)}</p>`;
      } else {
        const spend = rolls.toNext > 0 ? `Spend ${money(rolls.toNext)} more for your next one, online or in store with your Goblin card.` : 'Every $20 you spend earns one.';
        html += `<p class="ml-roll__none">${this.result ? 'That\'s all your rolls for now.' : 'No rolls ready yet.'} ${esc(spend)}</p>`;
      }
      slots.innerHTML = html;
      for (const button of slots.querySelectorAll('[data-roll]')) button.disabled = Boolean(this.rolling);
    }

    /** What a roll won, in Gobgob's words: store credit added, credit to claim at the counter, or no ones this time */
    resultCard({ roll, prize, message, at }) {
      const face = `<span class="ml-face ml-face--big${prize ? ' ml-face--win' : ''}" aria-hidden="true">${roll}</span>`;
      if (!prize) {
        const said = message || 'No ones this time. Spend $20 for another go.';
        return `<div class="ml-miss" data-result tabindex="-1">${face}<p><strong>You rolled ${roll}.</strong> ${esc(said)}</p></div>`;
      }
      const amount = Number(prize.amount) || 0;
      const kicker = String(message || (roll === 20 ? 'Natural 20! $20 store credit is yours.' : roll === 11 ? 'Two ones! $2 store credit, friend.' : 'A 1 on the face: $1 store credit.'))
        .replace(/\s*Show this screen at the counter to claim it\.?$/, '');
      const pending = prize.status === 'pending';
      const look = pending ? 'counter' : roll === 20 ? 'crit' : 'credit';
      return `<div class="ml-prize ml-prize--${look}" data-result tabindex="-1" role="group" aria-label="Your prize">
        <div class="ml-prize__top">${face}<p class="ml-prize__kicker">${esc(kicker)}</p></div>
        <p class="ml-prize__title">${esc(money(amount))} store credit</p>
        ${pending
          ? `<p class="ml-prize__stamp"><strong>Show this screen at the counter to claim it.</strong> <span>Rolled at ${esc(t.fmtTime(at))} on ${esc(longDay(at))}.</span></p>`
          : '<p class="ml-prize__text">Added to your account. It comes off at checkout while you\'re logged in, or at the counter.</p>'}
      </div>`;
    }

    /** The last 10 prizes, newest first, each with where it's up to */
    renderPrizes() {
      const box = this.querySelector('[data-prizes]');
      if (!box || !this.rolls) return;
      box.hidden = false;
      const rows = this.prizes.map((p) => this.prizeRow(p)).join('');
      box.innerHTML = `<h3 class="ml-prizes__title">Recent prizes</h3>${
        rows ? `<ul class="ml-prizes__list" role="list">${rows}</ul>` : '<p class="small muted">No prizes yet. Your next roll could be the one, friend.</p>'
      }`;
    }

    prizeRow(p) {
      const roll = Number(p.roll);
      const face = Number.isInteger(roll) && roll >= 1 && roll <= 20
        ? `<span class="ml-face ml-face--small${roll === 20 ? ' ml-face--crit' : ''}" aria-hidden="true">${roll}</span>`
        : '<span class="ml-face ml-face--small" aria-hidden="true"></span>';
      const what = p.kind === 'credit' || !p.kind ? `${money(Number(p.amount) || 0)} store credit` : 'A prize';
      const when = p.at ? shortDay(Number(p.at)) : '';
      const rolled = Number.isInteger(roll) ? `Rolled ${roll}` : '';
      const meta = [when, rolled].filter(Boolean).join(' · ');
      if (p.status === 'pending') {
        return `<li class="ml-prizes__row ml-prizes__row--pending">${face}<span class="ml-prizes__what">${esc(what)}<span class="ml-prizes__meta">${esc(meta)}</span><span class="ml-prizes__claim">Show this at the counter to claim it</span></span></li>`;
      }
      const [label, cls] = p.status === 'done' ? ['Claimed', 'badge--muted'] : ['Added', 'badge--new'];
      return `<li class="ml-prizes__row">${face}<span class="ml-prizes__what">${esc(what)}<span class="ml-prizes__meta">${esc(meta)}</span></span><span class="badge ${cls}">${label}</span></li>`;
    }

    /** Roll one of their rolls in the Lair app: the die tumbles until the answer is back */
    async roll(button) {
      if (this.rolling || typeof store.backend.roll !== 'function') return;
      this.rolling = true;
      for (const b of this.querySelectorAll('[data-roll]')) b.disabled = true;
      const label = button && button.querySelector('[data-roll-label]');
      if (label) label.textContent = 'Rolling…';
      const outcome = store.backend.roll({ kind: 'spend' }).then((data) => ({ data }), (error) => ({ error }));
      await this.tumble(outcome);
      const { data, error } = await outcome;
      const roll = Number(data && data.roll);
      if (error || !Number.isInteger(roll) || roll < 1 || roll > 20) {
        this.rolling = false;
        this.land(null);
        const text = error && error.message ? error.message : 'Gobgob dropped the dice. Please try again.';
        if (error && error.status === 409) {
          this.result = null;
          this.rollError = text || NO_ROLLS;
          await this.refreshRolls();
          return;
        }
        await this.refreshRolls();
        this.rollNote(text);
        return;
      }
      const prize = data.prize && typeof data.prize === 'object' ? data.prize : null;
      const at = Date.now();
      this.result = { roll, prize, message: data.message || '', at };
      if (data.rolls && typeof data.rolls === 'object') {
        this.rolls = {
          available: Math.max(0, Math.floor(Number(data.rolls.available ?? data.rolls.bonus) || 0)),
          toNext: Math.max(0, Math.round(Number(data.rolls.toNext) || 0)),
          per: Number(data.rolls.per) || PER_ROLL,
        };
      } else if (this.rolls) {
        this.rolls = { ...this.rolls, available: Math.max(0, this.rolls.available - 1) };
      }
      if (prize) this.prizes = [{ id: prize.id, kind: prize.kind || 'credit', amount: prize.amount, status: prize.status || 'added', roll, at }, ...this.prizes].slice(0, 10);
      this.rolling = false;
      this.land(roll, Boolean(prize));
      this.renderRolls();
      this.renderPrizes();
      if (prize) this.celebrate(roll === 20);
      const result = this.querySelector('[data-roll-slots] [data-result]');
      if (result) {
        result.focus({ preventScroll: true });
        if (!reduceMotion.matches) result.classList.add('is-new');
        this.reveal(result);
      }
      shop()?.announce(`You rolled ${roll}. ${data.message || (prize ? `${money(Number(prize.amount) || 0)} store credit.` : 'No prize this time.')}`);
    }

    /** After a roll didn't go through: what /me says is ready now */
    async refreshRolls() {
      try {
        const data = await store.backend.me();
        this.data = { ...(this.data || {}), rolls: data.rolls, prizes: data.prizes };
        this.renderDice();
      } catch {
        this.renderRolls();
        this.renderPrizes();
      }
    }

    rollNote(text) {
      const slots = this.querySelector('[data-roll-slots]');
      if (!slots) return;
      slots.insertAdjacentHTML('afterbegin', `<p class="form-message form-message--error ml-roll__error" role="alert">${esc(text)}</p>`);
    }

    async tumble(until) {
      const die = this.querySelector('[data-die]');
      const number = die && die.querySelector('.d20__number');
      if (!die || !number) return until;
      die.classList.remove('is-rolling', 'is-rattling', 'is-crit', 'is-win');
      if (reduceMotion.matches) return until;
      void die.offsetWidth;
      die.classList.add('is-rolling');
      const flicker = window.setInterval(() => {
        number.textContent = String(1 + Math.floor(Math.random() * 20));
      }, 70);
      let settled = false;
      until.then(() => {
        settled = true;
      });
      await wait(1100);
      die.classList.remove('is-rolling');
      if (!settled) {
        die.classList.add('is-rattling');
        await until;
        die.classList.remove('is-rattling');
      }
      window.clearInterval(flicker);
      return until;
    }

    land(roll, won = false) {
      const die = this.querySelector('[data-die]');
      const number = die && die.querySelector('.d20__number');
      if (!die || !number) return;
      number.textContent = roll ? String(roll) : '20';
      die.classList.toggle('is-crit', roll === 20);
      die.classList.toggle('is-win', Boolean(won) && roll !== 20);
    }

    /** A burst of tiny dice from the tray on a prize. Skipped when people prefer less motion. */
    celebrate(crit) {
      const burst = this.querySelector('[data-burst]');
      if (!burst || reduceMotion.matches) return;
      const colours = crit ? ['var(--c-gold)', 'var(--c-text)', 'var(--c-gold)', 'var(--c-ruby)'] : ['var(--c-goblin)', 'var(--c-text)', 'var(--c-gold)', 'var(--c-goblin)'];
      burst.innerHTML = '';
      for (let i = 0; i < 16; i += 1) {
        const bit = document.createElement('span');
        const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.3;
        const dist = 60 + Math.random() * 50;
        bit.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
        bit.style.setProperty('--dy', `${Math.round(Math.sin(angle) * dist * 0.8)}px`);
        bit.style.setProperty('--rot', `${Math.round(Math.random() * 360 - 180)}deg`);
        bit.style.setProperty('--bit', colours[i % colours.length]);
        bit.style.animationDelay = `${Math.round(Math.random() * 120)}ms`;
        burst.append(bit);
      }
      window.setTimeout(() => {
        burst.innerHTML = '';
      }, 1400);
    }

    /** On a phone the result can land below the fold: bring its top into view */
    reveal(el) {
      const box = el.getBoundingClientRect();
      if (box.top >= 0 && box.bottom <= window.innerHeight) return;
      window.scrollBy({ top: box.top - window.innerHeight * 0.25, behavior: smooth() });
    }

    /* ---------- session passes ---------- */
    renderPasses() {
      const box = this.querySelector('[data-passes]');
      if (!box) return;
      const passes = Array.isArray(this.data && this.data.passes) ? this.data.passes : [];
      this.count('passes', passes.filter((p) => (p.status || 'active') === 'active').length);
      if (!passes.length) {
        box.innerHTML = '<p class="ml-passes__none">No passes yet. A pass is a bundle of table sessions, like a league pass or a gift pack. Ask us at the counter, or claim one below.</p>';
        return;
      }
      const order = { active: 0, used: 1, expired: 2, void: 3 };
      const list = passes.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
      box.innerHTML = `<ul class="ml-passes__items" role="list">${list.map((p) => this.passCard(p)).join('')}</ul>
        <p class="small muted ml-passes__how">Each session covers one person's table fee. Pick your pass when you book a table, or show us your code at the counter.</p>`;
    }

    /** Where a pass came from, in a line: "Bought online #1550", or "Birthday gift from Gobgob" unless its label says so
        already. Nothing for one staff made: its label says what it is, and staff notes stay with staff. */
    passSource(p) {
      if (p.source === 'birthday') return /birthday/i.test(p.label || '') ? '' : 'Birthday gift from Gobgob';
      if (p.source !== 'order') return '';
      const how = (String(p.note || '').match(/^bought (online|at the counter)/i) || [])[0] || '';
      const order = p.orderName ? String(p.orderName).trim() : '';
      if (how) return order ? `${how} ${order}` : how;
      return order ? `Bought with order ${order}` : 'Bought from Dice Goblin';
    }

    passCard(p) {
      const status = p.status || 'active';
      const [label, cls] = PASS_STATUS[status] || [status, ''];
      const total = Math.max(0, Number(p.sessionsTotal) || 0);
      const left = Math.max(0, Math.min(total, Number(p.sessionsLeft) || 0));
      const ends = Number(p.expiresAt) || 0;
      const until = ends ? `${ends < Date.now() ? 'Ended' : 'Use by'} ${shortDay(ends)}` : 'No expiry';
      const cover = Number(p.cover) || 0;
      const from = this.passSource(p);
      return `<li class="ml-pass ml-pass--${esc(status)}">
        <div class="ml-pass__top">
          <h3 class="ml-pass__label">${esc(p.label || 'Session pass')}</h3>
          <span class="badge ${cls}">${esc(label)}</span>
        </div>
        ${from ? `<p class="ml-pass__from">${esc(from)}</p>` : ''}
        <p class="ml-pass__left"><strong>${left}</strong> of ${esc(plural(total, 'session', 'sessions'))} left</p>
        <span class="ml-pass__bar" aria-hidden="true"><span style="width: ${total ? Math.round((left / total) * 100) : 0}%"></span></span>
        <p class="ml-pass__meta">${esc(until)}${cover ? ` · Covers up to ${esc(money(cover))} a session` : ''}</p>
        <p class="ml-pass__code"><span class="visually-hidden">Pass code </span>${esc(p.code || '')}</p>
      </li>`;
    }

    async claimPass(form) {
      const message = form.querySelector('[data-claim-message]');
      const button = form.querySelector('[type="submit"]');
      const input = form.elements.code;
      const code = input.value.trim();
      const show = (text, ok) => {
        message.textContent = text;
        message.className = `form-message form-message--${ok ? 'success' : 'error'}`;
        message.hidden = false;
        input.setAttribute('aria-invalid', String(!ok));
      };
      if (!code) {
        show('Type the code from your pass first. It looks like SJ-OWLBEAR-17.', false);
        input.focus();
        return;
      }
      if (typeof store.backend.claimPass !== 'function') {
        show('Claiming a pass needs a newer lair-core.js.', false);
        return;
      }
      if (button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      try {
        const { pass } = await store.backend.claimPass({ code });
        if (this.data) {
          const others = (this.data.passes || []).filter((p) => codeKey(p.code) !== codeKey(pass.code));
          this.data.passes = [pass, ...others];
        }
        this.renderPasses();
        input.value = '';
        input.removeAttribute('aria-invalid');
        show(`It's yours! ${pass.label || 'The pass'} is on your account, with ${plural(Number(pass.sessionsLeft) || 0, 'session', 'sessions')} to use.`, true);
      } catch (err) {
        show(err.message || 'That didn\'t work. Try again, or ask us at the counter.', false);
        input.focus();
      } finally {
        button.removeAttribute('aria-busy');
      }
    }

    /* ---------- birthday gifts from Gobgob (GET /me gifts: this year's, which staff chose) ---------- */
    renderGifts() {
      const box = this.querySelector('[data-gifts]');
      if (!box) return;
      const gifts = (Array.isArray(this.data && this.data.gifts) ? this.data.gifts : []).map((g) => this.giftCard(g)).filter(Boolean);
      box.innerHTML = gifts.join('');
      box.hidden = !gifts.length;
    }

    /** "Birthday gift from Gobgob: $5 store credit, 2 sessions, a free Pokémon booster: code HBD-…", then where each part
        is and until when the code works (30 days) */
    giftCard(g) {
      if (!g || typeof g !== 'object') return '';
      const credit = Math.max(0, Number(g.credit) || 0);
      const sessions = Math.max(0, Number(g.sessions) || 0);
      const rolls = Math.max(0, Number(g.rolls) || 0);
      const product = g.product && g.product.title ? g.product : null;
      const parts = [
        credit ? esc(`${money(credit)} store credit`) : '',
        sessions ? esc(plural(sessions, 'session', 'sessions')) : '',
        rolls ? esc(plural(rolls, 'dice roll', 'dice rolls')) : '',
        product ? `${esc(`a free ${product.title}`)}${product.code ? `: code <span class="ml-gift__code">${esc(product.code)}</span>` : ''}` : '',
      ].filter(Boolean);
      if (!parts.length) return '';
      const at = Number(g.at) || Date.now();
      const hints = [];
      if (product && product.code) hints.push(`Use the code by ${shortDay(at + 30 * 24 * HOUR)}, online at checkout or at the counter.`);
      else if (product) hints.push(`Ask for your ${product.title} at the counter.`);
      if (sessions) hints.push(`Your ${plural(sessions, 'session is', 'sessions are')} in My passes.`);
      if (rolls) hints.push(`Your ${plural(rolls, 'roll is', 'rolls are')} ready in Dice.`);
      return `<article class="ml-gift" aria-label="Birthday gift from Gobgob">
        <p class="ml-gift__what"><span class="ml-gift__icon" aria-hidden="true">${this.icon('gift')}</span><span><strong>Birthday gift from Gobgob:</strong> ${parts.join(', ')}</span></p>
        ${hints.length ? `<p class="ml-gift__how">${esc(hints.join(' '))}</p>` : ''}
        ${product && product.code ? `<button class="button button--ghost button--small ml-gift__copy" type="button" data-copy="${esc(product.code)}">Copy the code</button>` : ''}
      </article>`;
    }

    /** Copy a gift's code for checkout. Without the clipboard, the code is selected so it can be copied by hand. */
    async copyCode(button) {
      const code = button.dataset.copy;
      const say = (text) => {
        button.textContent = text;
        window.clearTimeout(this.copyTimer);
        this.copyTimer = window.setTimeout(() => {
          button.textContent = 'Copy the code';
        }, 2500);
      };
      try {
        await navigator.clipboard.writeText(code);
        say('Copied');
        shop()?.announce(`Copied ${code}`);
      } catch {
        const el = button.closest('.ml-gift')?.querySelector('.ml-gift__code');
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
        say('Selected: copy it from there');
      }
    }

    /* ---------- the birthday ---------- */
    /** The saved birthday (MM-DD) into the day and month boxes, unless they're already being changed.
        An older Lair app sends no member: then there's nowhere to save it yet, so the form waits. */
    fillBirthday(member) {
      const form = this.querySelector('[data-birthday]');
      if (form) (form.closest('.ml-bday') || form).hidden = !member;
      if (!form || !member || form.dataset.touched) return;
      const parts = /^(\d{2})-(\d{2})$/.exec(String(member.birthday || ''));
      form.elements.month.value = parts ? String(Number(parts[1])) : '';
      form.elements.day.value = parts ? String(Number(parts[2])) : '';
    }

    async saveBirthday(form) {
      const message = form.querySelector('[data-birthday-message]');
      const button = form.querySelector('[type="submit"]');
      const day = Number(form.elements.day.value) || 0;
      const month = Number(form.elements.month.value) || 0;
      const show = (text, ok) => {
        message.textContent = text;
        message.className = `form-message form-message--${ok ? 'success' : 'error'}`;
        message.hidden = false;
      };
      if (Boolean(day) !== Boolean(month)) {
        show(day ? 'Pick the month too.' : 'Pick the day too.', false);
        (day ? form.elements.month : form.elements.day).focus();
        return;
      }
      if (day && day > MONTH_DAYS[month - 1]) {
        show(`${MONTHS[month - 1]} only has ${MONTH_DAYS[month - 1]} days. Pick another day.`, false);
        form.elements.day.focus();
        return;
      }
      if (typeof store.backend.saveProfile !== 'function') {
        show('Saving birthdays needs a newer lair-core.js.', false);
        return;
      }
      const birthday = day ? `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
      button.setAttribute('aria-busy', 'true');
      try {
        const result = await store.backend.saveProfile({
          firstName: form.dataset.firstName || '', name: form.dataset.name || '', email: form.dataset.email || '', birthday,
        });
        if (this.data) this.data.member = { ...(this.data.member || {}), ...((result && result.member) || {}), birthday };
        delete form.dataset.touched;
        show(birthday ? `Saved. Gobgob has circled ${day} ${MONTHS[month - 1]} on the calendar.` : 'Birthday cleared. Add it again any time.', true);
      } catch (err) {
        show(err.message || 'That didn\'t save. Please try again.', false);
      } finally {
        button.removeAttribute('aria-busy');
      }
    }

    /* ---------- Gobgob's quotes: one at a time, picked at random on load, then another every few seconds or on a tap.
       The d20 badge shows the quote's number (line 1 of the setting is face 1). ---------- */
    startQuotes() {
      const box = this.querySelector('[data-quotes]');
      if (!box) return;
      try {
        this.quotes = JSON.parse(box.querySelector('[data-quote-list]').textContent).map(String);
      } catch {
        this.quotes = [];
      }
      if (this.quotes.length < 2) return;
      this.quoteBox = box;
      this.quoteIndex = Number(box.dataset.index) || 0;
      // Hold still while a mouse is over it or the keyboard is in it; the pause button stops it for good.
      box.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'mouse') this.quoteHeld = true;
      });
      box.addEventListener('pointerleave', () => {
        this.quoteHeld = false;
      });
      box.addEventListener('focusin', (event) => {
        if (event.target.matches(':focus-visible')) this.quoteHeld = true;
      });
      box.addEventListener('focusout', (event) => {
        if (!box.contains(event.relatedTarget)) this.quoteHeld = false;
      });
      this.queueQuote();
    }

    queueQuote() {
      window.clearTimeout(this.quoteTimer);
      this.quoteTimer = window.setTimeout(() => {
        if (!this.quotePaused && !this.quoteHeld && !document.hidden) this.showQuote(this.randomQuote());
        this.queueQuote();
      }, QUOTE_EVERY);
    }

    /** Another quote at random: any of them but the one showing, so the same one never comes twice in a row */
    randomQuote() {
      const n = this.quotes.length;
      const pick = Math.floor(Math.random() * (n - 1));
      return pick >= this.quoteIndex ? pick + 1 : pick;
    }

    showQuote(index, spoken = false) {
      const n = this.quotes.length;
      const i = ((index % n) + n) % n;
      this.quoteIndex = i;
      const box = this.quoteBox;
      const swap = () => {
        box.querySelector('[data-quote-text]').textContent = this.quotes[i];
        box.querySelector('[data-quote-face]').textContent = String(i + 1);
        box.querySelector('[data-quote-number]').textContent = String(i + 1);
        box.dataset.index = String(i);
        if (spoken) shop()?.announce(this.quotes[i]);
      };
      window.clearTimeout(this.fadeTimer);
      if (reduceMotion.matches) {
        swap();
        return;
      }
      box.classList.add('is-fading');
      this.fadeTimer = window.setTimeout(() => {
        swap();
        box.classList.remove('is-fading');
      }, 300);
    }

    pauseQuotes(button) {
      this.quotePaused = !this.quotePaused;
      button.setAttribute('aria-pressed', String(this.quotePaused));
      button.querySelector('[data-icon-pause]').hidden = this.quotePaused;
      button.querySelector('[data-icon-play]').hidden = !this.quotePaused;
      if (!this.quotePaused) this.queueQuote();
    }

    /* ---------- tickets ---------- */
    ticket({ key, accent, eyebrow, title, tags = '', rows, notes = '', actions = '' }) {
      const item = this.items.get(key);
      const ref = String(item.ref || '');
      return `<article class="ticket ticket--compact ml-ticket ml-ticket--${accent}" aria-labelledby="ml-${esc(key)}">
        <div class="ticket__main">
          <p class="ticket__eyebrow">${esc(eyebrow)}</p>
          <h3 class="ml-ticket__title" id="ml-${esc(key)}">${esc(title)}</h3>
          ${tags ? `<div class="ml-ticket__tags">${tags}</div>` : ''}
          <dl class="summary">${rows.filter(Boolean).map(([dt, dd]) => `<div><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`).join('')}</dl>
          ${notes}
          <div class="cluster ml-ticket__actions">
            <button class="button button--ink button--small" type="button" data-ics="${esc(key)}">Add to calendar</button>
            ${actions}
          </div>
        </div>
        <div class="ticket__stub">
          <button class="ml-ticket__code" type="button" data-qr-show="${esc(ref)}" data-qr-kind="ticket" data-qr-what="${esc(item.what || '')}" aria-label="Show code ${esc(ref)} bigger">
            ${this.qr(ref, 150, `Ticket ${ref}`)}
            <span class="ml-ticket__ref">${esc(ref)}</span>
          </button>
          <p class="small">Show this at the counter to check in. Tap it to make it bigger.</p>
        </div>
      </article>`;
    }

    /** The money rows: the fee and where it's up to (paid, pay at the counter, waiting for an online payment, or part
        paid when the bill's being split), the pass saved for check-in, and what passes covered */
    feeRows(item, label) {
      const amount = Number(item.amount) || 0;
      const covered = Number(item.covered) || 0;
      const paidSoFar = Number(item.paidAmount) || 0;
      const owed = Math.max(0, amount - covered);
      const due = item.due != null && Number.isFinite(Number(item.due)) ? Number(item.due) : item.paid ? 0 : Math.max(0, owed - paidSoFar);
      const part = paidSoFar > 0 && due > 0 && !item.paid;
      let value;
      if (item.paid || (amount > 0 && due === 0)) value = `${esc(money(amount))} <span class="badge badge--new">Paid</span>`;
      else if (item.status === 'held') value = `${esc(money(amount))} <span class="badge badge--gold">Waiting for payment</span>`;
      else if (part || covered) value = esc(money(amount));
      else if (amount > 0) value = `${esc(money(amount))} <span class="badge">Pay at the counter</span>`;
      else value = 'Free';
      const rows = [[label, value]];
      if (item.pass && item.pass.code) {
        const left = Number(item.pass.sessionsLeft ?? item.pass.left);
        rows.push(['Pass', `${esc(item.pass.label || 'Session pass')} <span class="ml-ticket__mono">${esc(item.pass.code)}</span>${
          covered ? '' : `<span class="ml-ticket__hint">We use it when you check in${Number.isFinite(left) ? ` (${esc(plural(left, 'session', 'sessions'))} left)` : ''}.</span>`
        }`]);
      }
      if (covered) rows.push(['Covered', `${esc(money(covered))} by ${item.pass ? 'your pass' : 'a pass'}`]);
      // A bill being split is paid in parts: what's been paid of what's owed (after the pass), and what's left
      if (part) rows.push(['So far', `<span class="ml-part">Paid ${esc(money(paidSoFar))} of ${esc(money(owed))} · <strong>${esc(money(due))} left</strong></span>`]);
      else if (covered && due > 0 && !item.paid && item.status !== 'held') rows.push(['To pay', `${esc(money(due))} <span class="badge">Pay at the counter</span>`]);
      return { rows, due, owed };
    }

    /** Under the details: how to pay, the split bill, and what paying online means */
    payNotes(item, { due }) {
      const notes = [];
      if (item.split) notes.push(SPLIT_NOTE);
      if (item.payment === 'online' && item.paid) {
        notes.push(item.kind === 'join' || item.occurrenceId
          ? "You paid online, so you're locked in. Can't make it after all? Have a chat with us about a refund."
          : `Need to cancel? Do it at least ${this.refundHours} hours before and we'll refund you. After that the fee can't be refunded.`);
      } else if (due > 0 && item.status !== 'held') {
        notes.unshift(Number(item.paidAmount) > 0 ? "Pay what's left at the counter. Show your code and we'll ring it up." : PAY_AT_COUNTER);
      }
      return notes.map((text) => `<p class="small ml-ticket__note">${esc(text)}</p>`).join('');
    }

    pastList(items, describe) {
      if (!items.length) return '';
      const rows = items
        .map((item) => {
          const [label, cls] = pastLabel(item);
          const refund = REFUND[item.refund] ? `<span class="ml-past__note ml-past__note--${esc(item.refund)}">${esc(REFUND[item.refund])}</span>` : '';
          return `<li class="ml-past__row"><span class="ml-past__date">${esc(shortDay(item.start))}</span><span class="ml-past__what">${esc(describe(item))}</span><span class="badge ${cls}">${esc(label)}</span>${refund}</li>`;
        })
        .join('');
      return `<details class="ml-past"><summary class="ml-past__summary">Earlier and cancelled (${items.length})</summary><ul class="ml-past__list" role="list">${rows}</ul></details>`;
    }

    split(list) {
      const items = list.map((item) => ({ ...item, start: Number(item.start), end: Number(item.end) || undefined }));
      return {
        soon: items.filter(isUpcoming).sort(byStart),
        past: items.filter((item) => !isUpcoming(item)).sort((a, b) => b.start - a.start),
      };
    }

    eventTitle(occurrenceId) {
      if (!occurrenceId) return '';
      const event = (store.data.events || []).find((e) => e.id === occurrenceId);
      return event ? event.title : '';
    }

    renderBookings(list) {
      const panel = this.panel('bookings');
      if (!panel) return;
      const { soon, past } = this.split(list);
      this.count('bookings', soon.length);
      const tickets = soon
        .map((b) => {
          const key = `bk-${b.ref}`;
          const event = this.eventTitle(b.occurrenceId);
          this.items.set(key, { ...b, kind: 'table', what: event ? `Game table at ${event}` : 'Your table' });
          const room = b.tables && b.tables.length ? store.roomOf(b.tables[0]) : null;
          const amount = b.amount || (room ? room.price * (b.people || 1) : 0);
          const fee = this.feeRows({ ...b, amount }, 'Table fee');
          return this.ticket({
            key,
            accent: 'table',
            eyebrow: dayLabel(b.start),
            title: span(b.start, b.end),
            tags: b.split ? '<span class="badge ml-tag ml-tag--split">Splitting the bill</span>' : '',
            rows: [
              event ? ['Event', esc(event)] : null,
              ['Tables', esc(tablesText(b.tables))],
              ['People', esc(b.people)],
              ...fee.rows,
            ],
            notes: this.payNotes({ ...b, amount }, fee),
            actions: b.start > Date.now() ? `<button class="button button--small ml-cancel" type="button" data-cancel="${esc(key)}">Cancel booking</button>` : '',
          });
        })
        .join('');
      panel.innerHTML = `${tickets ? `<div class="ml-tickets">${tickets}</div>` : this.empty('bookings')}${this.pastList(past, (b) => `${tablesText(b.tables)}, ${plural(b.people || 1, 'person', 'people')}`)}`;
    }

    players(list) {
      if (!Array.isArray(list) || !list.length) return '';
      return `<ul class="ml-players" role="list">${list
        .map((p) => `<li>${esc(p.name)}${p.character ? ` <span class="ml-players__as">as</span> <em>${esc(p.character)}</em>` : ''}</li>`)
        .join('')}</ul>`;
    }

    renderSeats(list) {
      const panel = this.panel('seats');
      if (!panel) return;
      const { soon, past } = this.split(list);
      this.count('seats', soon.length);
      const tickets = soon
        .map((s) => {
          const key = `st-${s.ref}`;
          this.items.set(key, { ...s, kind: 'seat', what: s.gameTitle || 'Your game' });
          const fee = this.feeRows(s, s.people > 1 ? 'Seats' : 'Seat');
          return this.ticket({
            key,
            accent: 'seat',
            eyebrow: dayLabel(s.start),
            title: s.gameTitle || 'GM game',
            rows: [
              ['When', esc(span(s.start, s.end))],
              s.tables && s.tables.length ? ['Tables', esc(tablesText(s.tables))] : null,
              s.gm ? ['GM', esc(s.gm)] : null,
              ['Players', this.players(s.players) || esc(plural(s.people || 1, 'seat', 'seats'))],
              ...fee.rows,
            ],
            notes: this.payNotes(s, fee),
            actions: s.start > Date.now() ? `<button class="button button--small ml-cancel" type="button" data-cancel="${esc(key)}">Give up my seat${s.people > 1 ? 's' : ''}</button>` : '',
          });
        })
        .join('');
      panel.innerHTML = `${tickets ? `<div class="ml-tickets">${tickets}</div>` : this.empty('seats')}${this.pastList(past, (s) => `${s.gameTitle || 'GM game'}, ${plural(s.people || 1, 'seat', 'seats')}`)}`;
    }

    renderJoins(list) {
      const panel = this.panel('joins');
      if (!panel) return;
      const { soon, past } = this.split(list);
      this.count('joins', soon.length);
      const tickets = soon
        .map((j) => {
          const key = `ej-${j.ref}`;
          this.items.set(key, { ...j, kind: 'join', what: j.title || 'Event' });
          const fee = this.feeRows({ ...j, kind: 'join' }, 'Entry');
          const charged = Number(j.amount) > 0;
          return this.ticket({
            key,
            accent: 'event',
            eyebrow: dayLabel(j.start),
            title: j.title || 'Event',
            rows: [
              ['Starts', esc(t.fmtTime(j.start))],
              ['People', esc(j.people || 1)],
              ...(charged ? fee.rows : []),
            ],
            notes: charged ? this.payNotes({ ...j, kind: 'join' }, fee) : '',
          });
        })
        .join('');
      panel.innerHTML = `${tickets ? `<div class="ml-tickets">${tickets}</div>` : this.empty('joins')}${this.pastList(past, (j) => `${j.title || 'Event'}, ${plural(j.people || 1, 'person', 'people')}`)}`;
    }

    /* ---------- games I run ---------- */
    renderGames(data) {
      const panel = this.panel('games');
      if (!panel) return;
      const games = (data.games || []).map((g) => ({ ...g, start: Number(g.start), end: Number(g.end) }));
      const me = data.customer || {};
      const groups = new Map();
      games.forEach((g) => {
        const id = g.seriesId || g.id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(g);
      });
      const now = Date.now();
      const live = [];
      const ended = [];
      for (const sessions of groups.values()) {
        sessions.sort(byStart);
        const next = sessions.find((g) => g.end > now && g.status !== 'cancelled');
        if (next) live.push({ next, later: sessions.filter((g) => g !== next && g.start > next.start && g.status !== 'cancelled').length });
        else ended.push(sessions[sessions.length - 1]);
      }
      live.sort((a, b) => a.next.start - b.next.start);
      this.count('games', live.length);
      const runs = Boolean(games.length || me.gm || me.staff || data.gmProfile);
      let html = live.length ? `<div class="ml-games">${live.map((group) => this.gameCard(group)).join('')}</div>` : this.empty('games');
      if (!live.length && games.length) html = '<p class="small muted">No sessions coming up. List your next one on the games board.</p>';
      html += this.creditsBlock(data.credits || []);
      if (runs) html += this.profileForm(data.gmProfile);
      html += this.pastList(ended, (g) => `${g.title}, ${plural(g.taken || 0, 'player', 'players')}`);
      panel.innerHTML = html;
    }

    gameCard({ next: g, later }) {
      const [label, cls] = GAME_STATUS[g.status] || [g.status, ''];
      const seats = Number(g.seats) || 0;
      const roster = Array.isArray(g.players) ? g.players : [];
      const taken = Math.max(Number(g.taken) || 0, roster.length);
      const left = Math.max(0, seats - taken);
      let pips = '';
      for (let i = 0; i < seats; i += 1) pips += `<span class="ml-pip${i < taken ? ' ml-pip--taken' : ''}"></span>`;
      const when = [SCHEDULE[g.schedule] || '', later ? `${plural(later, 'more session', 'more sessions')} booked` : ''].filter(Boolean).join('. ');
      return `<article class="ml-game ml-game--${ACCENT[g.system] || 'goblin'}">
        <div class="ml-game__top">
          ${g.system ? `<span class="badge">${esc(g.system)}</span>` : ''}
          <span class="badge ${cls}">${esc(label)}</span>
        </div>
        <h3 class="ml-game__title">${esc(g.title)}</h3>
        <p class="ml-game__when"><strong>Next session:</strong> ${esc(dayLabel(g.start))}, ${esc(span(g.start, g.end))}</p>
        <p class="small muted">${esc([tablesText(g.tables), when].filter(Boolean).join('. '))}</p>
        ${g.status === 'pending' ? '<p class="small ml-game__wait">A staff goblin checks new games before they go on the board. We\'ll let you know.</p>' : ''}
        <div class="ml-game__seats"><span class="ml-pips" aria-hidden="true">${pips}</span><span>${esc(`${taken} of ${plural(seats, 'seat', 'seats')} taken`)}${left ? `, ${esc(left)} left` : ''}</span></div>
        ${
          roster.length
            ? `<ul class="ml-roster" role="list">${roster
                .map((p) => `<li><span class="ml-roster__who"><strong>${esc(p.name)}</strong>${p.character ? ` <span class="ml-players__as">as</span> <em>${esc(p.character)}</em>` : ''}</span>${p.paid ? '<span class="badge badge--new">Paid</span>' : '<span class="badge">Pays at the counter</span>'}</li>`)
                .join('')}</ul>`
            : `<p class="small muted">${g.status === 'pending' ? 'Players can join once it\'s approved.' : 'No players yet. Share the games board with your friends!'}</p>`
        }
      </article>`;
    }

    creditsBlock(credits) {
      const earned = credits.filter((c) => c.status === 'credited' || c.status === 'manual');
      if (!earned.length) return '';
      const total = earned.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
      const rows = earned
        .slice()
        .sort((a, b) => Number(b.at) - Number(a.at))
        .slice(0, 4)
        .map((c) => `<li class="ml-past__row"><span class="ml-past__date">${esc(shortDay(Number(c.at)))}</span><span class="ml-past__what">${esc(`${c.title}, ${plural(c.players || 0, 'player', 'players')}`)}</span><span class="ml-credits__amount">${esc(money(c.amount || 0))}</span></li>`)
        .join('');
      return `<div class="ml-credits">
        <p class="ml-credits__total"><span class="ml-credits__big">${esc(money(total))}</span> GM credit in the last 30 days, added to your store credit.</p>
        <ul class="ml-past__list" role="list">${rows}</ul>
      </div>`;
    }

    profileForm(profile) {
      const c = store.cfg.customer || {};
      const name = profile ? profile.name : c.name || '';
      const bio = profile ? profile.bio || '' : '';
      return `<details class="ml-profile"${profile ? '' : ' open'}>
        <summary class="ml-profile__summary">${profile ? 'Edit my GM profile' : 'Set up my GM profile'}</summary>
        <form class="stack ml-profile__form" data-gm-profile novalidate>
          <p class="small muted">Players see this on your games.</p>
          <div class="field">
            <label class="field__label" for="ml-gm-name">Name players see</label>
            <input class="input" id="ml-gm-name" name="name" maxlength="60" required autocomplete="nickname" value="${esc(name)}">
          </div>
          <div class="field">
            <label class="field__label" for="ml-gm-bio">About you as a GM</label>
            <textarea class="textarea" id="ml-gm-bio" name="bio" maxlength="600" rows="4" placeholder="What do you love running? What can players expect at your table?">${esc(bio)}</textarea>
            <p class="field__hint">Up to 600 characters.</p>
          </div>
          <p class="form-message" data-profile-message role="status" hidden></p>
          <button class="button button--potion" type="submit">Save my GM profile</button>
        </form>
      </details>`;
    }

    /* ---------- a code, big: the Goblin card, the tab's code or a ticket's ---------- */
    showQr(button) {
      const dialog = this.qrDialog;
      const code = button.dataset.qrShow;
      if (!dialog || !code) return;
      const kind = button.dataset.qrKind || 'ticket';
      const size = Math.max(180, Math.min(340, window.innerWidth - 80, window.innerHeight - 300));
      dialog.querySelector('[data-qr-title]').textContent = kind === 'ticket' ? 'Your ticket' : 'Your Goblin card';
      dialog.querySelector('[data-qr-plate]').innerHTML = this.qr(code, size, `${kind === 'ticket' ? 'Ticket' : 'Goblin card'} ${code}`);
      dialog.querySelector('[data-qr-code]').textContent = code;
      dialog.querySelector('[data-qr-what]').textContent = kind === 'ticket' ? button.dataset.qrWhat || '' : (this.member && this.member.name) || '';
      const how = dialog.querySelector('[data-qr-how]');
      if (how) {
        how.textContent = kind === 'tab'
          ? 'Show this at the counter to pay your tab.'
          : kind === 'card'
            ? 'Show this at the counter to check in, pay your tab and earn rolls.'
            : 'Show this at the counter to check in. Your Goblin card works too.';
      }
      const opener = button;
      dialog.showModal();
      document.body.classList.add('has-open-dialog');
      dialog.addEventListener('close', () => document.contains(opener) && opener.focus(), { once: true });
    }

    /* ---------- actions ---------- */
    onClick(event) {
      const on = (selector) => event.target.closest(selector);
      let el;
      if (on('[data-retry]')) {
        this.loading = this.load();
        return;
      }
      if ((el = on('[data-qty-box]'))) {
        const stepper = event.target.closest('[data-step]');
        if (!stepper || stepper.disabled) return;
        const delta = Number(stepper.dataset.step);
        if (el.dataset.qtyBox === 'edit') {
          this.stepEdit(el.dataset.id, delta);
          return;
        }
        if (this.step(el.dataset.id, delta)) {
          const picked = this.draft.get(el.dataset.id);
          shop()?.announce(`${el.dataset.name}: ${picked ? picked.qty : 0}`);
        }
        return;
      }
      if (on('[data-scan]')) {
        this.openScanner();
        return;
      }
      if ((el = on('[data-menu-toggle]'))) {
        this.toggleGroup(el.dataset.menuToggle);
        return;
      }
      if ((el = on('[data-tab-save]'))) {
        this.addToTab(el);
        return;
      }
      if (on('[data-tab-edit]')) {
        this.startEdit();
        return;
      }
      if ((el = on('[data-tab-edit-save]'))) {
        this.saveEdit(el);
        return;
      }
      if (on('[data-tab-edit-cancel]')) {
        this.editing = null;
        this.renderTabCard();
        this.syncBar();
        this.querySelector('[data-tab-edit]')?.focus();
        return;
      }
      if (on('[data-tab-clear]')) {
        this.askClear = true;
        this.tabNote = null;
        this.renderTabCard();
        this.querySelector('[data-tab-clear-no]')?.focus();
        return;
      }
      if (on('[data-tab-clear-no]')) {
        this.askClear = false;
        this.renderTabCard();
        this.querySelector('[data-tab-clear]')?.focus();
        return;
      }
      if ((el = on('[data-tab-clear-yes]'))) {
        this.clearTab(el);
        return;
      }
      if ((el = on('[data-qr-show]'))) {
        this.showQr(el);
        return;
      }
      if ((el = on('[data-roll]'))) {
        this.roll(el);
        return;
      }
      if (on('[data-die]')) {
        // A tap on the die rolls one of their rolls, when there's one ready
        const next = this.querySelector('[data-roll]');
        if (next && !next.disabled) this.roll(next);
        return;
      }
      if (on('[data-quote-next]') && this.quotes && this.quotes.length > 1) {
        this.showQuote(this.randomQuote(), true);
        this.queueQuote();
        return;
      }
      if ((el = on('[data-quote-pause]'))) {
        this.pauseQuotes(el);
        return;
      }
      if ((el = on('[data-ics]'))) {
        this.calendar(this.items.get(el.dataset.ics));
        return;
      }
      if ((el = on('[data-cancel]'))) {
        this.askCancel(el.dataset.cancel, el);
        return;
      }
      if ((el = on('[data-leave]'))) {
        this.askLeave(el.dataset.leave, el);
        return;
      }
      if ((el = on('[data-confirm-leave]'))) {
        this.leave(el);
        return;
      }
      if ((el = on('[data-copy]'))) {
        this.copyCode(el);
        return;
      }
      if ((el = on('[data-confirm-cancel]'))) this.cancel(el);
    }

    calendar(item) {
      if (!item) return;
      const where = tablesText(item.tables);
      const url = icsFile({
        title: item.kind === 'table' ? `Dice Goblin table, ${item.ref}` : `${item.what} at Dice Goblin`,
        start: item.start,
        end: endOf(item),
        description: `${where ? `${where}. ` : ''}Show ${item.ref} at the counter.`,
        location: store.cfg.shop.address || 'Dice Goblin',
      });
      const link = document.createElement('a');
      link.href = url;
      link.download = `dice-goblin-${item.ref}.ics`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    askCancel(key, opener) {
      const item = this.items.get(key);
      if (!item || !this.dialog) return;
      this.cancelling = key;
      this.opener = opener;
      const seat = item.kind === 'seat';
      const ahead = item.start - Date.now();
      const fee = seat ? 'seat fee' : 'table fee';
      let refundLine = 'You were paying at the counter, so there\'s nothing to refund.';
      if (item.paid && item.pay === 'now' && item.occurrenceId) {
        refundLine = 'You paid online, so you\'re locked in. If you cancel, have a chat with us about a refund.';
      } else if (item.paid && item.pay === 'now') {
        refundLine = ahead >= this.refundHours * HOUR
          ? `You paid ${money(item.amount || 0)} online. It's more than ${this.refundHours} hours away, so we'll refund you.`
          : `It's less than ${this.refundHours} hours away, so the ${fee} can't be refunded.`;
      } else if (item.paid || Number(item.paidAmount) > 0) {
        refundLine = 'You\'ve paid some of it already, so have a chat with us about a refund.';
      }
      this.querySelector('[data-cancel-title]').textContent = seat ? `Give up your seat${item.people > 1 ? 's' : ''}?` : 'Cancel this booking?';
      this.querySelector('[data-cancel-body]').innerHTML = `
        <p><strong>${esc(seat ? item.what : `${(item.tables || []).length > 1 ? 'Tables' : 'Table'} ${tablesText(item.tables)}`)}</strong><br>${esc(dayLabel(item.start))}, ${esc(span(item.start, endOf(item)))}</p>
        <p>${esc(refundLine)}</p>
        <p class="form-message form-message--error" data-cancel-error role="alert" hidden></p>
        <div class="cluster">
          <button class="button button--ruby" type="button" data-confirm-cancel>${seat ? 'Give up my seat' : 'Cancel booking'}</button>
          <button class="button button--ghost" type="button" data-dialog-close>Keep it</button>
        </div>`;
      this.dialog.showModal();
      document.body.classList.add('has-open-dialog');
      this.dialog.addEventListener('close', () => this.opener && document.contains(this.opener) && this.opener.focus(), { once: true });
    }

    async cancel(button) {
      const item = this.items.get(this.cancelling);
      if (!item || button.getAttribute('aria-busy') === 'true') return;
      const error = this.dialog.querySelector('[data-cancel-error]');
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      try {
        const result = await store.backend.updateBooking(item.id || item.ref, { status: 'cancelled' });
        this.dialog.close();
        const refund = result && result.refund;
        this.notice(
          result && result.notice
            ? result.notice
            : refund && refund.due
              ? `Cancelled ${item.ref}. We'll refund ${money(refund.amount || item.amount || 0)} to you in the next few days.`
              : `Cancelled ${item.ref}. Thanks for letting us know.`,
        );
        await this.load();
      } catch (err) {
        if (error) {
          error.textContent = err.message || 'That didn\'t work. Please try again, or give us a call.';
          error.hidden = false;
        }
      } finally {
        button.removeAttribute('aria-busy');
        button.disabled = false;
      }
    }

    notice(text) {
      const box = this.querySelector('[data-notice]');
      if (!box) return;
      box.textContent = text;
      box.hidden = false;
      box.scrollIntoView({ block: 'nearest', behavior: smooth() });
    }

    async onSubmit(event) {
      const birthday = event.target.closest('[data-birthday]');
      if (birthday) {
        event.preventDefault();
        this.saveBirthday(birthday);
        return;
      }
      const claim = event.target.closest('[data-claim]');
      if (claim) {
        event.preventDefault();
        this.claimPass(claim);
        return;
      }
      const form = event.target.closest('[data-gm-profile]');
      if (!form) return;
      event.preventDefault();
      const message = form.querySelector('[data-profile-message]');
      const button = form.querySelector('[type="submit"]');
      const name = form.name.value.trim();
      const show = (text, ok) => {
        message.textContent = text;
        message.className = `form-message form-message--${ok ? 'success' : 'error'}`;
        message.hidden = false;
      };
      if (!name) {
        show('Add the name players will see.', false);
        form.name.focus();
        return;
      }
      if (typeof store.backend.saveGmProfile !== 'function') {
        show('Saving profiles needs a newer lair-core.js.', false);
        return;
      }
      button.setAttribute('aria-busy', 'true');
      try {
        const { profile } = await store.backend.saveGmProfile({ name, bio: form.bio.value.trim() });
        if (this.data) this.data.gmProfile = profile || { name, bio: form.bio.value.trim() };
        show('Saved. Players see this on your games.', true);
        const summary = form.closest('details')?.querySelector('summary');
        if (summary) summary.textContent = 'Edit my GM profile';
      } catch (err) {
        show(err.message || 'That didn\'t save. Please try again.', false);
      } finally {
        button.removeAttribute('aria-busy');
      }
    }
  }

  customElements.define('my-lair', MyLair);
})();
