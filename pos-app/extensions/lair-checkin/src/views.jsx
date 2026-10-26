// The check-in screens, drawn from what Modal.jsx hands them. The 27 Oct 2026 rework (Mo: "one obvious next step on
// every screen", and "always clear who's here, what they owe and what's in the cart"): each screen has one main button,
// with who it's about, what's to pay and the cart strip above it. They don't call the POS or the Lair app themselves:
// every button calls back into Modal.jsx (`ctx.act`).
import '@shopify/ui-extensions/preact';
import { useState } from 'preact/hooks';
import {
  CLOSES,
  checkinOutcome,
  codeInQuery,
  currentRow,
  everythingPlan,
  groupPlan,
  passChange,
  passInUse,
  passOptions,
  passProblem,
  personAction,
  personPlan,
  tabPlan,
  whyNothing,
  withGroups,
} from './flow.js';
import { customerIdNumber, dateLabel, firstName, longDay, money, peopleLabel, plural, tablesLabel, whenLabel } from './format.js';
import { accountLine, tabItems } from './lines.js';
import { cardFullWords, cardHeading, loyaltyCard, rollWords, stampMarks, stampWords } from './loyalty.js';
import { saleStrip } from './sale.js';
import { amountProblem, bookerPayer, paidSummary, parseDollars, paymentsLine, pendingState, personShare, shareSummary, WAITING } from './split.js';
import {
  areYou,
  countRows,
  dayBuckets,
  dayCounts,
  dueOf,
  finishedLine,
  gameTitle,
  gmPaysChoice,
  gmPaysFor,
  groupBadges,
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
  rowState,
  searchToday,
  sortRows,
  whatLabel,
  withCover,
} from './today.js';

/**
 * @typedef {import('./today.js').Today} Today
 * @typedef {import('./today.js').Row} Row
 * @typedef {import('./today.js').Group} Group
 * @typedef {import('./today.js').PassLike} PassLike
 * @typedef {import('./today.js').Badge} Badge
 * @typedef {import('./flow.js').Screen} Screen
 * @typedef {import('./flow.js').GroupScreen} GroupScreen
 * @typedef {import('./flow.js').PersonScreen} PersonScreen
 * @typedef {import('./flow.js').MemberScreen} MemberScreen
 * @typedef {import('./flow.js').PassScreen} PassScreen
 * @typedef {import('./flow.js').ReadyScreen} ReadyScreen
 * @typedef {import('./flow.js').SplitState} SplitState
 * @typedef {import('./flow.js').PersonActionName} PersonActionName
 * @typedef {import('./split.js').Pending} Pending
 * @typedef {{ title: string, message: string, tone: 'critical' | 'warning' | 'info' | 'success', retry?: (() => void) | null,
 *   action?: { label: string, run: () => void } | null }} Shown
 *   a banner on screen, with Try again, or another next step (Scan again, Close and pay) as a button under it
 * @typedef {{ bookings: string[], shares: string[], tabs: string[], customerId: number | null, value: import('./cart.js').CartLike }} CartState
 * @typedef {'any' | 'payer' | 'pass'} Want
 * @typedef {{
 *   back: () => void,
 *   home: () => void,
 *   close: () => void,
 *   scan: (want: Want) => void,
 *   lookUp: (text: string, want: Want) => void,
 *   setQuery: (query: string) => void,
 *   refresh: () => void,
 *   openGroup: (key: string) => void,
 *   startPicking: (keys: string[]) => void,
 *   setTicks: (keys: string[]) => void,
 *   stopPicking: () => void,
 *   checkInGroup: () => void,
 *   openRow: (row: Row, group: { key?: string, title?: string } | null, passes?: PassLike[], loyalty?: object | null) => void,
 *   person: (action: PersonActionName, force?: boolean) => void,
 *   setChoice: (choice: string | null) => void,
 *   changePass: () => void,
 *   undoPass: () => void,
 *   setSplit: (patch: Partial<SplitState>) => void,
 *   addShare: () => void,
 *   askGm: (confirm: 'cover' | 'uncover' | null) => void,
 *   cover: () => void,
 *   uncover: () => void,
 *   addEverything: () => void,
 *   checkInMemberOnly: () => void,
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
 *   busyKey: string,
 *   problem: Shown | null,
 *   query: string,
 *   cart: CartState,
 *   names: Map<number, string>,
 *   pending: Record<string, Pending>,
 *   backLabel: string,
 *   act: Actions,
 * }} Ctx
 */

