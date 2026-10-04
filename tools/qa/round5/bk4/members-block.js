    /* ---------- members (round 5): the list, a member's page, birthday gifts, and waiving what they owe ----------
       The list is GET /members?q=&sort=&owing=1: the top 100 by the sort, or who a search finds. A member's page loads
       them again by customer ID, their day at the counter (a member code checks nothing in, and brings what they owe
       from earlier weekly-game sessions) and their passes. */

    /** The list, for the search, sort and "Owes money" as they are now. A newer ask wins over one still on its way. */
    async loadMembers() {
      const m = this.members;
      const ask = `${m.q}|${m.sort}|${m.owing ? 1 : 0}`;
      m.asked = ask;
      m.loading = true;
      this.renderMembers();
      try {
        const be = store.backend;
        const data = typeof be.members === 'function' ? await be.members({ q: m.q, sort: m.sort, owing: m.owing }) : m.q ? await be.findMembers(m.q) : [];
        if (m.asked !== ask) return;
        m.list = asList(data, 'members', 'results').filter((x) => x && x.customerId != null);
        m.list.forEach((x) => this.keepPerson(x));
        Object.assign(m, { error: null, loadedAt: Date.now() });
      } catch (error) {
        if (m.asked !== ask) return;
        m.error = error.message || 'The members didn’t load. Try again in a moment.';
      }
      m.loading = false;
      this.renderMembers();
    }

    /** What the page knows about a member: from the list, a search, the birthdays or their own page */
    keepPerson(x) {
      if (!x || x.customerId == null) return null;
      const id = String(x.customerId);
      const people = this.members.people;
      people[id] = { ...(people[id] || {}), ...x, customerId: id };
      return people[id];
    }

    /** Members, searched for something (a member code from a check-in card without a customer ID) */
    findMember(q) {
      Object.assign(this.members, { view: null, q: String(q || '').trim(), confirm: null, gift: null });
      if (this.tab !== 'members') this.setTab('members');
      if (!this.members.loading) this.loadMembers();
      this.querySelector('#tab-members')?.scrollIntoView({ block: 'start' });
    }

    /** A member's page: from the list, the birthdays, or a member card at check-in (seen: what that card knows) */
    openMember(id, seen = null) {
      const m = this.members;
      const key = String(id);
      if (seen) this.keepPerson({ ...seen, customerId: key });
      Object.assign(m, { view: { kind: 'member', id: key }, confirm: null, gift: null });
      this.waiveAsk = null;
      if (this.tab !== 'members') this.setTab('members');
      else this.renderMembers();
      this.querySelector('#tab-members')?.scrollIntoView({ block: 'start' });
      this.loadPerson(key);
    }

    /** Back to the list */
    closeMember() {
      Object.assign(this.members, { view: null, confirm: null, gift: null });
      this.waiveAsk = null;
      this.renderMembers();
      if (!this.members.list && !this.members.loading) this.loadMembers();
      this.querySelector('#tab-members')?.scrollIntoView({ block: 'start' });
    }

    /** A member's page, fresh: the member again (spend, what they owe, prizes), their day at the counter with what they
        owe from earlier sessions (a member code checks nothing in), and their passes */
    async loadPerson(id) {
      const m = this.members;
      const be = store.backend;
      const d = (m.detail[id] = { ...(m.detail[id] || {}), loading: true, error: null });
      this.renderMembers();
      try {
        const data = typeof be.members === 'function' ? await be.members({ q: id, sort: 'recent' }) : await be.findMembers(id);
        const found = asList(data, 'members', 'results').find((x) => x && String(x.customerId) === id);
        if (found) this.keepPerson(found);
        else if (!(m.people[id] && m.people[id].name)) d.error = 'That member couldn’t be found.';
      } catch (error) {
        d.error = error.message || 'Their details didn’t load. Try again.';
      }
      const person = m.people[id] || {};
      const code = m.fresh[id] || person.code || '';
      const email = String(person.email || '').toLowerCase();
      const [card, passes] = await Promise.all([
        code ? be.checkin({ code }).catch((error) => ({ failed: error })) : null,
        typeof be.listPasses === 'function'
          ? be.listPasses(person.email || person.name || code, 'all').then((x) => asList(x, 'passes'), (error) => ({ failed: error }))
          : [],
      ]);
      if (card && card.failed) d.rowsError = card.failed.message || 'What they owe didn’t load.';
      else {
        d.rowsError = null;
        const rows = card ? asList(card.rows).map((x) => ({ ...x, type: x.type || 'booking', tables: x.tables || [] })) : [];
        // the floor's bookings too, for an owed row the member card didn't bring
        const known = new Set(rows.map((x) => x.id));
        const extra = store.data.bookings
          .filter((b) => b.owed && !b.waived && String(b.customerId || '') === id && !known.has(b.id))
          .map((b) => this.rowOfBooking(b));
        d.rows = [...rows, ...extra];
      }
      if (passes && passes.failed) d.passesError = passes.failed.message || 'Their passes didn’t load.';
      else {
        d.passesError = null;
        const holderOf = (p) => p.holder || { customerId: p.customerId, email: p.holderEmail };
        const rank = (p) => ((p.status || 'active') === 'active' ? 0 : 1);
        d.passes = (passes || [])
          .filter((p) => {
            const h = holderOf(p);
            if (h.customerId) return String(h.customerId) === id;
            return Boolean(email) && String(h.email || '').toLowerCase() === email;
          })
          .sort((a, b) => rank(a) - rank(b) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      }
      d.loading = false;
      this.renderMembers();
    }

    renderMembers() {
      const wrap = this.querySelector('[data-members]');
      if (!wrap) return;
      const m = this.members;
      const v = m.view;
      const mode = v ? `${v.kind}:${v.id}` : 'list';
      // each view is drawn once when it opens (so typing survives a redraw), then its parts are kept current
      if (wrap.dataset.mode !== mode) {
        wrap.dataset.mode = mode;
        wrap.innerHTML = !v ? this.membersListHtml() : v.kind === 'member' ? this.personHtml() : v.kind === 'gift' ? this.giftFormHtml(v.id) : this.giftDoneHtml(v.id);
        if (v && v.kind === 'gift') this.paintGiftProduct();
        wrap.querySelectorAll('svg.qr').forEach((svg) => fitQr(svg, 152));
      }
      if (!v) this.paintMemberList();
      else if (v.kind === 'member') this.paintPerson(v.id);
      const birthdays = this.querySelector('[data-birthdays]');
      if (birthdays) birthdays.hidden = Boolean(v);
    }

    membersListHtml() {
      const m = this.members;
      return `<div class="staff-members">
        <h3 class="h3">Members</h3>
        <form class="staff-members__tools" role="search" data-members-form novalidate>
          <div class="field staff-search">
            <label class="field__label" for="members-find">Find a member</label>
            <input class="input" id="members-find" name="q" type="search" data-members-find value="${esc(m.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="Name, email or member code" aria-describedby="members-find-hint">
            <span class="field__hint" id="members-find-hint">Their member code is on the card in their My Lair.</span>
          </div>
          <div class="staff-members__filters">
            <fieldset class="staff-members__group"><legend class="field__label">Sort by</legend><div class="cluster">
              ${SORTS.map(([value, label]) => `<label class="chip"><input class="chip__input" type="radio" name="members-sort" value="${value}" data-members-sort="${value}"${m.sort === value ? ' checked' : ''}><span class="chip__label">${label}</span></label>`).join('')}
            </div></fieldset>
            <fieldset class="staff-members__group"><legend class="field__label">Show</legend><div class="cluster">
              <label class="chip staff-members__owing"><input class="chip__input" type="checkbox" name="owing" data-members-owing${m.owing ? ' checked' : ''}><span class="chip__label">Owes money</span></label>
            </div></fieldset>
          </div>
        </form>
        <div data-members-list aria-live="polite"></div>
      </div>`;
    }

    paintMemberList() {
      const box = this.querySelector('[data-members-list]');
      if (!box) return;
      const m = this.members;
      let html;
      if (m.error) html = `<div class="form-message form-message--error"><p>${esc(m.error)}</p></div>`;
      else if (!m.list) html = '<p class="muted">Loading the members…</p>';
      else if (!m.list.length) {
        html = m.q
          ? `<p class="muted">No members${m.owing ? ' who owe money' : ''} match “${esc(m.q)}”.${m.owing ? ' Try it without Owes money.' : ' People become members when they book, join a game or open My Lair.'}</p>`
          : `<p class="muted">${m.owing ? 'Nobody owes anything right now.' : 'No members yet. People become members when they book, join a game or open My Lair.'}</p>`;
      } else {
        const by = { spend: 'spend this year', recent: 'last visit', owing: 'what they owe' }[m.sort] || 'spend this year';
        const count = m.q
          ? `${plural(m.list.length, 'member', 'members')} found, by ${by}`
          : `${m.list.length >= 100 ? 'The top 100 members' : plural(m.list.length, 'member', 'members')}${m.owing ? ' who owe money' : ''}, by ${by}`;
        html = `<p class="small muted staff-mem-count">${esc(count)}</p>
          <div class="staff-mem-head" aria-hidden="true"><span>Member</span><span>This year</span><span>Total</span><span>Last visit</span><span>Owed</span><span>Open tab</span></div>
          <ul class="staff-mem-rows" role="list">${m.list.map((x) => this.memberRowHtml(x)).join('')}</ul>`;
      }
      if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
      }
      box.classList.toggle('is-loading', Boolean(m.loading && m.list));
    }

    /** One member in the list: a card on a phone, a row of columns on a wider screen. One tap opens their page. */
    memberRowHtml(x) {
      const id = String(x.customerId);
      const code = this.members.fresh[id] || x.code || '';
      const owed = Number(x.owed) || 0;
      const tab = Number(x.openTab) || 0;
      const prizes = asList(x.pendingPrizes).filter((p) => p && p.status !== 'done').length;
      const badges = `${prizes ? `<span class="badge staff-prize-badge">${prizes > 1 ? `${prizes} prizes waiting` : 'Prize waiting'}</span>` : ''}${x.giftedThisYear ? '<span class="badge badge--new">Gifted</span>' : ''}`;
      const cell = (key, label, value, state = '') => `<span class="staff-mem-row__cell staff-mem-row__cell--${key}${state}"><span class="staff-mem-row__k">${label}</span><span class="staff-mem-row__v">${value}</span></span>`;
      const count = Number(x.owedCount) || 0;
      return `<li><button class="staff-mem-row${owed || tab ? ' is-owing' : ''}" type="button" data-member-view="${esc(id)}">
          <span class="staff-mem-row__who"><strong class="staff-mem-row__name">${esc(x.name || x.email || 'Member')}</strong><span class="staff-mem-row__code staff-card__code">${esc(code || 'No code yet')}</span>${badges ? `<span class="staff-mem-row__badges">${badges}</span>` : ''}</span>
          ${cell('year', 'This year', money(Number(x.spendYear) || 0))}
          ${cell('total', 'Total', money(Number(x.spendTotal) || 0))}
          ${cell('seen', 'Last visit', esc(seenText(x.lastSeen)))}
          ${cell('owed', 'Owed', owed ? `${money(owed)}${count ? `<span class="staff-mem-row__n">${plural(count, 'session', 'sessions')}</span>` : ''}` : '<span aria-label="nothing">—</span>', owed ? ' is-due' : ' is-zero')}
          ${cell('tab', 'Open tab', tab ? money(tab) : '<span aria-label="nothing">—</span>', tab ? ' is-due' : ' is-zero')}
        </button></li>`;
    }

    /** A member's page: drawn once, then its parts are kept current */
    personHtml() {
      return `<div class="staff-person">
        <button class="text-link staff-gm__back" type="button" data-members-back>‹ All members</button>
        <div class="staff-person__main" data-person-card></div>
        <div class="staff-person__side">
          <section class="staff-gm__section" data-person-owed></section>
          <section class="staff-gm__section" data-person-prizes hidden></section>
          <section class="staff-gm__section" data-person-passes></section>
          <section class="staff-gm__section" data-person-gifts></section>
        </div>
      </div>`;
    }

    paintPerson(id) {
      const m = this.members;
      const x = m.people[id] || { customerId: id };
      const d = m.detail[id] || {};
      const put = (sel, html) => {
        const el = this.querySelector(sel);
        if (!el) return null;
        el.hidden = !html;
        if (el.dataset.html === html) return null;
        el.dataset.html = html;
        el.innerHTML = html;
        return el;
      };
      const card = put('[data-person-card]', this.personCardHtml(x, d));
      if (card) fitQr(card.querySelector('svg.qr'), 168);
      put('[data-person-owed]', this.personOwedHtml(x, d));
      put('[data-person-prizes]', this.personPrizesHtml(x));
      put('[data-person-passes]', this.personPassesHtml(x, d));
      put('[data-person-gifts]', this.personGiftsHtml(x));
    }

    /** Who they are: name, email, badges, their member code and its QR, spend, last visit, birthday, and what to do */
    personCardHtml(x, d = {}) {
      const id = String(x.customerId);
      const m = this.members;
      const first = firstOf(x);
      const code = m.fresh[id] || x.code || '';
      const qr = code && window.DGQR ? window.DGQR.svg(code, { size: 168, margin: 4, label: `member code ${code}` }) : '';
      const owed = Number(x.owed) || 0;
      const tab = Number(x.openTab) || 0;
      const prizes = asList(x.pendingPrizes).filter((p) => p && p.status !== 'done').length;
      const badges = [
        owed ? `<span class="badge staff-prize-badge">Owes ${money(owed)}</span>` : '',
        tab ? `<span class="badge staff-prize-badge">Tab ${money(tab)}</span>` : '',
        prizes ? `<span class="badge staff-prize-badge">${prizes > 1 ? `${prizes} prizes waiting` : 'Prize waiting'}</span>` : '',
        x.giftedThisYear || this.giftsFor(x).length ? '<span class="badge badge--new">Gifted this year</span>' : '',
      ].join('');
      const facts = [
        ['This year', money(Number(x.spendYear) || 0)],
        ['Total', money(Number(x.spendTotal) || 0)],
        ['Last visit', seenText(x.lastSeen)],
        ['Birthday', birthdayText(x.birthday) || 'Not given'],
      ];
      const confirm = m.confirm === `code:${id}`
        ? `<div class="staff-confirm" role="group" aria-labelledby="code-q-${esc(id)}">
            <p id="code-q-${esc(id)}"><strong>Make a new member code for ${esc(first)}?</strong> ${code ? `<span class="staff-card__code">${esc(code)}</span> stops working straight away, and their` : 'Their'} My Lair shows the new one.</p>
            <div class="cluster">
              <button class="button button--small" type="button" data-member-new-code="${esc(id)}">Yes, new code</button>
              <button class="button button--ghost button--small" type="button" data-member-confirm="">Keep ${code ? 'this one' : 'it as is'}</button>
            </div>
          </div>`
        : '';
      return `<article class="staff-person__card">
        <header class="staff-person__head">
          <h3 class="h3 staff-person__name">${esc(x.name || x.email || 'Member')}</h3>
          <p class="small muted">${x.email ? esc(x.email) : x.name && 'email' in x ? 'No email on file' : ''}</p>
          ${badges ? `<p class="cluster staff-person__badges">${badges}</p>` : ''}
          ${d.error ? `<p class="small staff-photo__error">${esc(d.error)} <button class="text-link" type="button" data-member-retry="${esc(id)}">Try again</button></p>` : ''}
        </header>
        <div class="staff-person__code">
          ${qr ? `<div class="staff-person__qr">${qr}</div>` : ''}
          <p class="staff-person__code-text"><span class="small muted">Member code</span><strong class="staff-card__code">${esc(code || 'None yet')}</strong>${m.fresh[id] ? '<span class="badge badge--new">New</span>' : ''}</p>
        </div>
        <dl class="staff-person__facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="cluster staff-person__actions">
          <button class="button button--small" type="button" data-gift-open="${esc(id)}">Send a gift</button>
          <button class="button button--ghost button--small" type="button" data-member-pass="${esc(id)}">Issue a pass</button>
          ${confirm ? '' : `<button class="button button--ghost button--small" type="button" data-member-confirm="code:${esc(id)}">New member code</button>`}
        </div>
        ${confirm}
      </article>`;
    }

    /** What they owe: each earlier weekly-game session that ended unpaid, with Waive, and their open tab */
    personOwedHtml(x, d) {
      const id = String(x.customerId);
      const first = firstOf(x);
      const rows = (d.rows || []).filter((r) => r.owed || r.waived).map((r) => this.liveRow(r));
      const open = rows.filter((r) => !r.waived && ledger(r).due);
      const total = Number(x.owed) || 0;
      const count = Number(x.owedCount) || 0;
      const tab = Number(x.openTab) || 0;
      let body;
      if (!d.rows && d.loading) body = '<p class="small muted">Looking up what they owe…</p>';
      else if (rows.length) body = `<ul class="staff-owed" role="list">${rows.map((r) => this.owedRowHtml(r, first)).join('')}</ul>`;
      else if (total) body = `<p class="small">${esc(first)} owes ${money(total)}${count ? ` for ${plural(count, 'session', 'sessions')}` : ''}, but ${count > 1 ? 'they' : 'it'} didn’t load here. Scan their code on the POS to see ${count > 1 ? 'them' : 'it'}.</p>`;
      else body = '<p class="small muted">Nothing owed.</p>';
      const more = open.length && count > open.length
        ? `<p class="small muted">${plural(count - open.length, 'more owed session isn’t', 'more owed sessions aren’t')} listed here. Scan their code on the POS to see everything.</p>`
        : '';
      const tabLine = tab ? `<p class="staff-owed__tab"><strong>Open tab: ${money(tab)}</strong> <span class="small muted">Scan their code on the POS to add it to the sale.</span></p>` : '';
      const error = d.rowsError ? `<p class="small staff-photo__error">${esc(d.rowsError)} <button class="text-link" type="button" data-member-retry="${esc(id)}">Try again</button></p>` : '';
      return `<h4 class="staff-sheet__sub">Owed${total ? ` · ${money(total)}` : ''}</h4>${body}${more}${tabLine}${error}`;
    }

    /** Dice prizes Shopify couldn't add, given at the counter: Mark done (nothing when there are none) */
    personPrizesHtml(x) {
      const id = String(x.customerId);
      const prizes = asList(x.pendingPrizes).filter((p) => p && p.status !== 'done');
      if (!prizes.length) return '';
      const what = (p) => (p.kind === 'percent' ? `${p.percent || 10}% off` : `${money(Number(p.amount) || 0)} store credit`);
      const rolled = (p) => (p.roll ? ` · rolled ${Number(p.roll) === 20 ? 'a natural 20' : `${[8, 11, 18].includes(Number(p.roll)) ? 'an' : 'a'} ${p.roll}`}` : '');
      return `<h4 class="staff-sheet__sub">Dice prizes waiting</h4>
        <ul class="staff-prizes" role="list">${prizes
          .map((p) => `<li class="staff-prize">
              <span><strong>${esc(what(p))}</strong> to sort at the counter${esc(rolled(p))}${p.at ? ` · ${esc(t.fmtDate(t.key(Number(p.at))).replace(',', ''))}` : ''}</span>
              <button class="button button--gold button--small" type="button" data-prize-done="${esc(p.id)}" data-member="${esc(id)}">Mark done</button>
            </li>`)
          .join('')}</ul>`;
    }

    /** Their passes, where each came from; one tap opens it under Passes */
    personPassesHtml(x, d) {
      const id = String(x.customerId);
      let body;
      if (d.passesError) body = `<p class="small staff-photo__error">${esc(d.passesError)} <button class="text-link" type="button" data-member-retry="${esc(id)}">Try again</button></p>`;
      else if (!d.passes) body = '<p class="small muted">Loading their passes…</p>';
      else if (!d.passes.length) body = '<p class="small muted">No passes.</p>';
      else body = `<ul class="staff-pass-rows" role="list">${d.passes.map((p) => this.passRowHtml(p)).join('')}</ul>`;
      return `<h4 class="staff-sheet__sub">Passes</h4>${body}`;
    }

    /** This year's birthday gifts */
    personGiftsHtml(x) {
      const gifts = this.giftsFor(x);
      let body;
      if (gifts.length) {
        body = `<ul class="staff-gifts" role="list">${gifts
          .map((g) => `<li class="staff-gifts__item"><span class="staff-gifts__when">${esc(shortDate(Number(g.at)))}</span><span class="staff-gifts__what">${esc(this.giftText(g))}${g.emailed ? ' <span class="badge">Emailed</span>' : ''}</span></li>`)
          .join('')}</ul>`;
      } else if (x.giftedThisYear) body = `<p class="small">${esc(firstOf(x))} has had a birthday gift this year.</p>`;
      else body = '<p class="small muted">No birthday gift yet this year.</p>';
      return `<h4 class="staff-sheet__sub">Birthday gifts this year</h4>${body}`;
    }

    /** POST /prizes/:id/done: the credit's been given at the counter */
    async prizeDone(button) {
      button.disabled = true;
      const m = this.members;
      const id = button.dataset.member;
      const prizeId = button.dataset.prizeDone;
      try {
        await store.backend.markPrizeDone(prizeId);
        const drop = (x) => {
          if (x) x.pendingPrizes = asList(x.pendingPrizes).filter((p) => p.id !== prizeId);
        };
        drop(m.people[id]);
        drop((m.list || []).find((x) => String(x.customerId) === id));
        this.toast(`Done. ${m.people[id] ? `${firstOf(m.people[id])}’s` : 'The'} prize is sorted.`);
      } catch (error) {
        button.disabled = false;
        this.toast(error.message || 'That didn’t work. Try again.');
      }
      this.renderMembers();
    }

    /** POST /members/:customerId/new-code (after it asks): the old code stops working */
    async newMemberCode(button) {
      button.disabled = true;
      const m = this.members;
      const id = button.dataset.memberNewCode;
      try {
        const { code } = await store.backend.newMemberCode(id);
        m.fresh[id] = code;
        if (m.people[id]) m.people[id].code = code;
        const listed = (m.list || []).find((x) => String(x.customerId) === id);
        if (listed) listed.code = code;
        m.confirm = null;
        this.toast(`New member code: ${code}. The old one won’t work any more.`);
      } catch (error) {
        button.disabled = false;
        this.toast(error.message || 'That didn’t work. Try again.');
      }
      this.renderMembers();
    }

    /* ---------- waiving an owed row (round 5): POST /bookings/:id/update { waived: true }, after it asks ---------- */
    /** An owed row the page has: on the check-in card or a member's page */
    owedRowById(id) {
      const r = this.result;
      const rows = [
        ...(r && Array.isArray(r.rows) ? r.rows : []),
        ...(r && r.row ? [r.row] : []),
        ...Object.values(this.members.detail).flatMap((d) => d.rows || []),
      ];
      const row = rows.find((x) => x && x.id === id);
      return row ? this.liveRow(row) : null;
    }

    /** What's owed on it goes to nothing: the check-in card and their page show it waived straight away, then their
        totals load again */
    async waive(button) {
      const id = button.dataset.waiveYes;
      if (!id || button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      const row = this.owedRowById(id);
      const said = row ? `Waived: ${money(ledger(row).due)} for ${this.rowTitleOf(row)}. ${firstOf(row)} doesn’t owe it any more.` : 'Waived. They don’t owe it any more.';
      try {
        await store.mutate('updateBooking', id, { waived: true });
        this.waiveAsk = null;
        this.markWaived(id, row);
        this.toast(said);
        const v = this.members.view;
        if (v && v.kind === 'member') this.loadPerson(v.id);
        if (this.members.list) this.loadMembers();
      } catch (error) {
        this.toast(error.message || 'That didn’t work. Try again.');
      } finally {
        if (button.isConnected) button.removeAttribute('aria-busy');
      }
      this.renderCheckin(true);
      this.renderMembers();
    }

    /** A row waived: nothing to pay, not owed; and what the page knows of its member owes that much less */
    markWaived(id, row = null) {
      const patch = (x) => (x && x.id === id ? { ...x, owed: false, waived: true, due: 0 } : x);
      const r = this.result;
      if (r && Array.isArray(r.rows)) r.rows = r.rows.map(patch);
      if (r && r.row) r.row = patch(r.row);
      Object.values(this.members.detail).forEach((d) => {
        if (Array.isArray(d.rows)) d.rows = d.rows.map(patch);
      });
      const who = row && row.customerId ? this.members.people[String(row.customerId)] : null;
      if (who && Number(who.owed) > 0) {
        who.owed = Math.max(0, Number(who.owed) - ledger(row).due);
        who.owedCount = Math.max(0, (Number(who.owedCount) || 1) - 1);
      }
    }

    /* ---------- birthday gifts (round 5): staff choose, from a member's page or the birthdays list ----------
       POST /members/:customerId/gift: any of store credit (dollars), a pass of sessions, extra dice rolls and a free
       product (a one-use code just for them), with an email. A part that fails comes back in problems; the rest still
       go through, and the page says which did. */

    /** What to suggest: the Lair app's range (in dollars), or 2% and 5% of their spend over the last year, rounded to the
        dollar, at least $2 each */
    suggestionFor(x) {
      const s = x && x.suggested;
      if (s && Number.isFinite(Number(s.low)) && Number.isFinite(Number(s.high))) return { low: Number(s.low), high: Number(s.high), spend: x.spendYear };
      if (!x || x.spendYear == null) return null;
      const dollars = Math.max(0, Number(x.spendYear) || 0) / 100;
      return { low: Math.max(2, Math.round(dollars * 0.02)), high: Math.max(2, Math.round(dollars * 0.05)), spend: x.spendYear };
    }

    /** This year's gifts the page knows of: sent from here, and what the Lair app sends (gifts, or the birthday list's
        lastGift), each once */
    giftsFor(x) {
      const year = t.today().slice(0, 4);
      const id = String(x.customerId);
      const sent = (this.members.sent[id] || []).map((s) => this.giftOf(s)).filter((g) => g.credit || g.sessions || g.rolls || g.product);
      const seen = new Set();
      return [...sent, ...asList(x.gifts), ...(x.lastGift ? [x.lastGift] : [])]
        .filter((g) => g && g.at && t.key(Number(g.at)).slice(0, 4) === year)
        .filter((g) => {
          const key = g.id || String(g.at);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => Number(b.at) - Number(a.at));
    }

    /** A gift in words: "$15 store credit, 2 sessions (pass AN-OCTOPUS-10) and Wingspan (code HBD-ANOCTOPUS10)" */
    giftText(g) {
      const parts = [];
      if (Number(g.credit) > 0) parts.push(`${money(Number(g.credit))} store credit`);
      if (Number(g.sessions) > 0) parts.push(`${plural(Number(g.sessions), 'session', 'sessions')}${g.passCode ? ` (pass ${g.passCode})` : ''}`);
      if (Number(g.rolls) > 0) parts.push(plural(Number(g.rolls), 'dice roll', 'dice rolls'));
      if (g.product && g.product.title) parts.push(`${g.product.title}${g.product.code ? ` (code ${g.product.code})` : ''}`);
      return parts.length ? listText(parts) : 'A gift';
    }

    openGift(id, from = 'member') {
      const m = this.members;
      const key = String(id);
      Object.assign(m, { view: { kind: 'gift', id: key, from }, confirm: null, gift: { id: key, product: null, variantId: null, q: '', results: null, searching: false, error: null } });
      this.waiveAsk = null;
      if (this.tab !== 'members') this.setTab('members');
      else this.renderMembers();
      this.querySelector('#tab-members')?.scrollIntoView({ block: 'start' });
    }

    /** Back from the gift form or what it did: to their page, or the list when it came from the birthdays */
    giftBack() {
      const v = this.members.view;
      if (v && v.from !== 'birthdays') this.openMember(v.id);
      else this.closeMember();
    }

    giftFormHtml(id) {
      const m = this.members;
      const x = m.people[id] || { customerId: id };
      const first = firstOf(x);
      const s = this.suggestionFor(x);
      const known = this.giftsFor(x);
      const bday = birthdayText(x.birthday);
      const noEmail = Object.prototype.hasOwnProperty.call(x, 'email') && !x.email;
      const already = x.giftedThisYear || known.length
        ? `<p class="staff-gift__warn"><strong>${esc(first)} has had a birthday gift this year${known[0] ? `: ${esc(this.giftText(known[0]))} on ${esc(shortDate(Number(known[0].at)))}` : ''}.</strong> You can still send another.</p>`
        : '';
      const stepper = (name, label, hint) => `<div class="booking__row staff-gift__count">
          <span class="field__label" id="gift-${name}-label">${label}</span>
          <div class="stepper"><button class="stepper__button" type="button" data-seats-step="-1" aria-label="One fewer">−</button><input class="stepper__value" name="${name}" type="number" inputmode="numeric" min="0" max="20" value="0" data-seats aria-labelledby="gift-${name}-label" aria-describedby="gift-${name}-hint"><button class="stepper__button" type="button" data-seats-step="1" aria-label="One more">+</button></div>
          <span class="small muted" id="gift-${name}-hint">${hint}</span>
        </div>`;
      return `<div class="staff-gift">
        <button class="text-link staff-gm__back" type="button" data-gift-back>‹ ${esc(m.view && m.view.from === 'birthdays' ? 'All members' : `${first}’s page`)}</button>
        <div class="staff-gift__head">
          <h3 class="h3">Send ${esc(first)} a birthday gift</h3>
          <p class="small muted">${esc(x.name || x.email || '')}${bday ? ` · Birthday ${esc(bday)}` : ''}${x.code ? ` · <span class="staff-card__code">${esc(x.code)}</span>` : ''}</p>
        </div>
        ${already}
        <form class="staff-form staff-gift__form" data-gift-form data-id="${esc(id)}" novalidate>
          <div class="field">
            <label class="field__label" for="gift-credit">Store credit <span class="muted">($)</span></label>
            <input class="input staff-gift__money" id="gift-credit" name="credit" type="number" inputmode="decimal" min="0" max="1000" step="0.01" value="${s ? s.low : ''}" placeholder="0" aria-describedby="gift-credit-hint">
            <span class="field__hint" id="gift-credit-hint">${s ? `Suggested $${s.low}–$${s.high} (2–5% of ${money(Number(s.spend) || 0)} this year). ` : ''}Empty or 0 for none.</span>
          </div>
          <div class="booking__grid">
            ${stepper('sessions', 'Sessions', `A pass on their account. Each session covers a table fee, up to ${money(store.cfg.prices.table)}.`)}
            ${stepper('rolls', 'Dice rolls', 'Extra rolls in My Lair. They don’t expire.')}
          </div>
          <div class="field staff-gift__product">
            <span class="field__label" id="gift-product-label">A product <span class="muted">(optional)</span></span>
            <div data-gift-product></div>
            <span class="field__hint" id="gift-product-hint">They get a code that makes it free: one use, just for them, for 30 days.</span>
          </div>
          <div class="field"><label class="field__label" for="gift-note">Note <span class="muted">(optional)</span></label><textarea class="textarea staff-gift__note" id="gift-note" name="note" rows="2" maxlength="300"></textarea></div>
          <label class="check staff-gift__email"><input class="check__input" type="checkbox" name="notify"${noEmail ? ' disabled' : ' checked'}><span class="check__text"><strong>Email them</strong><span class="small muted">${noEmail
            ? 'No email on file, so tell them at the counter.'
            : `“Happy birthday from Gobgob!”${x.email ? ` to ${esc(x.email)}` : ''}, with every gift and the product code.`}</span></span></label>
          <p class="form-message form-message--error" data-form-error hidden></p>
          <button class="button button--block" type="submit">Send the gift</button>
        </form>
      </div>`;
    }

    /** The gift's product: the shop search, or the one picked (and which one, when it comes in more than one) */
    paintGiftProduct() {
      const box = this.querySelector('[data-gift-product]');
      const g = this.members.gift;
      if (!box || !g) return;
      if (g.product) {
        const p = g.product;
        const picked = p.variants.find((v) => v.id === String(g.variantId)) || p.variants[0];
        box.innerHTML = `<div class="staff-gift__picked">
            ${p.image ? `<img class="staff-gift__img" src="${esc(p.image)}" alt="" width="48" height="48" loading="lazy">` : ''}
            <span class="staff-gift__picked-text"><strong>${esc(p.title)}</strong><span class="small muted">${esc(money(picked.price))}${picked.title ? ` · ${esc(picked.title)}` : ''}</span></span>
            <button class="text-link staff-gift__change" type="button" data-gift-unpick>Change</button>
          </div>
          ${p.variants.length > 1 ? `<div class="field"><label class="field__label" for="gift-variant">Which one</label><select class="select" id="gift-variant" data-gift-variant>${p.variants
            .map((v) => `<option value="${esc(v.id)}"${v.id === picked.id ? ' selected' : ''}>${esc(v.title || p.title)} · ${esc(money(v.price))}${v.available ? '' : ' (sold out)'}</option>`)
            .join('')}</select></div>` : ''}`;
        return;
      }
      box.innerHTML = `<div class="staff-gift__search">
          <input class="input" id="gift-product" type="search" data-gift-search value="${esc(g.q || '')}" placeholder="Search the shop" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-labelledby="gift-product-label" aria-describedby="gift-product-hint">
          <div class="staff-gift__results" data-gift-results aria-live="polite"></div>
        </div>`;
      this.paintGiftResults();
    }

    paintGiftResults() {
      const box = this.querySelector('[data-gift-results]');
      const g = this.members.gift;
      if (!box || !g) return;
      let html = '';
      if (g.error) html = `<p class="small staff-photo__error">${esc(g.error)}</p>`;
      else if (g.picking) html = '<p class="small muted">Opening it…</p>';
      else if (g.searching && !g.results) html = '<p class="small muted">Searching the shop…</p>';
      else if (g.results && !g.results.length) html = `<p class="small muted">Nothing in the shop matches “${esc(g.q)}”.</p>`;
      else if (g.results) {
        html = `<ul class="staff-member__list" role="list">${g.results
          .map((r) => `<li><button class="staff-member__option staff-gift__option" type="button" data-gift-pick="${esc(r.handle)}">${r.image ? `<img class="staff-gift__img" src="${esc(r.image)}" alt="" width="40" height="40" loading="lazy">` : '<span class="staff-gift__img" aria-hidden="true"></span>'}<span class="staff-gift__option-text"><strong>${esc(r.title)}</strong>${r.price ? `<span class="small muted">${esc(r.price)}</span>` : ''}</span></button></li>`)
          .join('')}</ul>`;
      }
      if (box.dataset.html !== html) {
        box.dataset.html = html;
        box.innerHTML = html;
      }
    }

    /** The shop's predictive search, products only, without library copies and gift cards */
    async searchProducts(q) {
      const g = this.members.gift;
      if (!g) return;
      g.q = q;
      if (q.length < 2) {
        Object.assign(g, { results: null, searching: false, error: null });
        this.paintGiftResults();
        return;
      }
      g.asked = (g.asked || 0) + 1;
      const ask = g.asked;
      Object.assign(g, { searching: true, error: null });
      this.paintGiftResults();
      try {
        const response = await fetch(`${ROOT}search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Search: ${response.status}`);
        const data = await response.json();
        if (g.asked !== ask || this.members.gift !== g) return;
        const found = (data && data.resources && data.resources.results && data.resources.results.products) || [];
        g.results = found
          .filter(giftable)
          .map((p) => ({
            handle: p.handle || (String(p.url || '').match(/\/products\/([^/?#]+)/) || [])[1] || '',
            title: p.title || 'Product',
            price: p.price != null && p.price !== '' && Number.isFinite(Number(p.price)) ? money(Math.round(Number(p.price) * 100)) : '',
            image: thumb(p.image || p.featured_image),
          }))
          .filter((p) => p.handle)
          .slice(0, 6);
      } catch {
        if (g.asked !== ask || this.members.gift !== g) return;
        g.error = 'The shop search isn’t working right now. Try again in a moment.';
      }
      g.searching = false;
      this.paintGiftResults();
    }

    /** A product picked: its variants from /products/<handle>.js. A membership can't be a gift code. */
    async pickProduct(handle) {
      const g = this.members.gift;
      if (!g || !handle) return;
      Object.assign(g, { picking: handle, error: null });
      this.paintGiftResults();
      try {
        const response = await fetch(`${ROOT}products/${encodeURIComponent(handle)}.js`, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Product ${handle}: ${response.status}`);
        const p = await response.json();
        if (this.members.gift !== g) return;
        if (p.requires_selling_plan) {
          Object.assign(g, { picking: null, error: `${p.title || 'That one'} is a membership, so it can’t be a gift code. Pick something else.` });
          this.paintGiftResults();
          return;
        }
        const variants = asList(p.variants).map((v) => ({
          id: String(v.id), title: v.title && v.title !== 'Default Title' ? String(v.title) : '', price: Number(v.price) || 0, available: v.available !== false,
        }));
        if (!variants.length) throw new Error('No variants');
        g.product = { handle, title: p.title || handle, image: thumb(p.featured_image), variants };
        g.variantId = (variants.find((v) => v.available) || variants[0]).id;
        g.picking = null;
        this.paintGiftProduct();
        this.querySelector('[data-gift-unpick]')?.focus({ preventScroll: true });
      } catch {
        if (this.members.gift !== g) return;
        Object.assign(g, { picking: null, error: 'That product didn’t open. Try again, or pick another.' });
        this.paintGiftResults();
      }
    }

    unpickProduct() {
      const g = this.members.gift;
      if (!g) return;
      Object.assign(g, { product: null, variantId: null });
      this.paintGiftProduct();
      this.querySelector('[data-gift-search]')?.focus({ preventScroll: true });
    }

    /** Send it: at least one gift. Then the page shows what each part did, with the pass code and the product code. */
    async sendGift(form) {
      const m = this.members;
      const id = form.dataset.id;
      const note = form.querySelector('[data-form-error]');
      if (note) note.hidden = true;
      const raw = String(form.credit.value || '').trim();
      const credit = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(credit) || credit < 0 || credit > 1000) {
        form.credit.focus();
        throw new Error('Store credit is $0 to $1000.');
      }
      const count = (input, what) => {
        const n = Number(input.value || 0);
        if (!Number.isInteger(n) || n < 0 || n > 20) {
          input.focus();
          throw new Error(`Give 0 to 20 ${what}.`);
        }
        return n;
      };
      const sessions = count(form.sessions, 'sessions');
      const rolls = count(form.rolls, 'dice rolls');
      const g = m.gift || {};
      const variant = g.product ? g.product.variants.find((v) => v.id === String(g.variantId)) || g.product.variants[0] : null;
      if (!(credit > 0) && !sessions && !rolls && !variant) throw new Error('Pick at least one gift: store credit, sessions, dice rolls or a product.');
      const body = { notify: Boolean(form.notify && form.notify.checked && !form.notify.disabled) };
      if (credit > 0) body.credit = Math.round(credit * 100) / 100;
      if (sessions) body.sessions = sessions;
      if (rolls) body.rolls = rolls;
      if (variant) Object.assign(body, { productVariantId: variant.id, productTitle: `${g.product.title}${variant.title ? ` (${variant.title})` : ''}` });
      const text = form.note.value.trim();
      if (text) body.note = text;
      if (typeof store.backend.giftMember !== 'function') throw new Error('Gifts need the newer Lair app. Refresh the page.');
      const result = await store.backend.giftMember(id, body);
      const sent = { body, gift: (result && result.gift) || {}, at: Date.now() };
      m.sent[id] = [sent, ...(m.sent[id] || [])];
      const given = this.giftOf(sent);
      if (given.credit || given.sessions || given.rolls || given.product) this.keepPerson({ customerId: id, giftedThisYear: true });
      Object.assign(m, { view: { kind: 'gift-done', id, from: (m.view && m.view.from) || 'member' }, gift: null });
      this.renderMembers();
      this.querySelector('#tab-members')?.scrollIntoView({ block: 'start' });
      // what it changed elsewhere: a birthday pass under Passes, Gifted on the birthdays and the list
      if (given.sessions) this.passes.list = null;
      if (this.tab === 'passes') this.loadPasses();
      this.loadBirthdays();
      if (m.list) this.loadMembers();
    }

    /** Each part of a gift: whether it went through, and what the Lair app said about the ones that didn't */
    giftParts(body, gift) {
      const g = gift || {};
      const PARTS = ['credit', 'sessions', 'rolls', 'product', 'email'];
      const problems = asList(g.problems).map((p) => {
        if (typeof p === 'string') return { part: partOf(p), message: p };
        const message = String((p && (p.message || p.error || p.reason)) || '');
        const named = p ? partOf(p.part || p.kind || p.type || '') : 'other';
        return { part: PARTS.includes(named) ? named : partOf(message), message };
      });
      const said = (part) => problems.filter((p) => p.part === part).map((p) => p.message).filter(Boolean);
      const out = { other: said('other') };
      const none = (value) => value != null && !(Number(value) > 0);
      if (body.credit) {
        const why = said('credit');
        out.credit = { ok: !why.length && !none(g.credit), why };
      }
      if (body.sessions) {
        const why = said('sessions');
        out.sessions = { ok: !why.length && Boolean(g.passCode || Number(g.sessions) > 0), why };
      }
      if (body.rolls) {
        const why = said('rolls');
        out.rolls = { ok: !why.length && !none(g.rolls), why };
      }
      if (body.productVariantId) {
        const why = said('product');
        out.product = { ok: !why.length && Boolean(g.product && g.product.code), why };
      }
      out.email = body.notify ? { ok: Boolean(g.emailed), why: said('email') } : { off: true, ok: false, why: [] };
      return out;
    }

    /** A gift sent from here, as the gifts list keeps them: what was sent, less the parts that didn't go through */
    giftOf({ body, gift }) {
      const parts = this.giftParts(body, gift);
      const g = gift || {};
      return {
        id: g.id || null, at: Number(g.at) || Date.now(),
        credit: parts.credit && parts.credit.ok ? Math.round(body.credit * 100) : 0,
        sessions: parts.sessions && parts.sessions.ok ? body.sessions : 0,
        passCode: (parts.sessions && parts.sessions.ok && g.passCode) || null,
        rolls: parts.rolls && parts.rolls.ok ? body.rolls : 0,
        product: parts.product && parts.product.ok ? { title: g.product.title || body.productTitle, code: g.product.code } : null,
        emailed: Boolean(g.emailed),
      };
    }

    /** What a gift did: each part, the pass code and the product code, and anything that didn't go through */
    giftDoneHtml(id) {
      const m = this.members;
      const x = m.people[id] || { customerId: id };
      const first = firstOf(x);
      const last = (m.sent[id] || [])[0];
      const from = (m.view && m.view.from) || 'member';
      const back = `<button class="text-link staff-gm__back" type="button" data-gift-back>‹ ${esc(from === 'birthdays' ? 'All members' : `${first}’s page`)}</button>`;
      if (!last) return `<div class="staff-gift">${back}</div>`;
      const { body, gift } = last;
      const g = gift || {};
      const parts = this.giftParts(body, gift);
      const why = (list) => (list.length ? list.map((w) => `<span class="staff-gift__why">${esc(w)}</span>`).join('') : '<span class="staff-gift__why">It didn’t go through.</span>');
      const item = (state, what, said) => `<li class="staff-gift__part is-${state}"><span class="staff-gift__mark" aria-hidden="true">${{ ok: '✓', bad: '!', off: '–' }[state]}</span><span class="staff-gift__part-body"><strong>${what}</strong>${said}</span></li>`;
      const items = [];
      if (parts.credit) {
        items.push(item(parts.credit.ok ? 'ok' : 'bad', esc(`${money(Math.round(body.credit * 100))} store credit`),
          parts.credit.ok ? '<span>On their account, for the shop online or at the counter.</span>' : why(parts.credit.why)));
      }
      if (parts.sessions) {
        const code = g.passCode;
        items.push(item(parts.sessions.ok ? 'ok' : 'bad', esc(`${plural(body.sessions, 'session', 'sessions')}`), parts.sessions.ok
          ? `<span>A pass on their account. It shows in their My Lair.</span>${code ? `<span class="staff-gift__code">${esc(code)}</span><button class="button button--ghost button--small" type="button" data-pass-open="" data-code="${esc(code)}">Open the pass</button>` : ''}`
          : why(parts.sessions.why)));
      }
      if (parts.rolls) {
        items.push(item(parts.rolls.ok ? 'ok' : 'bad', esc(plural(body.rolls, 'dice roll', 'dice rolls')),
          parts.rolls.ok ? '<span>Added. They roll them in My Lair, and they don’t expire.</span>' : why(parts.rolls.why)));
      }
      if (parts.product) {
        const title = (g.product && g.product.title) || body.productTitle;
        items.push(item(parts.product.ok ? 'ok' : 'bad', esc(title), parts.product.ok
          ? `<span>Free with this code: one use, just for ${esc(first)}, for 30 days.</span><span class="staff-gift__code staff-gift__code--big">${esc(g.product.code)}</span>`
          : why(parts.product.why)));
      }
      if (parts.email.off) {
        items.push(item('off', 'Not emailed', `<span>${'email' in x && !x.email ? 'No email on file, so tell them at the counter.' : 'You left Email them off, so tell them at the counter.'}${parts.product && parts.product.ok ? ' Give them the product code.' : ''}</span>`));
      } else {
        items.push(item(parts.email.ok ? 'ok' : 'bad', parts.email.ok ? 'Emailed' : 'Not emailed', parts.email.ok
          ? `<span>“Happy birthday from Gobgob!”${x.email ? ` to ${esc(x.email)}` : ''}, with every gift${parts.product && parts.product.ok ? ' and the product code' : ''}.</span>`
          : why(parts.email.why)));
      }
      parts.other.forEach((w) => items.push(item('bad', 'Something else', `<span class="staff-gift__why">${esc(w)}</span>`)));
      const gifts = ['credit', 'sessions', 'rolls', 'product'].filter((k) => parts[k]);
      const good = gifts.filter((k) => parts[k].ok).length;
      const bad = gifts.length - good + (!parts.email.off && !parts.email.ok ? 1 : 0) + parts.other.length;
      const status = !good ? 'The gift didn’t go through' : bad ? `Gift sent, with ${bad > 1 ? 'problems' : 'a problem'}` : 'Gift sent';
      return `<div class="staff-gift staff-gift--done">
        ${back}
        <article class="staff-gift__result${!good ? ' is-bad' : bad ? ' is-mixed' : ''}" role="status" aria-labelledby="gift-status">
          <p class="checkin-card__status" id="gift-status">${esc(status)}</p>
          <h3 class="h3">${esc(x.name || first)}</h3>
          <ul class="staff-gift__parts" role="list">${items.join('')}</ul>
          ${body.note ? `<p class="small"><span class="muted">Note:</span> ${esc(body.note)}</p>` : ''}
        </article>
        <div class="cluster">
          <button class="button button--small" type="button" data-member-view="${esc(id)}">${esc(first)}’s page</button>
          <button class="button button--ghost button--small" type="button" data-members-back>All members</button>
        </div>
      </div>`;
    }
