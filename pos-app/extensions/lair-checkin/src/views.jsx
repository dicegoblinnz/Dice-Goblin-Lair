// The check-in screens, drawn from what Modal.jsx hands them. They don't call the POS or the Lair app themselves:
// every button calls back into Modal.jsx (`ctx.act`).
import '@shopify/ui-extensions/preact';
import { useState } from 'preact/hooks';
import {
  checkinOutcome,
  codeInQuery,
  currentRow,
  everythingPlan,
  passChange,
  passInUse,
  passOptions,
  passProblem,
  personPlan,
  tabPlan,
  withGroups,
} from './flow.js';
import { customerIdNumber, dateLabel, firstName, longDay, money, peopleLabel, plural, tablesLabel, whenLabel } from './format.js';
import { tabItems } from './lines.js';
import {
  amountProblem,
  bookerPayer,
  canSplit,
  paidSummary,
  parseDollars,
  paymentsLine,
  pendingState,
  personShare,
  shareSummary,
  splitFirst,
  WAITING,
} from './split.js';
import {
  areYou,
  dayCounts,
  dueOf,
  groupDetails,
  groupSummary,
  owedWhen,
  passCandidates,
  passLeft,
  passSummary,
  passUsable,
  playerNames,
  refundPending,
  rowBadges,
  rowDetails,
  rowKey,
  searchToday,
  sortGroups,
  sortRows,
  whatLabel,
} from './today.js';

/**
 * @typedef {import('./today.js').Today} Today
 * @typedef {import('./today.js').Row} Row
 * @typedef {import('./today.js').Group} Group
 * @typedef {import('./today.js').PassLike} PassLike
 * @typedef {import('./today.js').Badge} Badge
 * @typedef {import('./flow.js').Screen} Screen
 * @typedef {import('./flow.js').PersonScreen} PersonScreen
 * @typedef {import('./flow.js').MemberScreen} MemberScreen
 * @typedef {import('./flow.js').PassScreen} PassScreen
 * @typedef {import('./flow.js').SplitState} SplitState
 * @typedef {import('./split.js').Pending} Pending
 * @typedef {{ title: string, message: string, tone: 'critical' | 'warning' | 'info', retry?: (() => void) | null }} Shown
 *   a banner on screen, maybe with Try again
 * @typedef {{ bookings: string[], shares: string[], tabs: string[], customerId: number | null }} CartState
 * @typedef {'any' | 'payer' | 'pass'} Want
 * @typedef {{
 *   back: () => void,
 *   scan: (want: Want) => void,
 *   lookUp: (text: string, want: Want) => void,
 *   setQuery: (query: string) => void,
 *   refresh: () => void,
 *   openGroup: (key: string) => void,
 *   openRow: (row: Row, group: { key?: string, title?: string } | null, passes?: PassLike[]) => void,
 *   checkIn: (force: boolean) => void,
 *   setChoice: (choice: string | null) => void,
 *   changePass: () => void,
 *   undoPass: () => void,
 *   addToCart: () => void,
 *   done: () => void,
 *   setSplit: (patch: Partial<SplitState>) => void,
 *   addShare: () => void,
 *   refreshRow: () => void,
 *   forgetShare: () => void,
 *   checkInEveryone: () => void,
 *   addEverything: () => void,
 *   addTab: () => void,
 *   putMemberOnSale: () => void,
 *   openPass: (pass: PassLike) => void,
 *   togglePicking: () => void,
 *   usePassOn: (row: Row, group: Group) => void,
 * }} Actions
 * @typedef {{
 *   today: Today | null,
 *   loading: boolean,
 *   listProblem: Shown | null,
 *   todayKey: string,
 *   now: number,
 *   busy: string,
 *   problem: Shown | null,
 *   query: string,
 *   cart: CartState,
 *   pending: Record<string, Pending>,
 *   backLabel: string,
 *   act: Actions,
 * }} Ctx
 */