/** The screen on top of the stack. @param {{ screen: Screen, ctx: Ctx }} props */
export function CurrentScreen({ screen, ctx }) {
  switch (screen.name) {
    case 'group':
      return <GroupView screen={screen} ctx={ctx} />;
    case 'person':
      return <PersonView screen={screen} ctx={ctx} />;
    case 'member':
      return <MemberView screen={screen} ctx={ctx} />;
    case 'pass':
      return <PassView screen={screen} ctx={ctx} />;
    case 'ready':
      return <ReadyView screen={screen} ctx={ctx} />;
    default:
      return <HomeView ctx={ctx} />;
  }
}

/* ---------------- home: scan, search, Today ---------------- */

/** @param {{ ctx: Ctx }} props */
function HomeView({ ctx }) {
  const { today, query, busy, act } = ctx;
  const { people, arrived } = dayCounts(today);
  const subheading = [longDay(today?.now || ctx.now), people ? `${arrived} of ${people} here` : ''].filter(Boolean).join(' · ');
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
      <CartStrip ctx={ctx} />
      <s-button variant="primary" disabled={Boolean(busy)} onClick={() => act.scan('any')}>
        Scan a code
      </s-button>
      <s-text color="subdued">Or use the scanner.</s-text>
      <s-search-field
        placeholder="Search by name, or type their code"
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
    <s-stack direction="block" gap="base">
      {code ? (
        <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.lookUp(code, 'any')}>
          {`Look up ${code}`}
        </s-button>
      ) : null}
      {!today ? (
        <TodayList ctx={ctx} />
      ) : found.length ? (
        <s-section heading={plural(found.length, 'match', 'matches')}>
          <RowList
            items={found.map(({ row, group }) => ({ row, group, details: [gameTitle(group).name, rowDetails(row)].filter(Boolean).join(' · ') }))}
            cart={cart}
            busy={busy}
            onOpen={(row, group) => act.openRow(row, group)}
          />
        </s-section>
      ) : code ? null : (
        <s-empty-state heading={`No one called "${query.trim()}" today`} subheading="Check the spelling, or scan their code.">
          <s-icon slot="graphic" type="search" />
        </s-empty-state>
      )}
    </s-stack>
  );
}

/**
 * Today's games, events and table bookings: now and next, later today, and finished (shown when someone there still
 * has something to pay, else behind a button).
 * @param {{ ctx: Ctx }} props
 */
function TodayList({ ctx }) {
  const { today, loading, listProblem, busy, act } = ctx;
  const [showFinished, setShowFinished] = useState(false);
  if (!today) {
    if (listProblem) return <ProblemBanner problem={listProblem} busy={Boolean(busy) || loading} />;
    return <BusyLine label="Loading today…" />;
  }
  const buckets = dayBuckets(today.groups, ctx.now);
  const owing = buckets.finished.some((group) => countRows(group.rows).due > 0);
  return (
    <s-stack direction="block" gap="base">
      {listProblem ? <ProblemBanner problem={listProblem} busy={Boolean(busy) || loading} /> : null}
      {loading ? <BusyLine label="Refreshing…" /> : null}
      {today.groups.length ? null : (
        <s-empty-state heading="Nothing booked today yet" subheading="If someone shows you a code, scan it.">
          <s-icon slot="graphic" type="info" />
        </s-empty-state>
      )}
      <GroupSection heading="Now and next" groups={buckets.now} ctx={ctx} />
      <GroupSection heading="Later today" groups={buckets.later} ctx={ctx} />
      {buckets.finished.length ? (
        owing || showFinished ? (
          <GroupSection heading="Finished" groups={buckets.finished} ctx={ctx} finished />
        ) : (
          <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => setShowFinished(true)}>
            {`Show finished (${buckets.finished.length})`}
          </s-button>
        )
      ) : null}
    </s-stack>
  );
}

