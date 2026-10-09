// Library memberships: Grab, Stash and Hoard, billed by the Lair itself through Shopify's subscription contracts
// (replacing Simplee Memberships).
//
// How it fits together
// - The Lair Memberships app (a second Shopify app, made in the Dev Dashboard) owns the membership selling plans and
//   the contracts people make at checkout. It logs in with its own client ID and secret (MEMBERSHIPS_CLIENT_ID,
//   MEMBERSHIPS_CLIENT_SECRET), separate from the Lair's own app, so card access never rides on the Lair's token.
// - Shopify keeps the card. The Lair decides when to charge: each renewal bills one Shopify billing cycle, with an
//   idempotency key built from the contract, the cycle and the try, so a request sent twice is one charge.
// - Webhooks (/webhooks/memberships) say when a contract is made or changes, and how each charge went.
// - The 10-minute maintenance bills what's due, retries failed payments, moves damage charges on once their notice
//   runs out, and ends memberships that were cancelled or couldn't be paid.
// - Damage charges ride on a member's next bill: the cycle being billed gets the charge added to it (that cycle only),
//   so it's one payment and one Shopify order. Or, once its notice has been emailed, staff take one straight away: from
//   the member's store credit (the Lair's own app), or on their saved card through a one-off contract of its own,
//   billed once and then cancelled.
// - Nothing charges a card until MEMBERSHIPS_BILLING is 'on'. Until then the Lair keeps its records up to date only.
//
// Never twice, never early: the rules every change here keeps
// - One charge in flight per membership. A charge is claimed (its row written) before Shopify is asked, and only from
//   a freshly read row that is due right now, so overlapping runs and webhooks can't bill early or twice.
// - A charge that may have reached Shopify (its send never came back) is looked up by its key before anything else
//   happens to it. A charge Shopify could still complete (a bank check) is never tried again: if it's never finished
//   the membership ends, and a late success is still taken (staff hear if that makes two).
// - Before every send the cycle is read (not billed or skipped already) and given exactly that charge's damage
//   charges, or none, so a waived charge left on a cycle is never billed.
// - A cycle more than 2 days late is never billed: missed months are skipped (staff hear), not billed in a burst.
// - Only a failed payment on the member's card counts as a try. Shopify refusing the request, or a failure that isn't
//   the card (the store, the payment provider), voids or holds the charge and tells staff; the member isn't emailed.
//
// These are Lair methods: lair.js copies them onto Lair.prototype, so `this` is the Durable Object. The usual rule
// holds: every await first, then one synchronous read-check-write.
import { HOUR, MIN, LairTime, RuleError, libraryPlan, makeId } from './core.js';
import { ShopifyAdmin, emailReady } from './shopify.js';

/* ---------- small helpers (the same as lair.js's) ---------- */
const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const money = (cents) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const trimmed = (v, max) => String(v ?? '').trim().slice(0, max);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const cents = (amount) => {
  const n = Math.round(Number(amount) * 100);
  return Number.isFinite(n) ? n : 0;
};
const decimal = (c) => (c / 100).toFixed(2);
const DAY = 24 * HOUR;

/** The number at the end of a Shopify gid ("gid://shopify/SubscriptionContract/123" → "123"), or the text as it is. */
export const numericId = (value) => String(value ?? '').trim().split('/').pop();
const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

/** `ms` moved on `n` calendar months (UTC): a stand-in for when Shopify hasn't said when the next bill is */
export const addMonths = (ms, n) => {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
};

/** Shopify's revision ids only go up: true when `a` is older than `b` (either missing: false) */
const olderRevision = (a, b) => /^\d+$/.test(String(a ?? '')) && /^\d+$/.test(String(b ?? '')) && BigInt(a) < BigInt(b);

/* ---------- the plans and the rules (Mo, October 2026) ---------- */
/** The three library plans: games a member can have at once (reserved and at home together) and the monthly price. */
export const TIERS = {
  grab: { key: 'grab', name: 'Grab', games: 1, price: 3000 },
  stash: { key: 'stash', name: 'Stash', games: 3, price: 6000 },
  hoard: { key: 'hoard', name: 'Hoard', games: 5, price: 7500 },
};
export const TIER_ORDER = ['grab', 'stash', 'hoard'];
/** A damage charge waits this long after its notice before it can go on a bill (Mo, 9 Oct 2026) */
export const FEE_NOTICE_DAYS = 7;
/** A damage charge is $1 to $500 (up to a game's RRP) */
export const FEE_MIN = 100;
export const FEE_MAX = 50000;
export const FEE_REASONS = { missing: 'Missing parts', damaged: 'Damaged', lost: 'Lost or not returned' };
/** After a renewal fails: try again this many days after the first failure, then it ends (3 tries in a week) */
export const RETRY_DAYS = [3, 7];
export const MAX_ATTEMPTS = RETRY_DAYS.length + 1;
/** A payment waiting on the member's bank check (3D Secure) this long pauses borrowing. It's never tried again. */
export const CHALLENGE_DAYS = 3;
/** A membership left waiting this long (on a bank check, or on a new card after the bank flagged a payment) ends */
export const GIVE_UP_DAYS = 7;
/** A billing cycle more than this late isn't billed: the membership moves on to the next one (staff hear) */
export const LATE_GRACE = 2 * DAY;
/** Shopify refused a bill, or a payment failed for a reason that isn't the card: the next try waits this long */
export const REFUSAL_HOLD = DAY;
/** The first renewal is never billed sooner than this after joining (the checkout paid the first month); staff hear
 * if Shopify's first cycle is later than the second number. */
const FIRST_BILL_MIN_DAYS = 25;
const FIRST_BILL_MAX_DAYS = 35;
/** A charge Shopify hasn't answered is asked about after this; a bank check every 2 hours */
const RECONCILE_AFTER = 30 * MIN;
const CHALLENGE_CHECK_EVERY = 2 * HOUR;
/** A claim no run finished (the Worker stopped, or Shopify didn't answer) is picked up again after this; staff hear
 * about one still stuck after 2 hours, and one that never reached Shopify within LATE_GRACE is dropped */
const CLAIM_STALE = 15 * MIN;
const STUCK_ALERT_AFTER = 2 * HOUR;
/** Failures on the store's side and Shopify refusals for one cycle: after this many, billing it stops for a month
 * (staff hear), so a card is never tried day after day (Shopify revokes one after 30 tries in 35 days) */
const STORE_SIDE_MAX = 3;
const STOPPED_HOLD = 30 * DAY;
/** While a member's plan change is with Shopify, nothing is billed for them */
const PLAN_CHANGE_LOCK = 2 * MIN;
/** A membership whose next bill date Shopify couldn't give is asked again after this */
const DATES_RETRY_EVERY = 30 * MIN;
/** One maintenance run at a time: a second one this soon after the first started does nothing */
const RUN_LOCK = 5 * MIN;
/** Shopify's card update email: at most once an hour for a membership */
const CARD_EMAIL_GAP = HOUR;
/** At most this many charges started (and this many checked) in one maintenance run, so a run stays short */
const CHARGES_A_RUN = 20;
const CHECKS_A_RUN = 10;
/** Webhook ids are kept this long to spot repeats */
const EVENT_KEEP_DAYS = 7;
/** The selling plan group the Lair made, found again by its merchant code */
export const GROUP_CODE = 'lair-library-membership';
/** The product damage charges are billed as (made by setup when there's no MEMBERSHIPS_FEE_VARIANT_ID) */
export const FEE_HANDLE = 'library-damage-charge';
/** What Lair Memberships needs from Shopify (read_orders: a billing attempt's order) */
export const MEMBERSHIP_SCOPES = [
  'read_own_subscription_contracts', 'write_own_subscription_contracts', 'read_customer_payment_methods', 'read_orders', 'write_products',
  'read_customers', 'write_customers',
];
/** The webhooks Lair Memberships asks for (GraphQL topic names) */
export const MEMBERSHIP_TOPICS = [
  'SUBSCRIPTION_CONTRACTS_CREATE', 'SUBSCRIPTION_CONTRACTS_UPDATE', 'SUBSCRIPTION_CONTRACTS_ACTIVATE', 'SUBSCRIPTION_CONTRACTS_PAUSE',
  'SUBSCRIPTION_CONTRACTS_CANCEL', 'SUBSCRIPTION_CONTRACTS_EXPIRE', 'SUBSCRIPTION_CONTRACTS_FAIL',
  'SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS', 'SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE', 'SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED',
  'CUSTOMER_PAYMENT_METHODS_CREATE', 'CUSTOMER_PAYMENT_METHODS_UPDATE', 'CUSTOMER_PAYMENT_METHODS_REVOKE',
];
/**
 * Failed payments that aren't the member's card: the store, the payment provider, Shopify or stock. They never count as
 * a try and the member isn't emailed; staff hear, and it's tried again the next day (at most 3 times a cycle). A card
 * the gateway can't take, or a wrong address, is the member's to fix, so those count as tries.
 */
export const NOT_THE_CARD = new Set([
  'MERCHANT_ACCOUNT_ERROR', 'MERCHANT_RULE', 'PAYMENT_PROVIDER_IS_NOT_ENABLED', 'NON_TEST_ORDER_LIMIT_REACHED', 'TEST_MODE', 'CUSTOMER_INVALID',
  'CUSTOMER_NOT_FOUND', 'FREE_GIFT_CARD_NOT_ALLOWED', 'INSUFFICIENT_INVENTORY', 'INVENTORY_ALLOCATIONS_NOT_FOUND', 'INVALID_AMOUNT',
  'AMOUNT_TOO_LARGE', 'AMOUNT_TOO_SMALL', 'INVALID_CURRENCY', 'INVALID_PURCHASE_TYPE', 'PURCHASE_TYPE_NOT_SUPPORTED', 'INVOICE_ALREADY_PAID',
  'UNEXPECTED_ERROR',
]);
/** Shopify refusing a bill for one of these means the Lair's cycle is wrong: the next cycle is read again */
const CYCLE_REFUSALS = ['BILLING_CYCLE_SKIPPED', 'BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE', 'CYCLE_INDEX_OUT_OF_RANGE', 'CYCLE_START_DATE_OUT_OF_RANGE', 'UPCOMING_CYCLE_LIMIT_EXCEEDED'];
/** A charge in these is still with the Lair or Shopify */
const OPEN = "('claimed', 'pending', 'challenged')";

/* Damage charges taken now (Mo, 9 Oct 2026: "charge them immediately either by taking their credit or charging their
 * card"), once the notice has been emailed */
/** The idempotency key of a damage charge payment's one billing attempt */
export const payNowKey = (paymentId) => `lair-damage-${paymentId}`;
/** Damage charges staff can take now */
const CHARGEABLE_NOW = ['notice', 'due', 'unpaid'];
/** A damage charge payment in these is still with the Lair or Shopify */
const PAYING = "('claimed', 'checking', 'pending', 'challenged')";
/** Store credit whose answer was lost is looked for in the account after this; still not there after the second, it
 * didn't come off; staff are asked to look if Shopify can't say for an hour */
const CREDIT_CHECK_AFTER = 2 * MIN;
const CREDIT_GONE_AFTER = 10 * MIN;
const CREDIT_ASK_AFTER = HOUR;
/** A one-off charge contract whose making may have reached Shopify is looked for this long before it's made again */
const CONTRACT_LOOK_AFTER = 2 * MIN;

/** The words members and staff see, kept together so the theme's demo can say the same */
export const MEMBERSHIP_MESSAGES = {
  login: 'Log in to manage your library membership.',
  none: "You're not in the library yet. Join on the library page.",
  noneStaff: 'No library membership with that ID.',
  tier: 'Pick Grab, Stash or Hoard.',
  same: (name) => `You're already on ${name}.`,
  pastDue: 'Sort out your last payment first, then you can change plans.',
  ending: "Your membership is ending, so the plan can't change. Keep your membership first, then pick a new plan.",
  editsWaiting: 'You can change plans once your payment has gone through.',
  changing: 'Your plan is changing right now. Try again in a minute.',
  plansNotReady: "Plan changes aren't open yet. Ask us at the counter and we'll sort it.",
  shopifyDown: "Shopify didn't answer just now. Try again in a minute.",
  notActive: "That membership isn't active, so there's nothing to cancel.",
  notCancelling: "Your membership isn't set to end, so there's nothing to undo.",
  tooLate: 'Your membership has already ended. Join again on the library page.',
  noCard: "There's no card on your membership. Ask us at the counter.",
  cardSoon: 'Shopify sent you a link in the last hour. Check your inbox, and your spam folder too.',
  blocked: "Your last library payment didn't go through, so borrowing is paused. Update your card in My Lair and Gobgob will try again.",
  blockedBank: 'Your bank wants you to confirm your last library payment, so borrowing is paused. Look for the email from Shopify, and check your spam folder too.',
  feeAmount: "A charge is $1 to $500 (no more than the game's RRP).",
  feeReason: 'Pick what happened: missing parts, damaged, or lost.',
  feeTitle: 'Say which game it is.',
  feeMember: 'No member with that customer ID.',
  feeLoan: "That loan isn't this member's.",
  feeNone: 'That charge could not be found.',
  feeNotYours: "That charge isn't yours.",
  feeLocked: "That charge is being paid right now. Once it's gone through, refund it in Shopify if you need to.",
  feeDispute: "That charge can't be disputed now. Have a chat with us at the counter.",
  feeAction: 'Pick waive, hold, reinstate, counter (paid at the counter) or a new amount.',
  feeChange: "That charge can't change now.",
  staffWhen: "Pick when it ends: 'end' (at the end of the month they've paid for) or 'now'.",
  retryNotDue: "That membership's payments are fine, so there's nothing to retry.",
  retryBank: "That payment is waiting on the member's bank check, so it can't be tried again yet.",
  // charging a damage charge now (staff)
  feeUse: "Pick 'credit' (their store credit), 'card' (their saved card) or 'auto' (store credit if it covers it, else the card).",
  feeNotEmailed: "The notice hasn't been emailed yet, so it can't be charged now. Check the member has an email address.",
  feeOnHold: 'That charge is on hold. Put it back on first.',
  feePaid: 'That charge is paid already.',
  feeWaived: 'That charge was waived. Put it back on first.',
  cardsOff: 'Card charges are off until library billing is switched on. Use store credit, or collect it at the counter.',
  noCardSaved: (name) => `There's no card saved for ${name}. Use store credit, or collect it at the counter.`,
  noFeeProduct: "There's no damage charge product to bill the card with yet. Run setup with memberships=plans.",
  membershipsOff: "Lair Memberships isn't connected, so cards can't be charged right now.",
  creditOff: "Shopify isn't connected, so store credit can't be used right now.",
  creditShort: (name, amount, balance) => (balance != null && balance > 0
    ? `${name} has ${money(balance)} of store credit, so it can't cover ${money(amount)}. Nothing came off.`
    : `${name} doesn't have ${money(amount)} of store credit, so nothing came off.`),
  noWayNow: (name) => `There's no way to take it from ${name} now: not enough store credit and no card to charge. Collect it at the counter.`,
  settleNone: "That charge isn't waiting on a store credit check.",
  settleSay: 'Say whether the store credit came off: taken true or false.',
  settleWait: 'The Lair is still checking with Shopify. Try again in a few minutes.',
  cardFlagged: (name) => `${name}'s bank flagged their card, so it can't be charged until they update it. Use store credit, or collect it at the counter.`,
};

/* ---------- pure helpers (exported for the tests) ---------- */

/** A selling plan's tier from its name, matched without case: "hoard", "stash" (or "treasure"), "grab" (or "loot"). */
export function tierOf(name) {
  const text = String(name ?? '').toLowerCase();
  if (text.includes('hoard')) return 'hoard';
  if (text.includes('stash') || text.includes('treasure')) return 'stash';
  if (text.includes('grab') || text.includes('loot')) return 'grab';
  return null;
}

/** The higher of two tiers (null counts as nothing) */
export const higherTier = (a, b) => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

/** The idempotency key for one try at billing one cycle of a contract: the same request twice is one charge. */
export const chargeKey = (contractId, cycle, attempt) => `lair-membership-${numericId(contractId)}-c${cycle}-a${attempt}`;

/** When to try again after a failed renewal, from the first failure: null once the last try has failed. */
export function retryAt(firstFailedAt, failedTries) {
  if (failedTries >= MAX_ATTEMPTS) return null;
  return firstFailedAt + RETRY_DAYS[failedTries - 1] * DAY;
}