/** The screen on top of the stack. @param {{ screen: Screen, ctx: Ctx }} props */
export function CurrentScreen({ screen, ctx }) {
  switch (screen.name) {
    case 'group':
      return <GroupView groupKey={screen.key} ctx={ctx} />;
    case 'person':
      return <PersonView screen={screen} ctx={ctx} />;
    case 'member':
      return <MemberView screen={screen} ctx={ctx} />;
    case 'pass':
      return <PassView screen={screen} ctx={ctx} />;
    default:
      return <HomeView ctx={ctx} />;
  }
}

/* ---------------- home: scan, search, Today ---------------- */

/** @param {{ ctx: Ctx }} props */
function HomeView({ ctx }) {
  const { today, query, busy, act } = ctx;
  const { people, arrived } = dayCounts(today);
  const subheading = [longDay(today?.now || ctx.now), people ? `${people} booked · ${arrived} here` : ''].filter(Boolean).join(' · ');
  return (
    <Page
      heading="Lair check-in"
      subheading={subheading}
      action={
        <s-button slot="secondary-actions" disabled={ctx.loading || Boolean(busy)} onClick={act.refresh}>
          Refresh
        </s-button>
      }
    >
      <Status ctx={ctx} />
      <s-button variant="primary" disabled={Boolean(busy)} onClick={() => act.scan('any')}>
        Scan a code
      </s-button>
      <s-search-field
        placeholder="Search by name, or type a code"
        value={query}
        onInput={(event) => act.setQuery(event.currentTarget.value ?? '')}
      />
      {query.trim() ? <SearchResults ctx={ctx} /> : <TodayList ctx={ctx} />}
    </Page>
  );
}

/** @param {{ ctx: Ctx }} props */
function SearchResults({ ctx }) {
  const { today, query, busy, act, cart } = ctx;
  const code = codeInQuery(query);
  const found = searchToday(today, query);
  return (
    <s-stack direction="block" gap="small">
      {code ? (
        <s-button disabled={Boolean(busy)} onClick={() => act.lookUp(code, 'any')}>
          {`Look up ${code}`}
        </s-button>
      ) : null}
      {!today ? (
        <TodayList ctx={ctx} />
      ) : found.length ? (
        <s-section heading={plural(found.length, 'match', 'matches')}>
          <RowList
            items={found.map(({ row, group }) => ({ row, group, details: [group.title, rowDetails(row)].filter(Boolean).join(' · ') }))}
            cart={cart}
            busy={busy}
            onOpen={(row, group) => act.openRow(row, group)}
          />
        </s-section>
      ) : code ? null : (
        <s-text color="subdued">{`No one called "${query.trim()}" today. Check the spelling, or scan their code.`}</s-text>
      )}
    </s-stack>
  );
}