/** @param {{ heading: string, groups: Group[], ctx: Ctx, finished?: boolean }} props */
function GroupSection({ heading, groups, ctx, finished = false }) {
  if (!groups.length) return null;
  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="small">
        {groups.map((group, i) => (
          <s-stack key={group.key} direction="block" gap="small">
            {i ? <s-divider /> : null}
            <s-clickable disabled={Boolean(ctx.busy)} onClick={() => ctx.act.openGroup(group.key)}>
              {finished ? (
                <Item title={finishedLine(group)} lines={[]} badges={[]} />
              ) : (
                <Item title={gameTitle(group).name || 'Bookings'} lines={[groupLine(group)]} badges={groupBadges(group, ctx.now)} />
              )}
            </s-clickable>
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

/** "GM Kate · 6pm–10pm · T7, T8", "7pm–11pm · T9, T10" or "6 bookings". @param {Group} group */
function groupLine(group) {
  const { gm } = gameTitle(group);
  return [gm ? `GM ${gm}` : '', groupDetails(group)].filter(Boolean).join(' · ');
}

/* ---------------- a group: a GM game, an event, or the table bookings ---------------- */

/** @param {{ screen: GroupScreen, ctx: Ctx }} props */
function GroupView({ screen, ctx }) {
  const { today, busy, act, cart } = ctx;
  const group = today?.groups.find((g) => g.key === screen.key) || null;
  if (!group) {
    return (
      <Page heading="Not on today's list" subheading="">
        <BackButton ctx={ctx} />
        <Status ctx={ctx} />
        <s-banner tone="warning" heading="This one isn't on today's list any more">
          Go back to Today and tap Refresh.
        </s-banner>
      </Page>
    );
  }
  const { name, gm } = gameTitle(group);
  const subheading = [gm ? `GM ${gm}` : '', groupDetails(group)].filter(Boolean).join(' · ');
  const plan = groupPlan(group.rows, screen.ticked, cart.bookings);
  const busyNow = Boolean(busy);
  const rows = sortRows(group.rows);

  if (screen.picking) {
    // "Check in several at once": tick who's paying together, then one button.
    const byKey = new Map(rows.map((row) => [rowKey(row), row]));
    const tickable = plan.tickable.map((key) => byKey.get(key)).filter((row) => Boolean(row));
    return (
      <Page heading={name || 'Bookings'} subheading={subheading} action={<ScanAction ctx={ctx} />}>
        <Status ctx={ctx} />
        <CartStrip ctx={ctx} />
        <s-section heading="Who's paying together?">
          <s-choice-list multiple values={screen.ticked} onChange={(event) => act.setTicks([...(event.currentTarget.values || [])])}>
            {tickable.map((row) => (
              <s-choice key={rowKey(row)} value={rowKey(row)}>
                {tickLabel(row, cart)}
              </s-choice>
            ))}
          </s-choice-list>
        </s-section>
        <s-stack direction="block" gap="small">
          <s-button variant="primary" loading={ctx.busyKey === 'main'} disabled={busyNow || !plan.label} onClick={act.checkInGroup}>
            {plan.label || "Tick who's paying together"}
          </s-button>
          {plan.label ? (
            <s-text color="subdued">
              {plan.passNote ? 'A saved pass comes off when they check in, so it may come to less.' : plan.due ? CLOSES : 'Nothing to pay, so nothing goes in the cart.'}
            </s-text>
          ) : null}
          <s-button variant="secondary" disabled={busyNow} onClick={act.stopPicking}>
            Cancel
          </s-button>
        </s-stack>
      </Page>
    );
  }

  const toCome = rows.filter((row) => rowState(row) === 'waiting');
  const here = rows.filter((row) => rowState(row) === 'arrived');
  const others = rows.filter((row) => !['waiting', 'arrived'].includes(rowState(row)));
  /** @param {string} heading @param {Row[]} list */
  const section = (heading, list) =>
    list.length ? (
      <s-section heading={heading}>
        <RowList items={list.map((row) => ({ row, group, details: rowDetails(row) }))} cart={cart} busy={busy} onOpen={(row) => act.openRow(row, group)} />
      </s-section>
    ) : null;
  const several = plan.toCome.length > 1 || (!plan.toCome.length && plan.tickable.length > 1);
  return (
    <Page heading={name || 'Bookings'} subheading={subheading} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      <s-text type="strong">{groupSummary(group)}</s-text>
      <CartStrip ctx={ctx} />
      {several ? (
        <s-stack direction="block" gap="small">
          <s-button variant="primary" disabled={busyNow} onClick={() => act.startPicking(plan.toCome.length ? plan.toCome : plan.tickable)}>
            Check in several at once
          </s-button>
          <s-text color="subdued">For people paying together. Paying on their own? Tap their name, or scan their code.</s-text>
        </s-stack>
      ) : null}
      {section('Still to come', toCome)}
      {section('Here', here)}
      {section('Not coming', others)}
      {group.rows.length ? null : (
        <s-empty-state heading="No one has booked this yet" subheading="People who book show up here.">
          <s-icon slot="graphic" type="info" />
        </s-empty-state>
      )}
    </Page>
  );
}

/** "Sam Jones · Due $15 · Weekly": one person to tick. @param {Row} row @param {CartState} cart */
function tickLabel(row, cart) {
  const badges = rowBadges(row, Boolean(row.ref) && cart.bookings.includes(String(row.ref))).map((badge) => badge.text);
  return [row.name || 'Guest', peopleLabel(row.people) && Number(row.people) > 1 ? peopleLabel(row.people) : '', ...badges].filter(Boolean).join(' · ');
}

/* ---------------- a person: "Are you Sam?" ---------------- */

/** @param {{ screen: PersonScreen, ctx: Ctx }} props */
function PersonView({ screen, ctx }) {
  const { today, busy, act, cart } = ctx;
  const payer = gameTitle({ kind: 'game', title: screen.groupTitle }).gm;
  const row = withCover(currentRow(screen, today), screen.cover, payer);
  const plan = personPlan(row, screen.result, ctx.todayKey);
  const outcome = screen.result ? checkinOutcome(screen.result) : null;
  const ref = String(row.ref || '');
  const inCart = Boolean(ref) && cart.bookings.includes(ref);
  const share = ctx.pending[rowKey(row)] || null;
  const pending = pendingState(share, row, cart.shares, ctx.now);
  const justChecked = Boolean(outcome?.arrived);
  const inUse = passInUse(row, screen.uses);
  const main = personAction({ row, plan, choice: screen.choice, inUse, inCart, share: pending, justChecked });
  const choices = passOptions(row, screen.passes, inUse);
  const card = loyaltyCard(screen.loyalty);
  const busyNow = Boolean(busy);
  const first = firstName(row.name);
  const holding = pending === 'in-cart' || pending === 'waiting';
  const splitting = screen.split.open && plan.stage === 'pay' && !holding && !inCart;
  const asking = Boolean(screen.confirm);
  const showPasses =
    row.type !== 'join' && !splitting && !asking && !holding && !inCart && (plan.stage === 'check-in' || plan.stage === 'pay' || (plan.stage === 'done' && Boolean(inUse)));
  const cardShown = screen.filled ? (
    <s-banner tone="success" heading="Card full!">
      {`${cardFullWords(first)} Let them know.`}
    </s-banner>
  ) : card ? (
    <LoyaltySection card={card} />
  ) : null;
  /** @param {{ action: PersonActionName, label: string }} button */
  const label = (button) => (button.action === 'back' && button.label === 'Back' ? `‹ ${ctx.backLabel}` : button.label);

  if (plan.stage === 'done' && justChecked && !asking) {
    // They're in, with nothing to pay: ready for the next scan.
    return (
      <Page heading="Checked in" subheading={ref} action={<ScanAction ctx={ctx} />}>
        <Status ctx={ctx} />
        <s-banner tone="success" heading={first ? `${first}'s in` : "They're in"}>
          {[whyNothing(row), outcome?.notice || ''].filter(Boolean).join(' ')}
        </s-banner>
        {cardShown}
        {showPasses ? <PassChoice row={row} screen={screen} options={choices.options} inUse={inUse} stage={plan.stage} ctx={ctx} /> : null}
        <MainButtons main={main} label={label} ctx={ctx} />
      </Page>
    );
  }

  return (
    <Page heading={areYou(row)} subheading={ref} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      {plan.warning ? (
        <s-banner tone="warning" heading="Check before you let them in">
          {plan.warning}
        </s-banner>
      ) : null}
      {refundPending(row) ? (
        <s-banner tone="critical" heading="Refund to sort out">
          They paid online and this was cancelled or missed. Sort out the refund on the staff page.
        </s-banner>
      ) : null}
      <s-section heading={row.name || 'Guest'}>
        <s-stack direction="block" gap="small">
          {personFacts(row, screen.groupTitle).map((line) => (
            <s-text key={line}>{line}</s-text>
          ))}
          <Badges list={rowBadges(row, inCart)} />
        </s-stack>
      </s-section>
      <MoneySection row={row} plan={plan} />
      {cardShown}
      {screen.note ? (
        <s-banner tone="success" heading={screen.note.heading}>
          {screen.note.body}
        </s-banner>
      ) : null}
      {outcome?.arrived && plan.stage === 'pay' && (outcome.passText || outcome.notice) ? (
        <s-banner tone="info" heading={outcome.text}>
          {[outcome.passText ? `${outcome.passText}.` : '', outcome.notice].filter(Boolean).join(' ')}
        </s-banner>
      ) : null}
      {pending === 'in-cart' && share ? (
        <s-banner tone="info" heading={`A ${money(share.amount)} share is in the cart`}>
          Take payment with Pay on Verifone. Their share shows here once it's paid.
        </s-banner>
      ) : null}
      {pending === 'waiting' && share ? (
        <s-banner tone="info" heading={WAITING}>
          {`The ${money(share.amount)} share left the cart. It shows here as paid once the payment reaches the Lair app, usually within a minute.`}
        </s-banner>
      ) : null}
      {showPasses ? <PassChoice row={row} screen={screen} options={choices.options} inUse={inUse} stage={plan.stage} ctx={ctx} /> : null}
      {splitting ? <SplitPanel row={row} split={screen.split} ctx={ctx} /> : null}
      {asking ? null : <CartStrip ctx={ctx} person={row} />}
      {splitting || asking ? null : <MainButtons main={main} label={label} ctx={ctx} />}
      {splitting ? null : <GmPaysPanel row={row} screen={screen} payer={payer} inCart={inCart} holding={holding} ctx={ctx} />}
      {plan.stage === 'check-in' && row.type !== 'join' && dueOf(row) > 0 && !choices.options.length && !asking ? (
        <s-button variant="secondary" disabled={busyNow} onClick={() => act.scan('pass')}>
          Use a session pass
        </s-button>
      ) : null}
    </Page>
  );
}

/**
 * The person view's main button, what happens next under it, and the quieter ones.
 * @param {{ main: import('./flow.js').PersonAction, label: (button: { action: PersonActionName, label: string }) => string, ctx: Ctx }} props
 */
function MainButtons({ main, label, ctx }) {
  const busyNow = Boolean(ctx.busy);
  return (
    <s-stack direction="block" gap="small">
      <s-button variant="primary" loading={ctx.busyKey === 'main'} disabled={busyNow} onClick={() => ctx.act.person(main.action, main.force)}>
        {label(main)}
      </s-button>
      {main.hint ? <s-text color="subdued">{main.hint}</s-text> : null}
      {main.more.map((more) => (
        <s-button key={more.action} variant="secondary" loading={ctx.busyKey === more.action} disabled={busyNow} onClick={() => ctx.act.person(more.action)}>
          {label(more)}
        </s-button>
      ))}
    </s-stack>
  );
}

/**
 * The lines under the person's name: what, when and where, players and notes.
 * @param {Row} row
 * @param {string} groupTitle
 */
function personFacts(row, groupTitle) {
  const lines = [
    // A seat's group says who's running the game: "GM seat: Curse of Strahd · GM Kate".
    row.kind === 'gm-seat' && groupTitle ? `GM seat: ${groupTitle}` : whatLabel(row),
    [peopleLabel(row.people), tablesLabel(row.tables)].filter(Boolean).join(' at '),
    row.owed ? owedWhen(row) : whenLabel(row.start, row.end),
  ];
  const players = playerNames(row);
  if (players.length) lines.push(`Players: ${players.join(', ')}`);
  if (row.note) lines.push(`Note: ${row.note}`);
  return lines.filter(Boolean);
}

/**
 * What's to pay, big, with how it's made up: a pass, what's paid so far, the GM paying.
 * @param {{ row: Row, plan: ReturnType<typeof personPlan> }} props
 */
function MoneySection({ row, plan }) {
  const due = dueOf(row);
  /** @type {string[]} */
  const lines = [];
  if (Number(row.covered) > 0 && !row.owed) lines.push(`A pass covered ${money(row.covered)}.`);
  if (!row.owed && plan.stage === 'check-in' && (row.pass?.code || row.pass?.label)) lines.push(`Saved pass: ${passSummary(row.pass)}.`);
  const paid = paidSummary(row);
  if (paid) lines.push(paid);
  const who = paymentsLine(row);
  if (who) lines.push(`Paid so far: ${who}`);
  if (row.split) lines.push('They said they would split the bill.');
  if (gmPaysFor(row)) {
    const gm = row.gmPays || {};
    lines.push(`${gm.payer || 'The GM'} pays ${gm.amount ? money(gm.amount) : 'the table fee'} for this seat, on their account.`);
  }
  if (plan.stage === 'owed' && row.owed) lines.push("A weekly regular's seat is theirs to pay for, even if they didn't come. To let them off, waive it on the staff page.");
  return (
    <s-section heading={row.owed ? `Owed from ${owedWhen(row)}` : 'To pay'}>
      <s-stack direction="block" gap="small">
        <s-heading>{due ? money(due) : 'Nothing to pay'}</s-heading>
        {lines.map((line) => (
          <s-text key={line} color="subdued">
            {line}
          </s-text>
        ))}
      </s-stack>
    </s-section>
  );
}

/**
 * The loyalty card: a star for each stamp, then what's left and any rolls waiting.
 * @param {{ card: import('./loyalty.js').Card }} props
 */
function LoyaltySection({ card }) {
  const words = rollWords(card);
  return (
    <s-section heading={cardHeading(card)}>
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small-300">
          {stampMarks(card).map((stamped, i) => (
            <s-icon key={i} type={stamped ? 'star-filled' : 'circle'} tone={stamped ? 'caution' : 'neutral'} />
          ))}
        </s-stack>
        <s-text>{stampWords(card)}</s-text>
        {words ? <s-text color="subdued">{words}</s-text> : null}
      </s-stack>
    </s-section>
  );
}

/**
 * "GM pays for a player" (contract v21-gm-cover), on a GM game's player: "Kate pays for this seat", then a yes or no
 * on the screen; once Kate pays, "Stop Kate paying" (with its own yes or no). Neither while the seat's own line is in
 * the sale: paying it ends the GM's offer, and Kate's charge on top would take too much. Kate pays her charge from her
 * own member code ("Add everything") or her tab, like any booking.
 * @param {{ row: Row, screen: PersonScreen, payer: string, inCart: boolean, holding: boolean, ctx: Ctx }} props
 *   inCart: the seat's line is in the cart; holding: a share of it is in the cart or its payment is on its way
 */
function GmPaysPanel({ row, screen, payer, inCart, holding, ctx }) {
  const { act, busy } = ctx;
  const choice = gmPaysChoice(row, inCart || holding);
  // A share paid a moment ago: the player is paying, so there's nothing for the GM to pay.
  if (!choice || (choice === 'in-cart' && !inCart)) return null;
  const name = row.gmPays?.payer || payer;
  // "The GM" to start a sentence, "the GM" inside one, when the GM's name isn't known.
  const gm = name || 'The GM';
  const gmIn = name || 'the GM';
  const first = firstName(row.name) || 'them';
  const busyNow = Boolean(busy);
  if (choice === 'in-cart') {
    return <s-text color="subdued">{`For ${gmIn} to pay for this seat, take ${first}'s fee off the sale first.`}</s-text>;
  }
  if (screen.confirm === 'cover' && choice === 'offer') {
    return (
      <s-section heading={`${gm} pays for ${first}'s seat?`}>
        <s-stack direction="block" gap="small">
          <s-text>
            {`${row.gmPays?.amount ? money(row.gmPays.amount) : "The seat's table fee"} goes on ${gmIn}'s account. ${first} pays nothing, and ${gmIn} gets no GM credit for this seat.`}
          </s-text>
          <s-button variant="primary" loading={ctx.busyKey === 'gm-pays'} disabled={busyNow} onClick={act.cover}>
            {`Yes, ${gmIn} pays`}
          </s-button>
          <s-button variant="secondary" disabled={busyNow} onClick={() => act.askGm(null)}>
            Cancel
          </s-button>
        </s-stack>
      </s-section>
    );
  }
  if (screen.confirm === 'uncover' && choice === 'stop') {
    return (
      <s-section heading={`Stop ${gmIn} paying for ${first}'s seat?`}>
        <s-stack direction="block" gap="small">
          <s-text>{`${first}'s seat goes back to its full price. If ${gmIn} has paid it already, staff get an email to give that money back.`}</s-text>
          <s-button variant="primary" tone="critical" loading={ctx.busyKey === 'gm-stop'} disabled={busyNow} onClick={act.uncover}>
            {`Yes, stop ${gmIn} paying`}
          </s-button>
          <s-button variant="secondary" disabled={busyNow} onClick={() => act.askGm(null)}>
            Cancel
          </s-button>
        </s-stack>
      </s-section>
    );
  }
  return choice === 'stop' ? (
    <s-button variant="secondary" tone="critical" disabled={busyNow} onClick={() => act.askGm('uncover')}>
      {`Stop ${gmIn} paying`}
    </s-button>
  ) : (
    <s-button variant="secondary" disabled={busyNow} onClick={() => act.askGm('cover')}>
      {`${gm} pays for this seat`}
    </s-button>
  );
}

/**
 * The session pass. Before check-in: their one pass is a switch (on when it's saved on the booking), or a choice of
 * theirs. Once they're here: the pass in use with "Undo pass", or another one to switch to, or a pass to cover what's
 * left.
 * @param {{ row: Row, screen: PersonScreen, options: { value: string, label: string }[],
 *   inUse: { code: string, label: string } | null, stage: string, ctx: Ctx }} props
 */
function PassChoice({ row, screen, options, inUse, stage, ctx }) {
  const { act, busy } = ctx;
  const here = stage !== 'check-in';
  const change = here ? passChange(inUse, screen.choice) : null;
  const passes = options.filter((option) => option.value !== 'none');
  if (!options.length && !inUse) return null;
  if (!here && passes.length === 1) {
    const only = passes[0];
    return (
      <s-section heading="Session pass">
        <s-stack direction="block" gap="small">
          <s-switch
            label={only.label}
            details="Each session covers one person's table fee. Turn it off to pay instead."
            checked={screen.choice === only.value}
            disabled={Boolean(busy)}
            onChange={(event) => act.setChoice(event.currentTarget.checked ? only.value : 'none')}
          />
          <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.scan('pass')}>
            Scan a different pass
          </s-button>
        </s-stack>
      </s-section>
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
        {change && change.action === 'switch' ? (
          // ("Use the pass" for what's left is the screen's main button.)
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
            <s-text color="subdued">Or scan their member code with the scanner.</s-text>
            <s-button variant="secondary" disabled={Boolean(busy)} onClick={() => act.scan('payer')}>
              Scan with the camera
            </s-button>
            <CodeEntry label="Or type their member code" placeholder="AK-KIWI-3" busy={Boolean(busy)} onFind={(text) => act.lookUp(text, 'payer')} />
            <s-text color="subdued">No member code? Go ahead anyway: it just won't count toward anyone's spend.</s-text>
          </s-stack>
        )}

        <s-button variant="primary" loading={ctx.busyKey === 'main'} disabled={Boolean(busy) || !amount} onClick={act.addShare}>
          {amount ? `Add ${money(amount)} to cart` : 'Add to cart'}
        </s-button>
        <s-text color="subdued">{CLOSES}</s-text>
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
  const first = firstName(name);
  const onSale = cart.customerId !== null && cart.customerId === customerIdNumber(member.customerId);
  // Rows from the Today list where it has them (they're updated as people check in). Owed sessions and a GM's charges
  // for their players' seats are listed apart.
  const rows = withGroups(screen.rows, today);
  const todayRows = rows.filter(({ row }) => !row.owed && row.kind !== 'gm-cover');
  const charges = rows.filter(({ row }) => !row.owed && row.kind === 'gm-cover');
  const owedRows = rows.filter(({ row }) => row.owed);
  const everything = everythingPlan(rows.map((x) => x.row), screen.tab, cart);
  const tab = tabPlan(screen.tab, cart.tabs);
  const { items, bad } = tabItems(screen.tab);
  const card = loyaltyCard(screen.loyalty);
  const monthly = screen.account?.billing === 'monthly';
  const account = accountLine(screen.account);
  const busyNow = Boolean(busy);
  const openRow = (/** @type {Row} */ row, /** @type {Group | null} */ group) => act.openRow(row, group, screen.passes, screen.loyalty || null);
  return (
    <Page heading={name} subheading={member.code ? `Member ${member.code}` : 'Member'} action={<ScanAction ctx={ctx} />}>
      <BackButton ctx={ctx} />
      <Status ctx={ctx} />
      {account ? (
        <s-banner tone="info" heading="Monthly account">
          {account}
        </s-banner>
      ) : null}
      {card ? <LoyaltySection card={card} /> : null}
      <s-section heading="To pay">
        <s-stack direction="block" gap="small">
          <s-heading>{everything.total ? money(everything.total) : 'Nothing to pay'}</s-heading>
          {everything.parts ? <s-text color="subdued">{everything.parts}</s-text> : null}
          {everything.note ? <s-text color="subdued">{everything.note}</s-text> : null}
        </s-stack>
      </s-section>
      <CartStrip ctx={ctx} person={{ customerId: member.customerId, name }} />
      {!everything.show ? (
        <s-text color="subdued">{`Nothing to check in or pay for ${first || 'them'} today.`}</s-text>
      ) : monthly ? (
        <s-stack direction="block" gap="small">
          {everything.today.waiting ? (
            <s-button variant="primary" loading={ctx.busyKey === 'main'} disabled={busyNow} onClick={act.checkInMemberOnly}>
              Check in
            </s-button>
          ) : null}
          {everything.total || everything.tab ? (
            <s-button variant={everything.today.waiting ? 'secondary' : 'primary'} loading={ctx.busyKey === 'everything'} disabled={busyNow} onClick={act.addEverything}>
              {`Pay now: ${everything.label}`}
            </s-button>
          ) : null}
        </s-stack>
      ) : (
        <s-stack direction="block" gap="small">
          <s-button variant="primary" loading={ctx.busyKey === 'everything'} disabled={busyNow} onClick={act.addEverything}>
            {everything.label}
          </s-button>
          <s-text color="subdued">
            {everything.total || everything.tab
              ? `${everything.today.waiting ? `Checks ${first || 'them'} in, adds` : 'Adds'} what they owe and puts ${first || 'them'} on the sale. ${CLOSES}`
              : `Checks ${first || 'them'} in. Nothing goes in the cart.`}
          </s-text>
        </s-stack>
      )}

      {todayRows.length ? (
        <s-section heading="Today">
          <RowList
            items={todayRows.map(({ row, group }) => ({ row, group, details: [whatLabel(row), rowDetails(row)].filter(Boolean).join(' · ') }))}
            cart={cart}
            busy={busy}
            onOpen={openRow}
          />
        </s-section>
      ) : null}

      {charges.length ? (
        <s-section heading="Paying for players">
          <RowList
            items={charges.map(({ row, group }) => ({ row, group, details: whenLabel(row.start, row.end) }))}
            cart={cart}
            busy={busy}
            onOpen={openRow}
            titleOf={(row) => whatLabel(row)}
          />
        </s-section>
      ) : null}

      {owedRows.length ? (
        <s-section heading="Owed">
          <s-stack direction="block" gap="small">
            <s-text color="subdued">
              {owedRows.some(({ row }) => row.onAccount)
                ? 'What they owe on their account, and any sessions they kept a seat for. Tap one to add just that.'
                : "Sessions they kept a seat for and haven't paid. Tap one to add just that."}
            </s-text>
            <RowList
              items={owedRows.map(({ row, group }) => ({ row, group, details: [whatLabel(row), owedWhen(row)].filter(Boolean).join(' · ') }))}
              cart={cart}
              busy={busy}
              onOpen={openRow}
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
            {tab.canAdd && everything.separate ? (
              <s-button variant="secondary" loading={ctx.busyKey === 'tab'} disabled={busyNow} onClick={act.addTab}>
                Add just the tab
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
                <s-clickable disabled={busyNow} onClick={() => act.openPass(pass)}>
                  <Item title={pass.label || 'Session pass'} lines={[passLine(pass)]} badges={[]} />
                </s-clickable>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {onSale ? null : (
        <s-button variant="secondary" loading={ctx.busyKey === 'on-sale'} disabled={busyNow} onClick={act.putMemberOnSale}>
          {`Put ${first || 'them'} on this sale`}
        </s-button>
      )}
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
              items={candidates.map(({ row, group }) => ({ row, group, details: [gameTitle(group).name, rowDetails(row)].filter(Boolean).join(' · ') }))}
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

/* ---------------- in the cart: only if the screen didn't close by itself ---------------- */

/** @param {{ screen: ReadyScreen, ctx: Ctx }} props */
function ReadyView({ screen, ctx }) {
  const { act, busy } = ctx;
  return (
    <Page heading="In the cart" subheading={screen.who}>
      <Status ctx={ctx} />
      <s-banner tone="success" heading={screen.heading}>
        {screen.body}
      </s-banner>
      {screen.extra ? (
        <s-banner tone="success" heading="Card full!">
          {screen.extra}
        </s-banner>
      ) : null}
      <s-button variant="primary" disabled={Boolean(busy)} onClick={act.close}>
        Close and pay
      </s-button>
      <s-button variant="secondary" disabled={Boolean(busy)} onClick={act.home}>
        Add someone else to this sale
      </s-button>
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

/** "Scan" in the action bar: the camera, for whatever code they show. @param {{ ctx: Ctx }} props */
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

/**
 * What's in the cart and who's on the sale. When someone else is on a sale with something in it, a warning: this
 * person's fee would join it.
 * @param {{ ctx: Ctx, person?: { customerId?: unknown, name?: string } | null }} props
 */
function CartStrip({ ctx, person = null }) {
  const strip = saleStrip(ctx.cart.value, ctx.names, person);
  if (strip.tone === 'warning') {
    return (
      <s-banner tone="warning" heading={strip.text}>
        {strip.detail}
      </s-banner>
    );
  }
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-icon type="cart" tone="neutral" />
      <s-text color="subdued">{strip.text}</s-text>
    </s-stack>
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

/** A problem and its next step as a button under it: Try again, or what the problem says to do. @param {{ problem: Shown, busy: boolean }} props */
function ProblemBanner({ problem, busy }) {
  const retry = problem.retry;
  const next = problem.action;
  return (
    <s-stack direction="block" gap="small">
      <s-banner tone={problem.tone} heading={problem.title}>
        {problem.message}
      </s-banner>
      {retry ? (
        <s-button disabled={busy} onClick={() => retry()}>
          Try again
        </s-button>
      ) : next ? (
        <s-button disabled={busy} onClick={() => next.run()}>
          {next.label}
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
 * @param {{ items: { row: Row, group: Group | null, details: string }[], cart: CartState, busy: string,
 *   onOpen: (row: Row, group: Group | null) => void, titleOf?: (row: Row) => string }} props
 */
function RowList({ items, cart, busy, onOpen, titleOf }) {
  return (
    <s-stack direction="block" gap="small">
      {items.map(({ row, group, details }, i) => (
        <s-stack key={rowKey(row)} direction="block" gap="small">
          {i ? <s-divider /> : null}
          <s-clickable disabled={Boolean(busy)} onClick={() => onOpen(row, group)}>
            <Item
              title={titleOf ? titleOf(row) : row.name || 'Guest'}
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