/** "Tue 3 Nov" in the Lair's time zone */
export function billDay(ms, tz) {
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** A card in words: "Visa ending 4242", "PayPal", or "your card" */
export function cardWords(card) {
  if (!card) return 'your card';
  if (card.kind === 'paypal') return 'PayPal';
  return card.last4 ? `${card.brand || 'Card'} ending ${card.last4}` : 'your card';
}

/** A billing attempt's state from Shopify's state union: { state: 'pending' | 'paid' | 'failed' | 'action', ... } */
export function attemptState(s) {
  const state = s || {};
  if (state.__typename === 'SubscriptionBillingAttemptSuccessState') return { state: 'paid', orderId: state.order?.id || null };
  if (state.__typename === 'SubscriptionBillingAttemptFailedState') {
    const e = state.error || {};
    return { state: 'failed', code: String(e.paymentCode || e.inventoryCode || e.generalCode || 'UNEXPECTED_ERROR').toUpperCase(), message: e.message || null };
  }
  if (state.__typename === 'SubscriptionBillingAttemptActionRequiredState') return { state: 'action', nextActionUrl: state.action?.nextActionUrl || null };
  return { state: 'pending' };
}

/** What a damage charge is for, as its bill line says it */
const feeLabel = (f) => `${FEE_REASONS[f.reason] || f.reason}: ${f.title}${f.details ? ` (${f.details})` : ''}`;

/** Shopify's userErrors as [{ code, message }] */
const errorsOf = (list) => (list || []).map((e) => ({ code: e.code ? String(e.code).toUpperCase() : null, message: String(e.message || '') }));
const errorWords = (errors) => (errors || []).map((e) => [e.code, e.message].filter(Boolean).join(': ')).filter(Boolean).join('; ').slice(0, 300) || 'Shopify said no';

/* ---------- Lair Memberships: Shopify calls ---------- */
const FAILED_FIELDS = `... on SubscriptionBillingAttemptFailedState { error { __typename
  ... on SubscriptionBillingAttemptPaymentError { paymentCode: code }
  ... on SubscriptionBillingAttemptInventoryError { inventoryCode: code }
  ... on SubscriptionBillingAttemptGeneralError { generalCode: code }
  ... on SubscriptionBillingAttemptUnexpectedError { message } } }
... on SubscriptionBillingAttemptActionRequiredState { action { ... on SubscriptionBillingAttemptPaymentChallenge { nextActionUrl } } }`;

export class MembershipsAdmin extends ShopifyAdmin {
  constructor(env, storage) {
    super(env, storage, { clientId: env.MEMBERSHIPS_CLIENT_ID, clientSecret: env.MEMBERSHIPS_CLIENT_SECRET, tokenKey: 'memberships-token' });
  }

  /**
   * One contract as the Lair needs it, or null. read_own_subscription_contracts and read_customer_payment_methods. (No
   * order fields: orders over 60 days old are out of reach, so the origin order comes from the webhook instead.)
   */
  async contract(id) {
    const data = await this.graphql(
      `query MembershipContract($id: ID!) { subscriptionContract(id: $id) { id status createdAt currencyCode revisionId
        customer { id }
        customerPaymentMethod(showRevoked: true) { id revokedAt instrument { __typename
          ... on CustomerCreditCard { brand lastDigits expiryMonth expiryYear }
          ... on CustomerShopPayAgreement { lastDigits expiryMonth expiryYear }
          ... on CustomerPaypalBillingAgreement { paypalAccountEmail } } }
        billingPolicy { interval intervalCount }
        lines(first: 10) { nodes { id sellingPlanId sellingPlanName variantId productId title quantity currentPrice { amount currencyCode } } } } }`,
      { id: gid('SubscriptionContract', id) },
    );
    const c = data.subscriptionContract;
    if (!c) return null;
    const pm = c.customerPaymentMethod;
    const i = pm?.instrument || null;
    const card = !i ? null
      : i.__typename === 'CustomerPaypalBillingAgreement' ? { kind: 'paypal' }
        : { kind: i.__typename === 'CustomerShopPayAgreement' ? 'shop-pay' : 'card', brand: i.brand || (i.__typename === 'CustomerShopPayAgreement' ? 'Shop Pay' : 'Card'), last4: i.lastDigits || '', expMonth: i.expiryMonth || null, expYear: i.expiryYear || null };
    return {
      gid: c.id, id: numericId(c.id), status: c.status, createdAt: Date.parse(c.createdAt) || Date.now(), currency: c.currencyCode || 'NZD',
      revisionId: c.revisionId != null ? String(c.revisionId) : null, customerId: c.customer?.id ? numericId(c.customer.id) : null,
      paymentMethodId: pm?.id || null, paymentRevoked: Boolean(pm?.revokedAt), card,
      interval: c.billingPolicy?.interval || 'MONTH', intervalCount: c.billingPolicy?.intervalCount || 1,
      lines: (c.lines?.nodes || []).map((l) => ({
        id: l.id, sellingPlanId: l.sellingPlanId || null, sellingPlanName: l.sellingPlanName || '', variantId: l.variantId || null,
        productId: l.productId || null, title: l.title || '', quantity: l.quantity || 1, price: cents(l.currentPrice?.amount),
      })),
    };
  }

  /** A contract's billing cycles from start to end (indexes, included): [{ index, startAt, endAt, expectedAt, billed, skipped, edited }] */
  async cycles(contractId, start, end) {
    const data = await this.graphql(
      `query MembershipCycles($contractId: ID!, $start: Int!, $end: Int!) {
        subscriptionBillingCycles(contractId: $contractId, billingCyclesIndexRangeSelector: { startIndex: $start, endIndex: $end }, first: 12) {
          nodes { cycleIndex cycleStartAt cycleEndAt billingAttemptExpectedDate status skipped edited } } }`,
      { contractId: gid('SubscriptionContract', contractId), start, end },
    );
    return (data.subscriptionBillingCycles?.nodes || []).map((n) => ({
      index: n.cycleIndex, startAt: Date.parse(n.cycleStartAt), endAt: Date.parse(n.cycleEndAt), expectedAt: Date.parse(n.billingAttemptExpectedDate),
      billed: n.status === 'BILLED', skipped: Boolean(n.skipped), edited: Boolean(n.edited),
    }));
  }

  /**
   * Bill one cycle of a contract: a billing attempt with that cycle and the idempotency key, allowing overselling (a
   * membership isn't stock). Returns { attemptId, errors }. The result comes later, by webhook.
   */
  async bill({ contractId, cycle, key }) {
    const data = await this.graphql(
      `mutation MembershipBill($contractId: ID!, $input: SubscriptionBillingAttemptInput!) {
        subscriptionBillingAttemptCreate(subscriptionContractId: $contractId, subscriptionBillingAttemptInput: $input) {
          subscriptionBillingAttempt { id } userErrors { field message code } } }`,
      { contractId: gid('SubscriptionContract', contractId), input: { idempotencyKey: key, billingCycleSelector: { index: cycle }, inventoryPolicy: 'ALLOW_OVERSELLING' } },
    );
    const out = data.subscriptionBillingAttemptCreate || {};
    return { attemptId: out.subscriptionBillingAttempt?.id || null, errors: errorsOf(out.userErrors) };
  }

  /**
   * How a billing attempt went: { state: 'pending' | 'paid' | 'failed' | 'action', orderId, code, message, nextActionUrl },
   * or null when Shopify has no such attempt.
   */
  async attempt(id) {
    const data = await this.graphql(
      `query MembershipAttempt($id: ID!) { subscriptionBillingAttempt(id: $id) { id state { __typename
        ... on SubscriptionBillingAttemptSuccessState { order { id } }
        ${FAILED_FIELDS} } } }`,
      { id },
    );
    const a = data.subscriptionBillingAttempt;
    return a ? attemptState(a.state) : null;
  }

  /**
   * The contract's billing attempt with this idempotency key (its 25 latest are looked at), as { id, state, ... }, or
   * null when Shopify has none. This is how a send that never came back is found out.
   */
  async findAttempt(contractId, key) {
    const data = await this.graphql(
      `query MembershipAttempts($id: ID!) { subscriptionContract(id: $id) { id billingAttempts(first: 25, reverse: true) {
        nodes { id idempotencyKey createdAt state { __typename ${FAILED_FIELDS} } } } } }`,
      { id: gid('SubscriptionContract', contractId) },
    );
    const a = (data.subscriptionContract?.billingAttempts?.nodes || []).find((n) => n.idempotencyKey === key);
    return a ? { id: a.id, ...attemptState(a.state) } : null;
  }

  /** Cancel (a member or staff ended it) or fail (it couldn't be paid) a contract: { status, errors } */
  async endContract(contractId, how) {
    const field = how === 'fail' ? 'subscriptionContractFail' : 'subscriptionContractCancel';
    const data = await this.graphql(
      `mutation MembershipEnd($id: ID!) { ${field}(subscriptionContractId: $id) { contract { id status } userErrors { field message code } } }`,
      { id: gid('SubscriptionContract', contractId) },
    );
    const out = data[field] || {};
    return { status: out.contract?.status || null, errors: errorsOf(out.userErrors) };
  }

  /**
   * A damage charge taken from the member's saved card now: a one-off contract on that card with a line for the charge
   * (the damage charge product's variant at the charge's price, nothing shipped), its one bill due within the hour so it
   * can be billed straight away. It carries the payment's id (_lair_payment), so a create whose answer was lost is found
   * again (findChargeContract) rather than made twice. It has no library plan on it, so the Lair never takes it for a
   * membership. Returns { contractId, errors }.
   */
  async createChargeContract({ customerId, paymentMethodId, currency, feeVariantId, paymentId, fee, billAt }) {
    const data = await this.graphql(
      `mutation MembershipChargeContract($input: SubscriptionContractAtomicCreateInput!) {
        subscriptionContractAtomicCreate(input: $input) { contract { id status } userErrors { field message code } } }`,
      {
        input: {
          customerId: gid('Customer', customerId), currencyCode: currency, nextBillingDate: new Date(billAt).toISOString(),
          contract: {
            status: 'ACTIVE', paymentMethodId, note: `Dice Goblin library damage charge (${fee.id}): ${fee.label}`.slice(0, 250),
            billingPolicy: { interval: 'DAY', intervalCount: 1 }, deliveryPolicy: { interval: 'DAY', intervalCount: 1 },
            customAttributes: [{ key: '_lair_payment', value: paymentId }],
          },
          lines: [{
            line: {
              productVariantId: gid('ProductVariant', feeVariantId), quantity: 1, currentPrice: decimal(fee.amount),
              customAttributes: [{ key: 'For', value: fee.label.slice(0, 250) }, { key: '_lair_charge', value: fee.id }],
            },
          }],
        },
      },
    );
    const out = data.subscriptionContractAtomicCreate || {};
    return { contractId: out.contract?.id || null, errors: errorsOf(out.userErrors) };
  }

  /** The one-off charge contract made for a payment (its 10 latest contracts are looked at), as { id, status }, or null */
  async findChargeContract(customerId, paymentId) {
    const data = await this.graphql(
      `query MembershipChargeContracts($id: ID!) { customer(id: $id) { id subscriptionContracts(first: 10, reverse: true) {
        nodes { id status customAttributes { key value } } } } }`,
      { id: gid('Customer', customerId) },
    );
    const c = (data.customer?.subscriptionContracts?.nodes || []).find((n) => (n.customAttributes || []).some((a) => a.key === '_lair_payment' && a.value === paymentId));
    return c ? { id: c.id, status: c.status } : null;
  }

  /**
   * Change the plan on a contract (from its next bill): a draft of the contract, the membership line moved to the new
   * selling plan and price, committed. Returns { ok, errors }. A contract with an edited billing cycle can't change
   * (HAS_FUTURE_EDITS) until that cycle is billed or its edit is removed.
   */
  async changePlan({ contractId, lineId, sellingPlanId, sellingPlanName, price }) {
    const started = await this.graphql(
      'mutation MembershipEdit($contractId: ID!) { subscriptionContractUpdate(contractId: $contractId) { draft { id } userErrors { field message code } } }',
      { contractId: gid('SubscriptionContract', contractId) },
    );
    const draftId = started.subscriptionContractUpdate?.draft?.id;
    const startErrors = errorsOf(started.subscriptionContractUpdate?.userErrors);
    if (!draftId || startErrors.length) return { ok: false, errors: startErrors.length ? startErrors : [{ code: null, message: 'no draft' }] };
    const updated = await this.graphql(
      `mutation MembershipLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
        subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) { lineUpdated { id } userErrors { field message code } } }`,
      { draftId, lineId, input: { sellingPlanId, sellingPlanName, currentPrice: decimal(price) } },
    );
    const lineErrors = errorsOf(updated.subscriptionDraftLineUpdate?.userErrors);
    if (lineErrors.length) return { ok: false, errors: lineErrors };
    const committed = await this.graphql(
      'mutation MembershipCommit($draftId: ID!) { subscriptionDraftCommit(draftId: $draftId) { contract { id revisionId } userErrors { field message code } } }',
      { draftId },
    );
    const commitErrors = errorsOf(committed.subscriptionDraftCommit?.userErrors);
    return { ok: !commitErrors.length && Boolean(committed.subscriptionDraftCommit?.contract?.id), errors: commitErrors };
  }

  /**
   * Edit one billing cycle only (the source contract and other cycles stay as they are): with dropPlan (damage charges
   * billed on their own) every line that isn't a damage charge comes off, whatever it's called; then a line goes on for
   * each charge, on the damage charge product's variant at the charge's price, with what it's for as line properties.
   * Any edit already on the cycle is removed first, and the committed lines are checked, so the cycle ends up with
   * exactly these charges (and, without dropPlan, the month's plan) or this says it didn't. Returns { ok, errors }.
   */
  async editCycle({ contractId, cycle, feeVariantId, fees = [], dropPlan = false }) {
    const cleared = await this.clearCycleEdit({ contractId, cycle });
    if (!cleared.ok) return cleared;
    const isFee = (line) => numericId(line?.variantId) === numericId(feeVariantId);
    const input = { contractId: gid('SubscriptionContract', contractId), selector: { index: cycle } };
    const started = await this.graphql(
      `mutation MembershipCycleEdit($input: SubscriptionBillingCycleInput!) { subscriptionBillingCycleContractEdit(billingCycleInput: $input) {
        draft { id lines(first: 20) { nodes { id variantId } } } userErrors { field message code } } }`,
      { input },
    );
    const draft = started.subscriptionBillingCycleContractEdit?.draft;
    const startErrors = errorsOf(started.subscriptionBillingCycleContractEdit?.userErrors);
    if (!draft?.id || startErrors.length) return { ok: false, errors: startErrors.length ? startErrors : [{ code: null, message: 'no draft' }] };
    const before = draft.lines?.nodes || [];
    if (!dropPlan && before.some(isFee)) return { ok: false, errors: [{ code: 'LINES', message: 'the bill already has a damage charge line on it' }] };
    if (dropPlan) {
      for (const line of before.filter((l) => !isFee(l))) {
        const removed = await this.graphql(
          'mutation MembershipLineRemove($draftId: ID!, $lineId: ID!) { subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) { lineRemoved { id } userErrors { field message code } } }',
          { draftId: draft.id, lineId: line.id },
        );
        const errors = errorsOf(removed.subscriptionDraftLineRemove?.userErrors);
        if (errors.length) return { ok: false, errors };
      }
    }
    for (const fee of fees) {
      const added = await this.graphql(
        `mutation MembershipLineAdd($draftId: ID!, $input: SubscriptionLineInput!) {
          subscriptionDraftLineAdd(draftId: $draftId, input: $input) { lineAdded { id } userErrors { field message code } } }`,
        {
          draftId: draft.id,
          input: {
            productVariantId: gid('ProductVariant', feeVariantId), quantity: 1, currentPrice: decimal(fee.amount),
            customAttributes: [{ key: 'For', value: fee.label.slice(0, 250) }, { key: '_lair_charge', value: fee.id }],
          },
        },
      );
      const errors = errorsOf(added.subscriptionDraftLineAdd?.userErrors);
      if (errors.length) return { ok: false, errors };
    }
    const committed = await this.graphql(
      `mutation MembershipCycleCommit($draftId: ID!) { subscriptionBillingCycleContractDraftCommit(draftId: $draftId) {
        contract { lines(first: 20) { nodes { id variantId quantity currentPrice { amount } } } } userErrors { field message code } } }`,
      { draftId: draft.id },
    );
    const errors = errorsOf(committed.subscriptionBillingCycleContractDraftCommit?.userErrors);
    if (errors.length) return { ok: false, errors };
    // What the bill now has: exactly these charges, and with dropPlan nothing else
    const lines = committed.subscriptionBillingCycleContractDraftCommit?.contract?.lines?.nodes || [];
    const feeLines = lines.filter(isFee);
    const feeTotal = feeLines.reduce((sum, l) => sum + cents(l.currentPrice?.amount) * (l.quantity || 1), 0);
    const wanted = fees.reduce((sum, f) => sum + f.amount, 0);
    if (feeLines.length !== fees.length || feeTotal !== wanted || (dropPlan && lines.length !== feeLines.length) || (!dropPlan && lines.length === feeLines.length)) {
      return { ok: false, errors: [{ code: 'LINES', message: `the edited bill has ${lines.length} lines (${feeLines.length} damage charges, ${money(feeTotal)}), not what was asked` }] };
    }
    return { ok: true, errors: [] };
  }

  /** Take any edit off one billing cycle (fine when there's none): { ok, errors } */
  async clearCycleEdit({ contractId, cycle }) {
    const data = await this.graphql(
      `mutation MembershipCycleEditDelete($input: SubscriptionBillingCycleInput!) { subscriptionBillingCycleEditDelete(billingCycleInput: $input) {
        billingCycles { cycleIndex } userErrors { field message code } } }`,
      { input: { contractId: gid('SubscriptionContract', contractId), selector: { index: cycle } } },
    );
    const errors = errorsOf(data.subscriptionBillingCycleEditDelete?.userErrors).filter((e) => e.code !== 'NO_CYCLE_EDITS');
    return { ok: !errors.length, errors };
  }

  /** Shopify's own email with a secure link to update a card: { ok, errors }. write_customers. */
  async sendCardEmail(paymentMethodId) {
    const data = await this.graphql(
      'mutation MembershipCardEmail($id: ID!) { customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) { customer { id } userErrors { field message } } }',
      { id: paymentMethodId },
    );
    const errors = errorsOf(data.customerPaymentMethodSendUpdateEmail?.userErrors);
    return { ok: !errors.length, errors };
  }

  /** A customer's name and email, for a new member's welcome: { name, firstName, email } or null. read_customers. */
  async customer(customerId) {
    const data = await this.graphql(
      'query MembershipCustomer($id: ID!) { customer(id: $id) { id firstName lastName displayName defaultEmailAddress { emailAddress } } }',
      { id: gid('Customer', customerId) },
    );
    const c = data.customer;
    if (!c) return null;
    const display = String(c.displayName || '').trim();
    const name = [c.firstName, c.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || (display.includes('@') ? '' : display);
    return { name: name.slice(0, 80), firstName: String(c.firstName || '').trim().slice(0, 40), email: String(c.defaultEmailAddress?.emailAddress || '').trim() };
  }

  /** Where Shopify sends this app's webhooks: [{ id, topic, uri }] */
  async webhooks() {
    const data = await this.graphql(
      'query MembershipHooks($topics: [WebhookSubscriptionTopic!]) { webhookSubscriptions(first: 50, topics: $topics) { nodes { id topic uri } } }',
      { topics: MEMBERSHIP_TOPICS },
    );
    return (data.webhookSubscriptions?.nodes || []).map((n) => ({ id: n.id, topic: n.topic, uri: n.uri }));
  }

  /** Make sure every membership webhook goes to `url`: { ok, created, errors } */
  async ensureWebhooks(url) {
    const have = new Set((await this.webhooks()).filter((h) => h.uri === url).map((h) => h.topic));
    const created = [];
    const errors = [];
    for (const topic of MEMBERSHIP_TOPICS.filter((t) => !have.has(t))) {
      const data = await this.graphql(
        `mutation MembershipHook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
        { topic, sub: { uri: url, format: 'JSON' } },
      );
      const problems = errorsOf(data.webhookSubscriptionCreate?.userErrors).filter((e) => !/taken|already/i.test(e.message));
      if (problems.length) errors.push(`${topic}: ${problems.map((e) => e.message).join('; ')}`);
      else created.push(topic);
    }
    return { ok: !errors.length, created, errors };
  }

  /** This app's own selling plan groups: [{ id, name, code, productIds, plans: [{ id, name, price }] }] */
  async ownGroups() {
    const data = await this.graphql(
      `query MembershipGroups { sellingPlanGroups(first: 20) { nodes { id name merchantCode products(first: 10) { nodes { id } }
        sellingPlans(first: 10) { nodes { id name pricingPolicies { ... on SellingPlanFixedPricingPolicy { adjustmentType adjustmentValue { ... on MoneyV2 { amount } } } } } } } } }`,
    );
    return (data.sellingPlanGroups?.nodes || []).map((g) => ({
      id: g.id, name: g.name, code: g.merchantCode, productIds: (g.products?.nodes || []).map((p) => p.id),
      plans: (g.sellingPlans?.nodes || []).map((p) => {
        const fixed = (p.pricingPolicies || []).find((x) => x?.adjustmentType === 'PRICE');
        return { id: p.id, name: p.name, price: fixed?.adjustmentValue?.amount != null ? cents(fixed.adjustmentValue.amount) : null };
      }),
    }));
  }

  /**
   * The membership plans: one group ("Library membership") with a monthly plan for each tier at its price, on the
   * products given (none: made now, added to a product later). Returns { group, errors }.
   */
  async createPlans(productIds = []) {
    const plan = (t, position) => ({
      name: t.name, options: [t.name], position, category: 'SUBSCRIPTION',
      description: `${plural(t.games, 'game', 'games')} at a time, unlimited swaps. ${money(t.price)} a month.`,
      billingPolicy: { recurring: { interval: 'MONTH', intervalCount: 1 } },
      deliveryPolicy: { recurring: { interval: 'MONTH', intervalCount: 1, intent: 'FULFILLMENT_BEGIN', preAnchorBehavior: 'ASAP', cutoff: 0 } },
      pricingPolicies: [{ fixed: { adjustmentType: 'PRICE', adjustmentValue: { fixedValue: decimal(t.price) } } }],
    });
    const data = await this.graphql(
      `mutation MembershipPlans($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
        sellingPlanGroupCreate(input: $input, resources: $resources) { sellingPlanGroup { id } userErrors { field message code } } }`,
      {
        input: {
          name: 'Library membership', merchantCode: GROUP_CODE, options: ['Plan'], description: 'Dice Goblin board game library: Grab, Stash and Hoard (the Lair bills these)',
          sellingPlansToCreate: TIER_ORDER.map((key, i) => plan(TIERS[key], i + 1)),
        },
        resources: { productIds: productIds.map((id) => gid('Product', id)) },
      },
    );
    const out = data.sellingPlanGroupCreate || {};
    return { group: out.sellingPlanGroup?.id || null, errors: errorsOf(out.userErrors) };
  }

  /** Put the membership plans on more products: { errors } */
  async addProducts(groupId, productIds) {
    const data = await this.graphql(
      'mutation MembershipPlansAdd($id: ID!, $productIds: [ID!]!) { sellingPlanGroupAddProducts(id: $id, productIds: $productIds) { sellingPlanGroup { id } userErrors { field message code } } }',
      { id: groupId, productIds: productIds.map((id) => gid('Product', id)) },
    );
    return { errors: errorsOf(data.sellingPlanGroupAddProducts?.userErrors) };
  }

  /** The damage charge product's first variant id, by its handle, or null */
  async feeVariant() {
    const data = await this.graphql(
      'query MembershipFeeProduct($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { id variants(first: 1) { nodes { id } } } }',
      { handle: FEE_HANDLE },
    );
    return data.productByIdentifier?.variants?.nodes?.[0]?.id || null;
  }

  /**
   * Make the damage charge product: active but on no sales channel (nobody can buy it), its one variant not shipped and
   * not stock-tracked. Each charge line sets its own price; the variant's $500 is only there so it's never cheap if it
   * ever shows up somewhere. Returns { variantId, problem }.
   */
  async createFeeProduct() {
    const made = await this.graphql(
      `mutation MembershipFeeCreate($product: ProductCreateInput!) { productCreate(product: $product) {
        product { id variants(first: 1) { nodes { id } } } userErrors { field message } } }`,
      { product: { title: 'Library damage charge', handle: FEE_HANDLE, status: 'ACTIVE', productType: 'Library', tags: ['lair-library-fee'], descriptionHtml: '<p>Damage and missing parts on Dice Goblin library games, billed with a library membership. Not for sale.</p>' } },
    );
    const product = made.productCreate?.product;
    const problems = errorsOf(made.productCreate?.userErrors);
    const variantId = product?.variants?.nodes?.[0]?.id || null;
    if (!variantId || problems.length) return { variantId: null, problem: problems.map((e) => e.message).join('; ') || 'no product came back' };
    const changed = await this.graphql(
      `mutation MembershipFeeVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`,
      { productId: product.id, variants: [{ id: variantId, price: '500.00', taxable: true, inventoryItem: { tracked: false, requiresShipping: false } }] },
    );
    const variantProblems = errorsOf(changed.productVariantsBulkUpdate?.userErrors);
    return { variantId, problem: variantProblems.length ? `made, but: ${variantProblems.map((e) => e.message).join('; ')}` : null };
  }
}

/* ---------- the Lair's side ---------- */
export const membershipMethods = {
  /** Lair Memberships' Shopify client, made again whenever its credentials change. */
  membershipsAdmin() {
    const env = this.env || {};
    const key = [env.SHOP, env.MEMBERSHIPS_CLIENT_ID, env.MEMBERSHIPS_CLIENT_SECRET, env.API_VERSION].join('|');
    if (!this.membershipsCache || this.membershipsCache.key !== key) this.membershipsCache = { key, admin: new MembershipsAdmin(env, this.ctx.storage) };
    return this.membershipsCache.admin;
  },

  /** MEMBERSHIPS_BILLING is 'on': the Lair may charge cards. */
  membershipBillingOn() {
    return String(this.env?.MEMBERSHIPS_BILLING || '').trim().toLowerCase() === 'on';
  },

  /** Simplee's tags still give a library plan to someone with no Lair membership, until MEMBERSHIPS_SIMPLEE_TAGS is 'off'. */
  simpleeTagsOn() {
    return String(this.env?.MEMBERSHIPS_SIMPLEE_TAGS || '').trim().toLowerCase() !== 'off';
  },

  /* ---------------- rows ---------------- */
  membershipRow(id) {
    return id ? this.sql.exec('SELECT * FROM memberships WHERE id = ?', numericId(id)).toArray()[0] || null : null;
  },

  membershipRows(customerId) {
    return customerId ? this.sql.exec('SELECT * FROM memberships WHERE customer_id = ? ORDER BY created_at DESC', String(customerId)).toArray() : [];
  },

  chargeRow(id) {
    return this.sql.exec('SELECT * FROM membership_charges WHERE id = ?', String(id)).toArray()[0] || null;
  },

  /** A membership's charge still in flight (claimed, with Shopify, or on a bank check), or null */
  openCharge(membershipId) {
    return this.sql.exec(`SELECT * FROM membership_charges WHERE membership_id = ? AND status IN ${OPEN} ORDER BY created_at DESC LIMIT 1`, String(membershipId)).toArray()[0] || null;
  },

  /** No later try at the same cycle (one the Lair dropped before sending doesn't count) */
  isLatestTry(charge) {
    return !this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND cycle = ? AND attempt > ? AND status != 'void'", charge.membership_id, charge.cycle, charge.attempt).toArray().length;
  },

  feeRow(id) {
    return this.sql.exec('SELECT * FROM damage_charges WHERE id = ?', String(id)).toArray()[0] || null;
  },

  /** A membership that can still be billed (a damage charge on it waits for a bill rather than going to staff) */
  billable(m) {
    return Boolean(m && ['active', 'past_due', 'cancelling', 'paused'].includes(m.status));
  },

  /** Cancelled and running out its month: 'cancelling', or paused in Shopify while it was */
  isCancelling(m) {
    return Boolean(m && (m.status === 'cancelling' || (m.status === 'paused' && m.paused_from === 'cancelling')));
  },

  /** The meta table's saved plans: { groupId, plans: { grab: { id, name, price }, ... } } or null. */
  membershipPlans() {
    return parse(this.sql.exec("SELECT value FROM meta WHERE key = 'membership-plans'").toArray()[0]?.value, null);
  },

  /** The damage charge product's variant: MEMBERSHIPS_FEE_VARIANT_ID, else the one setup found or made, else null. */
  feeVariantId() {
    const set = String(this.env?.MEMBERSHIPS_FEE_VARIANT_ID || '').trim();
    if (set) return set;
    return this.sql.exec("SELECT value FROM meta WHERE key = 'membership-fee-variant'").toArray()[0]?.value || null;
  },

  /** A selling plan's tier: one of the Lair's plans by id, else by its name. */
  tierOfLine(line) {
    const plans = this.membershipPlans()?.plans || {};
    const byId = Object.entries(plans).find(([, p]) => p?.id && p.id === line?.sellingPlanId)?.[0];
    return byId || tierOf(line?.sellingPlanName);
  },

  /* ---------------- staff alerts ---------------- */
  /** When each membership alert last went to staff: { key: ms } */
  membershipAlerts() {
    return parse(this.sql.exec("SELECT value FROM meta WHERE key = 'membership-alerts'").toArray()[0]?.value, {});
  },

  /**
   * Tell staff about a membership problem, at most once a day for the same `key`, and note it in the status table.
   * Returns whether it went. No awaits.
   */
  staffAlert(key, subject, content, now = Date.now()) {
    const sent = this.membershipAlerts();
    if (sent[key] && now - sent[key] < DAY) return false;
    const kept = Object.fromEntries(Object.entries(sent).filter(([, at]) => now - at < 3 * DAY));
    kept[key] = now;
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('membership-alerts', ?)", JSON.stringify(kept));
    this.note({ membershipAlert: { key, subject, at: new Date(now).toISOString() } });
    this.notifyStaff(subject, content);
    return true;
  },

  /** Who a membership is, for staff: "Sam Jones" (or their member code) */
  memberName(customerId) {
    const member = this.memberRow(customerId);
    return member?.name || member?.first_name || member?.code || `customer ${customerId}`;
  },

  /**
   * The membership that counts for a member now: active, waiting on a payment (past_due) or cancelled but still inside
   * the month they paid for. The highest tier wins if they somehow have two. No awaits.
   */
  currentMembership(customerId, now = Date.now()) {
    const rows = this.membershipRows(customerId).filter((m) => ['active', 'past_due'].includes(m.status) || (m.status === 'cancelling' && (!m.cancel_at || m.cancel_at > now)));
    if (!rows.length) return null;
    return rows.reduce((best, m) => (higherTier(m.tier, best.tier) === m.tier && m.tier !== best.tier ? m : best), rows[0]);
  },

  /**
   * A member's library plan: their membership (source 'membership'; blocked while a payment is outstanding), else, for
   * someone who has never had a Lair membership, their Simplee tags (until MEMBERSHIPS_SIMPLEE_TAGS is 'off'), else
   * null. No awaits.
   */
  planOf(customerId, tags, now = Date.now()) {
    const m = this.currentMembership(customerId, now);
    if (m && TIERS[m.tier]) {
      const t = TIERS[m.tier];
      const blocked = m.status === 'past_due';
      return {
        name: t.name, games: t.games, tier: t.key, source: 'membership', status: m.status, blocked,
        bankCheck: blocked && this.openCharge(m.id)?.status === 'challenged',
      };
    }
    if (!this.simpleeTagsOn() || this.membershipRows(customerId).length) return null;
    const legacy = libraryPlan(tags);
    return legacy ? { ...legacy, source: 'simplee', blocked: false } : null;
  },

  /** A plan as GET /me and the staff page show it: { name, games }, plus blocked: true while a payment is outstanding. */
  planWords(plan) {
    if (!plan) return null;
    return plan.blocked ? { name: plan.name, games: plan.games, blocked: true } : { name: plan.name, games: plan.games };
  },

  /** Stop a blocked plan from reserving or borrowing more (402, with what to do). */
  checkPlanOpen(plan) {
    if (plan?.blocked) throw new RuleError(plan.bankCheck ? MEMBERSHIP_MESSAGES.blockedBank : MEMBERSHIP_MESSAGES.blocked, 402);
  },

  /* ---------------- views ---------------- */
  tierView(key) {
    const t = TIERS[key];
    return t ? { key: t.key, name: t.name, games: t.games, price: t.price } : null;
  },

  /**
   * A damage charge as members and staff see it. paidVia: 'bill', 'card', 'credit' or 'counter' once it's paid;
   * canChargeNow: its notice has been emailed and it can be taken now; payment: the latest try at taking it now.
   */
  feeView(f) {
    return {
      id: f.id, title: f.title, reason: f.reason, reasonWords: FEE_REASONS[f.reason] || f.reason, details: f.details || '', amount: f.amount,
      status: f.status, dueAt: f.due_at, createdAt: f.created_at, resolvedAt: f.resolved_at || null, disputeNote: f.dispute_note || null,
      emailedAt: f.emailed_at || null, paidVia: f.status === 'paid' ? f.paid_via || null : null,
      canChargeNow: Boolean(f.emailed_at) && CHARGEABLE_NOW.includes(f.status), payment: this.damagePaymentView(this.latestDamagePayment(f.id)),
    };
  },

  chargeView(c) {
    return { id: c.id, kind: c.kind, cycle: c.cycle, attempt: c.attempt, amount: c.amount, status: c.status, at: c.created_at, completedAt: c.completed_at || null, error: c.status === 'failed' ? c.error_code || null : null };
  },

  /** A membership for its member: plan, what's next, the card, recent charges and damage charges. No awaits. */
  membershipView(m, now = Date.now()) {
    const fees = this.sql.exec(
      `SELECT * FROM damage_charges WHERE membership_id = ? AND (status IN ('notice', 'due', 'billing', 'charging', 'disputed', 'unpaid') OR COALESCE(resolved_at, 0) > ?)
       ORDER BY created_at DESC`,
      m.id, now - 60 * DAY,
    ).toArray();
    const charges = this.sql.exec("SELECT * FROM membership_charges WHERE membership_id = ? AND status != 'void' ORDER BY created_at DESC LIMIT 6", m.id).toArray();
    const dueFees = fees.filter((f) => ['due', 'billing'].includes(f.status)).reduce((sum, f) => sum + f.amount, 0);
    const billing = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    const live = ['active', 'past_due'].includes(m.status) || (m.status === 'cancelling' && (!m.cancel_at || m.cancel_at > now));
    const open = this.openCharge(m.id);
    return {
      id: m.id, status: m.status, tier: this.tierView(m.tier), nextTier: billing !== m.tier ? this.tierView(billing) : null,
      price: m.price ?? TIERS[billing]?.price ?? null, nextBillAt: m.status === 'active' || m.status === 'past_due' ? m.next_bill_at || null : null,
      nextAmount: m.status === 'active' ? (m.price ?? TIERS[billing]?.price ?? 0) + dueFees : null,
      retryAt: m.status === 'past_due' ? m.retry_at || null : null, cancelAt: m.status === 'cancelling' ? m.cancel_at || null : null,
      endedAt: m.ended_at || null, endReason: m.end_reason || null, card: parse(m.card, null), live, bankCheck: open?.status === 'challenged',
      canChange: m.status === 'active', canCancel: m.status === 'active' || m.status === 'past_due',
      canResume: m.status === 'cancelling' && (m.cancel_at ? m.cancel_at > now : Boolean(open)),
      canUpdateCard: live && Boolean(m.payment_method_id), since: m.created_at,
      charges: charges.map((c) => this.chargeView(c)), damage: fees.map((f) => this.feeView(f)),
    };
  },

  /**
   * GET /me's membership: the one that counts now, else a paused one, else one that ended in the last 30 days (so they
   * see why), else null; with the plans to pick from. No awaits.
   */
  membershipForMember(customerId, now = Date.now()) {
    const rows = this.membershipRows(customerId);
    const recent = this.currentMembership(customerId, now)
      || rows.find((m) => m.status === 'paused')
      || rows.find((m) => ['ending', 'ended', 'cancelling'].includes(m.status) && (m.ended_at || m.cancel_at || m.updated_at || 0) > now - 30 * DAY);
    if (!recent) return null;
    return { ...this.membershipView(recent, now), plans: TIER_ORDER.map((k) => this.tierView(k)) };
  },

  /** A membership for staff: the member's view plus who they are, games at home and any hold on billing. No awaits. */
  staffMembershipView(m, now = Date.now()) {
    const member = this.memberRow(m.customer_id);
    const home = this.sql.exec("SELECT COUNT(*) AS n FROM library_loans WHERE customer_id = ? AND status = 'out'", m.customer_id).toArray()[0]?.n || 0;
    return {
      ...this.membershipView(m, now), customerId: m.customer_id, name: member?.name || member?.first_name || '', email: member?.email || member?.account_email || '',
      code: member?.code || '', atHome: home, source: m.source || null, contract: m.contract_gid,
      holdUntil: m.hold_until && m.hold_until > now ? m.hold_until : null,
    };
  },

  /** A member's membership for their staff page: the current one, else their latest, or null. No awaits. */
  staffMembershipFor(customerId, now = Date.now()) {
    const m = this.currentMembership(customerId, now) || this.membershipRows(customerId)[0] || null;
    return m ? this.staffMembershipView(m, now) : null;
  },

  /* ---------------- contracts from Shopify ---------------- */
  /**
   * The first renewal of a new contract: the first unbilled cycle Shopify expects to bill at least 25 days after the
   * contract started (the checkout paid the first month). Returns { index, expectedAt } or null.
   */
  async firstRenewal(admin, contract) {
    const cycles = await admin.cycles(contract.id, 1, 3);
    const after = contract.createdAt + FIRST_BILL_MIN_DAYS * DAY;
    const next = cycles.find((c) => !c.billed && !c.skipped && c.expectedAt >= after);
    return next ? { index: next.index, expectedAt: next.expectedAt } : null;
  },

  /** The next cycle to bill after `cycle`: { index, expectedAt } or null (Shopify didn't say). */
  async cycleAfter(admin, contractId, cycle) {
    const cycles = await admin.cycles(contractId, cycle + 1, cycle + 3);
    const next = cycles.find((c) => !c.billed && !c.skipped && c.index > cycle);
    return next ? { index: next.index, expectedAt: next.expectedAt } : null;
  },

  /**
   * Shopify's first billing cycle for a new membership should be about a month after joining. Later than 35 days and
   * staff hear, so it's checked before it's billed (it may mean the checkout's order paid a different cycle). No awaits.
   */
  checkFirstRenewal(m, renewal, now) {
    if (!m || !renewal) return;
    const days = Math.round((renewal.expectedAt - m.created_at) / DAY);
    if (days <= FIRST_BILL_MAX_DAYS) return;
    this.staffAlert(`first-renewal:${m.id}`, `Check a new library membership's first bill: ${this.memberName(m.customer_id)}`, {
      title: 'A first bill that looks late',
      intro: `Shopify's first billing cycle for ${this.memberName(m.customer_id)}'s new membership is ${days} days after they joined (cycle ${renewal.index}). It should be about a month. Check the contract's billing cycles in Shopify before it's billed.`,
      details: [['Membership', m.id], ['Joined', new Date(m.created_at).toISOString().slice(0, 10)], ['First bill', new Date(renewal.expectedAt).toISOString().slice(0, 10)]],
    }, now);
  },

  /**
   * Bring a contract's membership up to date from Shopify (its webhooks call this): a new one is saved, the member is
   * welcomed and staff hear; a known one gets its card, plan and Shopify status. Paused in Shopify, it's paused here
   * (and goes back to what it was when it's active again); ended in Shopify, it ends here. A contract that isn't a
   * library plan is left alone. Returns what happened.
   */
  async syncContract(idOrGid, { topic = null, originOrderId = null } = {}) {
    const admin = this.membershipsAdmin();
    if (!admin.configured) return { skipped: 'Lair Memberships is not connected' };
    const contract = await admin.contract(numericId(idOrGid));
    if (!contract) return { missing: numericId(idOrGid) };
    // a damage charge's one-off contract (nothing on it but damage charges) is never a membership
    const feeVariant = this.feeVariantId();
    if (feeVariant && contract.lines.length && contract.lines.every((l) => numericId(l.variantId) === numericId(feeVariant))) {
      return { ignored: contract.id, reason: 'a damage charge taken now' };
    }
    const known = this.membershipRow(contract.id);
    let renewal = null;
    if (!known || known.next_cycle == null) {
      try {
        renewal = await this.firstRenewal(admin, contract);
      } catch (error) {
        console.error('Lair: could not read billing cycles', error);
      }
    }
    let person = null;
    if (!known && contract.customerId && !this.memberRow(contract.customerId)) {
      try {
        person = await admin.customer(contract.customerId);
      } catch (error) {
        console.error('Lair: could not read the new member', error);
      }
    }
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const line = contract.lines.find((l) => this.tierOfLine(l));
    if (!line) return { ignored: contract.id, reason: 'not a library plan' };
    const tier = this.tierOfLine(line);
    const row = this.membershipRow(contract.id);
    if (row && olderRevision(contract.revisionId, row.revision_id)) return { stale: contract.id };
    const shopifyEnded = ['CANCELLED', 'EXPIRED', 'FAILED'].includes(contract.status);
    const card = contract.card ? JSON.stringify(contract.card) : null;
    if (!row) {
      const status = shopifyEnded ? 'ended' : contract.status === 'PAUSED' ? 'paused' : 'active';
      this.write(
        `INSERT INTO memberships (id, contract_gid, customer_id, status, shopify_status, tier, billing_tier, line_id, variant_id, selling_plan_id, price,
           currency, payment_method_id, card, next_cycle, next_bill_at, origin_order_id, revision_id, source, paused_from, dates_missing_at, ended_at, end_reason,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        contract.id, contract.gid, contract.customerId, status, contract.status, tier, tier, line.id, line.variantId, line.sellingPlanId, line.price,
        contract.currency, contract.paymentMethodId, card, renewal?.index ?? null, renewal?.expectedAt ?? null, originOrderId, contract.revisionId,
        originOrderId ? 'checkout' : 'created', status === 'paused' ? 'active' : null, renewal || shopifyEnded ? null : now,
        shopifyEnded ? now : null, shopifyEnded ? `shopify:${contract.status.toLowerCase()}` : null, contract.createdAt, now,
      );
      this.touchMember(contract.customerId, person ? { name: person.name, email: person.email } : {}, now);
      const made = this.membershipRow(contract.id);
      if (status === 'active') {
        this.tellNewMembership(made, rules);
        this.checkFirstRenewal(made, renewal, now);
      }
      return { created: contract.id, tier, status, nextBillAt: renewal?.expectedAt ?? null };
    }
    // A known membership: Shopify's card, plan line and status are the truth. The Lair's own statuses (past_due,
    // cancelling, ending) stay unless Shopify has ended or paused it.
    this.write(
      `UPDATE memberships SET shopify_status = ?, billing_tier = ?, line_id = ?, variant_id = ?, selling_plan_id = ?, price = ?, payment_method_id = ?, card = ?,
         revision_id = COALESCE(?, revision_id), origin_order_id = COALESCE(origin_order_id, ?), next_cycle = COALESCE(next_cycle, ?),
         next_bill_at = COALESCE(next_bill_at, ?), updated_at = ? WHERE id = ?`,
      contract.status, tier, line.id, line.variantId, line.sellingPlanId, line.price, contract.paymentMethodId, card, contract.revisionId, originOrderId,
      renewal?.index ?? null, renewal?.expectedAt ?? null, now, row.id,
    );
    if (renewal && row.next_cycle == null) {
      this.write('UPDATE memberships SET dates_missing_at = NULL WHERE id = ?', row.id);
      this.checkFirstRenewal(this.membershipRow(row.id), renewal, now);
    }
    if (shopifyEnded && row.status !== 'ended') {
      // The Lair asked for it (a cancelled membership past its month, or one that couldn't be paid), or someone ended
      // it in Shopify (staff hear; the member isn't emailed, in case it was a mistake like uninstalling the app).
      const asked = row.status === 'ending' || (row.status === 'cancelling' && row.cancel_at != null && row.cancel_at <= now);
      this.markEnded(row.id, { reason: asked ? (row.status === 'ending' ? row.end_reason || 'payment' : 'cancelled') : `shopify:${contract.status.toLowerCase()}`, shopifyStatus: contract.status, rules, now });
      if (!asked) {
        this.staffAlert(`shopify-ended:${row.id}`, `A library membership was ended in Shopify: ${this.memberName(row.customer_id)}`, {
          title: 'A membership ended outside the Lair',
          intro: `Shopify says ${this.memberName(row.customer_id)}'s library membership is ${contract.status.toLowerCase()}, but the Lair didn't end it. They haven't been emailed. If it was a mistake, they can join again on the library page.`,
          details: [['Membership', row.id], ['Was', row.status], ['Games at home', this.gamesAtHome(row.customer_id).join(', ')]],
        }, now);
      }
      return { updated: row.id, status: 'ended', topic };
    }
    if (row.status === 'ended' && ['ACTIVE', 'PAUSED'].includes(contract.status)) {
      // Brought back in Shopify after the Lair ended it: the Lair doesn't bill it or count it (staff decide)
      const name = this.memberName(row.customer_id);
      this.staffAlert(`reactivated:${row.id}`, `A library membership is active again in Shopify: ${name}`, {
        title: 'Active in Shopify, ended in the Lair',
        intro: `Shopify says ${name}'s library membership contract is ${contract.status.toLowerCase()} again, but the Lair had ended it, so it won't bill it or count it for borrowing. If they want to carry on, they can join again on the library page; cancel this contract in Shopify.`,
        details: [['Membership', row.id]],
      }, now);
      return { updated: row.id, status: 'ended', topic };
    }
    let status = row.status;
    let pausedFrom = row.paused_from;
    if (contract.status === 'PAUSED' && !['ended', 'paused'].includes(row.status)) {
      pausedFrom = row.status;
      status = 'paused';
    } else if (contract.status === 'ACTIVE' && row.status === 'paused') {
      status = row.paused_from || 'active';
      pausedFrom = null;
    }
    if (status !== row.status) this.write('UPDATE memberships SET status = ?, paused_from = ?, updated_at = ? WHERE id = ?', status, pausedFrom, now, row.id);
    return { updated: row.id, status, topic };
  },

  /**
   * A membership has ended in Shopify: ended here too, a claim that never reached Shopify is dropped, damage charges
   * that never got billed go to staff, and a cancelled member hears it's over. No awaits. Returns whether it changed.
   */
  markEnded(id, { reason, shopifyStatus = null, rules, now = Date.now() }) {
    const row = this.membershipRow(id);
    if (!row || row.status === 'ended') return false;
    this.write(
      `UPDATE memberships SET status = 'ended', shopify_status = COALESCE(?, shopify_status), ended_at = ?, end_reason = COALESCE(end_reason, ?), retry_at = NULL,
         hold_until = NULL, paused_from = NULL, updated_at = ? WHERE id = ?`,
      shopifyStatus, now, reason, now, id,
    );
    // A claim that may have reached Shopify is looked up by the next run (and dropped there if Shopify hasn't got it).
    for (const c of this.sql.exec("SELECT id FROM membership_charges WHERE membership_id = ? AND status = 'claimed' AND sent_at IS NULL", id).toArray()) {
      this.voidCharge(c.id, 'membership-ended');
    }
    this.settleEndedFees(id, now);
    if (reason === 'cancelled') this.tellMembershipEnded(this.membershipRow(id), rules);
    return true;
  },

  /* ---------------- webhooks ---------------- */
  /**
   * A webhook from Lair Memberships (the Worker has checked its signature): { topic, webhookId, payload }. Repeats (the
   * same webhook id) are answered without doing anything. Throws on a Shopify failure, so Shopify sends it again.
   */
  async membershipWebhook({ topic, webhookId, payload } = {}) {
    const id = trimmed(webhookId, 120);
    if (id && this.sql.exec('SELECT 1 AS n FROM membership_events WHERE webhook_id = ?', id).toArray().length) return { ok: true, repeat: true };
    const kind = String(topic || '');
    const body = payload || {};
    let result;
    if (kind.startsWith('subscription_contracts/')) {
      const origin = body.admin_graphql_api_origin_order_id || (body.origin_order_id ? gid('Order', body.origin_order_id) : null);
      result = await this.syncContract(body.admin_graphql_api_id || body.id, { topic: kind, originOrderId: origin });
    } else if (kind.startsWith('subscription_billing_attempts/')) result = await this.billingWebhook(body, kind);
    else if (kind.startsWith('customer_payment_methods/')) result = await this.paymentMethodChanged(body, kind);
    else result = { ignored: kind };
    if (id) this.write('INSERT OR IGNORE INTO membership_events (webhook_id, topic, at) VALUES (?, ?, ?)', id, kind, Date.now());
    return { ok: true, ...result };
  },

  /**
   * subscription_billing_attempts/success, /failure or /challenged: the charge it belongs to (by its key) moves on. The
   * payload's attempt id can be null (Shopify's own example has it so); a failure with no error code is read from
   * Shopify instead, so it's never mistaken for a failure on the store's side (if Shopify can't say, this throws and
   * Shopify sends the webhook again).
   */
  async billingWebhook(payload, topic) {
    const key = trimmed(payload.idempotency_key, 200);
    let charge = key ? this.sql.exec('SELECT * FROM membership_charges WHERE idempotency_key = ?', key).toArray()[0] : null;
    if (!charge && payload.admin_graphql_api_id) charge = this.sql.exec('SELECT * FROM membership_charges WHERE attempt_gid = ?', String(payload.admin_graphql_api_id)).toArray()[0];
    if (!charge) {
      // a damage charge taken now, on its own one-off contract
      let payment = key ? this.sql.exec('SELECT * FROM damage_payments WHERE idempotency_key = ?', key).toArray()[0] : null;
      if (!payment && payload.admin_graphql_api_id) payment = this.sql.exec('SELECT * FROM damage_payments WHERE attempt_gid = ?', String(payload.admin_graphql_api_id)).toArray()[0];
      if (payment) return this.damagePaymentWebhook(payment, payload, topic);
      return { unknown: key || payload.admin_graphql_api_id || null };
    }
    let outcome = topic.endsWith('/success') ? { state: 'paid', orderId: payload.admin_graphql_api_order_id || null }
      : topic.endsWith('/failure') ? { state: 'failed', code: payload.error_code ? String(payload.error_code).toUpperCase() : null, message: payload.error_message || null }
        : { state: 'action', nextActionUrl: null };
    if (outcome.state === 'failed' && !outcome.code) {
      const found = await this.membershipsAdmin().findAttempt(charge.membership_id, charge.idempotency_key);
      outcome = { ...outcome, code: found?.state === 'failed' ? found.code : 'UNEXPECTED_ERROR' };
    }
    // --- no awaits from here on (until chargeOutcome's own) ---
    if (payload.admin_graphql_api_id) this.write('UPDATE membership_charges SET attempt_gid = COALESCE(attempt_gid, ?) WHERE id = ?', String(payload.admin_graphql_api_id), charge.id);
    return this.chargeOutcome(charge.id, outcome);
  },

  /**
   * How a charge went, from its webhook or from asking Shopify: paid, failed, or waiting on a bank check (action). A
   * charge already paid stays paid. One the Lair stopped waiting on (failed or dropped) still takes a late success.
   * outcome.final: the Lair gave up on it (a bank check never done), so no more tries.
   */
  async chargeOutcome(chargeId, outcome) {
    const first = this.chargeRow(chargeId);
    if (!first) return { charge: chargeId, missing: true };
    if (first.status === 'paid' || (['failed', 'void'].includes(first.status) && outcome.state !== 'paid')) return { charge: chargeId, already: first.status };
    const m = this.membershipRow(first.membership_id);
    const admin = this.membershipsAdmin();
    let next = null;
    if (outcome.state === 'paid' && m) {
      try {
        next = await this.cycleAfter(admin, m.id, first.cycle);
      } catch (error) {
        console.error('Lair: could not read the next billing cycle', error);
      }
    }
    // Shopify's card update email goes out on the first failure that's the card's (a stale read here can only send it
    // twice, which does no harm)
    const code = String(outcome.code || 'UNEXPECTED_ERROR').toUpperCase();
    let cardEmail = null;
    const firstCardFailure = outcome.state === 'failed' && !outcome.final && !NOT_THE_CARD.has(code) && m && !(m.fail_count > 0)
      && ['active', 'past_due', 'cancelling'].includes(m.status) && m.payment_method_id && admin.configured && this.isLatestTry(first);
    if (firstCardFailure) {
      try {
        cardEmail = await admin.sendCardEmail(m.payment_method_id);
      } catch (error) {
        cardEmail = { ok: false };
        console.error('Lair: could not send the card update email', error);
      }
    }
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const charge = this.chargeRow(chargeId);
    if (!charge || charge.status === 'paid' || (['failed', 'void'].includes(charge.status) && outcome.state !== 'paid')) return { charge: chargeId, already: charge?.status || null };
    const row = this.membershipRow(charge.membership_id);
    if (cardEmail?.ok && row) this.write('UPDATE memberships SET card_email_at = ? WHERE id = ?', now, row.id);
    if (outcome.state === 'action') {
      this.write("UPDATE membership_charges SET status = 'challenged', next_action_url = COALESCE(?, next_action_url), updated_at = ? WHERE id = ?", outcome.nextActionUrl || null, now, charge.id);
      return { charge: charge.id, status: 'challenged' };
    }
    if (outcome.state === 'paid') return this.chargePaid(charge, row, outcome, next, rules, now);
    return this.chargeFailed(charge, row, { ...outcome, code }, { cardEmailSent: Boolean(cardEmail?.ok) }, rules, now);
  },

  /**
   * A charge was paid. Its damage charges are paid. A renewal pays the membership up to the next cycle (a plan change
   * takes effect, and borrowing is back on); damage charges billed on their own use their cycle up, so another would
   * go on the next. A payment after the Lair stopped waiting on it is still taken, and staff hear when that means the
   * same cycle was paid twice, or a membership was paid after it ended. No awaits.
   */
  chargePaid(charge, row, outcome, next, rules, now) {
    const late = ['failed', 'void'].includes(charge.status);
    this.write("UPDATE membership_charges SET status = 'paid', order_id = ?, completed_at = ?, updated_at = ? WHERE id = ?", outcome.orderId || null, now, now, charge.id);
    const name = row ? this.memberName(row.customer_id) : 'a member';
    for (const id of parse(charge.fees, [])) {
      const f = this.feeRow(id);
      if (!f) continue;
      if (f.status === 'paid') {
        // paid another way after this bill had stopped being waited on (taken now, or at the counter): paid twice
        if (f.charge_id !== charge.id) {
          const how = { credit: 'from their store credit', card: 'on their card', counter: 'at the counter' }[f.paid_via] || 'another way';
          this.staffAlert(`fee-twice:${f.id}`, `A damage charge was paid twice: ${name}`, {
            title: 'Paid twice',
            intro: `${name}'s ${money(f.amount)} charge for ${f.title} was paid already (${how}), and it was also on a library bill that has now been paid late. Refund ${money(f.amount)} of that order in Shopify, or give it back as store credit.`,
            details: [['Game', f.title], ['Charge', money(f.amount)], ['Order', outcome.orderId || '']],
          }, now);
        }
        continue;
      }
      if (f.status === 'waived') {
        this.staffAlert(`waived-paid:${f.id}`, `A waived damage charge was paid: ${name}`, {
          title: 'A waived charge was paid',
          intro: `${name}'s ${money(f.amount)} charge for ${f.title} was waived, but it was on a bill that has now been paid. Refund it in Shopify.`,
          details: [['Game', f.title], ['Charge', money(f.amount)], ['Order', outcome.orderId || '']],
        }, now);
      }
      this.write("UPDATE damage_charges SET status = 'paid', paid_via = 'bill', charge_id = ?, resolved_at = ?, updated_at = ? WHERE id = ?", charge.id, now, now, id);
    }
    // A later try at this cycle that never reached Shopify isn't needed now
    for (const c of this.sql.exec("SELECT id FROM membership_charges WHERE membership_id = ? AND cycle = ? AND status = 'claimed' AND sent_at IS NULL AND id != ?", charge.membership_id, charge.cycle, charge.id).toArray()) {
      this.voidCharge(c.id, 'paid-already');
    }
    const twice = this.sql.exec("SELECT * FROM membership_charges WHERE membership_id = ? AND cycle = ? AND status = 'paid' AND id != ?", charge.membership_id, charge.cycle, charge.id).toArray();
    if (twice.length) {
      this.staffAlert(`double:${charge.membership_id}:${charge.cycle}`, `A library bill was paid twice: ${name}`, {
        title: 'Paid twice',
        intro: `${name}'s library bill for one month was paid twice. Refund one of these orders in Shopify.`,
        details: [['Membership', charge.membership_id], ['Orders', [...twice.map((c) => c.order_id || c.id), outcome.orderId || charge.id].join(', ')], ['Each', money(charge.amount)]],
      }, now);
      return { charge: charge.id, status: 'paid', double: true };
    }
    if (!row) return { charge: charge.id, status: 'paid' };
    if (row.status === 'ended') {
      this.staffAlert(`late-paid:${charge.id}`, `A library payment came in after the membership ended: ${name}`, {
        title: 'Paid after it ended',
        intro: `${name}'s ${money(charge.amount)} library payment went through after their membership had ended. Refund it in Shopify, or ask them to join again.`,
        details: [['Membership', row.id], ['Order', outcome.orderId || '']],
      }, now);
      return { charge: charge.id, status: 'paid', ended: true };
    }
    // A late payment for a cycle the membership has already moved past changes nothing else
    if (row.next_cycle != null && charge.cycle < row.next_cycle) {
      if (late) {
        this.staffAlert(`late-paid:${charge.id}`, `A late library payment came in: ${name}`, {
          title: 'A late payment',
          intro: `${name}'s ${money(charge.amount)} library payment for an earlier month went through late. Check whether they've now paid for that month twice.`,
          details: [['Membership', row.id], ['Order', outcome.orderId || '']],
        }, now);
      }
      return { charge: charge.id, status: 'paid', old: true };
    }
    if (charge.kind === 'fees') {
      this.write(
        'UPDATE memberships SET next_cycle = ?, next_bill_at = ?, fail_count = 0, failed_at = NULL, retry_at = NULL, hold_until = NULL, updated_at = ? WHERE id = ?',
        next?.index ?? charge.cycle + 1, next?.expectedAt ?? null, now, row.id,
      );
      return { charge: charge.id, status: 'paid' };
    }
    const wasLate = ['past_due', 'ending'].includes(row.status);
    const paidUntil = next?.expectedAt ?? addMonths(row.next_bill_at ?? now, 1);
    let status = row.status;
    let pausedFrom = row.paused_from;
    let endReason = row.end_reason;
    if (['active', 'past_due', 'ending'].includes(row.status)) {
      // ('ending': the Lair had given up on it, but the contract hasn't been ended in Shopify yet, so it carries on)
      status = 'active';
      endReason = null;
    } else if (row.status === 'paused' && ['past_due', 'ending'].includes(row.paused_from)) pausedFrom = 'active';
    // Cancelled while this renewal was being paid (and maybe paused since): they keep the month it paid for
    const cancelling = this.isCancelling(row);
    const cancelAt = cancelling && (row.cancel_at == null || row.cancel_at <= now) ? paidUntil : row.cancel_at;
    this.write(
      `UPDATE memberships SET status = ?, paused_from = ?, tier = ?, next_cycle = ?, next_bill_at = ?, paid_through = ?, retry_at = NULL, failed_at = NULL,
         fail_count = 0, hold_until = NULL, cancel_at = ?, end_reason = ?, dates_missing_at = ?, updated_at = ? WHERE id = ?`,
      status, pausedFrom, TIERS[charge.tier] ? charge.tier : row.tier, next?.index ?? charge.cycle + 1, next?.expectedAt ?? null, paidUntil, cancelAt ?? null,
      endReason, next ? null : now, now, row.id,
    );
    const fresh = this.membershipRow(row.id);
    if (wasLate) this.tellPaymentSorted(fresh, charge, rules);
    if (cancelling && row.cancel_at !== cancelAt) this.tellCancelled(fresh, rules);
    return { charge: charge.id, status: 'paid' };
  },

  /**
   * A charge failed. Its damage charges wait for the next try (or, when there isn't one, go to staff). A failure that
   * isn't the card holds billing (see storeSideProblem: staff hear; the member doesn't, and no try is counted).
   * Otherwise it's a try: another is set (3 days, then a week, after the first failure, and never in the past; none
   * when the bank flagged fraud, until the card is updated), or after the last one the membership ends. A late failure,
   * or one for a membership that has moved on, is only recorded. No awaits.
   */
  chargeFailed(charge, row, outcome, { cardEmailSent }, rules, now) {
    const code = outcome.code;
    this.write(
      "UPDATE membership_charges SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      code, trimmed(outcome.message, 300) || null, now, now, charge.id,
    );
    this.feesBack(charge, now);
    const feeIds = parse(charge.fees, []);
    if (!row || !this.isLatestTry(charge) || (row.next_cycle != null && charge.cycle < row.next_cycle)) return { charge: charge.id, status: 'failed', recorded: true };
    if (charge.kind === 'renewal' && this.isCancelling(row)) {
      // Cancelled while this renewal was being paid (and maybe paused since), and it didn't go through: it ends now,
      // with no more tries (a damage charge on it is billed on its own)
      this.write('UPDATE memberships SET cancel_at = ?, retry_at = NULL, fail_count = 0, failed_at = NULL, updated_at = ? WHERE id = ?', now, now, row.id);
      return { charge: charge.id, status: 'failed', ending: true };
    }
    if (!['active', 'past_due', 'cancelling'].includes(row.status)) return { charge: charge.id, status: 'failed', recorded: true };
    if (!outcome.final && NOT_THE_CARD.has(code)) {
      const name = this.memberName(row.customer_id);
      const held = this.storeSideProblem(charge, row, {
        subject: `A library payment failed, not because of the card: ${name}`, title: 'A payment that failed on our side',
        problem: `${name}'s ${money(charge.amount)} library payment failed with ${code}, which isn't a problem with their card (it's the store, the payment provider or Shopify). They haven't been told and it doesn't count against them.`,
        details: [['Membership', row.id], ['Error', [code, outcome.message].filter(Boolean).join(': ')]],
      }, now);
      return { charge: charge.id, status: 'failed', counted: false, ...held };
    }
    const failures = (row.fail_count || 0) + 1;
    const firstFailed = row.failed_at || now;
    const fraud = /FRAUD/.test(code);
    const last = outcome.final || failures >= MAX_ATTEMPTS || (fraud && charge.kind === 'fees');
    if (!last && charge.kind === 'renewal') {
      const again = fraud ? null : Math.max(retryAt(firstFailed, failures), now + DAY);
      this.write("UPDATE memberships SET status = 'past_due', fail_count = ?, failed_at = ?, retry_at = ?, updated_at = ? WHERE id = ?", failures, firstFailed, again, now, row.id);
      this.tellPaymentFailed(this.membershipRow(row.id), charge, { again, cardEmailSent, fraud, giveUpAt: firstFailed + GIVE_UP_DAYS * DAY }, rules);
      return { charge: charge.id, status: 'failed', retryAt: again };
    }
    if (!last && charge.kind === 'fees') {
      // Damage charges billed on their own (after cancelling) get the same tries; the membership stays as it is
      const again = Math.max(retryAt(firstFailed, failures), now + DAY);
      this.write('UPDATE memberships SET fail_count = ?, failed_at = ?, retry_at = ?, updated_at = ? WHERE id = ?', failures, firstFailed, again, now, row.id);
      this.tellFeesFailed(this.membershipRow(row.id), charge, { again, cardEmailSent }, rules);
      return { charge: charge.id, status: 'failed', retryAt: again };
    }
    // The last try failed (or the bank check was never done, or the bank flagged fraud on damage charges): its damage
    // charges go to staff to collect at the counter
    for (const id of feeIds) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ? AND status = 'due'", now, id);
    if (charge.kind === 'renewal') {
      this.write(
        "UPDATE memberships SET status = 'ending', end_reason = 'payment', fail_count = ?, failed_at = ?, retry_at = NULL, updated_at = ? WHERE id = ?",
        failures, firstFailed, now, row.id,
      );
      this.tellPaymentGaveUp(this.membershipRow(row.id), charge, { code, tries: failures, bank: Boolean(outcome.final) }, rules);
      return { charge: charge.id, status: 'failed', final: true };
    }
    this.write('UPDATE memberships SET fail_count = 0, failed_at = NULL, retry_at = NULL, updated_at = ? WHERE id = ?', now, row.id);
    this.tellFeesGaveUp(this.membershipRow(row.id), charge, { code }, rules);
    return { charge: charge.id, status: 'failed', final: true };
  },

  /**
   * Failures on the store's side and Shopify refusals for a charge's cycle so far (none of them count against the
   * member). No awaits.
   */
  storeSideCount(membershipId, cycle) {
    const codes = [...NOT_THE_CARD];
    return this.sql.exec(
      `SELECT COUNT(*) AS n FROM membership_charges WHERE membership_id = ? AND cycle = ? AND (
         (status = 'failed' AND error_code IN (${codes.map(() => '?').join(', ')})) OR (status = 'void' AND void_reason LIKE 'refused:%'))`,
      membershipId, cycle, ...codes,
    ).toArray()[0]?.n || 0;
  },

  /**
   * A failure on the store's side, or Shopify refusing a bill: nothing counts against the member, who isn't told, and
   * staff hear. Billing waits a day; after 3 for the same cycle it stops for 30 days (staff press Retry once it's sorted),
   * so the card is never tried day after day. Damage charges billed on their own go to staff to collect at the counter
   * instead. Returns { holdUntil, stopped }. No awaits.
   */
  storeSideProblem(charge, m, { subject, title, problem, details }, now) {
    const stop = this.storeSideCount(charge.membership_id, charge.cycle) >= STORE_SIDE_MAX;
    if (stop && charge.kind === 'fees') {
      for (const id of parse(charge.fees, [])) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ? AND status = 'due'", now, id);
      this.write('UPDATE memberships SET fail_count = 0, failed_at = NULL, retry_at = NULL, hold_until = NULL, updated_at = ? WHERE id = ?', now, m.id);
      this.staffAlert(`store-side:${m.id}`, subject, {
        title, details,
        intro: `${problem} This has happened ${STORE_SIDE_MAX} times for these damage charges, so they're on the staff page under Damage to collect at the counter.`,
      }, now);
      return { holdUntil: null, stopped: true };
    }
    const until = now + (stop ? STOPPED_HOLD : REFUSAL_HOLD);
    this.write('UPDATE memberships SET hold_until = ?, updated_at = ? WHERE id = ?', until, now, m.id);
    // A failed payment's next try moves with the hold, so it isn't taken for one that's overdue (until billing stops)
    if (!stop && m.status === 'past_due' && m.retry_at != null) this.write('UPDATE memberships SET retry_at = MAX(retry_at, ?) WHERE id = ?', until, m.id);
    this.staffAlert(`store-side:${m.id}${stop ? ':stopped' : ''}`, subject, {
      title, details,
      intro: stop
        ? `${problem} This has happened ${STORE_SIDE_MAX} times for this bill, so the Lair has stopped billing them for 30 days. Once it's sorted, press Retry on their membership on the staff page.`
        : `${problem} The Lair tries again tomorrow.`,
    }, now);
    return { holdUntil: until, stopped: stop };
  },

  /**
   * A charge that won't be paid: its damage charges go back to waiting for a bill (due), or to staff (unpaid) when the
   * membership can't be billed any more. No awaits.
   */
  feesBack(charge, now) {
    const to = this.billable(this.membershipRow(charge.membership_id)) ? 'due' : 'unpaid';
    for (const id of parse(charge.fees, [])) {
      this.write("UPDATE damage_charges SET status = ?, charge_id = NULL, updated_at = ? WHERE id = ? AND status = 'billing' AND charge_id = ?", to, now, id, charge.id);
    }
  },

  /**
   * Drop a claim Shopify never got (billing switched off, the membership cancelled, ended or paused, a hold, or Shopify
   * refused it): it's void, its damage charges go back to waiting, and with `hold` billing waits that long. No awaits.
   */
  voidCharge(chargeId, reason, { hold = 0 } = {}) {
    const now = Date.now();
    const charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return { charge: chargeId, already: charge?.status || null };
    this.write("UPDATE membership_charges SET status = 'void', void_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?", reason, now, now, chargeId);
    this.feesBack(charge, now);
    if (hold) this.write('UPDATE memberships SET hold_until = ?, updated_at = ? WHERE id = ?', now + hold, now, charge.membership_id);
    // A renewal that was on its way when they cancelled never happened, so the membership ends now
    if (charge.kind === 'renewal') {
      this.write(
        "UPDATE memberships SET cancel_at = ?, updated_at = ? WHERE id = ? AND cancel_at IS NULL AND (status = 'cancelling' OR (status = 'paused' AND paused_from = 'cancelling'))",
        now, now, charge.membership_id,
      );
    }
    return { charge: chargeId, void: reason };
  },

  /**
   * customer_payment_methods/create, /update or /revoke: the member's memberships (on that card, or theirs) get their
   * card from Shopify again, and one waiting on a failed payment is tried again on the next maintenance run when its
   * card has changed (a new card should work). Not while a bank check is waiting: that payment could still go through.
   */
  async paymentMethodChanged(payload, topic) {
    const pm = String(payload.admin_graphql_api_id || '');
    const customerId = numericId(payload.admin_graphql_api_customer_id || payload.customer_id || '');
    if (!pm && !customerId) return { ignored: topic };
    const rows = this.sql.exec("SELECT * FROM memberships WHERE status != 'ended' AND (payment_method_id = ? OR customer_id = ?)", pm, customerId).toArray();
    const before = new Map(rows.map((r) => [r.id, `${r.payment_method_id}|${r.card}`]));
    const results = [];
    for (const row of rows) results.push(await this.syncContract(row.id, { topic }));
    // --- no awaits from here on ---
    const now = Date.now();
    let retried = 0;
    if (!topic.endsWith('/revoke')) {
      for (const row of rows) {
        const fresh = this.membershipRow(row.id);
        // waiting on a failed payment: a renewal (past_due), or a cancelled member's damage charges
        const waiting = fresh?.status === 'past_due' || (fresh?.status === 'cancelling' && fresh.fail_count > 0 && fresh.retry_at != null);
        if (!waiting || this.openCharge(fresh.id) || (fresh.fail_count || 0) >= MAX_ATTEMPTS) continue;
        const changed = topic.endsWith('/update') ? fresh.payment_method_id === pm : before.get(row.id) !== `${fresh.payment_method_id}|${fresh.card}`;
        if (!changed || (fresh.retry_at != null && fresh.retry_at <= now)) continue;
        this.write('UPDATE memberships SET retry_at = ?, updated_at = ? WHERE id = ?', now, now, fresh.id);
        retried += 1;
      }
    }
    return { paymentMethod: pm || null, memberships: rows.length, retried, results };
  },

  /* ---------------- maintenance ---------------- */
  /**
   * The 10-minute run for memberships (one at a time): webhooks in place (once a day), charges Shopify hasn't answered
   * asked about, claims a run never finished picked up, damage charges taken now followed up (and their one-off
   * contracts closed), damage charges past their notice made due, next bill dates
   * Shopify didn't give asked for again, and (only with MEMBERSHIPS_BILLING on) late renewals moved on and what's due
   * billed. Then memberships that were cancelled or couldn't be paid end. Returns a summary for the status table.
   * Never throws.
   */
  async membershipMaintenance(rules, now = Date.now(), { webhookUrl = null, force = false } = {}) {
    const admin = this.membershipsAdmin();
    const out = { configured: admin.configured, billing: this.membershipBillingOn() ? 'on' : 'off' };
    if (this.membershipRunUntil && this.membershipRunUntil > Date.now()) return { ...out, busy: true };
    this.membershipRunUntil = Date.now() + RUN_LOCK;
    try {
      // Damage charges taken now are followed up on their own, so nothing there can stop the rest (and store credit
      // only needs the Lair's own app, so it's followed up even without Lair Memberships)
      try {
        out.paidNow = await this.reconcileDamagePayments(rules, Date.now(), { cards: admin.configured });
      } catch (error) {
        console.error('Lair: following up damage charges taken now failed', error);
        out.paidNowError = String(error.message || error).slice(0, 300);
      }
      if (!admin.configured) return out;
      try {
        out.webhooks = await this.ensureMembershipWebhooks(webhookUrl, { force });
      } catch (error) {
        out.webhooks = { ok: false, reason: String(error.message || error).slice(0, 200) };
      }
      try {
        out.checked = await this.reconcileCharges(rules, Date.now());
        out.fees = this.feesFallDue(Date.now());
        out.renewals = await this.fillRenewalDates(Date.now());
        if (this.membershipBillingOn()) {
          out.caughtUp = await this.catchUpRenewals(rules, Date.now());
          out.unbillable = this.feesWithoutProduct(Date.now());
          out.charged = await this.chargeDue(rules, Date.now());
        } else {
          out.charged = [];
          out.waiting = this.waitingCount(Date.now());
        }
        out.gaveUp = this.giveUpWaiting(rules, Date.now());
        out.ended = await this.endMemberships(rules, Date.now());
      } catch (error) {
        console.error('Lair: membership maintenance failed', error);
        out.error = String(error.message || error).slice(0, 300);
      }
      this.sql.exec('DELETE FROM membership_events WHERE at < ?', now - EVENT_KEEP_DAYS * DAY);
    } finally {
      this.membershipRunUntil = 0;
    }
    return out;
  },

  /** Webhooks for Lair Memberships at url, checked once a day (or now, with force): { ok, created?, reason? } */
  async ensureMembershipWebhooks(url, { force = false } = {}) {
    if (!url) return { ok: false, reason: 'No public address to send webhooks to (PUBLIC_URL).' };
    const saved = await this.ctx.storage.get?.('membership-webhooks');
    if (!force && saved?.url === url && Date.now() - saved.checkedAt < 24 * HOUR) return { ok: true, url };
    const result = await this.membershipsAdmin().ensureWebhooks(url);
    if (result.ok) await this.ctx.storage.put?.('membership-webhooks', { url, checkedAt: Date.now() });
    return { ...result, url };
  },

  /**
   * Charges Shopify hasn't answered. A claim no run finished goes through sendCharge again (which first looks it up
   * by its key if it may have reached Shopify, and drops it if it's no longer wanted); staff hear about one stuck for 2
   * hours. A pending one is asked about after 30 minutes, a bank check every 2 hours (after 3 days borrowing pauses,
   * and after 7 it's given up as the last try). One whose attempt id the Lair never got (a webhook can come without it)
   * is found by its key; one Shopify has no record of is looked up by its key and dropped or sent again. Returns the
   * charge ids looked at.
   */
  async reconcileCharges(rules, now) {
    const admin = this.membershipsAdmin();
    const looked = [];
    const stale = this.sql.exec("SELECT id FROM membership_charges WHERE status = 'claimed' AND updated_at < ? ORDER BY updated_at LIMIT ?", now - CLAIM_STALE, CHECKS_A_RUN).toArray();
    for (const { id } of stale) {
      looked.push(id);
      await this.sendCharge(id, admin);
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.chargeRow(id);
      if (fresh?.status === 'claimed' && at - fresh.created_at > STUCK_ALERT_AFTER) {
        const name = this.memberName(this.membershipRow(fresh.membership_id)?.customer_id);
        this.staffAlert(`stuck:${fresh.membership_id}`, `A library bill is stuck: ${name}`, {
          title: "A bill that hasn't gone",
          intro: `The Lair has been trying to send ${name}'s ${money(fresh.amount)} library bill to Shopify for over 2 hours: Shopify isn't answering, or won't take the bill's damage charges on or off. It keeps trying. A bill that hasn't gone 2 days after it was due is dropped, and the next one is billed when it comes.`,
          details: [['Membership', fresh.membership_id], ['Cycle', String(fresh.cycle)], ['Claimed', new Date(fresh.created_at).toISOString().slice(0, 16).replace('T', ' ')]],
        }, at);
      }
    }
    const waiting = this.sql.exec(
      "SELECT * FROM membership_charges WHERE (status = 'pending' AND updated_at < ?) OR (status = 'challenged' AND updated_at < ?) ORDER BY updated_at LIMIT ?",
      now - RECONCILE_AFTER, now - CHALLENGE_CHECK_EVERY, CHECKS_A_RUN,
    ).toArray();
    for (const charge of waiting) {
      looked.push(charge.id);
      let state;
      try {
        if (charge.attempt_gid) state = await admin.attempt(charge.attempt_gid);
        else {
          state = await admin.findAttempt(charge.membership_id, charge.idempotency_key);
          if (state) this.write('UPDATE membership_charges SET attempt_gid = COALESCE(attempt_gid, ?) WHERE id = ?', state.id, charge.id);
        }
      } catch (error) {
        console.error('Lair: could not check a membership charge', error);
        continue;
      }
      if (state?.state === 'paid' || state?.state === 'failed') {
        await this.chargeOutcome(charge.id, state);
        continue;
      }
      if (!state) {
        // Shopify has no attempt by that id: look it up by its key instead (and drop it if Shopify never got it)
        const fresh = this.chargeRow(charge.id);
        if (fresh?.status !== charge.status) continue;
        this.write("UPDATE membership_charges SET status = 'claimed', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?", Date.now(), Date.now(), charge.id);
        await this.sendCharge(charge.id, admin);
        continue;
      }
      if (state.state === 'action' && charge.status !== 'challenged') await this.chargeOutcome(charge.id, state);
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.chargeRow(charge.id);
      if (!fresh || !['pending', 'challenged'].includes(fresh.status)) continue;
      this.write('UPDATE membership_charges SET updated_at = ? WHERE id = ?', at, fresh.id);
      if (fresh.status === 'challenged') {
        if (this.bankCheckWaits(fresh.id, rules, at) === 'give-up') {
          await this.chargeOutcome(fresh.id, { state: 'failed', code: 'AUTHENTICATION_REQUIRED', message: "The bank check wasn't done.", final: true });
        }
      } else if (at - fresh.created_at > DAY) {
        const name = this.memberName(this.membershipRow(fresh.membership_id)?.customer_id);
        this.staffAlert(`pending:${fresh.id}`, `A library payment has been processing for a day: ${name}`, {
          title: 'A payment still processing',
          intro: `Shopify has been processing ${name}'s ${money(fresh.amount)} library payment for over a day. The Lair keeps checking it. If it's still stuck, look at the contract's billing attempts in Shopify.`,
          details: [['Membership', fresh.membership_id], ['Attempt', fresh.attempt_gid || '']],
        }, at);
      }
    }
    return looked;
  },

  /**
   * A payment waiting on the member's bank check: after 3 days borrowing pauses (past_due, with no new try, because
   * the check could still go through; the member hears), and after 7 days it's given up (the caller fails it as the last
   * try, and a late success is still taken). No awaits. Returns 'paused', 'give-up' or null.
   */
  bankCheckWaits(chargeId, rules, now) {
    const charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'challenged') return null;
    const age = now - charge.created_at;
    if (age >= GIVE_UP_DAYS * DAY) return 'give-up';
    const m = this.membershipRow(charge.membership_id);
    if (age >= CHALLENGE_DAYS * DAY && m?.status === 'active' && charge.kind === 'renewal' && this.isLatestTry(charge)) {
      this.write("UPDATE memberships SET status = 'past_due', failed_at = COALESCE(failed_at, ?), retry_at = NULL, updated_at = ? WHERE id = ?", charge.created_at, now, m.id);
      this.tellBankCheck(this.membershipRow(m.id), charge, rules);
      return 'paused';
    }
    return null;
  },

  /**
   * Damage charges whose notice ran out are due (they go on the member's next bill), or, when there's no membership
   * that can be billed, go to staff to collect at the counter. No awaits. Returns how many moved.
   */
  feesFallDue(now) {
    const ready = this.sql.exec("SELECT * FROM damage_charges WHERE status = 'notice' AND due_at <= ?", now).toArray();
    for (const f of ready) {
      const billable = this.billable(this.membershipRow(f.membership_id));
      this.write("UPDATE damage_charges SET status = ?, updated_at = ? WHERE id = ? AND status = 'notice'", billable ? 'due' : 'unpaid', now, f.id);
      if (!billable) this.feeToCounter(f, now);
    }
    return ready.length;
  },

  /** Staff hear about a damage charge to collect at the counter (no membership can be billed for it). No awaits. */
  feeToCounter(f, now) {
    const name = this.memberName(f.customer_id);
    this.staffAlert(`unpaid:${f.id}`, `A damage charge to collect at the counter: ${name}`, {
      title: 'A damage charge to collect',
      intro: `${name}'s ${money(f.amount)} charge for ${f.title} can't go on a library bill (they have no membership to bill), so it's on the staff page under Damage to sort at the counter.`,
      details: [['Game', f.title], ['What happened', `${FEE_REASONS[f.reason] || f.reason}${f.details ? `: ${f.details}` : ''}`], ['Charge', money(f.amount)]],
    }, now);
  },

  /**
   * Memberships whose next bill date Shopify hasn't given are asked again, the longest-waiting first, at most every 30
   * minutes each. Staff hear about one still unknown after a day (it can't be billed until it's known). Returns how
   * many were filled.
   */
  async fillRenewalDates(now) {
    const admin = this.membershipsAdmin();
    let filled = 0;
    const rows = this.sql.exec(
      `SELECT * FROM memberships WHERE status IN ('active', 'past_due', 'cancelling') AND next_bill_at IS NULL AND COALESCE(dates_checked_at, 0) < ?
       ORDER BY COALESCE(dates_checked_at, 0), created_at LIMIT ?`,
      now - DATES_RETRY_EVERY, CHECKS_A_RUN,
    ).toArray();
    for (const row of rows) {
      let next = null;
      try {
        if (row.next_cycle == null) {
          const contract = await admin.contract(row.id);
          next = contract ? await this.firstRenewal(admin, contract) : null;
        } else {
          next = (await admin.cycles(row.id, row.next_cycle, row.next_cycle)).find((c) => !c.billed && !c.skipped) || await this.cycleAfter(admin, row.id, row.next_cycle - 1);
          if (next) next = { index: next.index, expectedAt: next.expectedAt };
        }
      } catch (error) {
        console.error('Lair: could not read billing cycles', error);
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.membershipRow(row.id);
      if (!fresh || fresh.next_bill_at != null) continue;
      if (next) {
        this.write('UPDATE memberships SET next_cycle = ?, next_bill_at = ?, dates_checked_at = ?, dates_missing_at = NULL, updated_at = ? WHERE id = ?', next.index, next.expectedAt, at, at, row.id);
        if (row.next_cycle == null) this.checkFirstRenewal(this.membershipRow(row.id), next, at);
        filled += 1;
        continue;
      }
      this.write('UPDATE memberships SET dates_checked_at = ?, dates_missing_at = COALESCE(dates_missing_at, ?) WHERE id = ?', at, at, row.id);
      const since = fresh.dates_missing_at || at;
      if (at - since >= DAY) {
        const name = this.memberName(row.customer_id);
        this.staffAlert(`dates:${row.id}`, `A library membership with no next bill date: ${name}`, {
          title: 'No next bill date',
          intro: `Shopify hasn't given the next billing cycle for ${name}'s library membership for over a day, so it can't be billed. They can still borrow. Check the contract's billing cycles in Shopify.`,
          details: [['Membership', row.id], ['Cycle', row.next_cycle == null ? 'the first' : String(row.next_cycle)], ['Since', new Date(since).toISOString().slice(0, 16).replace('T', ' ')]],
        }, at);
      }
    }
    return filled;
  },

  /**
   * Renewals more than 2 days late (billing was off, the Lair was down, or the contract was paused) aren't billed late,
   * and never several at once: the membership moves on to the first billing cycle that isn't (it's billed when that
   * comes), and staff hear which months weren't billed. The same goes for a failed payment whose next try is more than
   * 2 days overdue: that month is dropped, not retried late, and borrowing is back on. Only with billing on. Returns the
   * membership ids moved on.
   */
  async catchUpRenewals(rules, now) {
    const admin = this.membershipsAdmin();
    const rows = this.sql.exec(
      `SELECT * FROM memberships WHERE next_cycle IS NOT NULL AND (
         (status = 'active' AND next_bill_at IS NOT NULL AND next_bill_at <= ?) OR (status = 'past_due' AND retry_at IS NOT NULL AND retry_at <= ?))
       ORDER BY COALESCE(retry_at, next_bill_at) LIMIT ?`,
      now - LATE_GRACE, now - LATE_GRACE, CHECKS_A_RUN,
    ).toArray();
    const moved = [];
    for (const row of rows) {
      if (this.openCharge(row.id)) continue;
      let next = null;
      try {
        for (let start = row.next_cycle; start < row.next_cycle + 36 && !next; start += 12) {
          const cycles = await admin.cycles(row.id, start, start + 11);
          if (!cycles.length) break;
          const found = cycles.find((c) => !c.billed && !c.skipped && c.expectedAt > now - LATE_GRACE);
          if (found) next = { index: found.index, expectedAt: found.expectedAt };
        }
      } catch (error) {
        console.error('Lair: could not read billing cycles', error);
        continue;
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.membershipRow(row.id);
      if (!fresh || fresh.status !== row.status || fresh.next_cycle !== row.next_cycle || fresh.next_bill_at !== row.next_bill_at || fresh.retry_at !== row.retry_at || this.openCharge(fresh.id)) continue;
      if (!next) {
        const name = this.memberName(row.customer_id);
        this.staffAlert(`dates:${row.id}`, `A library membership with no next bill date: ${name}`, {
          title: 'No next bill date',
          intro: `${name}'s library membership was due a bill more than 2 days ago, and Shopify has no later billing cycle to move on to, so it can't be billed. Check the contract in Shopify.`,
          details: [['Membership', row.id], ['Cycle', String(row.next_cycle)]],
        }, at);
        continue;
      }
      this.write(
        "UPDATE memberships SET status = 'active', next_cycle = ?, next_bill_at = ?, fail_count = 0, failed_at = NULL, retry_at = NULL, updated_at = ? WHERE id = ?",
        next.index, next.expectedAt, at, row.id,
      );
      moved.push({
        id: row.id, name: this.memberName(row.customer_id), from: row.next_bill_at, to: next.expectedAt, failed: row.status === 'past_due',
        skipped: Math.max(1, next.index - row.next_cycle),
      });
    }
    if (moved.length) {
      this.notifyStaff(`Library bills that were too late to take: ${moved.length}`, {
        title: 'Months not billed',
        intro: "These library memberships were due a bill (or a retry of a failed payment) more than 2 days ago: billing was off, the Lair was down, or the contract was paused. The Lair doesn't bill late or several months at once, so it skipped to the next bill, and anyone whose payment had failed can borrow again. Bill them in Shopify if you want those months.",
        details: moved.map((m) => [m.name, `${plural(m.skipped, 'month', 'months')} not billed (due ${billDay(m.from, rules.tz)}${m.failed ? ', its payment had failed' : ''}); next bill ${billDay(m.to, rules.tz)}`]),
      });
    }
    return moved.map((m) => m.id);
  },

  /** Memberships that would be billed if billing were on (for the status table while it's off). No awaits. */
  waitingCount(now) {
    return this.sql.exec(
      "SELECT COUNT(*) AS n FROM memberships WHERE (status = 'active' AND next_bill_at <= ?) OR (status = 'past_due' AND retry_at <= ?)", now, now,
    ).toArray()[0]?.n || 0;
  },

  /**
   * What a membership is due now, from its row: 'renewal' (its next bill, within 2 days of its date, or its next try
   * after a failed payment), 'fees' (a cancelled one's damage charges, after its paid month), or null. Nothing while
   * billing is on hold, or while a charge is in flight. No awaits.
   */
  dueKind(m, now) {
    if (!m || m.next_cycle == null || (m.hold_until && m.hold_until > now) || (m.changing_until && m.changing_until > now) || this.openCharge(m.id)) return null;
    if (m.status === 'active') return m.next_bill_at != null && m.next_bill_at <= now && m.next_bill_at > now - LATE_GRACE ? 'renewal' : null;
    if (m.status === 'past_due') return m.retry_at != null && m.retry_at <= now ? 'renewal' : null;
    if (m.status === 'cancelling') {
      return m.cancel_at != null && m.cancel_at <= now && (m.retry_at == null || m.retry_at <= now) && this.dueFees(m.id, now).length ? 'fees' : null;
    }
    return null;
  },

  /** Who's due a charge now (see dueKind), the longest-waiting first. No awaits. */
  dueMemberships(now) {
    const rows = this.sql.exec(
      `SELECT * FROM memberships WHERE next_cycle IS NOT NULL AND COALESCE(hold_until, 0) <= ? AND (
         (status = 'active' AND next_bill_at <= ?) OR (status = 'past_due' AND retry_at <= ?) OR (status = 'cancelling' AND cancel_at <= ?))
       ORDER BY COALESCE(retry_at, next_bill_at, cancel_at)`,
      now, now, now, now,
    ).toArray();
    return rows.filter((m) => this.dueKind(m, now));
  },

  /** A membership's damage charges ready for a bill (due, oldest first). No awaits. */
  dueFees(membershipId, now) {
    return this.sql.exec("SELECT * FROM damage_charges WHERE membership_id = ? AND status = 'due' AND due_at <= ? ORDER BY created_at", membershipId, now).toArray();
  },

  /**
   * With no damage charge product (setup makes it), damage charges can't go on bills: a renewal goes without them, a
   * cancelled membership's go to staff to collect (so it can end), and staff hear once a day. No awaits. Returns how
   * many went to staff.
   */
  feesWithoutProduct(now) {
    if (this.feeVariantId()) return 0;
    const waiting = this.sql.exec(
      "SELECT f.* FROM damage_charges f JOIN memberships m ON m.id = f.membership_id WHERE f.status = 'due' AND m.status IN ('active', 'past_due', 'cancelling')",
    ).toArray();
    if (!waiting.length) return 0;
    let moved = 0;
    for (const f of waiting) {
      const m = this.membershipRow(f.membership_id);
      if (m.status !== 'cancelling' || m.cancel_at == null || m.cancel_at > now) continue;
      this.write("UPDATE damage_charges SET status = 'unpaid', note = COALESCE(note, ?), updated_at = ? WHERE id = ? AND status = 'due'", 'No damage charge product to bill it with', now, f.id);
      moved += 1;
    }
    this.staffAlert('fees-product', "Damage charges can't go on library bills", {
      title: 'No damage charge product',
      intro: `There's no damage charge product, so ${plural(waiting.length, 'damage charge', 'damage charges')} can't go on library bills. Run setup with memberships=plans (it makes the product), or put the product's variant ID in the config table as MEMBERSHIPS_FEE_VARIANT_ID.${moved ? ` ${plural(moved, 'charge', 'charges')} for cancelled memberships went to the staff page to collect at the counter.` : ''}`,
    }, now);
    return moved;
  },

  /**
   * Start a charge for each membership that's due (up to 20 a run): claim it from its freshly read row (a webhook or
   * another run may have moved it on), then send it. Returns the charge ids started.
   */
  async chargeDue(rules, now) {
    const started = [];
    const admin = this.membershipsAdmin();
    const ids = this.dueMemberships(now).slice(0, CHARGES_A_RUN).map((m) => m.id);
    for (const id of ids) {
      const charge = this.claimCharge(id, Date.now());
      if (!charge) continue;
      started.push(charge.id);
      await this.sendCharge(charge.id, admin);
    }
    return started;
  },

  /**
   * Claim the next try at billing a membership's cycle, if it's due right now: a charge row (one more than the last try
   * at that cycle) with its idempotency key, and its damage charges marked billing (when there's a damage charge product
   * to bill them with). A renewal's tier is the plan it bills (a plan change takes effect when it's paid). Returns the
   * charge row, or null. No awaits.
   */
  claimCharge(membershipId, now) {
    const m = this.membershipRow(membershipId);
    const kind = this.dueKind(m, now);
    if (!kind) return null;
    if (this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND cycle = ? AND status = 'paid'", m.id, m.next_cycle).toArray().length) {
      // that cycle is paid already: the next one is read from Shopify again
      this.write('UPDATE memberships SET next_bill_at = NULL, dates_missing_at = COALESCE(dates_missing_at, ?), updated_at = ? WHERE id = ?', now, now, m.id);
      return null;
    }
    const fees = this.feeVariantId() ? this.dueFees(m.id, now) : [];
    if (kind === 'fees' && !fees.length) return null;
    const last = this.sql.exec('SELECT MAX(attempt) AS n FROM membership_charges WHERE membership_id = ? AND cycle = ?', m.id, m.next_cycle).toArray()[0]?.n || 0;
    const attempt = last + 1;
    const tier = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    const amount = (kind === 'renewal' ? m.price ?? TIERS[tier].price : 0) + fees.reduce((sum, f) => sum + f.amount, 0);
    const id = makeId('mc');
    this.write(
      `INSERT INTO membership_charges (id, membership_id, cycle, attempt, idempotency_key, kind, status, amount, fees, tier, edit_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, 'needed', ?, ?)`,
      id, m.id, m.next_cycle, attempt, chargeKey(m.id, m.next_cycle, attempt), kind, amount, JSON.stringify(fees.map((f) => f.id)), kind === 'renewal' ? tier : null, now, now,
    );
    for (const f of fees) this.write("UPDATE damage_charges SET status = 'billing', charge_id = ?, updated_at = ? WHERE id = ?", id, now, f.id);
    return this.chargeRow(id);
  },

  /**
   * Whether a claimed charge should still go to Shopify: a reason it shouldn't ('billing-off', 'held', 'too-late', the
   * membership's status, 'cycle-done'), or null. No awaits.
   */
  chargeUnwanted(charge, now) {
    if (!this.membershipBillingOn()) return 'billing-off';
    const m = this.membershipRow(charge.membership_id);
    if (!m) return 'no-membership';
    if (m.hold_until && m.hold_until > now) return 'held';
    // never sent within 2 days of being claimed (Shopify down, or the bill's edit kept failing): too late to send now
    if (now - charge.created_at > LATE_GRACE) return 'too-late';
    if (charge.kind === 'renewal' && !['active', 'past_due'].includes(m.status)) return `membership-${m.status}`;
    if (charge.kind === 'fees' && m.status !== 'cancelling') return `membership-${m.status}`;
    if (m.next_cycle != null && charge.cycle < m.next_cycle) return 'cycle-done';
    return null;
  },

  /**
   * Take a claimed charge to Shopify. If it may have reached Shopify already (an earlier send never came back), it's
   * looked up by its key first, and an attempt Shopify has is taken up rather than sent again. A charge that's no
   * longer wanted is dropped. Then the cycle is read (a cycle that's billed or skipped already isn't billed again),
   * given exactly the charge's damage charges or none, and billed. Shopify not answering leaves it for the next run.
   * Returns what happened.
   */
  async sendCharge(chargeId, admin = this.membershipsAdmin()) {
    let charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return { charge: chargeId, already: charge?.status || null };
    const waiting = () => {
      this.write('UPDATE membership_charges SET updated_at = ? WHERE id = ?', Date.now(), chargeId);
      return { charge: chargeId, waiting: true };
    };
    if (charge.sent_at) {
      let found;
      try {
        found = await admin.findAttempt(charge.membership_id, charge.idempotency_key);
      } catch (error) {
        console.error('Lair: could not look up a membership charge', error);
        return waiting();
      }
      // --- no awaits until chargeOutcome ---
      charge = this.chargeRow(chargeId);
      // (a webhook may have moved it on meanwhile without saying which attempt it was: keep the id either way)
      if (found && charge && !charge.attempt_gid) this.write('UPDATE membership_charges SET attempt_gid = ? WHERE id = ?', found.id, chargeId);
      if (!charge || charge.status !== 'claimed') return { charge: chargeId, already: charge?.status || null };
      if (found) {
        this.write("UPDATE membership_charges SET status = 'pending', attempt_gid = ?, updated_at = ? WHERE id = ?", found.id, Date.now(), chargeId);
        if (found.state === 'pending') return { charge: chargeId, status: 'pending', found: true };
        return { ...(await this.chargeOutcome(chargeId, found)), found: true };
      }
    }
    const unwanted = this.chargeUnwanted(charge, Date.now());
    if (unwanted) return this.voidCharge(chargeId, unwanted);
    let cycle;
    try {
      [cycle] = await admin.cycles(charge.membership_id, charge.cycle, charge.cycle);
    } catch (error) {
      console.error('Lair: could not read a billing cycle', error);
      return waiting();
    }
    // --- no awaits until prepareCycle ---
    charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return { charge: chargeId, already: charge?.status || null };
    if (!cycle || cycle.index !== charge.cycle || cycle.billed || cycle.skipped) return this.cycleNotBillable(charge, cycle);
    const ready = await this.prepareCycle(chargeId, admin);
    if (ready !== 'ready') return ready === 'waiting' ? waiting() : { charge: chargeId, void: 'fees-refused' };
    // --- no awaits until the bill ---
    charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return { charge: chargeId, already: charge?.status || null };
    const late = this.chargeUnwanted(charge, Date.now());
    if (late) return this.voidCharge(chargeId, late);
    const sentAt = Date.now();
    this.write('UPDATE membership_charges SET sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?', sentAt, sentAt, chargeId);
    let result;
    try {
      result = await admin.bill({ contractId: charge.membership_id, cycle: charge.cycle, key: charge.idempotency_key });
    } catch (error) {
      // It may or may not have reached Shopify: the next run looks it up by its key before anything else
      console.error('Lair: could not start a membership charge', error);
      return { charge: chargeId, waiting: true };
    }
    // --- no awaits from here on (except a contract read after a refusal) ---
    const fresh = this.chargeRow(chargeId);
    // A webhook can get here first (and may not say which attempt it was): the attempt id is kept whatever it did
    if (result.attemptId && fresh && !fresh.attempt_gid) this.write('UPDATE membership_charges SET attempt_gid = ? WHERE id = ?', result.attemptId, chargeId);
    if (!fresh || fresh.status !== 'claimed') return { charge: chargeId, already: fresh?.status || null };
    if (result.attemptId) {
      this.write("UPDATE membership_charges SET status = 'pending', attempt_gid = ?, updated_at = ? WHERE id = ?", result.attemptId, Date.now(), chargeId);
      return { charge: chargeId, status: 'pending' };
    }
    const refused = this.chargeRefused(fresh, result.errors);
    if (refused.resync) {
      try {
        await this.syncContract(fresh.membership_id, { topic: 'refused' });
      } catch (error) {
        console.error('Lair: could not read a refused contract', error);
      }
    }
    return refused;
  },

  /**
   * The cycle a charge was for can't be billed: Shopify says it's billed already (outside the Lair), skipped, or has
   * no such cycle. The charge is dropped, the next cycle is read again, and staff hear; a membership waiting on a failed
   * payment for a cycle that's been paid another way is back to normal. No awaits.
   */
  cycleNotBillable(charge, cycle) {
    const now = Date.now();
    const why = !cycle || cycle.index !== charge.cycle ? 'cycle-missing' : cycle.billed ? 'cycle-billed' : 'cycle-skipped';
    this.voidCharge(charge.id, why);
    const m = this.membershipRow(charge.membership_id);
    if (!m) return { charge: charge.id, void: why };
    this.write(
      'UPDATE memberships SET next_bill_at = NULL, dates_missing_at = COALESCE(dates_missing_at, ?), updated_at = ? WHERE id = ? AND next_cycle = ?',
      now, now, m.id, charge.cycle,
    );
    if (why === 'cycle-billed' && m.status === 'past_due') {
      this.write("UPDATE memberships SET status = 'active', fail_count = 0, failed_at = NULL, retry_at = NULL, updated_at = ? WHERE id = ?", now, m.id);
    }
    const name = this.memberName(m.customer_id);
    this.staffAlert(`cycle:${m.id}:${charge.cycle}`, `A library bill the Lair didn't take: ${name}`, {
      title: why === 'cycle-billed' ? 'Billed outside the Lair' : 'A bill that was skipped',
      intro: why === 'cycle-billed'
        ? `Shopify says ${name}'s library bill for this month was already taken, but not by the Lair. The Lair didn't bill it again. Check their orders in Shopify.`
        : why === 'cycle-skipped'
          ? `${name}'s library bill for this month is skipped in Shopify, so the Lair didn't take it and moves on to the next one.`
          : `Shopify has no billing cycle ${charge.cycle} for ${name}'s library membership, so the Lair didn't bill it. Check the contract in Shopify.`,
      details: [['Membership', m.id], ['Cycle', String(charge.cycle)], ['Amount', money(charge.amount)]],
    }, now);
    return { charge: charge.id, void: why };
  },

  /**
   * Give a charge's cycle exactly its damage charges before it's billed. A renewal with none has any edit the Lair left
   * on that cycle taken off; one with damage charges (or damage charges billed on their own, without the month's plan)
   * has the cycle edited to them. Shopify not answering leaves the charge for the next run; Shopify saying no sends a
   * renewal without its damage charges (staff hear) and drops damage charges billed on their own (staff collect them).
   * Returns 'ready', 'waiting' or 'void'.
   */
  async prepareCycle(chargeId, admin) {
    let charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return 'void';
    if (charge.edit_state === 'done') return 'ready';
    const m = this.membershipRow(charge.membership_id);
    const feeIds = parse(charge.fees, []);
    if (feeIds.length || charge.kind === 'fees') {
      const feeVariantId = this.feeVariantId();
      if (!feeVariantId) return this.feesRefused(charge, [{ code: null, message: 'no damage charge product (run setup)' }]) === 'again' ? this.prepareCycle(chargeId, admin) : 'void';
      // From here the cycle may carry an edit, until it's billed or the Lair takes it off
      this.write('UPDATE memberships SET edited_cycle = ?, updated_at = ? WHERE id = ?', charge.cycle, Date.now(), m.id);
      const fees = feeIds.map((id) => this.feeRow(id)).filter(Boolean).map((f) => ({ id: f.id, amount: f.amount, label: feeLabel(f) }));
      let edited;
      try {
        edited = await admin.editCycle({ contractId: m.id, cycle: charge.cycle, feeVariantId, dropPlan: charge.kind === 'fees', fees });
      } catch (error) {
        console.error('Lair: could not put damage charges on a bill', error);
        return 'waiting';
      }
      // --- no awaits from here on ---
      charge = this.chargeRow(chargeId);
      if (!charge || charge.status !== 'claimed') return 'void';
      if (!edited.ok) return this.feesRefused(charge, edited.errors) === 'again' ? this.prepareCycle(chargeId, admin) : 'void';
      this.write("UPDATE membership_charges SET edit_state = 'done', updated_at = ? WHERE id = ?", Date.now(), chargeId);
      return 'ready';
    }
    if (m.edited_cycle === charge.cycle) {
      let cleared;
      try {
        cleared = await admin.clearCycleEdit({ contractId: m.id, cycle: charge.cycle });
      } catch (error) {
        console.error('Lair: could not clear a bill edit', error);
        return 'waiting';
      }
      // --- no awaits from here on ---
      charge = this.chargeRow(chargeId);
      if (!charge || charge.status !== 'claimed') return 'void';
      if (!cleared.ok) {
        const name = this.memberName(m.customer_id);
        this.staffAlert(`clear:${m.id}`, `A library bill is waiting on Shopify: ${name}`, {
          title: "A bill that can't go yet",
          intro: `Shopify won't take the old damage charges off ${name}'s next library bill, so the Lair isn't billing it yet (it would charge them again). It keeps trying.`,
          details: [['Membership', m.id], ['Cycle', String(charge.cycle)], ['Shopify said', errorWords(cleared.errors)]],
        });
        return 'waiting';
      }
      this.write('UPDATE memberships SET edited_cycle = NULL, updated_at = ? WHERE id = ? AND edited_cycle = ?', Date.now(), m.id, charge.cycle);
    }
    this.write("UPDATE membership_charges SET edit_state = 'done', updated_at = ? WHERE id = ?", Date.now(), chargeId);
    return 'ready';
  },

  /**
   * Shopify wouldn't put a charge's damage charges on its cycle (or there's no product to bill them with). A renewal
   * goes without them (they wait, due, for the next bill) and staff hear: 'again'. Damage charges billed on their own
   * can't be billed, so the charge is dropped and they go to staff to collect: 'void'. No awaits.
   */
  feesRefused(charge, errors) {
    const now = Date.now();
    const rows = parse(charge.fees, []).map((id) => this.feeRow(id)).filter(Boolean);
    const total = rows.reduce((sum, f) => sum + f.amount, 0);
    const name = this.memberName(this.membershipRow(charge.membership_id)?.customer_id);
    if (charge.kind === 'fees') {
      this.voidCharge(charge.id, 'fees-refused');
      for (const f of rows) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ? AND status = 'due'", now, f.id);
      this.staffAlert(`fees-refused:${charge.membership_id}`, `Damage charges to collect at the counter: ${name}`, {
        title: "Damage charges that couldn't be billed",
        intro: `Shopify wouldn't bill ${name}'s damage charges (${money(total)}), so they're on the staff page under Damage to sort at the counter.`,
        details: [['Membership', charge.membership_id], ['Shopify said', errorWords(errors)]],
      }, now);
      return 'void';
    }
    this.feesBack(charge, now);
    this.write("UPDATE membership_charges SET fees = '[]', amount = ?, updated_at = ? WHERE id = ?", Math.max(0, charge.amount - total), now, charge.id);
    this.staffAlert(`fees-left-off:${charge.membership_id}`, `Damage charges left off a library bill: ${name}`, {
      title: 'Damage charges left off a bill',
      intro: `Shopify wouldn't add the damage charges to ${name}'s library bill, so the membership was billed without them. They'll go on the next bill.`,
      details: [['Membership', charge.membership_id], ['Charges', money(total)], ['Shopify said', errorWords(errors)]],
    }, now);
    return 'again';
  },

  /**
   * Shopify refused to bill (a userError, not a payment failure: nothing was charged). Busy: sent again by the next run.
   * The contract ended or missing: the membership ends. Anything else: the charge is dropped and it's a problem on the
   * store's side (storeSideProblem: billing waits, staff hear, the member isn't told). Returns what happened, with
   * resync when the contract should be read again. No awaits.
   */
  chargeRefused(charge, errors) {
    const now = Date.now();
    const codes = errors.map((e) => e.code).filter(Boolean);
    const words = errorWords(errors);
    this.write('UPDATE membership_charges SET error_code = ?, error_message = ?, updated_at = ? WHERE id = ?', codes[0] || 'REFUSED', words, now, charge.id);
    if (codes.includes('THROTTLED')) return { charge: charge.id, waiting: true };
    const m = this.membershipRow(charge.membership_id);
    const name = this.memberName(m?.customer_id);
    if (codes.some((c) => ['CONTRACT_TERMINATED', 'CONTRACT_NOT_FOUND'].includes(c))) {
      this.voidCharge(charge.id, codes.includes('CONTRACT_TERMINATED') ? 'contract-terminated' : 'contract-missing');
      if (m && m.status !== 'ended') {
        // a cancelled member is told their membership has ended (it was going to); anyone else isn't, in case it was a mistake
        const reason = m.status === 'ending' ? 'payment' : this.isCancelling(m) ? 'cancelled' : 'shopify:ended';
        this.markEnded(m.id, { reason, rules: this.rulesCache || {}, now });
        this.staffAlert(`shopify-ended:${m.id}`, `A library membership has ended in Shopify: ${name}`, {
          title: 'A membership ended outside the Lair',
          intro: `Shopify wouldn't bill ${name}'s library membership because the contract has ended there, so the Lair has ended it too. ${reason === 'cancelled' ? "They'd cancelled, so they've had the usual email to say it has ended." : "They haven't been emailed."}`,
          details: [['Membership', m.id], ['Shopify said', words]],
        }, now);
      }
      return { charge: charge.id, ended: true, resync: codes.includes('CONTRACT_TERMINATED') };
    }
    this.voidCharge(charge.id, `refused:${codes[0] || 'unknown'}`.toLowerCase());
    if (codes.some((c) => CYCLE_REFUSALS.includes(c))) {
      this.write('UPDATE memberships SET next_bill_at = NULL, dates_missing_at = COALESCE(dates_missing_at, ?), updated_at = ? WHERE id = ? AND next_cycle = ?', now, now, charge.membership_id, charge.cycle);
    }
    const held = m ? this.storeSideProblem(charge, m, {
      subject: `Shopify wouldn't take a library bill: ${name}`, title: "A bill Shopify wouldn't take",
      problem: codes.includes('CONTRACT_UNDER_REVIEW')
        ? `Shopify won't bill ${name}'s library membership while its first order is under review for fraud risk. Check the order in Shopify. Nothing was charged and they haven't been told.`
        : `Shopify wouldn't bill ${name}'s library membership. Nothing was charged and they haven't been told.`,
      details: [['Membership', charge.membership_id], ['Amount', money(charge.amount)], ['Shopify said', words]],
    }, now) : {};
    return { charge: charge.id, void: 'refused', codes, ...held, resync: codes.includes('CONTRACT_PAUSED') };
  },

  /**
   * A membership waiting on a new card (the bank flagged the last payment, so it isn't tried again on its own) ends a
   * week after it stopped being paid. No awaits. Returns the ids.
   */
  giveUpWaiting(rules, now) {
    const rows = this.sql.exec(
      "SELECT * FROM memberships WHERE status = 'past_due' AND retry_at IS NULL AND failed_at IS NOT NULL AND failed_at <= ?", now - GIVE_UP_DAYS * DAY,
    ).toArray();
    const out = [];
    for (const row of rows) {
      if (this.openCharge(row.id)) continue;
      this.write("UPDATE memberships SET status = 'ending', end_reason = 'payment', updated_at = ? WHERE id = ? AND status = 'past_due'", now, row.id);
      const last = this.sql.exec("SELECT * FROM membership_charges WHERE membership_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", row.id).toArray()[0];
      this.tellPaymentGaveUp(this.membershipRow(row.id), last || { kind: 'renewal', amount: row.price || 0 }, { code: last?.error_code || null, tries: row.fail_count || 1, waited: true }, rules);
      out.push(row.id);
    }
    return out;
  },

  /**
   * End what should end: a cancelled membership past its paid month with nothing left to bill (no charge in flight,
   * no damage charge in its notice, due, being billed or being taken now) is cancelled in Shopify; one whose payments failed for good
   * is marked failed there. Staff hear when Shopify won't. Returns the ids ended.
   */
  async endMemberships(rules, now) {
    const admin = this.membershipsAdmin();
    const ended = [];
    // Cancelled while a payment was in flight, and that payment has gone (whichever way) without setting an end: it
    // ends now, so it can never sit cancelled forever
    for (const r of this.sql.exec("SELECT id FROM memberships WHERE status = 'cancelling' AND cancel_at IS NULL").toArray()) {
      if (!this.openCharge(r.id)) this.write('UPDATE memberships SET cancel_at = ?, updated_at = ? WHERE id = ? AND cancel_at IS NULL', now, now, r.id);
    }
    const rows = this.sql.exec(
      "SELECT * FROM memberships WHERE status = 'ending' OR (status = 'cancelling' AND cancel_at IS NOT NULL AND cancel_at <= ?) ORDER BY updated_at LIMIT ?", now, CHARGES_A_RUN,
    ).toArray();
    for (const row of rows) {
      if (this.openCharge(row.id)) continue;
      // (a damage charge being taken now waits too: if that doesn't work, it can still be billed on its own)
      if (row.status === 'cancelling' && this.sql.exec("SELECT 1 AS n FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due', 'billing', 'charging')", row.id).toArray().length) continue;
      const how = row.status === 'ending' ? 'fail' : 'cancel';
      let result;
      try {
        result = await admin.endContract(row.id, how);
      } catch (error) {
        console.error('Lair: could not end a membership in Shopify', error);
        continue;
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      if (result.errors.length && !result.errors.some((e) => e.code === 'CONTRACT_TERMINATED')) {
        this.staffAlert(`end:${row.id}`, `Shopify wouldn't end a library membership: ${this.memberName(row.customer_id)}`, {
          title: "A membership Shopify wouldn't end",
          intro: `The Lair tried to end ${this.memberName(row.customer_id)}'s library membership in Shopify, and Shopify said no. It keeps trying.`,
          details: [['Membership', row.id], ['Shopify said', errorWords(result.errors)]],
        }, at);
        continue;
      }
      const fresh = this.membershipRow(row.id);
      if (!fresh || fresh.status === 'ended') continue;
      if (fresh.status !== row.status) {
        // kept (or paid) while Shopify was ending it: it has ended there, so it ends here too, and staff hear
        this.staffAlert(`end-race:${row.id}`, `A library membership ended just as it changed: ${this.memberName(row.customer_id)}`, {
          title: 'Ended as it changed',
          intro: `${this.memberName(row.customer_id)}'s library membership was ended in Shopify just as it changed in the Lair (it's now ${fresh.status}). It has ended. If they meant to keep it, they can join again.`,
          details: [['Membership', row.id]],
        }, at);
      }
      this.markEnded(row.id, { reason: how === 'fail' ? 'payment' : 'cancelled', shopifyStatus: result.status || (how === 'fail' ? 'FAILED' : 'CANCELLED'), rules, now: at });
      ended.push(row.id);
    }
    return ended;
  },

  /** A membership ended: its damage charges that never got billed go to staff to sort at the counter. No awaits. */
  settleEndedFees(membershipId, now) {
    const open = this.sql.exec("SELECT * FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due')", membershipId).toArray();
    for (const f of open) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ?", now, f.id);
    return open.length;
  },

  /* ---------------- members: change, cancel, keep, card ---------------- */
  /** The membership a member acts on: their current one (or, for resume and the card, a cancelled one). */
  ownMembership(who, { allowEnding = false } = {}) {
    if (!who?.customerId) throw new RuleError(MEMBERSHIP_MESSAGES.login, 401);
    const now = Date.now();
    const m = this.currentMembership(who.customerId, now)
      || (allowEnding ? this.membershipRows(who.customerId).find((r) => r.status === 'cancelling') : null);
    if (!m) throw new RuleError(MEMBERSHIP_MESSAGES.none, 404);
    return m;
  },

  /**
   * POST /me/membership/change { tier }: a new plan from the next bill (the price changes on the contract now; the
   * games at a time change when that bill is paid, so moving up and back down before it can't skip paying). Not while
   * a payment is in flight. Returns { membership }.
   */
  async changeMembership(input, who) {
    const rules = await this.rules();
    // --- no awaits until Shopify: check, then mark it changing, so nothing is billed for them until it's done ---
    const m = this.ownMembership(who);
    const tier = String(input?.tier ?? '').trim().toLowerCase();
    if (!TIERS[tier]) throw new RuleError(MEMBERSHIP_MESSAGES.tier);
    if (m.status === 'past_due') throw new RuleError(MEMBERSHIP_MESSAGES.pastDue, 409);
    if (m.status !== 'active') throw new RuleError(MEMBERSHIP_MESSAGES.ending, 409);
    if (this.openCharge(m.id)) throw new RuleError(MEMBERSHIP_MESSAGES.editsWaiting, 409);
    if (m.changing_until && m.changing_until > Date.now()) throw new RuleError(MEMBERSHIP_MESSAGES.changing, 409);
    const billing = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    if (tier === billing) throw new RuleError(MEMBERSHIP_MESSAGES.same(TIERS[tier].name), 409);
    const plan = this.membershipPlans()?.plans?.[tier];
    if (!plan?.id || !m.line_id) throw new RuleError(MEMBERSHIP_MESSAGES.plansNotReady, 503);
    const price = Number.isInteger(plan.price) ? plan.price : TIERS[tier].price;
    this.write('UPDATE memberships SET changing_until = ? WHERE id = ?', Date.now() + PLAN_CHANGE_LOCK, m.id);
    const admin = this.membershipsAdmin();
    let cleared = null;
    let result;
    try {
      // A damage charge edit the Lair left on a cycle would block the change (HAS_FUTURE_EDITS): it's only needed while
      // that cycle is being billed, and nothing is being billed now
      if (m.edited_cycle != null) cleared = await admin.clearCycleEdit({ contractId: m.id, cycle: m.edited_cycle });
      result = await admin.changePlan({ contractId: m.id, lineId: m.line_id, sellingPlanId: plan.id, sellingPlanName: TIERS[tier].name, price });
    } catch (error) {
      console.error('Lair: plan change failed', error);
      this.write('UPDATE memberships SET changing_until = NULL WHERE id = ?', m.id);
      throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    }
    // --- no awaits from here on ---
    const now = Date.now();
    this.write('UPDATE memberships SET changing_until = NULL WHERE id = ?', m.id);
    if (cleared?.ok) this.write('UPDATE memberships SET edited_cycle = NULL WHERE id = ? AND edited_cycle = ?', m.id, m.edited_cycle);
    if (!result.ok) {
      if (result.errors.some((e) => e.code === 'HAS_FUTURE_EDITS')) throw new RuleError(MEMBERSHIP_MESSAGES.editsWaiting, 409);
      this.note({ membershipChange: { membership: m.id, message: errorWords(result.errors), at: new Date(now).toISOString() } });
      throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    }
    // Shopify has the new plan, so the Lair records it whatever else happened meanwhile; the member hears if it's still on
    this.write('UPDATE memberships SET billing_tier = ?, selling_plan_id = ?, price = ?, plan_changed_at = ?, updated_at = ? WHERE id = ?', tier, plan.id, price, now, now, m.id);
    const fresh = this.membershipRow(m.id);
    if (fresh.status === 'active') this.tellPlanChanged(fresh, rules);
    return { membership: this.membershipForMember(who.customerId, now) };
  },

  /**
   * POST /me/membership/cancel: no more bills. A paid-up membership runs to the end of the month they've paid for; any
   * damage charge still owed is billed on its own then. One waiting on a failed payment ends now (that month was never
   * paid). Returns { membership }.
   */
  async cancelMembership(input, who) {
    const m = this.ownMembership(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const fresh = this.membershipRow(m.id);
    const inFlight = this.endBy(fresh, { by: 'member', now });
    this.tellCancelled(this.membershipRow(m.id), rules, { inFlight });
    return { membership: this.membershipForMember(who.customerId, now) };
  },

  /**
   * When a membership's paid month ends: its next bill date, else when it was last paid up to, else a month after it
   * was last paid (or started). No awaits.
   */
  periodEnd(m) {
    if (m.next_bill_at != null) return m.next_bill_at;
    if (m.paid_through != null) return m.paid_through;
    const paid = this.sql.exec("SELECT MAX(completed_at) AS at FROM membership_charges WHERE membership_id = ? AND kind = 'renewal' AND status = 'paid'", m.id).toArray()[0]?.at;
    return addMonths(paid || m.created_at, 1);
  },

  /**
   * Set a membership to end (no awaits): 'end' (the default) at the end of the paid month; 'now' straight away (staff,
   * or a membership waiting on a failed payment). A claim that never reached Shopify is dropped. A payment Shopify may
   * have is left to finish: paid, they keep the month it paid for; not paid, it ends now. Returns whether a payment
   * was in flight.
   */
  endBy(m, { by, now, when = 'end' }) {
    if (!['active', 'past_due', 'cancelling', 'paused'].includes(m.status)) throw new RuleError(MEMBERSHIP_MESSAGES.notActive, 409);
    let open = this.openCharge(m.id);
    if (open?.status === 'claimed' && !open.sent_at) {
      this.voidCharge(open.id, 'cancelled');
      open = null;
    }
    if (open) {
      if (m.status !== 'cancelling') {
        this.write(
          "UPDATE memberships SET status = 'cancelling', cancel_at = NULL, cancel_requested_at = ?, cancel_by = ?, paused_from = NULL, updated_at = ? WHERE id = ?",
          now, by, now, m.id,
        );
      }
      return true;
    }
    if (m.status === 'cancelling') {
      if (when === 'now' && (m.cancel_at == null || m.cancel_at > now)) this.write('UPDATE memberships SET cancel_at = ?, cancel_by = ?, updated_at = ? WHERE id = ?', now, by, now, m.id);
      return false;
    }
    const end = this.periodEnd(m);
    const at = when === 'now' || m.status === 'past_due' || end <= now ? now : end;
    this.write(
      `UPDATE memberships SET status = 'cancelling', cancel_at = ?, cancel_requested_at = ?, cancel_by = ?, retry_at = NULL, fail_count = 0, failed_at = NULL,
         paused_from = NULL, updated_at = ? WHERE id = ?`,
      at, now, by, now, m.id,
    );
    return false;
  },

  /** POST /me/membership/resume: keep a cancelled membership that hasn't run out yet. Returns { membership }. */
  async resumeMembership(input, who) {
    const m = this.ownMembership(who, { allowEnding: true });
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const fresh = this.membershipRow(m.id);
    if (fresh.status !== 'cancelling') throw new RuleError(MEMBERSHIP_MESSAGES.notCancelling, 409);
    if (fresh.cancel_at == null ? !this.openCharge(fresh.id) : fresh.cancel_at <= now) throw new RuleError(MEMBERSHIP_MESSAGES.tooLate, 409);
    this.write("UPDATE memberships SET status = 'active', cancel_at = NULL, cancel_requested_at = NULL, cancel_by = NULL, updated_at = ? WHERE id = ?", now, fresh.id);
    return { membership: this.membershipForMember(who.customerId, now) };
  },

  /** POST /me/membership/card: Shopify emails the member a secure link to update their card (at most once an hour). */
  async membershipCardEmail(input, who) {
    const m = this.ownMembership(who, { allowEnding: true });
    if (!m.payment_method_id) throw new RuleError(MEMBERSHIP_MESSAGES.noCard, 409);
    if (m.card_email_at && Date.now() - m.card_email_at < CARD_EMAIL_GAP) throw new RuleError(MEMBERSHIP_MESSAGES.cardSoon, 429);
    let result;
    try {
      result = await this.membershipsAdmin().sendCardEmail(m.payment_method_id);
    } catch (error) {
      console.error('Lair: card update email failed', error);
      throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    }
    if (!result.ok) throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    // --- no awaits from here on ---
    const now = Date.now();
    this.write('UPDATE memberships SET card_email_at = ?, updated_at = ? WHERE id = ?', now, now, m.id);
    return { sent: true, message: "Shopify's emailed you a secure link to update your card. It can take a few minutes to arrive." };
  },

  /* ---------------- damage charges ---------------- */
  /**
   * POST /library/damage (staff): { customerId, loanId?, title?, reason, details?, amount (cents), chargeNow?, use? }.
   * The member gets an itemised notice now; after 7 days (unless it's waived, disputed, or the bits come back) it goes
   * on their next bill, or, with no membership to bill, to staff to collect at the counter. chargeNow (staff with
   * money): the notice says it's being taken now, then it is (chargeDamageNow's `use`); when it can't be (no email,
   * no card, not enough store credit), the notice is the usual one, or it goes back to it, and chargeNow says why.
   * Returns { charge, chargeNow? }.
   */
  async createDamageCharge(input, who) {
    this.requireStaff(who, ['library', 'money']);
    const chargeNow = input?.chargeNow === true;
    const use = String(input?.use ?? 'auto').trim().toLowerCase() || 'auto';
    if (chargeNow) {
      this.requireStaff(who, 'money');
      if (!['auto', 'credit', 'card'].includes(use)) throw new RuleError(MEMBERSHIP_MESSAGES.feeUse);
    }
    const rules = await this.rules();
    const customerId = trimmed(input?.customerId, 40);
    // Charging now: the store credit balance first (when Shopify will say), to pick store credit or the card
    const balance = chargeNow && use !== 'card' && this.memberRow(customerId) ? await this.creditBalanceOrNull(customerId) : null;
    // --- no awaits from here on (until it's charged now) ---
    const now = Date.now();
    const member = this.memberRow(customerId);
    if (!member) throw new RuleError(MEMBERSHIP_MESSAGES.feeMember, 404);
    const reason = String(input?.reason ?? '').trim().toLowerCase();
    if (!FEE_REASONS[reason]) throw new RuleError(MEMBERSHIP_MESSAGES.feeReason);
    const amount = Number(input?.amount);
    if (!Number.isInteger(amount) || amount < FEE_MIN || amount > FEE_MAX) throw new RuleError(MEMBERSHIP_MESSAGES.feeAmount);
    let loan = null;
    if (input?.loanId) {
      loan = this.sql.exec('SELECT * FROM library_loans WHERE id = ?', trimmed(input.loanId, 40)).toArray()[0] || null;
      if (!loan || loan.customer_id !== member.customer_id) throw new RuleError(MEMBERSHIP_MESSAGES.feeLoan, 404);
    }
    const title = trimmed(input?.title, 120) || loan?.title || '';
    if (!title) throw new RuleError(MEMBERSHIP_MESSAGES.feeTitle);
    const m = this.currentMembership(member.customer_id, now)
      || this.membershipRows(member.customer_id).find((r) => ['cancelling', 'paused'].includes(r.status)) || null;
    const id = makeId('dc');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      `INSERT INTO damage_charges (id, customer_id, membership_id, loan_id, variant_id, title, reason, details, amount, status, due_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'notice', ?, ?, ?, ?)`,
      id, member.customer_id, m?.id || null, loan?.id || null, loan?.variant_id || null, title, reason, trimmed(input?.details, 300) || null, amount,
      now + FEE_NOTICE_DAYS * DAY, by, now, now,
    );
    const fee = this.feeRow(id);
    // Charging now: how, decided before the notice so it can say so (no way to: the usual notice)
    let method = null;
    let why = null;
    if (chargeNow) {
      try {
        method = this.payNowMethod(fee, use, balance);
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        why = error.message;
      }
    }
    const nowWords = method ? { method, card: method === 'card' ? this.savedCardFor(fee.customer_id)?.card || null : null } : null;
    // The notice, waited for: it only counts as emailed once the email service has it, and only then is it taken now
    const emailed = await this.sendDamageNotice(id, m, rules, { now: nowWords });
    // --- no awaits from here on (until it's charged now) ---
    let paidNow = null;
    if (chargeNow && method && emailed) {
      try {
        const done = await this.payDamageNow(id, method, { by, told: true, rules, orCard: use === 'auto' });
        paidNow = { ok: true, message: done.message, payment: this.damagePaymentView(done.payment) };
      } catch (error) {
        // the charge is logged and its notice has gone whatever happened here, so this never fails the request (a
        // payment left part-way is followed up by the next run)
        if (!(error instanceof RuleError)) console.error('Lair: taking a damage charge now failed', error);
        paidNow = {
          ok: false, error: error instanceof RuleError ? error.message : 'Something went wrong taking it now. Check the charge on the Damage tab.',
          payment: this.damagePaymentView(this.latestDamagePayment(id)),
        };
      }
    } else if (chargeNow) {
      paidNow = { ok: false, error: why || MEMBERSHIP_MESSAGES.feeNotEmailed, payment: null };
    }
    return {
      charge: { ...this.feeView(this.feeRow(id)), emailed, billable: Boolean(m && this.feeVariantId()) },
      ...(chargeNow ? { chargeNow: paidNow } : {}),
    };
  },

  /** GET /library/damage?status=open|all&customerId= (staff): damage charges, newest first, with who they're for. */
  async listDamageCharges(url, who) {
    this.requireStaff(who, ['library', 'money']);
    await this.rules();
    // --- no awaits from here on ---
    const status = url.searchParams.get('status') === 'all' ? 'all' : 'open';
    const customerId = trimmed(url.searchParams.get('customerId'), 40);
    const where = [status === 'open' ? "status IN ('notice', 'due', 'billing', 'charging', 'disputed', 'unpaid')" : '1 = 1', customerId ? 'customer_id = ?' : '1 = 1'].join(' AND ');
    const rows = this.sql.exec(`SELECT * FROM damage_charges WHERE ${where} ORDER BY created_at DESC LIMIT 200`, ...(customerId ? [customerId] : [])).toArray();
    return {
      charges: rows.map((f) => {
        const member = this.memberRow(f.customer_id);
        return { ...this.feeView(f), customerId: f.customer_id, name: member?.name || member?.first_name || '', code: member?.code || '', membershipId: f.membership_id || null, by: f.created_by || null, note: f.note || null };
      }),
    };
  },

  /**
   * POST /library/damage/:id/update (staff, money): { action, amount?, note? }.
   * - waive: nothing to pay (the member hears).
   * - hold: it waits, off any bill, while staff sort it out (as a dispute does).
   * - reinstate: back on (due again if its notice has run out, or to collect at the counter with no membership to bill);
   *   a waived one was told it was cancelled, so it gets a new notice and 7 days again.
   * - counter: paid at the counter.
   * - amount: a new amount; the member gets a new notice and 7 days again (it can't be charged now until that notice
   *   has gone).
   * A charge being paid right now (on a bill, or being taken now) can't change. Returns { charge }.
   */
  async updateDamageCharge(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const f = this.feeRow(trimmed(id, 40));
    if (!f) throw new RuleError(MEMBERSHIP_MESSAGES.feeNone, 404);
    const action = String(input?.action ?? '').trim().toLowerCase();
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const note = trimmed(input?.note, 300) || null;
    if (!['waive', 'hold', 'reinstate', 'counter', 'amount'].includes(action)) throw new RuleError(MEMBERSHIP_MESSAGES.feeAction);
    if (['billing', 'charging'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeLocked, 409);
    // a notice to send after this (a new amount, or back on after it was waived): { was } or { again }
    let notice = null;
    if (action === 'waive') {
      if (!['notice', 'due', 'disputed', 'unpaid'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      // (they're told there's nothing to pay, so its notice no longer counts: put back on, it gets a new one)
      this.write(
        "UPDATE damage_charges SET status = 'waived', charge_id = NULL, emailed_at = NULL, resolved_at = ?, resolved_by = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
        now, by, note, now, f.id,
      );
      this.tellWaived(this.feeRow(f.id), rules);
    } else if (action === 'hold') {
      if (!['notice', 'due'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      this.write("UPDATE damage_charges SET status = 'disputed', dispute_note = COALESCE(dispute_note, ?), note = COALESCE(?, note), updated_at = ? WHERE id = ?", 'On hold (staff)', note, now, f.id);
    } else if (action === 'counter') {
      if (!['notice', 'due', 'disputed', 'unpaid'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      this.write("UPDATE damage_charges SET status = 'paid', paid_via = 'counter', resolved_at = ?, resolved_by = ?, note = ?, updated_at = ? WHERE id = ?", now, by, note || 'Paid at the counter', now, f.id);
    } else if (action === 'reinstate') {
      if (!['waived', 'disputed', 'unpaid'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      if (f.status === 'waived') {
        // They were told it was cancelled, so it's a new notice, with 7 days again
        this.write(
          "UPDATE damage_charges SET status = 'notice', due_at = ?, emailed_at = NULL, resolved_at = NULL, resolved_by = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
          now + FEE_NOTICE_DAYS * DAY, note, now, f.id,
        );
        notice = { again: true };
      } else {
        const next = f.due_at > now ? 'notice' : this.billable(this.membershipRow(f.membership_id)) ? 'due' : 'unpaid';
        this.write('UPDATE damage_charges SET status = ?, resolved_at = NULL, resolved_by = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?', next, note, now, f.id);
      }
    } else {
      const amount = Number(input?.amount);
      if (!Number.isInteger(amount) || amount < FEE_MIN || amount > FEE_MAX) throw new RuleError(MEMBERSHIP_MESSAGES.feeAmount);
      if (!['notice', 'due', 'disputed'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      if (amount !== f.amount) {
        // A new amount is a new notice: the member hears it and gets 7 days again (and it can't be taken now until
        // that notice has gone)
        this.write(
          "UPDATE damage_charges SET amount = ?, status = 'notice', due_at = ?, dispute_note = NULL, emailed_at = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
          amount, now + FEE_NOTICE_DAYS * DAY, note, now, f.id,
        );
        notice = { was: f.amount };
      }
    }
    // the new notice, waited for (it only counts as emailed once the email service has it)
    if (notice) await this.sendDamageNotice(f.id, this.membershipRow(f.membership_id), rules, notice);
    return { charge: this.feeView(this.feeRow(f.id)) };
  },

  /**
   * POST /me/damage/:id/dispute { note }: the member thinks it's wrong. It waits (no bill) until staff sort it out,
   * and staff hear. Returns { charge }.
   */
  async disputeDamageCharge(id, input, who) {
    if (!who?.customerId) throw new RuleError(MEMBERSHIP_MESSAGES.login, 401);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const f = this.feeRow(trimmed(id, 40));
    if (!f) throw new RuleError(MEMBERSHIP_MESSAGES.feeNone, 404);
    if (f.customer_id !== String(who.customerId)) throw new RuleError(MEMBERSHIP_MESSAGES.feeNotYours, 403);
    if (!['notice', 'due'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeDispute, 409);
    const note = trimmed(input?.note, 500) || null;
    this.write("UPDATE damage_charges SET status = 'disputed', dispute_note = ?, updated_at = ? WHERE id = ?", note, now, f.id);
    const member = this.memberRow(f.customer_id);
    this.notifyStaff(`Damage charge disputed: ${member?.name || member?.first_name || member?.code || 'a member'}, ${f.title}`, {
      title: 'A damage charge to sort out',
      intro: `${member?.name || 'A member'} doesn't think the ${money(f.amount)} charge for ${f.title} is right. It won't go on a bill until you've sorted it out on the staff page (waive it, change it, or put it back on).`,
      details: [['Game', f.title], ['What we said', `${FEE_REASONS[f.reason] || f.reason}${f.details ? `: ${f.details}` : ''}`], ['Charge', money(f.amount)], ['They said', note || '(nothing)'], ['Member code', member?.code || '']],
    });
    return { charge: this.feeView(this.feeRow(f.id)) };
  },

  /* ---------------- damage charges taken now: store credit or the saved card ---------------- */
  // Once a damage charge's notice has been emailed, staff can take it straight away instead of waiting for the next bill
  // (Mo, 9 Oct 2026). Store credit comes off through the Lair's own app. A card can only be charged by Lair Memberships
  // billing a subscription contract, so the charge gets a one-off contract of its own on the member's saved card,
  // billed once (its idempotency key is the payment's), then cancelled. Neither way is ever done twice: the payment is
  // claimed (its row written, the charge 'charging') before Shopify is asked, store credit whose answer was lost is
  // looked for in the account before anything else happens, and a contract or bill whose answer was lost is found by
  // its marker or key rather than made again. A charge that couldn't be taken goes back to where it was: its notice,
  // the next bill, or the counter.

  damagePaymentRow(id) {
    return id ? this.sql.exec('SELECT * FROM damage_payments WHERE id = ?', String(id)).toArray()[0] || null : null;
  },

  /** A damage charge's payment in flight, or null */
  openDamagePayment(feeId) {
    return this.sql.exec(`SELECT * FROM damage_payments WHERE fee_id = ? AND status IN ${PAYING} ORDER BY created_at DESC LIMIT 1`, String(feeId)).toArray()[0] || null;
  },

  /** A damage charge's latest try at taking it now, or null */
  latestDamagePayment(feeId) {
    return this.sql.exec('SELECT * FROM damage_payments WHERE fee_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', String(feeId)).toArray()[0] || null;
  },

  damagePaymentView(p) {
    if (!p) return null;
    return {
      id: p.id, method: p.method, status: p.status, amount: p.amount, at: p.created_at, completedAt: p.completed_at || null,
      card: p.method === 'card' ? cardWords(parse(p.card, null)) : null, balanceAfter: p.method === 'credit' ? p.balance_after ?? null : null,
      error: p.status === 'failed' ? p.error_code || null : null,
    };
  },

  /** A member's store credit balance (cents), or null when Shopify won't say */
  async creditBalanceOrNull(customerId) {
    if (!this.shopify?.configured) return null;
    try {
      return await this.shopify.storeCreditBalance(customerId, this.env?.CURRENCY || 'NZD');
    } catch (error) {
      console.error('Lair: could not read a store credit balance', error);
      return null;
    }
  },

  /**
   * The card a damage charge can go on now: the member's current membership's, else that of their latest membership
   * with one. { membershipId, paymentMethodId, card, currency } or null. No awaits.
   */
  savedCardFor(customerId, now = Date.now()) {
    const current = this.currentMembership(customerId, now);
    const m = current?.payment_method_id ? current : this.membershipRows(customerId).find((r) => r.payment_method_id) || null;
    return m ? { membershipId: m.id, paymentMethodId: m.payment_method_id, card: parse(m.card, null), currency: m.currency || this.env?.CURRENCY || 'NZD' } : null;
  },

  /** Can this damage charge be taken now? Throws (404, 409) with why not. No awaits. */
  checkChargeNow(f) {
    if (!f) throw new RuleError(MEMBERSHIP_MESSAGES.feeNone, 404);
    if (['billing', 'charging'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeLocked, 409);
    if (f.status === 'paid') throw new RuleError(MEMBERSHIP_MESSAGES.feePaid, 409);
    if (f.status === 'waived') throw new RuleError(MEMBERSHIP_MESSAGES.feeWaived, 409);
    if (f.status === 'disputed') throw new RuleError(MEMBERSHIP_MESSAGES.feeOnHold, 409);
    if (!CHARGEABLE_NOW.includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
    if (!f.emailed_at) throw new RuleError(MEMBERSHIP_MESSAGES.feeNotEmailed, 409);
  },

  /**
   * Why the member's card can't be charged now, or null when it can. A card their bank flagged as fraud isn't tried
   * again until it's updated (as with renewals). No awaits.
   */
  savedCardProblem(customerId) {
    if (!this.membershipBillingOn()) return MEMBERSHIP_MESSAGES.cardsOff;
    const card = this.savedCardFor(customerId);
    if (!card) return MEMBERSHIP_MESSAGES.noCardSaved(this.memberName(customerId));
    const m = this.membershipRow(card.membershipId);
    const lastBill = this.sql.exec("SELECT error_code FROM membership_charges WHERE membership_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", m.id).toArray()[0];
    const lastNow = this.sql.exec(
      "SELECT error_code, payment_method_id FROM damage_payments WHERE customer_id = ? AND method = 'card' AND status IN ('failed', 'paid') ORDER BY created_at DESC LIMIT 1", String(customerId),
    ).toArray()[0];
    const flagged = (m.status === 'past_due' && m.retry_at == null && /FRAUD/.test(lastBill?.error_code || ''))
      || (lastNow && /FRAUD/.test(lastNow.error_code || '') && lastNow.payment_method_id === card.paymentMethodId);
    if (flagged) return MEMBERSHIP_MESSAGES.cardFlagged(this.memberName(customerId));
    if (!this.membershipsAdmin().configured) return MEMBERSHIP_MESSAGES.membershipsOff;
    if (!this.feeVariantId()) return MEMBERSHIP_MESSAGES.noFeeProduct;
    return null;
  },

  /**
   * How to take a damage charge now: 'credit' or 'card'. use 'credit' or 'card' is that, if it can be used; 'auto' is
   * store credit when the balance covers it, else the card, else store credit when the balance can't be read (Shopify
   * says if it's short). Throws (409, 503) when there's no way. No awaits.
   */
  payNowMethod(f, use, balance) {
    const name = this.memberName(f.customer_id);
    const creditOn = Boolean(this.shopify?.configured);
    if (use === 'card') {
      const problem = this.savedCardProblem(f.customer_id);
      if (problem) throw new RuleError(problem, 409);
      return 'card';
    }
    if (use === 'credit') {
      if (!creditOn) throw new RuleError(MEMBERSHIP_MESSAGES.creditOff, 503);
      if (balance != null && balance < f.amount) throw new RuleError(MEMBERSHIP_MESSAGES.creditShort(name, f.amount, balance), 409);
      return 'credit';
    }
    if (creditOn && balance != null && balance >= f.amount) return 'credit';
    if (!this.savedCardProblem(f.customer_id)) return 'card';
    if (creditOn && balance == null) return 'credit';
    throw new RuleError(MEMBERSHIP_MESSAGES.noWayNow(name), 409);
  },

  /**
   * POST /library/damage/:id/charge { use: 'auto' | 'credit' | 'card' } (staff, money): take a damage charge now, once
   * its notice has been emailed, from the member's store credit or their saved card (auto, the default: store credit
   * when it covers the charge, else the card). Not one on a bill being paid, on hold or disputed. Store credit is taken
   * there and then; a card payment is with Shopify when this answers ('pending'), and the charge shows how it went.
   * Returns { charge, payment, message }.
   */
  async chargeDamageNow(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    const use = String(input?.use ?? 'auto').trim().toLowerCase() || 'auto';
    if (!['auto', 'credit', 'card'].includes(use)) throw new RuleError(MEMBERSHIP_MESSAGES.feeUse);
    const before = this.feeRow(trimmed(id, 40));
    this.checkChargeNow(before);
    const balance = use === 'card' ? null : await this.creditBalanceOrNull(before.customer_id);
    // --- no awaits until the claim (payDamageNow checks the charge again first) ---
    const method = this.payNowMethod(this.feeRow(before.id) || before, use, balance);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    const done = await this.payDamageNow(before.id, method, { by, rules, orCard: use === 'auto' });
    return { charge: this.feeView(this.feeRow(before.id)), payment: this.damagePaymentView(done.payment), message: done.message };
  },

  /**
   * Take a damage charge now. It's claimed first (no awaits until then): its payment row, and the charge 'charging'.
   * Store credit then comes off (Shopify saying no leaves the charge as it was; a lost answer is looked for in the
   * account by the next run), or the card's one-off contract is made and billed (sendDamagePayment). told: the member's
   * notice said it would be taken now. orCard: store credit Shopify says is short goes on the card instead, when it can.
   * Returns { payment, message } (message: for staff), or throws (409) when Shopify said no there and then.
   */
  async payDamageNow(feeId, method, { by = 'staff', told = false, rules, orCard = false } = {}) {
    const f = this.feeRow(feeId);
    this.checkChargeNow(f);
    const name = this.memberName(f.customer_id);
    if (method === 'card') {
      const problem = this.savedCardProblem(f.customer_id);
      if (problem) throw new RuleError(problem, 409);
      const card = this.savedCardFor(f.customer_id);
      const p = this.claimDamagePayment(f, 'card', { card, by, told });
      await this.sendDamagePayment(p.id);
      // --- no awaits from here on ---
      const fresh = this.damagePaymentRow(p.id);
      const on = cardWords(card.card);
      if (fresh.status === 'failed') throw new RuleError(`Shopify wouldn't charge ${on} (${fresh.error_message || fresh.error_code}). Nothing was charged.`, 409);
      if (fresh.status === 'void') throw new RuleError(`The charge didn't go to Shopify (${fresh.void_reason}). Nothing was charged.`, 409);
      return {
        payment: fresh,
        message: fresh.status === 'paid' ? `Paid: ${money(f.amount)} went on ${on}.`
          : fresh.status === 'claimed' ? `Shopify didn't answer, so the Lair keeps trying to charge ${on} (it shows here within 15 minutes).`
            : fresh.status === 'challenged' ? `${name}'s bank wants them to confirm the payment. It shows here once they have.`
              : `Charging ${money(f.amount)} to ${on}. It shows here once Shopify says how it went.`,
      };
    }
    if (!this.shopify?.configured) throw new RuleError(MEMBERSHIP_MESSAGES.creditOff, 503);
    const p = this.claimDamagePayment(f, 'credit', { by, told });
    let done;
    try {
      done = await this.shopify.changeStoreCredit(f.customer_id, -f.amount, p.currency || 'NZD');
    } catch (error) {
      // --- no awaits from here on (unless the card is used instead) ---
      const fresh = this.damagePaymentRow(p.id);
      if (!error?.refused) {
        // it may or may not have come off: the next run looks in the account, so it's never taken twice
        console.error('Lair: store credit for a damage charge had no answer', error);
        this.write("UPDATE damage_payments SET status = 'checking', error_message = ?, updated_at = ? WHERE id = ? AND status = 'claimed'", String(error?.message || error).slice(0, 300), Date.now(), p.id);
        return { payment: this.damagePaymentRow(p.id), message: "Shopify didn't answer, so the Lair is checking whether the store credit came off. It shows here within 10 minutes." };
      }
      const short = error.code === 'INSUFFICIENT_FUNDS';
      const toCard = short && orCard && !this.savedCardProblem(f.customer_id);
      this.damagePaymentFailed(fresh, { code: error.code || 'REFUSED', message: error.message, refused: true }, rules, { quiet: toCard, inRequest: true });
      if (toCard) return this.payDamageNow(feeId, 'card', { by, told, rules });
      throw new RuleError(short ? MEMBERSHIP_MESSAGES.creditShort(name, f.amount, null)
        : `Shopify wouldn't take the store credit (${String(error.message || error.code).slice(0, 160)}). Nothing came off.`, 409);
    }
    // --- no awaits from here on ---
    const fresh = this.damagePaymentRow(p.id);
    if (fresh.status === 'paid') {
      // (an answer slow enough for the next run to have found it in the account already: just its transaction)
      this.write('UPDATE damage_payments SET transaction_id = COALESCE(transaction_id, ?), balance_after = COALESCE(balance_after, ?) WHERE id = ?', done.id || null, done.balanceAfter ?? null, p.id);
    } else this.damagePaymentPaid(fresh, { transactionId: done.id, balanceAfter: done.balanceAfter }, rules);
    return { payment: this.damagePaymentRow(p.id), message: `Paid: ${money(f.amount)} came off ${name}'s store credit.` };
  },

  /** Claim a damage charge to take now: its payment row ('claimed') and the charge 'charging'. No awaits. */
  claimDamagePayment(f, method, { card = null, by = 'staff', told = false } = {}) {
    const now = Date.now();
    const id = makeId('dp');
    this.write(
      `INSERT INTO damage_payments (id, fee_id, customer_id, method, amount, currency, status, fee_was, told, idempotency_key, membership_id, payment_method_id,
         card, by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, f.id, f.customer_id, method, f.amount, card?.currency || this.env?.CURRENCY || 'NZD', f.status, told ? 1 : 0, payNowKey(id), card?.membershipId || null,
      card?.paymentMethodId || null, card?.card ? JSON.stringify(card.card) : null, by, now, now,
    );
    this.write("UPDATE damage_charges SET status = 'charging', payment_id = ?, updated_at = ? WHERE id = ?", id, now, f.id);
    return this.damagePaymentRow(id);
  },

  /**
   * Where a damage charge goes back to when taking it now didn't work: still in its notice, the notice; else the next
   * bill, or the counter when there's no membership to bill (one that was for the counter stays there). No awaits.
   */
  feeRouteBack(f, was, now) {
    if (was === 'unpaid') return 'unpaid';
    if (was === 'notice' && f.due_at > now) return 'notice';
    return this.billable(this.membershipRow(f.membership_id)) ? 'due' : 'unpaid';
  },

  /** A payment that didn't happen: its damage charge goes back (feeRouteBack). Returns where it went, or null. No awaits. */
  feeBackFromPayment(p, now) {
    const f = this.feeRow(p.fee_id);
    if (!f || f.status !== 'charging' || f.payment_id !== p.id) return null;
    const to = this.feeRouteBack(f, p.fee_was, now);
    this.write("UPDATE damage_charges SET status = ?, payment_id = NULL, updated_at = ? WHERE id = ? AND status = 'charging' AND payment_id = ?", to, now, f.id, p.id);
    if (to === 'unpaid' && p.fee_was !== 'unpaid') this.feeToCounter(f, now);
    return to;
  },

  /** Whether a claimed card payment should still go to Shopify: why not ('billing-off', 'fee-changed', 'too-late'), or null. No awaits. */
  damagePaymentUnwanted(p, now) {
    if (p.method === 'card' && !this.membershipBillingOn()) return 'billing-off';
    const f = this.feeRow(p.fee_id);
    if (!f || f.status !== 'charging' || f.payment_id !== p.id) return 'fee-changed';
    if (now - p.created_at > LATE_GRACE) return 'too-late';
    return null;
  },

  /**
   * Drop a payment Shopify never got: void, and its damage charge goes back. Staff hear why, and so does the member
   * when their notice said it would be taken now. No awaits.
   */
  voidDamagePayment(pid, reason) {
    const now = Date.now();
    const p = this.damagePaymentRow(pid);
    if (!p || p.status !== 'claimed') return { payment: pid, already: p?.status || null };
    this.write("UPDATE damage_payments SET status = 'void', void_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?", reason, now, now, pid);
    const to = this.feeBackFromPayment(p, now);
    if (to) {
      const f = this.feeRow(p.fee_id);
      const name = this.memberName(p.customer_id);
      const why = reason === 'too-late' ? `The Lair couldn't get it to Shopify for 2 days, so it has stopped trying.`
        : reason === 'billing-off' ? 'Library billing was switched off before it reached Shopify.'
          : `It didn't reach Shopify (${reason}).`;
      this.staffAlert(`pay-dropped:${p.id}`, `A damage charge couldn't be taken: ${name}`, {
        title: "A card charge that didn't go",
        intro: `${name}'s ${money(p.amount)} charge for ${f.title} wasn't taken from ${cardWords(parse(p.card, null))}. ${why} Nothing was charged. ${this.feeRouteWords(f, to, null, { staff: true })}${p.told ? ' They have been told.' : ''}`,
        details: [['Charge', money(p.amount)], ['Card', cardWords(parse(p.card, null))]],
      }, now);
      if (p.told) this.tellDamageNotTaken(f, p, { code: 'NOT_SENT', theirs: false, to }, this.rulesCache || null);
    }
    return { payment: pid, void: reason, fee: to };
  },

  /**
   * Take a card payment to Shopify, never twice: the one-off contract is made (or, when an earlier try may have made
   * it, found by its marker first), then billed once with the payment's key (or, when an earlier bill's answer was
   * lost, looked up by its key first). A payment no longer wanted is dropped before it's billed; Shopify saying no
   * fails it (the charge goes back); Shopify not answering leaves it for the next run. Returns what happened.
   */
  async sendDamagePayment(pid, admin = this.membershipsAdmin()) {
    const rules = await this.rules();
    let p = this.damagePaymentRow(pid);
    if (!p || p.status !== 'claimed' || p.method !== 'card') return { payment: pid, already: p?.status || null };
    const waiting = () => {
      this.write('UPDATE damage_payments SET updated_at = ? WHERE id = ?', Date.now(), pid);
      return { payment: pid, waiting: true };
    };
    const already = (row) => ({ payment: pid, already: row?.status || null });
    if (!p.contract_gid && p.contract_sent_at) {
      // an earlier try may have made the contract: look for it before making another
      let found;
      try {
        found = await admin.findChargeContract(p.customer_id, p.id);
      } catch (error) {
        console.error('Lair: could not look for a charge contract', error);
        return waiting();
      }
      // --- no awaits until the contract is made ---
      p = this.damagePaymentRow(pid);
      if (found && p && !p.contract_gid) this.write('UPDATE damage_payments SET contract_gid = ?, updated_at = ? WHERE id = ?', found.id, Date.now(), pid);
      if (!p || p.status !== 'claimed') return already(p);
      p = this.damagePaymentRow(pid);
      if (!p.contract_gid && Date.now() - p.contract_sent_at < CONTRACT_LOOK_AFTER) return waiting();
    }
    if (!p.contract_gid) {
      const unwanted = this.damagePaymentUnwanted(p, Date.now());
      if (unwanted) return this.voidDamagePayment(pid, unwanted);
      const f = this.feeRow(p.fee_id);
      const sentAt = Date.now();
      this.write('UPDATE damage_payments SET contract_sent_at = ?, updated_at = ? WHERE id = ?', sentAt, sentAt, pid);
      let made;
      try {
        made = await admin.createChargeContract({
          customerId: p.customer_id, paymentMethodId: p.payment_method_id, currency: p.currency || 'NZD', feeVariantId: this.feeVariantId(), paymentId: p.id,
          fee: { id: f.id, amount: p.amount, label: feeLabel(f) }, billAt: sentAt + HOUR,
        });
      } catch (error) {
        // it may or may not have been made: it's looked for before another is
        console.error('Lair: could not make a charge contract', error);
        return { payment: pid, waiting: true };
      }
      // --- no awaits until the bill ---
      p = this.damagePaymentRow(pid);
      // (the contract is kept whatever happened meanwhile, so it's closed once the payment is done)
      if (made.contractId && p && !p.contract_gid) this.write('UPDATE damage_payments SET contract_gid = ?, updated_at = ? WHERE id = ?', made.contractId, Date.now(), pid);
      if (!p || p.status !== 'claimed') return already(p);
      if (!made.contractId) return this.damagePaymentRefused(p, made.errors, rules);
      p = this.damagePaymentRow(pid);
    }
    if (p.sent_at) {
      // an earlier bill may have reached Shopify: look it up by its key before anything else
      let found;
      try {
        found = await admin.findAttempt(p.contract_gid, p.idempotency_key);
      } catch (error) {
        console.error('Lair: could not look up a damage charge payment', error);
        return waiting();
      }
      // --- no awaits from here on (if it's found) ---
      p = this.damagePaymentRow(pid);
      if (found && p && !p.attempt_gid) this.write('UPDATE damage_payments SET attempt_gid = ? WHERE id = ?', found.id, pid);
      if (!p || p.status !== 'claimed') return already(p);
      if (found) {
        this.write("UPDATE damage_payments SET status = 'pending', attempt_gid = ?, updated_at = ? WHERE id = ?", found.id, Date.now(), pid);
        if (found.state === 'pending') return { payment: pid, status: 'pending', found: true };
        return { ...this.damagePaymentOutcome(pid, found, rules), found: true };
      }
    }
    const unwanted = this.damagePaymentUnwanted(p, Date.now());
    if (unwanted) return this.voidDamagePayment(pid, unwanted);
    const sentAt = Date.now();
    this.write('UPDATE damage_payments SET sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?', sentAt, sentAt, pid);
    let result;
    try {
      result = await admin.bill({ contractId: p.contract_gid, cycle: 1, key: p.idempotency_key });
    } catch (error) {
      // it may or may not have reached Shopify: the next run looks it up by its key first
      console.error('Lair: could not bill a damage charge', error);
      return { payment: pid, waiting: true };
    }
    // --- no awaits from here on ---
    const fresh = this.damagePaymentRow(pid);
    // a webhook can get here first: the attempt id is kept whatever it did
    if (result.attemptId && fresh && !fresh.attempt_gid) this.write('UPDATE damage_payments SET attempt_gid = ? WHERE id = ?', result.attemptId, pid);
    if (!fresh || fresh.status !== 'claimed') return already(fresh);
    if (result.attemptId) {
      this.write("UPDATE damage_payments SET status = 'pending', attempt_gid = ?, updated_at = ? WHERE id = ?", result.attemptId, Date.now(), pid);
      return { payment: pid, status: 'pending' };
    }
    return this.damagePaymentRefused(fresh, result.errors, rules);
  },

  /** Shopify said no to the contract or the bill (nothing was charged): busy, it's tried again by the next run; else it fails. No awaits. */
  damagePaymentRefused(p, errors, rules) {
    const codes = errors.map((e) => e.code).filter(Boolean);
    if (codes.includes('THROTTLED')) {
      this.write('UPDATE damage_payments SET updated_at = ? WHERE id = ?', Date.now(), p.id);
      return { payment: p.id, waiting: true };
    }
    return { ...this.damagePaymentFailed(p, { code: codes[0] || 'REFUSED', message: errorWords(errors), refused: true }, rules), refused: true };
  },

  /**
   * How a card payment went, from its webhook or from asking Shopify: paid, failed, or waiting on a bank check (the
   * member hears). One already paid stays paid; one the Lair stopped waiting on still takes a late success. No awaits.
   */
  damagePaymentOutcome(pid, outcome, rules) {
    const p = this.damagePaymentRow(pid);
    if (!p) return { payment: pid, missing: true };
    if (p.status === 'paid' || (['failed', 'void'].includes(p.status) && outcome.state !== 'paid')) return { payment: pid, already: p.status };
    if (outcome.state === 'pending') return { payment: pid, status: p.status };
    if (outcome.state === 'action') {
      if (p.status === 'challenged') return { payment: pid, status: 'challenged' };
      this.write("UPDATE damage_payments SET status = 'challenged', next_action_url = COALESCE(?, next_action_url), updated_at = ? WHERE id = ?", outcome.nextActionUrl || null, Date.now(), pid);
      this.tellDamageBankCheck(this.feeRow(p.fee_id), this.damagePaymentRow(pid), rules);
      return { payment: pid, status: 'challenged' };
    }
    if (outcome.state === 'paid') return this.damagePaymentPaid(p, outcome, rules);
    return this.damagePaymentFailed(p, outcome, rules);
  },

  /**
   * A payment went through: its damage charge is paid (paid_via 'card' or 'credit') and the member gets a receipt. One
   * that comes in after the Lair stopped waiting on it still pays the charge; if something else paid it too (a bill,
   * the counter, another payment) or it was waived, staff hear to refund one. No awaits.
   */
  damagePaymentPaid(p, outcome, rules) {
    const now = Date.now();
    this.write(
      `UPDATE damage_payments SET status = 'paid', order_id = COALESCE(?, order_id), transaction_id = COALESCE(?, transaction_id), balance_after = COALESCE(?, balance_after),
         error_code = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
      outcome.orderId || null, outcome.transactionId || null, outcome.balanceAfter ?? null, now, now, p.id,
    );
    const f = this.feeRow(p.fee_id);
    const name = this.memberName(p.customer_id);
    const paidWith = p.method === 'card' ? `on their card (order ${numericId(outcome.orderId || '') || 'in Shopify'})` : 'from their store credit';
    const refund = p.method === 'card' ? 'Refund one of them in Shopify.' : 'Refund one: add the store credit back on their member page.';
    if (!f || (f.status === 'paid' && f.payment_id === p.id && f.paid_via === p.method)) return { payment: p.id, status: 'paid' };
    if (['paid', 'waived'].includes(f.status)) {
      this.staffAlert(`pay-twice:${p.id}`, `A damage charge was paid twice: ${name}`, {
        title: f.status === 'waived' ? 'A waived charge was paid' : 'Paid twice',
        intro: `${name}'s ${money(p.amount)} charge for ${f.title} was ${f.status === 'waived' ? 'waived' : `paid already (${f.paid_via || 'another way'})`}, and a payment ${paidWith} has just gone through too. ${refund}`,
        details: [['Game', f.title], ['Charge', money(p.amount)], ['Order', outcome.orderId || '']],
      }, now);
      return { payment: p.id, status: 'paid', double: true };
    }
    const mine = f.status === 'charging' && f.payment_id === p.id;
    this.write("UPDATE damage_charges SET status = 'paid', payment_id = ?, paid_via = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?", p.id, p.method, now, p.by || null, now, f.id);
    this.tellDamagePaid(this.feeRow(f.id), this.damagePaymentRow(p.id), rules);
    if (!mine) {
      // a late success: the charge had gone back (or was being paid another way)
      const twice = ['billing', 'charging'].includes(f.status);
      this.staffAlert(`pay-late:${p.id}`, twice ? `A damage charge may be paid twice: ${name}` : `A late payment paid a damage charge: ${name}`, {
        title: twice ? 'Maybe paid twice' : 'A late payment',
        intro: twice
          ? `${name}'s ${money(p.amount)} charge for ${f.title} has just been paid ${paidWith}, while it was also ${f.status === 'billing' ? 'on a library bill being paid' : 'being taken another way'}. If that goes through too, ${refund.charAt(0).toLowerCase()}${refund.slice(1)}`
          : `${name}'s ${money(p.amount)} charge for ${f.title} was paid ${paidWith} after the Lair had stopped waiting on it, so it's paid now${f.status === 'disputed' ? ". They'd disputed it meanwhile: check, and refund it if it's wrong" : ''}.`,
        details: [['Game', f.title], ['Charge', money(p.amount)], ['Was', f.status]],
      }, now);
    }
    return { payment: p.id, status: 'paid', late: !mine };
  },

  /**
   * A payment didn't happen (Shopify said no, the card was declined, the bank check was never done, or store credit
   * never came off): its damage charge goes back to where it was. The member hears when it's their card's doing, or
   * when their notice said it would be taken now; staff hear unless they're looking at the answer (inRequest). quiet:
   * neither (store credit was short, so the card is being used instead). No awaits.
   */
  damagePaymentFailed(p, outcome, rules, { quiet = false, inRequest = false } = {}) {
    const now = Date.now();
    const code = String(outcome.code || 'UNEXPECTED_ERROR').toUpperCase();
    this.write(
      "UPDATE damage_payments SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      code, trimmed(outcome.message, 300) || null, now, now, p.id,
    );
    const to = this.feeBackFromPayment(p, now);
    if (!to || quiet) return { payment: p.id, status: 'failed', fee: to };
    const f = this.feeRow(p.fee_id);
    // the card's own doing (declined, expired, the bank check never done) rather than the store's or Shopify's
    const theirs = p.method === 'card' && !outcome.refused && !NOT_THE_CARD.has(code);
    if (theirs || p.told) this.tellDamageNotTaken(f, p, { code, theirs, to }, rules);
    if (!inRequest) {
      const name = this.memberName(p.customer_id);
      this.staffAlert(`pay-failed:${f.id}`, `A damage charge couldn't be taken now: ${name}`, {
        title: "A charge that couldn't be taken",
        intro: `${name}'s ${money(p.amount)} charge for ${f.title} couldn't be taken ${p.method === 'card' ? `from ${cardWords(parse(p.card, null))}` : 'from their store credit'} (${code}). Nothing was charged. ${this.feeRouteWords(f, to, null, { staff: true })}${theirs || p.told ? ' They have been told.' : ''}`,
        details: [['Game', f.title], ['Charge', money(p.amount)], ['Error', [code, outcome.message].filter(Boolean).join(': ').slice(0, 200)]],
      }, now);
    }
    return { payment: p.id, status: 'failed', fee: to };
  },

  /**
   * A billing attempt webhook for a damage charge taken now: { state } from the topic (a failure with no error code is
   * read from Shopify, and if it can't say, this throws so Shopify sends it again), then damagePaymentOutcome.
   */
  async damagePaymentWebhook(p, payload, topic) {
    let outcome = topic.endsWith('/success') ? { state: 'paid', orderId: payload.admin_graphql_api_order_id || null }
      : topic.endsWith('/failure') ? { state: 'failed', code: payload.error_code ? String(payload.error_code).toUpperCase() : null, message: payload.error_message || null }
        : { state: 'action', nextActionUrl: null };
    if (outcome.state === 'failed' && !outcome.code && p.contract_gid) {
      const found = await this.membershipsAdmin().findAttempt(p.contract_gid, p.idempotency_key);
      outcome = { ...outcome, code: found?.state === 'failed' ? found.code : 'UNEXPECTED_ERROR' };
    }
    const rules = await this.rules();
    // --- no awaits from here on ---
    if (payload.admin_graphql_api_id) this.write('UPDATE damage_payments SET attempt_gid = COALESCE(attempt_gid, ?) WHERE id = ?', String(payload.admin_graphql_api_id), p.id);
    return { damagePayment: p.id, ...this.damagePaymentOutcome(p.id, outcome, rules) };
  },

  /**
   * Damage charges taken now that need following up (part of the 10-minute run): card payments a run never finished
   * (or whose answer was lost) taken up again; store credit whose answer was lost looked for in the account (found:
   * paid; not there after 10 minutes: it didn't come off; Shopify can't say for an hour: staff are asked to look and
   * settle it); card payments Shopify hasn't answered asked about after 30 minutes (a bank check every 2 hours, given
   * up after 7 days); and the one-off contracts of payments that are done cancelled in Shopify. Returns the payment ids
   * looked at.
   */
  async reconcileDamagePayments(rules, now, { cards = true } = {}) {
    const admin = this.membershipsAdmin();
    const looked = [];
    const stale = cards ? this.sql.exec(
      "SELECT id FROM damage_payments WHERE method = 'card' AND status = 'claimed' AND updated_at < ? ORDER BY updated_at LIMIT ?", now - CLAIM_STALE, CHECKS_A_RUN,
    ).toArray() : [];
    for (const { id } of stale) {
      looked.push(id);
      await this.sendDamagePayment(id, admin);
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.damagePaymentRow(id);
      if (fresh?.status === 'claimed' && at - fresh.created_at > STUCK_ALERT_AFTER) {
        const name = this.memberName(fresh.customer_id);
        this.staffAlert(`pay-stuck:${fresh.id}`, `A damage charge is stuck: ${name}`, {
          title: "A card charge that hasn't gone",
          intro: `The Lair has been trying to charge ${name}'s card ${money(fresh.amount)} for a damage charge for over 2 hours, and Shopify isn't answering. It keeps trying, and stops (charging nothing) after 2 days.`,
          details: [['Charge', money(fresh.amount)], ['Started', new Date(fresh.created_at).toISOString().slice(0, 16).replace('T', ' ')]],
        }, at);
      }
    }
    const unsure = this.sql.exec(
      `SELECT * FROM damage_payments WHERE method = 'credit' AND ((status = 'checking' AND updated_at < ?) OR (status = 'claimed' AND updated_at < ?))
       ORDER BY updated_at LIMIT ?`,
      now - CREDIT_CHECK_AFTER, now - CLAIM_STALE, CHECKS_A_RUN,
    ).toArray();
    for (const p of unsure) {
      looked.push(p.id);
      let debits = null;
      try {
        debits = this.shopify?.configured ? await this.shopify.storeCreditDebits(p.customer_id, p.currency || 'NZD') : null;
      } catch (error) {
        console.error('Lair: could not read store credit debits', error);
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.damagePaymentRow(p.id);
      if (!fresh || !['checking', 'claimed'].includes(fresh.status)) continue;
      this.write("UPDATE damage_payments SET status = 'checking', updated_at = ? WHERE id = ?", at, p.id);
      // Someone else's take-off of the same amount from the same account could be the debit found: one still waiting
      // on its answer (it records its own debit, so this waits), or one staff settled by hand (its debit has no id
      // here, so a match can't be told apart: staff are asked)
      const twins = this.sql.exec(
        `SELECT status FROM damage_payments WHERE method = 'credit' AND customer_id = ? AND amount = ? AND id != ?
           AND (status = 'claimed' OR (status = 'paid' AND transaction_id IS NULL AND created_at BETWEEN ? AND ?))`,
        fresh.customer_id, fresh.amount, fresh.id, fresh.created_at - CLAIM_STALE, fresh.created_at + CLAIM_STALE,
      ).toArray();
      let unsureWhose = false;
      if (debits) {
        // a debit of this amount, taken by an app (not spent on an order) while this was with Shopify, that isn't
        // anything else the Lair took
        const known = new Set([
          ...this.sql.exec('SELECT transaction_id AS id FROM damage_payments WHERE transaction_id IS NOT NULL').toArray(),
          ...this.sql.exec('SELECT transaction_id AS id FROM member_credit WHERE transaction_id IS NOT NULL').toArray(),
        ].map((r) => r.id));
        const match = debits.filter((d) => d.id && !d.fromOrder && d.amount === fresh.amount && !known.has(d.id)
          && d.createdAt >= fresh.created_at - 2 * MIN && d.createdAt <= fresh.created_at + CLAIM_STALE)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (match && twins.some((t) => t.status === 'claimed')) continue;
        if (match && twins.length) unsureWhose = true;
        else if (match) {
          this.damagePaymentPaid(this.damagePaymentRow(p.id), { transactionId: match.id, balanceAfter: match.balanceAfter }, rules);
          continue;
        } else {
          if (at - fresh.created_at >= CREDIT_GONE_AFTER) this.damagePaymentFailed(this.damagePaymentRow(p.id), { code: 'NOT_TAKEN', message: 'Shopify has no record of it coming off.' }, rules);
          continue;
        }
      }
      if (at - fresh.created_at >= CREDIT_ASK_AFTER) {
        const f = this.feeRow(fresh.fee_id);
        const name = this.memberName(fresh.customer_id);
        this.staffAlert(`credit-check:${fresh.id}`, `Check a store credit payment: ${name}`, {
          title: 'Did the store credit come off?',
          intro: `The Lair asked Shopify to take ${money(fresh.amount)} of ${name}'s store credit for ${f?.title || 'a damage charge'}, but Shopify didn't answer, and ${unsureWhose ? `it can't tell whether the ${money(fresh.amount)} that came off around then was for this or for another charge of the same amount` : "it can't read their store credit to check"}. Look at their store credit in Shopify admin (Customers, then ${name}). On the staff page's Damage tab, say whether it came off for this charge.`,
          details: [['Charge', money(fresh.amount)], ['Asked', new Date(fresh.created_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC']],
        }, at);
      }
    }
    if (!cards) return looked;
    const waiting = this.sql.exec(
      `SELECT * FROM damage_payments WHERE method = 'card' AND ((status = 'pending' AND updated_at < ?) OR (status = 'challenged' AND updated_at < ?))
       ORDER BY updated_at LIMIT ?`,
      now - RECONCILE_AFTER, now - CHALLENGE_CHECK_EVERY, CHECKS_A_RUN,
    ).toArray();
    for (const p of waiting) {
      looked.push(p.id);
      let state;
      try {
        state = p.attempt_gid ? await admin.attempt(p.attempt_gid) : await admin.findAttempt(p.contract_gid, p.idempotency_key);
      } catch (error) {
        console.error('Lair: could not check a damage charge payment', error);
        continue;
      }
      // --- no awaits from here on (for this one, unless Shopify has no such attempt) ---
      const at = Date.now();
      const fresh = this.damagePaymentRow(p.id);
      if (!fresh || !['pending', 'challenged'].includes(fresh.status)) continue;
      if (state?.id && !fresh.attempt_gid) this.write('UPDATE damage_payments SET attempt_gid = ? WHERE id = ?', state.id, p.id);
      if (state?.state === 'paid' || state?.state === 'failed') {
        this.damagePaymentOutcome(p.id, state, rules);
        continue;
      }
      if (!state) {
        // Shopify has no attempt by that id: looked up by its key (and billed again with the same key if Shopify never got it)
        this.write("UPDATE damage_payments SET status = 'claimed', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?", at, at, p.id);
        await this.sendDamagePayment(p.id, admin);
        continue;
      }
      if (state.state === 'action' && fresh.status !== 'challenged') this.damagePaymentOutcome(p.id, state, rules);
      const row = this.damagePaymentRow(p.id);
      this.write('UPDATE damage_payments SET updated_at = ? WHERE id = ?', at, p.id);
      if (row.status === 'challenged' && at - row.created_at >= GIVE_UP_DAYS * DAY) {
        this.damagePaymentFailed(row, { code: 'AUTHENTICATION_REQUIRED', message: "The bank check wasn't done." }, rules);
      } else if (row.status === 'pending' && at - row.created_at > DAY) {
        const name = this.memberName(row.customer_id);
        this.staffAlert(`pay-pending:${row.id}`, `A damage charge payment has been processing for a day: ${name}`, {
          title: 'A payment still processing',
          intro: `Shopify has been processing ${name}'s ${money(row.amount)} damage charge payment for over a day. The Lair keeps checking it.`,
          details: [['Charge', money(row.amount)], ['Attempt', row.attempt_gid || '']],
        }, at);
      }
    }
    // one-off contracts done with are cancelled in Shopify (so they can never be billed again)
    const done = this.sql.exec(
      "SELECT * FROM damage_payments WHERE contract_gid IS NOT NULL AND closed_at IS NULL AND status IN ('paid', 'failed', 'void') ORDER BY updated_at LIMIT ?", CHECKS_A_RUN,
    ).toArray();
    for (const p of done) {
      looked.push(p.id);
      let result;
      try {
        result = await admin.endContract(p.contract_gid, 'cancel');
      } catch (error) {
        console.error('Lair: could not close a charge contract', error);
        // (to the back of the queue, so one Shopify won't close never holds up the rest)
        this.write('UPDATE damage_payments SET updated_at = ? WHERE id = ?', Date.now(), p.id);
        continue;
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      if (!result.errors.length || result.errors.some((e) => ['CONTRACT_TERMINATED', 'CONTRACT_NOT_FOUND'].includes(e.code))) {
        this.write('UPDATE damage_payments SET closed_at = ?, updated_at = ? WHERE id = ?', at, at, p.id);
        continue;
      }
      this.write('UPDATE damage_payments SET updated_at = ? WHERE id = ?', at, p.id);
      if (at - (p.completed_at || p.created_at) > DAY) {
        this.staffAlert(`pay-close:${p.id}`, "A one-off charge contract won't close", {
          title: "A contract Shopify won't cancel",
          intro: `The Lair made a one-off subscription contract to take a ${money(p.amount)} damage charge, and Shopify won't cancel it now it's done. Nothing more will be billed on it, but cancel it in Shopify (the customer's subscriptions) to tidy up.`,
          details: [['Contract', p.contract_gid], ['Shopify said', errorWords(result.errors)]],
        }, at);
      }
    }
    return looked;
  },

  /**
   * POST /library/damage/:id/settle { taken: true | false } (staff, money): store credit Shopify couldn't confirm
   * (staff looked in Shopify admin): taken, it's paid; not, it goes back to where it was. Returns { charge, payment }.
   */
  async settleDamagePayment(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const f = this.feeRow(trimmed(id, 40));
    if (!f) throw new RuleError(MEMBERSHIP_MESSAGES.feeNone, 404);
    const p = this.openDamagePayment(f.id);
    if (!p || p.method !== 'credit' || p.status !== 'checking') throw new RuleError(MEMBERSHIP_MESSAGES.settleNone, 409);
    if (typeof input?.taken !== 'boolean') throw new RuleError(MEMBERSHIP_MESSAGES.settleSay);
    // the Lair's own look in the account comes first
    if (Date.now() - p.created_at < CREDIT_GONE_AFTER) throw new RuleError(MEMBERSHIP_MESSAGES.settleWait, 409);
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    if (input.taken) {
      this.damagePaymentPaid(p, {}, rules);
      this.write('UPDATE damage_payments SET error_message = ? WHERE id = ?', `${by} checked: it came off.`, p.id);
    } else this.damagePaymentFailed(p, { code: 'NOT_TAKEN', message: `${by} checked: it didn't come off.` }, rules, { inRequest: true });
    return { charge: this.feeView(this.feeRow(f.id)), payment: this.damagePaymentView(this.damagePaymentRow(p.id)) };
  },

  /* ---------------- staff: memberships ---------------- */
  /** GET /memberships?status=current|past_due|ended|all&customerId= (staff): memberships with who they are. */
  async listMemberships(url, who) {
    this.requireStaff(who, ['library', 'members', 'money']);
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const status = ['current', 'past_due', 'ended', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'current';
    const customerId = trimmed(url.searchParams.get('customerId'), 40);
    const where = {
      current: "status IN ('active', 'past_due', 'cancelling', 'ending', 'paused')", past_due: "status = 'past_due'", ended: "status = 'ended'", all: '1 = 1',
    }[status];
    const rows = this.sql.exec(`SELECT * FROM memberships WHERE ${where}${customerId ? ' AND customer_id = ?' : ''} ORDER BY created_at DESC LIMIT 300`, ...(customerId ? [customerId] : [])).toArray();
    return {
      memberships: rows.map((m) => this.staffMembershipView(m, now)), billing: this.membershipBillingOn() ? 'on' : 'off',
      counts: Object.fromEntries(['active', 'past_due', 'cancelling'].map((s) => [s, this.sql.exec('SELECT COUNT(*) AS n FROM memberships WHERE status = ?', s).toArray()[0]?.n || 0])),
    };
  },

  /** POST /memberships/:id/cancel { when: 'end' | 'now', note? } (staff, money): end a membership for someone. */
  async staffCancelMembership(id, input, who) {
    this.requireStaff(who, 'money');
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const when = String(input?.when ?? 'end').trim().toLowerCase();
    if (!['end', 'now'].includes(when)) throw new RuleError(MEMBERSHIP_MESSAGES.staffWhen);
    const m = this.membershipRow(trimmed(id, 40));
    if (!m) throw new RuleError(MEMBERSHIP_MESSAGES.noneStaff, 404);
    const inFlight = this.endBy(m, { by: who.customerId ? `staff:${who.customerId}` : 'staff', now, when });
    this.tellCancelled(this.membershipRow(m.id), rules, { inFlight });
    return { membership: this.staffMembershipView(this.membershipRow(m.id), now) };
  },

  /**
   * POST /memberships/:id/retry (staff, money): try a failed payment again on the next run (within 10 minutes), or
   * lift a hold after Shopify refused a bill. Not while a bank check could still go through.
   */
  async staffRetryMembership(id, who) {
    this.requireStaff(who, 'money');
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const m = this.membershipRow(trimmed(id, 40));
    if (!m) throw new RuleError(MEMBERSHIP_MESSAGES.noneStaff, 404);
    const open = this.openCharge(m.id);
    if (open?.status === 'challenged') throw new RuleError(MEMBERSHIP_MESSAGES.retryBank, 409);
    const held = m.hold_until && m.hold_until > now;
    if (m.status !== 'past_due' && !held) throw new RuleError(MEMBERSHIP_MESSAGES.retryNotDue, 409);
    this.write('UPDATE memberships SET retry_at = CASE WHEN status = ? THEN ? ELSE retry_at END, hold_until = NULL, updated_at = ? WHERE id = ?', 'past_due', now, now, m.id);
    return { membership: this.staffMembershipView(this.membershipRow(m.id), now) };
  },

  /* ---------------- setup ---------------- */
  /**
   * /setup?key=…&memberships=plans: Lair Memberships' permissions checked, its selling plans found or made (and put on
   * MEMBERSHIPS_PRODUCT_ID when it's set), the damage charge product found or made, and its webhooks in place. Returns
   * what it found and did. The plans only go on a product when MEMBERSHIPS_PRODUCT_ID says which.
   */
  async membershipSetup(webhookUrl) {
    const admin = this.membershipsAdmin();
    if (!admin.configured) return { ok: false, advice: 'Add MEMBERSHIPS_CLIENT_ID to the config table and MEMBERSHIPS_CLIENT_SECRET as a Worker secret.' };
    const out = { ok: true };
    try {
      const info = await admin.appInfo();
      out.app = info.app;
      out.missingScopes = MEMBERSHIP_SCOPES.filter((s) => !info.scopes.includes(s) && !(s.startsWith('read_') && info.scopes.includes(s.replace(/^read_/, 'write_'))));
      if (out.missingScopes.length) return { ...out, ok: false, advice: `Lair Memberships needs these permissions: ${out.missingScopes.join(', ')}` };
    } catch (error) {
      return { ok: false, login: String(error.message || error).slice(0, 300), advice: 'Lair Memberships could not log in: check MEMBERSHIPS_CLIENT_ID and MEMBERSHIPS_CLIENT_SECRET, and that the app is installed.' };
    }
    const productId = numericId(this.env?.MEMBERSHIPS_PRODUCT_ID || '');
    let group = (await admin.ownGroups()).find((g) => g.code === GROUP_CODE) || null;
    if (!group) {
      const made = await admin.createPlans(productId ? [productId] : []);
      if (!made.group) return { ...out, ok: false, plans: made.errors };
      group = (await admin.ownGroups()).find((g) => g.code === GROUP_CODE) || null;
      out.madePlans = true;
    } else if (productId && !group.productIds.includes(gid('Product', productId))) {
      const added = await admin.addProducts(group.id, [productId]);
      if (added.errors.length) out.productProblem = added.errors.map((e) => e.message).join('; ');
      else out.addedProduct = productId;
    }
    const plans = {};
    for (const p of group?.plans || []) {
      const tier = tierOf(p.name);
      if (tier && !plans[tier]) plans[tier] = { id: p.id, name: p.name, price: p.price ?? TIERS[tier].price };
    }
    out.plans = plans;
    out.productIds = group?.productIds || [];
    let feeVariant = String(this.env?.MEMBERSHIPS_FEE_VARIANT_ID || '').trim() || null;
    if (!feeVariant) {
      feeVariant = await admin.feeVariant();
      if (!feeVariant) {
        const made = await admin.createFeeProduct();
        feeVariant = made.variantId;
        if (made.problem) out.feeProblem = made.problem;
        if (made.variantId) out.madeFeeProduct = true;
      }
    }
    out.feeVariantId = feeVariant;
    if (!feeVariant) out.feeAdvice = "Make a product called 'Library damage charge' (not a physical product, quantity not tracked, on no sales channel) and put its variant's ID in the config table as MEMBERSHIPS_FEE_VARIANT_ID.";
    try {
      out.webhooks = await this.ensureMembershipWebhooks(webhookUrl, { force: true });
    } catch (error) {
      out.webhooks = { ok: false, reason: String(error.message || error).slice(0, 200) };
    }
    // --- no awaits from here on ---
    if (group) this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('membership-plans', ?)", JSON.stringify({ groupId: group.id, plans }));
    if (feeVariant && !this.env?.MEMBERSHIPS_FEE_VARIANT_ID) this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('membership-fee-variant', ?)", feeVariant);
    return out;
  },

  /* ---------------- emails ---------------- */
  /** Who a membership's emails go to: { email, first, name } (email '' when there's none) */
  membershipContact(customerId) {
    const member = this.memberRow(customerId);
    const email = isEmail(member?.email) ? member.email : isEmail(member?.account_email) ? member.account_email : '';
    const name = member?.name || member?.first_name || '';
    const first = member?.first_name || String(member?.name || '').split(/\s+/)[0] || 'friend';
    return { email, first, name, code: member?.code || '', member };
  },

  /** Games a member still has at home: [title] */
  gamesAtHome(customerId) {
    return this.sql.exec("SELECT title FROM library_loans WHERE customer_id = ? AND status = 'out' ORDER BY out_at", String(customerId)).toArray().map((l) => l.title);
  },

  /** What a member owes in damage charges staff will collect at the counter (cents) */
  owedAtCounter(customerId) {
    return this.sql.exec("SELECT COALESCE(SUM(amount), 0) AS n FROM damage_charges WHERE customer_id = ? AND status = 'unpaid'", String(customerId)).toArray()[0]?.n || 0;
  },

  /** Send one membership email to the member (no awaits). Returns whether it went. */
  membershipMail(customerId, subject, content) {
    if (!emailReady(this.env)) return false;
    const to = this.membershipContact(customerId);
    if (!to.email) return false;
    this.later(this.mail(this.letter(to.email, subject, { button: { label: 'Open My Library', url: `${this.page('myLair')}?view=library` }, ...content })));
    return true;
  },

  tellNewMembership(m, rules) {
    const t = TIERS[m.tier];
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, 'Welcome to the Dice Goblin library!', {
      title: "You're in the library!",
      intro: [`Kia ora ${to.first}!`, `You're on ${t.name}: ${plural(t.games, 'game', 'games')} at a time, with unlimited swaps. Gobgob has dusted off the shelves for you.`],
      details: [['Plan', `${t.name}, ${money(m.price ?? t.price)} a month`], ['Games at a time', String(t.games)], ['Next bill', m.next_bill_at ? billDay(m.next_bill_at, rules.tz) : 'In a month'], ['Card', cardWords(parse(m.card, null))]],
      outro: [
        'Reserve a game on its page in the library, or scan the box in the Lair to borrow it. Your member code is in My Lair.',
        `Look after the games so the next friend can play them too. Missing parts or damage are charged up to the game's RRP, and we always email you first. Usually the charge goes on your next bill after ${FEE_NOTICE_DAYS} days, so there's time to bring the bits back or tell us we've got it wrong, but we can also take it straight away from your store credit or card.`,
        'Change plans or cancel any time in My Lair.',
      ],
    });
    this.notifyStaff(`New library member: ${to.name || to.code || 'someone'} (${t.name})`, {
      title: 'A new library member',
      intro: `${to.name || 'Someone'} joined the library on ${t.name} (${plural(t.games, 'game', 'games')} at a time).`,
      details: [['Member', to.name], ['Member code', to.code], ['Plan', `${t.name}, ${money(m.price ?? t.price)} a month`], ['Email', to.email]],
    });
  },

  tellPaymentFailed(m, charge, { again, cardEmailSent, fraud, giveUpAt }, rules) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, "Your library payment didn't go through", {
      title: "Your payment didn't go through",
      intro: [
        `Kia ora ${to.first},`,
        fraud
          ? `We tried to take your ${money(charge.amount)} library payment, but your bank stopped it as possible fraud. We won't try that card again.`
          : `We tried to take your ${money(charge.amount)} library payment, but it didn't go through.`,
      ],
      details: [['Amount', money(charge.amount)], ['Card', cardWords(parse(m.card, null))], again ? ["We'll try again", billDay(again, rules.tz)] : ['Next step', 'Update your card']],
      outro: [
        cardEmailSent
          ? "Shopify has emailed you a secure link to update your card. Once it's updated, Gobgob tries again within the hour."
          : 'Update your card in My Lair (Library), and Gobgob tries again within the hour.',
        "Until it's paid, borrowing new games is paused. You can keep the games you have.",
        ...(fraud ? [`If your card isn't updated by ${billDay(giveUpAt, rules.tz)}, your membership ends.`] : []),
      ],
    });
    if (fraud) {
      this.notifyStaff(`A library payment flagged as fraud: ${to.name || to.code || 'a member'}`, {
        title: 'A payment flagged as fraud',
        intro: `${to.name || 'A member'}'s bank stopped their ${money(charge.amount)} library payment as possible fraud. The Lair won't try that card again. If they update their card it tries once more; if not, their membership ends on ${billDay(giveUpAt, rules.tz)}.`,
        details: [['Member', to.name], ['Member code', to.code], ['Email', to.email]],
      });
    }
  },

  /** A cancelled member's damage charge, billed on its own, didn't go through */
  tellFeesFailed(m, charge, { again, cardEmailSent }, rules) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, "Your damage charge payment didn't go through", {
      title: "Your payment didn't go through",
      intro: [`Kia ora ${to.first},`, `We tried to take the ${money(charge.amount)} damage charge from your library membership, but it didn't go through.`],
      details: [['Amount', money(charge.amount)], ['Card', cardWords(parse(m.card, null))], ["We'll try again", billDay(again, rules.tz)]],
      outro: [
        cardEmailSent
          ? "Shopify has emailed you a secure link to update your card. Once it's updated, Gobgob tries again within the hour."
          : `Update your card in My Lair (Library) before ${billDay(again, rules.tz)}, or pay it at the counter.`,
      ],
    });
  },

  /** A bank check has waited 3 days: borrowing pauses until it's done */
  tellBankCheck(m, charge, rules) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, 'Your bank wants you to confirm your library payment', {
      title: 'Confirm your payment',
      intro: [`Kia ora ${to.first},`, `Your bank wants you to confirm your ${money(charge.amount)} library payment. Shopify has emailed you a link to do it. Check your spam folder too.`],
      details: [['Amount', money(charge.amount)], ['Confirm by', billDay(charge.created_at + GIVE_UP_DAYS * DAY, rules.tz)]],
      outro: [
        "Until it's confirmed, borrowing new games is paused. You can keep the games you have.",
        `If it isn't confirmed by ${billDay(charge.created_at + GIVE_UP_DAYS * DAY, rules.tz)}, your membership ends.`,
      ],
    });
  },

  tellPaymentSorted(m, charge) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, 'Your library payment went through', {
      title: 'Payment sorted!',
      intro: [`Thanks, ${to.first}! Your ${money(charge.amount)} library payment went through, so borrowing is back on.`],
    });
  },

  /** A renewal that couldn't be paid: the membership ends (the member hears why) and staff hear. */
  tellPaymentGaveUp(m, charge, { code, tries, bank = false, waited = false }) {
    const to = this.membershipContact(m.customer_id);
    const t = TIERS[m.tier];
    const home = this.gamesAtHome(m.customer_id);
    // what they'll pay at the counter: unpaid already, and this membership's charges that never got billed (they go
    // to the counter when it ends)
    const owed = this.owedAtCounter(m.customer_id)
      + (this.sql.exec("SELECT COALESCE(SUM(amount), 0) AS n FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due')", m.id).toArray()[0]?.n || 0);
    const fraud = /FRAUD/.test(code || '');
    const why = bank ? "Your bank wanted you to confirm your library payment, and it wasn't confirmed in time"
      : fraud && waited ? "Your bank stopped your library payment and your card wasn't updated"
        : waited ? "We couldn't take your library payment and your card wasn't updated"
          : `We couldn't take your library payment after ${plural(tries, 'try', 'tries')}`;
    this.membershipMail(m.customer_id, 'Your library membership has ended', {
      title: 'Your membership has ended',
      intro: [`Kia ora ${to.first},`, `${why}, so your ${t ? `${t.name} ` : ''}membership has ended.`],
      details: [...(home.length ? [['Games at home', home.join(', ')]] : []), ...(owed ? [['Damage charges to pay', money(owed)]] : [])],
      outro: [
        ...(home.length ? ['Please bring back the games you have at home as soon as you can.'] : []),
        ...(owed ? ["There are damage charges still to pay. We'll sort them at the counter."] : []),
        'Want to come back? Join again any time on the library page.',
      ],
    });
    this.notifyStaff(`Library payment failed for good: ${to.name || to.code || 'a member'}`, {
      title: 'A library payment that failed for good',
      intro: `${to.name || 'A member'}'s library payment ${bank ? "was waiting on a bank check that wasn't done" : fraud ? 'was stopped by their bank as possible fraud' : `failed ${plural(tries, 'time', 'times')}`}, so their membership is ending.${home.length ? ' They still have games at home.' : ''}`,
      details: [['Member', to.name], ['Member code', to.code], ['Amount', money(charge.amount)], ['Last error', code || ''], ['Games at home', home.join(', ')]],
    });
  },

  /** A cancelled member's damage charges couldn't be taken: the member pays at the counter, staff hear */
  tellFeesGaveUp(m, charge, { code }) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, "We couldn't take your damage charge", {
      title: "We couldn't take the payment",
      intro: [`Kia ora ${to.first},`, `We couldn't take the ${money(charge.amount)} damage charge from your card, so we'll sort it at the counter next time you're in.`],
    });
    this.notifyStaff(`A damage charge to collect at the counter: ${to.name || to.code || 'a member'}`, {
      title: "A damage charge that couldn't be taken",
      intro: `${to.name || 'A member'}'s ${money(charge.amount)} damage charge couldn't be taken from their card. It's on the staff page under Damage to sort at the counter.`,
      details: [['Member', to.name], ['Member code', to.code], ['Amount', money(charge.amount)], ['Last error', code || '']],
    });
  },

  tellPlanChanged(m, rules) {
    const now = TIERS[m.tier];
    const next = TIERS[m.billing_tier];
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, `Your library plan changes to ${next.name}`, {
      title: `Moving to ${next.name}`,
      intro: [`Kia ora ${to.first}!`, `From your next bill on ${billDay(m.next_bill_at, rules.tz)}, you're on ${next.name}: ${plural(next.games, 'game', 'games')} at a time for ${money(m.price ?? next.price)} a month.`],
      outro: [now.key === next.key ? '' : `Until then you keep ${now.name} (${plural(now.games, 'game', 'games')} at a time).`, 'Changed your mind? Pick another plan in My Lair before your next bill.'].filter(Boolean),
    });
  },

  tellCancelled(m, rules, { inFlight = false } = {}) {
    const t = TIERS[m.tier];
    const to = this.membershipContact(m.customer_id);
    const owed = this.sql.exec("SELECT COUNT(*) AS n FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due', 'billing')", m.id).toArray()[0]?.n || 0;
    const waiting = inFlight && m.cancel_at == null;
    const ends = !waiting && m.cancel_at && m.cancel_at > Date.now() + HOUR;
    const day = ends ? billDay(m.cancel_at, rules.tz) : '';
    this.membershipMail(m.customer_id, 'Your library membership is cancelled', {
      title: 'Membership cancelled',
      intro: [
        `Kia ora ${to.first},`,
        waiting
          ? `We'd already started taking this month's payment when you cancelled your ${t.name} membership. If it goes through, your membership runs to the end of the month it pays for. If it doesn't, your membership ends now. There are no more bills after that.`
          : ends
            ? `Your ${t.name} membership runs until ${day}, and there are no more bills after that.`
            : `Your ${t.name} membership has ended, and there are no more bills.`,
      ],
      outro: [
        ends || waiting ? 'Please bring back any games you have at home before it ends.' : 'Please bring back any games you have at home.',
        ...(owed ? ["Any damage charge still owed is billed on its own, without another month's fee."] : []),
        ...(ends ? [`Changed your mind? Keep your membership in My Lair before ${day}.`] : []),
      ],
    });
  },

  tellMembershipEnded(m) {
    const t = TIERS[m.tier];
    const to = this.membershipContact(m.customer_id);
    const home = this.gamesAtHome(m.customer_id);
    const owed = this.owedAtCounter(m.customer_id);
    this.membershipMail(m.customer_id, 'Your library membership has ended', {
      title: 'Your membership has ended',
      intro: [`Thanks for borrowing with us, ${to.first}! Your ${t.name} membership has ended.`],
      details: [...(home.length ? [['Games at home', home.join(', ')]] : []), ...(owed ? [['Damage charges to pay', money(owed)]] : [])],
      outro: [
        ...(home.length ? ['Please bring back the games you have at home as soon as you can.'] : []),
        ...(owed ? ["There are damage charges still to pay. We'll sort them at the counter."] : []),
        'Come back any time: join again on the library page.',
      ],
    });
    if (home.length) {
      this.notifyStaff(`Library membership ended with games at home: ${to.name || to.code || 'a member'}`, {
        title: 'Games still out',
        intro: `${to.name || 'A member'}'s membership has ended, and they still have games at home.`,
        details: [['Member', to.name], ['Member code', to.code], ['Games at home', home.join(', ')], ['Email', to.email]],
      });
    }
  },

  /**
   * Send a damage charge's notice (damageNoticeLetter) and wait for the email service to take it. Only then does it
   * count as emailed (emailed_at, and only while the charge still has the amount the notice gives), since a charge
   * can be taken straight away once its notice has gone. Returns whether it went.
   */
  async sendDamageNotice(feeId, m, rules, opts = {}) {
    const fee = this.feeRow(feeId);
    const letter = fee ? this.damageNoticeLetter(fee, m, rules, opts) : null;
    if (!letter) return false;
    let result;
    try {
      result = await this.mail(letter);
    } catch (error) {
      console.error('Lair: a damage charge notice failed', error);
      result = { ok: false };
    }
    // --- no awaits from here on ---
    if (!result?.ok) return false;
    const at = Date.now();
    this.write('UPDATE damage_charges SET emailed_at = ?, updated_at = ? WHERE id = ? AND amount = ?', at, at, fee.id, fee.amount);
    return true;
  },

  /**
   * The itemised notice for a damage charge (or for a new amount: `was`, the old one; or back on after it was waived:
   * `again`). With a membership to bill, it goes on their next bill after the 7 days; without one, it's paid at the
   * counter. now ({ method: 'credit' | 'card', card }): it's being taken straight away instead, and the notice says so.
   * Returns the letter, or null when there's nobody to send it to. No awaits.
   */
  damageNoticeLetter(fee, m, rules, { was = null, now = null, again = false } = {}) {
    if (!emailReady(this.env)) return null;
    const to = this.membershipContact(fee.customer_id);
    if (!to.email) return null;
    const lost = fee.reason === 'lost';
    const when = billDay(fee.due_at, rules.tz);
    const billable = Boolean(m && this.billable(m) && this.feeVariantId());
    const bill = billable && m.next_bill_at && m.next_bill_at > fee.due_at && ['active', 'past_due'].includes(m.status) ? billDay(m.next_bill_at, rules.tz) : null;
    // A cancelled membership has no next bill: the charge is billed on its own once its notice and the paid month are over
    const onItsOwn = billable && this.isCancelling(m) ? billDay(Math.max(fee.due_at, m.cancel_at || 0), rules.tz) : null;
    const subject = was != null ? `The charge for ${fee.title} has changed`
      : again ? `The charge for ${fee.title} is back on`
        : lost ? `${fee.title} hasn't come back` : `About ${fee.title}: a charge for ${FEE_REASONS[fee.reason].toLowerCase()}`;
    return this.letter(to.email, subject, {
      button: { label: 'Open My Library', url: `${this.page('myLair')}?view=library` },
      title: was != null ? 'A changed charge' : again ? 'A charge back on' : lost ? "A library game hasn't come back" : 'A library game came back with a problem',
      intro: [
        `Kia ora ${to.first},`,
        was != null
          ? `We've changed the charge for ${fee.title} from ${money(was)} to ${money(fee.amount)}. You have ${FEE_NOTICE_DAYS} days from today to sort it, as before.`
          : again
            ? `We cancelled the charge for ${fee.title} earlier, but it's back on now. You have ${FEE_NOTICE_DAYS} days from today to sort it.`
            : lost
              ? `${fee.title} hasn't come back to the library, so there's a charge to replace it.`
              : `${fee.title} came back with a problem${fee.details ? `: ${fee.details}` : ''}. There's a charge to put it right.`,
      ],
      details: [
        ['Game', fee.title], ["What's wrong", `${FEE_REASONS[fee.reason]}${fee.details ? `: ${fee.details}` : ''}`], ['Charge', money(fee.amount)],
        now ? ['To pay', now.method === 'credit' ? 'Taken from your store credit today' : `Charged to ${cardWords(now.card)} today`]
          : onItsOwn ? ['To pay', `Billed to your card on its own, on ${onItsOwn}`]
            : billable ? ['Goes on your bill', bill ? `${bill} (not before ${when})` : `Your next bill after ${when}`]
              : ['To pay', `At the counter, after ${when}`],
      ],
      outro: now
        ? [
          `We're taking it ${now.method === 'credit' ? 'from your store credit' : `on ${cardWords(now.card)}`} now, and we'll email you when it's gone through.`,
          "Think we've got it wrong, or found the missing bits? Have a chat with us in the Lair and we'll sort it out.",
        ]
        : [
          lost ? `Found it? Bring it back before ${when} and we'll cancel the charge.` : `Found the missing bits? Bring them in before ${when} and we'll cancel the charge.`,
          billable
            ? "Think we've got it wrong? Tell us in My Lair (Library), and the charge waits while we sort it out."
            : "Think we've got it wrong? Tell us in My Lair (Library) or at the counter.",
        ],
    });
  },

  /**
   * Where a damage charge goes next after taking it now didn't work (`to`: its status now), in words for the member
   * ("It'll go on your next library bill instead, on Tue 3 Nov.") or for staff. No awaits.
   */
  feeRouteWords(f, to, rules, { staff = false } = {}) {
    const tz = rules?.tz || this.rulesCache?.tz || 'Pacific/Auckland';
    if (!f || !to) return '';
    const m = this.membershipRow(f.membership_id);
    const due = billDay(f.due_at, tz);
    if (to === 'unpaid' || !(this.billable(m) && this.feeVariantId())) {
      if (to === 'notice') return staff ? `It's back in its notice, then it's to collect at the counter after ${due}.` : `You can pay it at the counter after ${due} instead.`;
      return staff ? "It's on the staff page under Damage to collect at the counter." : "We'll sort it at the counter next time you're in.";
    }
    if (this.isCancelling(m)) {
      const day = billDay(Math.max(f.due_at, m.cancel_at || 0), tz);
      return staff ? `It'll be billed on its own on ${day}, once their membership's month is up.` : `It'll be billed to your card on its own on ${day} instead.`;
    }
    const after = to === 'notice' ? f.due_at : Date.now();
    const next = m.next_bill_at && m.next_bill_at > after && ['active', 'past_due'].includes(m.status) ? billDay(m.next_bill_at, tz) : null;
    if (to === 'notice') return staff ? `It's back in its notice, and goes on their next bill after ${due}.` : `It'll go on your next library bill instead${next ? `, on ${next}` : ` after ${due}`}.`;
    return staff ? `It's back waiting for their next bill${next ? ` (${next})` : ''}.` : `It'll go on your next library bill instead${next ? `, on ${next}` : ''}.`;
  },

  /** A damage charge taken now has gone through: the member's receipt. No awaits. */
  tellDamagePaid(fee, p) {
    const to = this.membershipContact(fee.customer_id);
    const credit = p.method === 'credit';
    const card = cardWords(parse(p.card, null));
    this.membershipMail(fee.customer_id, `Paid: the ${money(p.amount)} charge for ${fee.title}`, {
      title: 'Charge paid',
      intro: [
        `Kia ora ${to.first},`,
        credit ? `We've taken ${money(p.amount)} from your store credit for ${fee.title}.` : `We've charged ${money(p.amount)} to ${card} for ${fee.title}.`,
      ],
      details: [
        ['Game', fee.title], ["What's wrong", `${FEE_REASONS[fee.reason] || fee.reason}${fee.details ? `: ${fee.details}` : ''}`], ['Paid', money(p.amount)],
        ['Paid with', credit ? 'Store credit' : card], ...(credit && p.balance_after != null ? [['Store credit left', money(p.balance_after)]] : []),
      ],
      outro: ["Think we've got it wrong? Have a chat with us in the Lair and we'll sort it out."],
    });
  },

  /** Taking a damage charge now didn't work: the member hears where it goes instead. No awaits. */
  tellDamageNotTaken(fee, p, { code, theirs, to }, rules) {
    const who = this.membershipContact(fee.customer_id);
    const card = cardWords(parse(p.card, null));
    const what = p.method === 'credit'
      ? code === 'INSUFFICIENT_FUNDS'
        ? `We tried to take the ${money(p.amount)} charge for ${fee.title} from your store credit, but there wasn't enough.`
        : `We tried to take the ${money(p.amount)} charge for ${fee.title} from your store credit, but it didn't go through, so nothing came off.`
      : code === 'AUTHENTICATION_REQUIRED'
        ? `Your bank wanted you to confirm the ${money(p.amount)} charge for ${fee.title}, and it wasn't confirmed in time, so nothing was charged.`
        : code === 'NOT_SENT' || !theirs
          ? `We couldn't charge the ${money(p.amount)} for ${fee.title} to ${card} after all, so nothing was charged.`
          : `We tried to charge the ${money(p.amount)} for ${fee.title} to ${card}, but it didn't go through.`;
    this.membershipMail(fee.customer_id, `We couldn't take the charge for ${fee.title}`, {
      title: "We couldn't take the payment",
      intro: [`Kia ora ${who.first},`, what, this.feeRouteWords(fee, to, rules)],
      details: [['Game', fee.title], ['Charge', money(p.amount)], ...(p.method === 'card' ? [['Card', card]] : [])],
      outro: theirs && code !== 'AUTHENTICATION_REQUIRED' ? ['If your card has changed, update it in My Lair (Library).'] : [],
    });
  },

  /** A damage charge taken now waits on the member's bank check: they hear how to do it. No awaits. */
  tellDamageBankCheck(fee, p, rules) {
    const to = this.membershipContact(fee.customer_id);
    const by = billDay(p.created_at + GIVE_UP_DAYS * DAY, rules.tz);
    this.membershipMail(fee.customer_id, `Your bank wants you to confirm a ${money(p.amount)} payment`, {
      title: 'Confirm your payment',
      intro: [`Kia ora ${to.first},`, `Your bank wants you to confirm the ${money(p.amount)} charge for ${fee.title}. Shopify has emailed you a link to do it. Check your spam folder too.`],
      details: [['Game', fee.title], ['Charge', money(p.amount)], ['Confirm by', by]],
      outro: [`If it isn't confirmed by ${by}, nothing is charged and we'll sort it another way: on your next library bill, or at the counter.`],
    });
  },

  tellWaived(fee) {
    const to = this.membershipContact(fee.customer_id);
    this.membershipMail(fee.customer_id, `Good news: the ${fee.title} charge is cancelled`, {
      title: 'Charge cancelled',
      intro: [`Kia ora ${to.first}!`, `We've cancelled the ${money(fee.amount)} charge for ${fee.title}. There's nothing to pay. Thanks, friend!`],
    });
  },
};

/**
 * Round 10 (memberships) maintenance step for checkConnection: runs the membership upkeep, never throws. Kept here so
 * lair.js only needs one call.
 */
export async function membershipUpkeep(lair, rules, { webhookUrl = null, force = false } = {}) {
  try {
    return await lair.membershipMaintenance(rules, Date.now(), { webhookUrl, force });
  } catch (error) {
    console.error('Lair: memberships upkeep failed', error);
    return { error: String(error.message || error).slice(0, 300) };
  }
}

/** The time zone helper, re-exported for the tests */
export { LairTime };