/** @param {{ ctx: Ctx }} props */
function TodayList({ ctx }) {
  const { today, loading, listProblem, busy, act } = ctx;
  if (!today) {
    if (listProblem) return <ProblemBanner problem={listProblem} busy={Boolean(busy) || loading} />;
    return <BusyLine label="Loading today…" />;
  }
  const groups = sortGroups(today.groups);
  return (
    <s-section heading="Today">
      <s-stack direction="block" gap="small">
        {listProblem ? <ProblemBanner problem={listProblem} busy={Boolean(busy) || loading} /> : null}
        {loading ? <BusyLine label="Refreshing…" /> : null}
        {groups.length ? null : <s-text color="subdued">Nothing booked today yet.</s-text>}
        {groups.map((group, i) => (
          <s-stack key={group.key} direction="block" gap="small">
            {i ? <s-divider /> : null}
            <s-clickable disabled={Boolean(busy)} onClick={() => act.openGroup(group.key)}>
              <Item title={group.title || 'Bookings'} lines={[groupDetails(group)]} badges={[{ tone: 'neutral', text: groupSummary(group) }]} />
            </s-clickable>
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

/* ---------------- a group: a GM game, an event, or the table bookings ---------------- */

/** @param {{ groupKey: string, ctx: Ctx }} props */
function GroupView({ groupKey, ctx }) {
  const { today, busy, act, cart } = ctx;
  const group = today?.groups.find((g) => g.key === groupKey) || null;
  if (!group) {
    return (
      <Page heading="Not on today's list" subheading="">
        <BackButton ctx={ctx} />
        <Status ctx={ctx} />
        <s-text>This one isn't on today's list any more. Go back and refresh.</s-text>
      </Page>
    );
  }
  return (
    <Page heading={group.title || 'Bookings'} subheading={groupDetails(group)} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      <s-text type="strong">{groupSummary(group)}</s-text>
      {group.rows.length ? (
        <RowList
          items={sortRows(group.rows).map((row) => ({ row, group, details: rowDetails(row) }))}
          cart={cart}
          busy={busy}
          onOpen={(row) => act.openRow(row, group)}
        />
      ) : (
        <s-text color="subdued">No one has booked yet.</s-text>
      )}
    </Page>
  );
}

/* ---------------- a person: "Are you Sam?" ---------------- */

/** @param {{ screen: PersonScreen, ctx: Ctx }} props */
function PersonView({ screen, ctx }) {
  const { today, busy, act, cart } = ctx;
  const row = currentRow(screen, today);
  const plan = personPlan(row, screen.result, ctx.todayKey);
  const outcome = screen.result ? checkinOutcome(screen.result) : null;
  const ref = String(row.ref || '');
  const inCart = Boolean(ref) && cart.bookings.includes(ref);
  const share = ctx.pending[rowKey(row)] || null;
  const pending = pendingState(share, row, cart.shares, ctx.now);
  const holding = pending === 'in-cart' || pending === 'waiting';
  const due = dueOf(row);
  const inUse = passInUse(row, screen.uses);
  const choices = passOptions(row, screen.passes, inUse);
  const showPasses =
    row.type !== 'join' &&
    !screen.split.open &&
    !holding &&
    !inCart &&
    (plan.stage === 'check-in' || plan.stage === 'pay' || (plan.stage === 'done' && Boolean(inUse)));
  const paying = plan.stage === 'pay' && !inCart && !holding;
  const busyNow = Boolean(busy);
  return (
    <Page heading={areYou(row)} subheading={ref} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      <s-section heading={row.name || 'Guest'}>
        <s-stack direction="block" gap="small">
          <Badges list={rowBadges(row, inCart)} />
          {personFacts(row, screen.groupTitle).map((line) => (
            <s-text key={line}>{line}</s-text>
          ))}
        </s-stack>
      </s-section>

      {plan.warning ? (
        <s-banner tone="warning" heading="Check before you let them in">
          {plan.warning}
        </s-banner>
      ) : null}
      {outcome?.arrived ? (
        <s-banner tone="success" heading={outcome.text}>
          {[outcome.passText ? `${outcome.passText}.` : '', outcome.notice].filter(Boolean).join(' ') ||
            (outcome.total ? 'Add it to the cart, then take payment on the Verifone.' : 'All done.')}
        </s-banner>
      ) : null}
      {screen.note ? (
        <s-banner tone="success" heading={screen.note.heading}>
          {screen.note.body}
        </s-banner>
      ) : null}
      {pending === 'in-cart' && share ? (
        <s-banner tone="info" heading={`A ${money(share.amount)} share is in the cart`}>
          Take payment on the Verifone. Their share shows here once it's paid.
        </s-banner>
      ) : null}
      {pending === 'waiting' && share ? (
        <s-stack direction="block" gap="small">
          <s-banner tone="info" heading={WAITING}>
            {`The ${money(share.amount)} share left the cart. It shows here as paid once the payment reaches the Lair app, usually within a minute.`}
          </s-banner>
          <s-stack direction="inline" gap="small">
            <s-button disabled={busyNow} onClick={act.refreshRow}>
              Refresh
            </s-button>
            <s-button variant="secondary" disabled={busyNow} onClick={act.forgetShare}>
              It wasn't paid
            </s-button>
          </s-stack>
        </s-stack>
      ) : null}
      {inCart && plan.stage === 'pay' && pending !== 'in-cart' ? (
        <s-banner tone="info" heading="It's in the cart">
          Take payment on the Verifone. To change the pass or pay another way, take that line off the sale first.
        </s-banner>
      ) : null}
      {plan.stage === 'owed' ? (
        <s-banner tone={inCart ? 'info' : 'warning'} heading={inCart ? "It's in the cart" : `Owed from ${owedWhen(row)}`}>
          {inCart
            ? 'Take payment on the Verifone.'
            : "A weekly regular's seat is theirs to pay for, even if they didn't come. Add it to the cart, or waive it on the staff page."}
        </s-banner>
      ) : null}

      {showPasses ? <PassChoice row={row} screen={screen} options={choices.options} inUse={inUse} stage={plan.stage} ctx={ctx} /> : null}

      {screen.split.open && plan.stage === 'pay' && !holding && !inCart ? <SplitPanel row={row} split={screen.split} ctx={ctx} /> : null}

      {plan.stage === 'check-in' ? (
        <s-button variant="primary" disabled={busyNow} onClick={() => act.checkIn(plan.force)}>
          {plan.force ? 'Check in anyway' : 'Check in'}
        </s-button>
      ) : null}
      {paying && !screen.split.open ? <PayButtons row={row} due={due} busy={busyNow} act={act} /> : null}
      {plan.stage === 'owed' && !inCart ? (
        <s-button variant="primary" disabled={busyNow} onClick={act.addToCart}>
          {`Add ${money(due)} to cart`}
        </s-button>
      ) : null}
      {plan.stage === 'done' || ((plan.stage === 'pay' || plan.stage === 'owed') && (inCart || holding)) ? (
        <s-button variant={plan.stage === 'done' ? 'primary' : 'secondary'} disabled={busyNow} onClick={act.done}>
          Done
        </s-button>
      ) : null}
    </Page>
  );
}

/**
 * The lines under the person's name: what, when and where, players, notes, pass and payments.
 * @param {Row} row
 * @param {string} groupTitle
 */
function personFacts(row, groupTitle) {
  const lines = [
    // A seat's group says who's running the game: "GM seat: Curse of Strahd · GM Kate".
    row.kind === 'gm-seat' && groupTitle ? `GM seat: ${groupTitle}` : whatLabel(row),
    [peopleLabel(row.people), tablesLabel(row.tables)].filter(Boolean).join(' at '),
    whenLabel(row.start, row.end),
  ];
  const players = playerNames(row);
  if (players.length) lines.push(`Players: ${players.join(', ')}`);
  if (row.note) lines.push(`Note: ${row.note}`);
  // An owed seat is paid, never checked in, so its saved pass isn't used.
  if (!row.owed && (row.pass?.code || row.pass?.label)) lines.push(`Saved pass: ${passSummary(row.pass)}`);
  if (Number(row.covered) > 0) lines.push(`A pass covered ${money(row.covered)}`);
  if (row.split) lines.push('Splitting the bill');
  const paid = paidSummary(row);
  if (paid) lines.push(paid);
  const who = paymentsLine(row);
  if (who) lines.push(`Paid so far: ${who}`);
  if (refundPending(row)) lines.push('They paid online and this was cancelled or missed. Sort out the refund on the staff page.');
  return lines.filter(Boolean);
}

/**
 * "Add $X to cart" and "Split the bill": splitting leads when they said they'd split or part is paid already.
 * @param {{ row: Row, due: number, busy: boolean, act: Actions }} props
 */
function PayButtons({ row, due, busy, act }) {
  const add = (
    <s-button key="add" variant={splitFirst(row) ? 'secondary' : 'primary'} disabled={busy} onClick={act.addToCart}>
      {`Add ${money(due)} to cart`}
    </s-button>
  );
  if (!canSplit(row)) return add;
  const split = (
    <s-button key="split" variant={splitFirst(row) ? 'primary' : 'secondary'} disabled={busy} onClick={() => act.setSplit({ open: true })}>
      Split the bill
    </s-button>
  );
  return (
    <s-stack direction="block" gap="small">
      {splitFirst(row) ? [split, add] : [add, split]}
    </s-stack>
  );
}

/**
 * The session pass. Before check-in: pick the saved one, another of theirs, or none. Once they're here: the pass in
 * use with "Undo pass", or another one to switch to ("Switch to this pass", "Check in again without a pass"), or a
 * pass to cover what's left ("Use this pass").
 * @param {{ row: Row, screen: PersonScreen, options: { value: string, label: string }[],
 *   inUse: { code: string, label: string } | null, stage: string, ctx: Ctx }} props
 */
function PassChoice({ row, screen, options, inUse, stage, ctx }) {
  const { act, busy } = ctx;
  const here = stage !== 'check-in';
  const change = here ? passChange(inUse, screen.choice) : null;
  if (!options.length && !inUse) {
    return (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-text color="subdued">Got a session pass?</s-text>
        <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.scan('pass')}>
          Scan a pass
        </s-button>
      </s-stack>
    );
  }
  return (
    <s-section heading={here && !inUse ? 'Use a pass for what’s left?' : 'Session pass'}>
      <s-stack direction="block" gap="small">
        {here && inUse ? <s-text>{`${inUse.label} covered ${money(row.covered)}.`}</s-text> : null}
        {options.length ? (
          <s-choice-list values={screen.choice ? [screen.choice] : []} onChange={(event) => act.setChoice(event.currentTarget.values?.[0] ?? null)}>
            {options.map((option) => (
              <s-choice key={option.value} value={option.value}>
                {option.label}
              </s-choice>
            ))}
          </s-choice-list>
        ) : null}
        {change && change.action !== 'none' ? (
          <s-button disabled={Boolean(busy)} onClick={act.changePass}>
            {change.label}
          </s-button>
        ) : null}
        {here && inUse ? (
          <s-button variant="secondary" disabled={Boolean(busy)} onClick={act.undoPass}>
            Undo pass
          </s-button>
        ) : null}
        <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.scan('pass')}>
          Scan a pass
        </s-button>
      </s-stack>
    </s-section>
  );
}

/**
 * Split the bill: one person's share or another amount, who's paying, then "Add $X to cart".
 * @param {{ row: Row, split: SplitState, ctx: Ctx }} props
 */
function SplitPanel({ row, split, ctx }) {
  const { act, busy } = ctx;
  const custom = split.mode === 'custom';
  const typed = parseDollars(split.custom);
  const problem = custom && split.custom.trim() ? amountProblem(typed, row) : '';
  const amount = custom ? (typed && !problem ? typed : 0) : personShare(row);
  const booker = bookerPayer(row);
  return (
    <s-section heading="Split the bill">
      <s-stack direction="block" gap="base">
        <s-text type="strong">{shareSummary(row)}</s-text>
        <s-choice-list values={[split.mode]} onChange={(event) => act.setSplit({ mode: event.currentTarget.values?.[0] === 'custom' ? 'custom' : 'person' })}>
          <s-choice value="person">{`One person's share: ${money(personShare(row))}`}</s-choice>
          <s-choice value="custom">A different amount</s-choice>
        </s-choice-list>
        {custom ? (
          <s-number-field
            label="Amount in dollars"
            placeholder="12.50"
            controls="none"
            inputMode="decimal"
            value={split.custom}
            error={problem}
            onInput={(event) => act.setSplit({ custom: event.currentTarget.value ?? '' })}
          />
        ) : null}

        <s-text type="strong">Who's paying this share?</s-text>
        {split.payer ? (
          <s-stack direction="block" gap="small">
            <s-text>{`${split.payer.name}${split.payer.code ? ` (${split.payer.code})` : ''}. The spend goes on their account.`}</s-text>
            <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.setSplit({ payer: null })}>
              Someone else
            </s-button>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small">
            {booker ? (
              <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.setSplit({ payer: booker })}>
                {`${firstName(booker.name) || 'The booker'} (booked it)`}
              </s-button>
            ) : null}
            <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.scan('payer')}>
              Scan their member code
            </s-button>
            <CodeEntry label="Or type their member code" placeholder="AK-KIWI-3" busy={Boolean(busy)} onFind={(text) => act.lookUp(text, 'payer')} />
            <s-text color="subdued">No member code? Go ahead anyway: it just won't count toward anyone's dice rolls.</s-text>
          </s-stack>
        )}

        <s-button variant="primary" disabled={Boolean(busy) || !amount} onClick={act.addShare}>
          {amount ? `Add ${money(amount)} to cart` : 'Add to cart'}
        </s-button>
        <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.setSplit({ open: false })}>
          Don't split
        </s-button>
      </s-stack>
    </s-section>
  );
}

/* ---------------- a member: their day, their tab, their passes ---------------- */

/** @param {{ screen: MemberScreen, ctx: Ctx }} props */
function MemberView({ screen, ctx }) {
  const { today, busy, act, cart } = ctx;
  const member = screen.member;
  const name = String(member.name || '').trim() || 'Member';
  const onSale = cart.customerId !== null && cart.customerId === customerIdNumber(member.customerId);
  // Rows from the Today list where it has them (they're updated as people check in). Owed sessions are listed apart.
  const rows = withGroups(screen.rows, today);
  const todayRows = rows.filter(({ row }) => !row.owed);
  const owedRows = rows.filter(({ row }) => row.owed);
  const everything = everythingPlan(rows.map((x) => x.row), screen.tab, cart);
  const plan = everything.today;
  const tab = tabPlan(screen.tab, cart.tabs);
  const { items, bad } = tabItems(screen.tab);
  return (
    <Page heading={name} subheading={member.code ? `Member ${member.code}` : 'Member'} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      <s-stack direction="inline" gap="small" alignItems="center">
        <Badges list={[onSale ? { tone: 'success', text: 'On this sale' } : { tone: 'neutral', text: 'Not on this sale' }]} />
        {onSale ? null : (
          <s-button variant="secondary" disabled={Boolean(busy)} onClick={act.putMemberOnSale}>
            {`Put ${firstName(name)} on this sale`}
          </s-button>
        )}
      </s-stack>

      {everything.show ? (
        <s-stack direction="block" gap="small">
          <s-button variant="primary" disabled={Boolean(busy)} onClick={act.addEverything}>
            {everything.label}
          </s-button>
          {[everything.parts, everything.note].filter(Boolean).map((line) => (
            <s-text key={line} color="subdued">
              {line}
            </s-text>
          ))}
        </s-stack>
      ) : null}

      <s-section heading="Today">
        <s-stack direction="block" gap="small">
          {screen.notices.length ? (
            <s-banner tone="info" heading="Heads up">
              {screen.notices.join(' ')}
            </s-banner>
          ) : null}
          {todayRows.length ? (
            <RowList
              items={todayRows.map(({ row, group }) => ({ row, group, details: [whatLabel(row), rowDetails(row)].filter(Boolean).join(' · ') }))}
              cart={cart}
              busy={busy}
              onOpen={(row, group) => act.openRow(row, group, screen.passes)}
            />
          ) : (
            <s-text color="subdued">Nothing booked today.</s-text>
          )}
          {plan.canCheckIn ? (
            <s-button variant="secondary" disabled={Boolean(busy)} onClick={act.checkInEveryone}>
              {plan.waiting ? 'Check in everyone and add to cart' : `Add ${money(plan.due)} to cart`}
            </s-button>
          ) : null}
        </s-stack>
      </s-section>

      {owedRows.length ? (
        <s-section heading="Owed">
          <s-stack direction="block" gap="small">
            <s-text color="subdued">Sessions they kept a seat for and haven't paid. Tap one to add just that.</s-text>
            <RowList
              items={owedRows.map(({ row, group }) => ({ row, group, details: [whatLabel(row), owedWhen(row)].filter(Boolean).join(' · ') }))}
              cart={cart}
              busy={busy}
              onOpen={(row, group) => act.openRow(row, group, screen.passes)}
            />
          </s-stack>
        </s-section>
      ) : null}

      {tab.show ? (
        <s-section heading="Tab">
          <s-stack direction="block" gap="small">
            {items.map((item) => (
              <s-text key={item.variantId}>{`${item.qty} × ${item.title}`}</s-text>
            ))}
            {bad.map((title) => (
              <s-text key={`bad-${title}`} color="subdued">{`${title}: ring this one up by hand`}</s-text>
            ))}
            {items.length ? (
              <s-text color="subdued">{`About ${money(screen.tab?.total ?? items.reduce((sum, i) => sum + i.price * i.qty, 0))}. The till charges the shop's own prices.`}</s-text>
            ) : null}
            {tab.note ? <s-text>{tab.note}</s-text> : null}
            {tab.canAdd ? (
              <s-button variant="secondary" disabled={Boolean(busy)} onClick={act.addTab}>
                Add tab to cart
              </s-button>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      {screen.passes.length ? (
        <s-section heading="Passes">
          <s-stack direction="block" gap="small">
            {screen.passes.map((pass, i) => (
              <s-stack key={pass.code || i} direction="block" gap="small">
                {i ? <s-divider /> : null}
                <s-clickable disabled={Boolean(busy)} onClick={() => act.openPass(pass)}>
                  <Item title={pass.label || 'Session pass'} lines={[passLine(pass)]} badges={[]} />
                </s-clickable>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}
    </Page>
  );
}

/** "7 of 10 sessions left · expires 31 Dec 2026" @param {PassLike} pass */
function passLine(pass) {
  const left = passLeft(pass);
  const total = Number(pass.sessionsTotal);
  const parts = [];
  if (left !== null) parts.push(Number.isFinite(total) && total > 0 ? `${left} of ${total} sessions left` : plural(left, 'session') + ' left');
  if (pass.expiresAt) parts.push(`expires ${dateLabel(pass.expiresAt)}`);
  if (pass.code) parts.push(pass.code);
  return parts.join(' · ');
}

/* ---------------- a pass: who has it, what's left, and "Use on…" ---------------- */

/** @param {{ screen: PassScreen, ctx: Ctx }} props */
function PassView({ screen, ctx }) {
  const { today, busy, act, cart } = ctx;
  const pass = screen.pass;
  const usable = passUsable(pass);
  const holder = String(pass.holder?.name || '').trim();
  const candidates = screen.picking ? passCandidates(today, pass) : [];
  return (
    <Page heading={pass.label || 'Session pass'} subheading={pass.code ? `Pass ${pass.code}` : ''} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      <s-section heading={holder || 'No holder yet'}>
        <s-stack direction="block" gap="small">
          <s-text type="strong">{passLine({ ...pass, code: '' }) || 'Sessions unknown'}</s-text>
          {Number(pass.cover) > 0 ? <s-text>{`Each session covers one person's table fee, up to ${money(pass.cover)}.`}</s-text> : null}
          {pass.note ? <s-text>{`Note: ${pass.note}`}</s-text> : null}
        </s-stack>
      </s-section>
      {usable ? null : (
        <s-banner tone="warning" heading="This pass can't be used">
          {passProblem(pass)}
        </s-banner>
      )}
      {usable ? (
        <s-button variant={screen.picking ? 'secondary' : 'primary'} disabled={Boolean(busy)} onClick={act.togglePicking}>
          {screen.picking ? 'Cancel' : 'Use on…'}
        </s-button>
      ) : null}
      {screen.picking ? (
        <s-section heading="Use on…">
          {candidates.length ? (
            <RowList
              items={candidates.map(({ row, group }) => ({ row, group, details: [group.title, rowDetails(row)].filter(Boolean).join(' · ') }))}
              cart={cart}
              busy={busy}
              onOpen={(row, group) => (group ? act.usePassOn(row, group) : undefined)}
            />
          ) : (
            <s-text color="subdued">No one today has a table fee left to pay.</s-text>
          )}
        </s-section>
      ) : null}
    </Page>
  );
}

/* ---------------- small pieces ---------------- */

/**
 * @param {{ heading: string, subheading: string, action?: import('preact').ComponentChildren, children?: import('preact').ComponentChildren }} props
 */
function Page({ heading, subheading, action, children }) {
  return (
    <s-page heading={heading} subheading={subheading}>
      {action || null}
      <s-scroll-box>
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            {children}
          </s-stack>
        </s-box>
      </s-scroll-box>
    </s-page>
  );
}

/** "Scan" in the action bar: open whatever code they show. @param {{ ctx: Ctx }} props */
function ScanAction({ ctx }) {
  return (
    <s-button slot="secondary-actions" disabled={Boolean(ctx.busy)} onClick={() => ctx.act.scan('any')}>
      Scan
    </s-button>
  );
}

/** @param {{ ctx: Ctx }} props */
function BackButton({ ctx }) {
  return (
    <s-button variant="secondary" disabled={Boolean(ctx.busy)} onClick={ctx.act.back}>
      {`‹ ${ctx.backLabel}`}
    </s-button>
  );
}

/** What's happening, and what went wrong. @param {{ ctx: Ctx }} props */
function Status({ ctx }) {
  return (
    <>
      {ctx.busy ? <BusyLine label={ctx.busy} /> : null}
      {ctx.problem ? <ProblemBanner problem={ctx.problem} busy={Boolean(ctx.busy)} /> : null}
    </>
  );
}

/** @param {{ label: string }} props */
function BusyLine({ label }) {
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-spinner accessibilityLabel={label} />
      <s-text>{label}</s-text>
    </s-stack>
  );
}

/** @param {{ problem: Shown, busy: boolean }} props */
function ProblemBanner({ problem, busy }) {
  const retry = problem.retry;
  return (
    <s-stack direction="block" gap="small">
      <s-banner tone={problem.tone} heading={problem.title}>
        {problem.message}
      </s-banner>
      {retry ? (
        <s-button disabled={busy} onClick={() => retry()}>
          Try again
        </s-button>
      ) : null}
    </s-stack>
  );
}

/** @param {{ list: Badge[] }} props */
function Badges({ list }) {
  if (!list.length) return null;
  return (
    <s-stack direction="inline" gap="small">
      {list.map((badge) => (
        <s-badge key={badge.text} tone={badge.tone}>
          {badge.text}
        </s-badge>
      ))}
    </s-stack>
  );
}

/** A tappable line: a title, a line or two under it, and badges. @param {{ title: string, lines: string[], badges: Badge[] }} props */
function Item({ title, lines, badges }) {
  return (
    <s-box padding="small none">
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{title}</s-text>
        {lines.filter(Boolean).map((line) => (
          <s-text key={line} color="subdued">
            {line}
          </s-text>
        ))}
        <Badges list={badges} />
      </s-stack>
    </s-box>
  );
}

/**
 * People in a list, each opening their person view.
 * @param {{ items: { row: Row, group: Group | null, details: string }[], cart: CartState, busy: string, onOpen: (row: Row, group: Group | null) => void }} props
 */
function RowList({ items, cart, busy, onOpen }) {
  return (
    <s-stack direction="block" gap="small">
      {items.map(({ row, group, details }, i) => (
        <s-stack key={rowKey(row)} direction="block" gap="small">
          {i ? <s-divider /> : null}
          <s-clickable disabled={Boolean(busy)} onClick={() => onOpen(row, group)}>
            <Item
              title={row.name || 'Guest'}
              lines={[details]}
              badges={rowBadges(row, Boolean(row.ref) && cart.bookings.includes(String(row.ref)))}
            />
          </s-clickable>
        </s-stack>
      ))}
    </s-stack>
  );
}

/**
 * A box to type a code into, with a Find button (for people who left their phone at home).
 * @param {{ label: string, placeholder: string, busy: boolean, onFind: (text: string) => void }} props
 */
function CodeEntry({ label, placeholder, busy, onFind }) {
  const [text, setText] = useState('');
  return (
    <s-text-field label={label} placeholder={placeholder} value={text} onInput={(event) => setText(event.currentTarget.value ?? '')}>
      <s-button slot="accessory" disabled={busy || !text.trim()} onClick={() => onFind(text)}>
        Find
      </s-button>
    </s-text-field>
  );
}
