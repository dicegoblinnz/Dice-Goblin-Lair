// Library memberships: Grab, Stash and Hoard, billed by the Lair itself through Shopify's subscription contracts
// (replacing Simplee Memberships).
//
// How it fits together
// - The Lair Memberships app (a second Shopify app, made in the Dev Dashboard) owns the membership selling plans and
//   the contracts people make at checkout. It logs in with its own client ID and secret (MEMBERSHIPS_CLIENT_ID,
//   MEMBERSHIPS_CLIENT_SECRET), separate from the Lair's own app, so card access never rides on the Lair's token.
// - Shopify keeps the card. The Lair decides when to charge: each renewal bills one Shopify billing cycle, with an
//   idempotency key built from the contract, the cycle and the attempt, so a retried request never charges twice.
// - Webhooks (/webhooks/memberships) say when a contract is made or changes, and how each charge went.
// - The 10-minute maintenance bills what's due, retries failed payments, moves damage charges on once their notice
//   runs out, and ends memberships that were cancelled or couldn't be paid.
// - Damage charges ride on a member's next bill: the cycle being billed gets the charge added to it (that cycle only),
//   so it's one payment and one Shopify order.
// - Nothing charges a card until MEMBERSHIPS_BILLING is 'on'. Until then the Lair keeps its records up to date only.
//
// These are Lair methods: lair.js copies them onto Lair.prototype, so `this` is the Durable Object. The usual rule
// holds: every await first, then one synchronous read-check-write. A charge is claimed (its row written) before Shopify
// is asked to bill, so two runs can't bill the same cycle.
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
/** The first renewal is never billed sooner than this after joining (the checkout paid the first month) */
const FIRST_BILL_MIN_DAYS = 25;
/** A charge Shopify hasn't answered for this long is asked about; a claim with no attempt this long is sent again */
const RECONCILE_AFTER = 30 * MIN;
const CLAIM_STALE = 15 * MIN;
/** A payment waiting on the member's bank check (3D Secure) this long counts as a failed try */
const CHALLENGE_DAYS = 3;
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
/** What Lair Memberships needs from Shopify */
export const MEMBERSHIP_SCOPES = ['read_own_subscription_contracts', 'write_own_subscription_contracts', 'read_customer_payment_methods', 'write_products', 'read_customers', 'write_customers'];
/** The webhooks Lair Memberships asks for (GraphQL topic names) */
export const MEMBERSHIP_TOPICS = [
  'SUBSCRIPTION_CONTRACTS_CREATE', 'SUBSCRIPTION_CONTRACTS_UPDATE', 'SUBSCRIPTION_CONTRACTS_ACTIVATE', 'SUBSCRIPTION_CONTRACTS_PAUSE',
  'SUBSCRIPTION_CONTRACTS_CANCEL', 'SUBSCRIPTION_CONTRACTS_EXPIRE', 'SUBSCRIPTION_CONTRACTS_FAIL',
  'SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS', 'SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE', 'SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED',
  'CUSTOMER_PAYMENT_METHODS_UPDATE', 'CUSTOMER_PAYMENT_METHODS_REVOKE',
];

/** The words members and staff see, kept together so the theme's demo can say the same */
export const MEMBERSHIP_MESSAGES = {
  login: 'Log in to manage your library membership.',
  none: "You're not in the library yet. Join on the library page, friend.",
  noneStaff: 'No library membership with that ID.',
  tier: 'Pick Grab, Stash or Hoard.',
  same: (name) => `You're already on ${name}.`,
  pastDue: 'Sort out your last payment first, then you can change plans.',
  ending: "Your membership is ending, so the plan can't change. Keep your membership first, then pick a new plan.",
  editsWaiting: 'You can change plans once your payment has gone through.',
  plansNotReady: "Plan changes aren't open yet. Ask us at the counter and we'll sort it.",
  shopifyDown: "Shopify didn't answer just now. Try again in a minute.",
  notActive: "That membership isn't active, so there's nothing to cancel.",
  notCancelling: "Your membership isn't set to end, so there's nothing to undo.",
  tooLate: "Your membership has already ended. Join again on the library page, friend.",
  noCard: "There's no card on your membership. Ask us at the counter.",
  cardSoon: 'Shopify sent you a link in the last hour. Check your inbox, and your spam folder too.',
  blocked: "Your last library payment didn't go through, so borrowing is paused. Update your card in My Lair and Gobgob will try again.",
  feeAmount: "A charge is $1 to $500 (no more than the game's RRP).",
  feeReason: 'Pick what happened: missing parts, damaged, or lost.',
  feeTitle: 'Say which game it is.',
  feeMember: 'No member with that customer ID.',
  feeLoan: "That loan isn't this member's.",
  feeNone: 'That charge could not be found.',
  feeNotYours: "That charge isn't yours.",
  feeLocked: "That charge is being paid right now. Once it's gone through, refund it in Shopify if you need to.",
  feeDispute: "That charge can't be disputed now. Have a chat with us at the counter.",
  feeAction: 'Pick waive, reinstate or a new amount.',
  feeChange: "That charge can't change now.",
  staffWhen: "Pick when it ends: 'end' (at the end of the month they've paid for) or 'now'.",
  retryNotDue: "That membership's payments are fine, so there's nothing to retry.",
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

/** Shopify's userErrors as [{ code, message }] */
const errorsOf = (list) => (list || []).map((e) => ({ code: e.code || null, message: String(e.message || '') }));

/* ---------- Lair Memberships: Shopify calls ---------- */
export class MembershipsAdmin extends ShopifyAdmin {
  constructor(env, storage) {
    super(env, storage, { clientId: env.MEMBERSHIPS_CLIENT_ID, clientSecret: env.MEMBERSHIPS_CLIENT_SECRET, tokenKey: 'memberships-token' });
  }

  /** One contract as the Lair needs it, or null. read_own_subscription_contracts and read_customer_payment_methods. */
  async contract(id) {
    const data = await this.graphql(
      `query MembershipContract($id: ID!) { subscriptionContract(id: $id) { id status createdAt currencyCode revisionId
        customer { id } originOrder { id }
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
      originOrderId: c.originOrder?.id || null, paymentMethodId: pm?.id || null, paymentRevoked: Boolean(pm?.revokedAt), card,
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
        ... on SubscriptionBillingAttemptFailedState { error { __typename
          ... on SubscriptionBillingAttemptPaymentError { paymentCode: code }
          ... on SubscriptionBillingAttemptInventoryError { inventoryCode: code }
          ... on SubscriptionBillingAttemptGeneralError { generalCode: code }
          ... on SubscriptionBillingAttemptUnexpectedError { message } } }
        ... on SubscriptionBillingAttemptActionRequiredState { action { ... on SubscriptionBillingAttemptPaymentChallenge { nextActionUrl } } } } } }`,
      { id },
    );
    const a = data.subscriptionBillingAttempt;
    if (!a) return null;
    const s = a.state || {};
    if (s.__typename === 'SubscriptionBillingAttemptSuccessState') return { state: 'paid', orderId: s.order?.id || null };
    if (s.__typename === 'SubscriptionBillingAttemptFailedState') {
      const e = s.error || {};
      return { state: 'failed', code: e.paymentCode || e.inventoryCode || e.generalCode || 'UNEXPECTED_ERROR', message: e.message || null };
    }
    if (s.__typename === 'SubscriptionBillingAttemptActionRequiredState') return { state: 'action', nextActionUrl: s.action?.nextActionUrl || null };
    return { state: 'pending' };
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
   * Edit one billing cycle only (the source contract and other cycles stay as they are): remove the membership line
   * (dropPlan: a damage charge billed on its own) and add a line for each charge, on the damage charge product's variant
   * at the charge's price, with what it's for as line properties. Any edit already on the cycle is removed first, so
   * the cycle ends up with exactly these charges. Returns { ok, errors }.
   */
  async editCycle({ contractId, cycle, feeVariantId, fees = [], dropPlan = false }) {
    await this.clearCycleEdit({ contractId, cycle });
    const input = { contractId: gid('SubscriptionContract', contractId), selector: { index: cycle } };
    const started = await this.graphql(
      `mutation MembershipCycleEdit($input: SubscriptionBillingCycleInput!) { subscriptionBillingCycleContractEdit(billingCycleInput: $input) {
        draft { id lines(first: 20) { nodes { id sellingPlanId } } } userErrors { field message code } } }`,
      { input },
    );
    const draft = started.subscriptionBillingCycleContractEdit?.draft;
    const startErrors = errorsOf(started.subscriptionBillingCycleContractEdit?.userErrors);
    if (!draft?.id || startErrors.length) return { ok: false, errors: startErrors.length ? startErrors : [{ code: null, message: 'no draft' }] };
    if (dropPlan) {
      for (const line of (draft.lines?.nodes || []).filter((l) => l.sellingPlanId)) {
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
        contract { lines(first: 20) { nodes { id } } } userErrors { field message code } } }`,
      { draftId: draft.id },
    );
    const errors = errorsOf(committed.subscriptionBillingCycleContractDraftCommit?.userErrors);
    return { ok: !errors.length, errors };
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

  /** A membership's charge still in flight (claimed, waiting on Shopify, or on a bank check), or null */
  openCharge(membershipId) {
    return this.sql.exec("SELECT * FROM membership_charges WHERE membership_id = ? AND status IN ('claimed', 'pending', 'challenged') ORDER BY created_at DESC LIMIT 1", String(membershipId)).toArray()[0] || null;
  },

  feeRow(id) {
    return this.sql.exec('SELECT * FROM damage_charges WHERE id = ?', String(id)).toArray()[0] || null;
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
   * A member's library plan: their membership (source 'membership'; blocked while a payment is outstanding), else
   * their Simplee tags (source 'simplee') until everyone has moved across, else null. No awaits.
   */
  planOf(customerId, tags, now = Date.now()) {
    const m = this.currentMembership(customerId, now);
    if (m && TIERS[m.tier]) {
      const t = TIERS[m.tier];
      return { name: t.name, games: t.games, tier: t.key, source: 'membership', status: m.status, blocked: m.status === 'past_due' };
    }
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
    if (plan?.blocked) throw new RuleError(MEMBERSHIP_MESSAGES.blocked, 402);
  },

  /* ---------------- views ---------------- */
  tierView(key) {
    const t = TIERS[key];
    return t ? { key: t.key, name: t.name, games: t.games, price: t.price } : null;
  },

  feeView(f) {
    return {
      id: f.id, title: f.title, reason: f.reason, reasonWords: FEE_REASONS[f.reason] || f.reason, details: f.details || '', amount: f.amount,
      status: f.status, dueAt: f.due_at, createdAt: f.created_at, resolvedAt: f.resolved_at || null, disputeNote: f.dispute_note || null,
    };
  },

  chargeView(c) {
    return { id: c.id, kind: c.kind, cycle: c.cycle, attempt: c.attempt, amount: c.amount, status: c.status, at: c.created_at, completedAt: c.completed_at || null, error: c.status === 'failed' ? c.error_code || null : null };
  },

  /** A membership for its member: plan, what's next, the card, recent charges and damage charges. No awaits. */
  membershipView(m, now = Date.now()) {
    const fees = this.sql.exec(
      `SELECT * FROM damage_charges WHERE membership_id = ? AND (status IN ('notice', 'due', 'billing', 'disputed', 'unpaid') OR COALESCE(resolved_at, 0) > ?)
       ORDER BY created_at DESC`,
      m.id, now - 60 * DAY,
    ).toArray();
    const charges = this.sql.exec('SELECT * FROM membership_charges WHERE membership_id = ? ORDER BY created_at DESC LIMIT 6', m.id).toArray();
    const dueFees = fees.filter((f) => ['due', 'billing'].includes(f.status)).reduce((sum, f) => sum + f.amount, 0);
    const billing = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    const live = ['active', 'past_due'].includes(m.status) || (m.status === 'cancelling' && (!m.cancel_at || m.cancel_at > now));
    return {
      id: m.id, status: m.status, tier: this.tierView(m.tier), nextTier: billing !== m.tier ? this.tierView(billing) : null,
      price: m.price ?? TIERS[billing]?.price ?? null, nextBillAt: m.status === 'active' || m.status === 'past_due' ? m.next_bill_at || null : null,
      nextAmount: m.status === 'active' ? (m.price ?? TIERS[billing]?.price ?? 0) + dueFees : null,
      retryAt: m.status === 'past_due' ? m.retry_at || null : null, cancelAt: m.status === 'cancelling' ? m.cancel_at || null : null,
      endedAt: m.ended_at || null, endReason: m.end_reason || null, card: parse(m.card, null), live,
      canChange: m.status === 'active', canCancel: m.status === 'active' || m.status === 'past_due', canResume: m.status === 'cancelling' && Boolean(m.cancel_at && m.cancel_at > now),
      canUpdateCard: live && Boolean(m.payment_method_id), since: m.created_at,
      charges: charges.map((c) => this.chargeView(c)), damage: fees.map((f) => this.feeView(f)),
    };
  },

  /**
   * GET /me's membership: the one that counts now, else one that ended in the last 30 days (so they see why), else
   * null; with the plans to pick from. No awaits.
   */
  membershipForMember(customerId, now = Date.now()) {
    const current = this.currentMembership(customerId, now);
    const recent = current || this.membershipRows(customerId).find((m) => ['ending', 'ended', 'cancelling'].includes(m.status) && (m.ended_at || m.cancel_at || m.updated_at || 0) > now - 30 * DAY);
    if (!recent) return null;
    return { ...this.membershipView(recent, now), plans: TIER_ORDER.map((k) => this.tierView(k)) };
  },

  /** A membership for staff: the member's view plus who they are, and games at home. No awaits. */
  staffMembershipView(m, now = Date.now()) {
    const member = this.memberRow(m.customer_id);
    const home = this.sql.exec("SELECT COUNT(*) AS n FROM library_loans WHERE customer_id = ? AND status = 'out'", m.customer_id).toArray()[0]?.n || 0;
    return {
      ...this.membershipView(m, now), customerId: m.customer_id, name: member?.name || member?.first_name || '', email: member?.email || member?.account_email || '',
      code: member?.code || '', atHome: home, source: m.source || null, contract: m.contract_gid,
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
   * Bring a contract's membership up to date from Shopify (its webhooks call this): a new one is saved, the member is
   * welcomed and staff hear; a known one gets its card, plan and Shopify status. A contract that isn't a library plan
   * is left alone. Returns what happened.
   */
  async syncContract(idOrGid, { topic = null } = {}) {
    const admin = this.membershipsAdmin();
    if (!admin.configured) return { skipped: 'Lair Memberships is not connected' };
    const contract = await admin.contract(numericId(idOrGid));
    if (!contract) return { missing: numericId(idOrGid) };
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
    if (row?.revision_id && contract.revisionId && BigInt(contract.revisionId) < BigInt(row.revision_id)) return { stale: contract.id };
    const shopifyEnded = ['CANCELLED', 'EXPIRED', 'FAILED'].includes(contract.status);
    const card = contract.card ? JSON.stringify(contract.card) : null;
    if (!row) {
      const status = shopifyEnded ? 'ended' : contract.status === 'PAUSED' ? 'paused' : 'active';
      this.write(
        `INSERT INTO memberships (id, contract_gid, customer_id, status, shopify_status, tier, billing_tier, line_id, variant_id, selling_plan_id, price,
           currency, payment_method_id, card, next_cycle, next_bill_at, origin_order_id, revision_id, source, ended_at, end_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        contract.id, contract.gid, contract.customerId, status, contract.status, tier, tier, line.id, line.variantId, line.sellingPlanId, line.price,
        contract.currency, contract.paymentMethodId, card, renewal?.index ?? null, renewal?.expectedAt ?? null, contract.originOrderId, contract.revisionId,
        contract.originOrderId ? 'checkout' : 'created', shopifyEnded ? now : null, shopifyEnded ? `shopify:${contract.status.toLowerCase()}` : null, contract.createdAt, now,
      );
      this.touchMember(contract.customerId, person ? { name: person.name, email: person.email } : {}, now);
      if (status === 'active') this.tellNewMembership(this.membershipRow(contract.id), rules);
      return { created: contract.id, tier, status, nextBillAt: renewal?.expectedAt ?? null };
    }
    // A known membership: Shopify's status, card and plan line are the truth; the Lair's own status (cancelling,
    // past_due, ending) stays unless Shopify has ended or paused it.
    let status = row.status;
    let endedAt = row.ended_at;
    let endReason = row.end_reason;
    if (shopifyEnded && row.status !== 'ended') {
      status = 'ended';
      endedAt = now;
      endReason = row.end_reason || `shopify:${contract.status.toLowerCase()}`;
    } else if (contract.status === 'PAUSED' && row.status !== 'ended') status = 'paused';
    else if (contract.status === 'ACTIVE' && row.status === 'paused') status = 'active';
    this.write(
      `UPDATE memberships SET status = ?, shopify_status = ?, billing_tier = ?, line_id = ?, variant_id = ?, selling_plan_id = ?, price = ?, payment_method_id = ?,
         card = ?, revision_id = COALESCE(?, revision_id), next_cycle = COALESCE(next_cycle, ?), next_bill_at = COALESCE(next_bill_at, ?), ended_at = ?, end_reason = ?,
         updated_at = ? WHERE id = ?`,
      status, contract.status, tier, line.id, line.variantId, line.sellingPlanId, line.price, contract.paymentMethodId, card, contract.revisionId,
      renewal?.index ?? null, renewal?.expectedAt ?? null, endedAt, endReason, now, row.id,
    );
    if (status === 'ended' && row.status !== 'ended') this.settleEndedFees(row.id, now);
    return { updated: row.id, status, topic };
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
    let result;
    if (kind.startsWith('subscription_contracts/')) result = await this.syncContract(payload?.admin_graphql_api_id || payload?.id, { topic: kind });
    else if (kind.startsWith('subscription_billing_attempts/')) result = await this.billingWebhook(payload || {}, kind);
    else if (kind.startsWith('customer_payment_methods/')) result = await this.paymentMethodChanged(payload || {}, kind);
    else result = { ignored: kind };
    if (id) this.write('INSERT OR IGNORE INTO membership_events (webhook_id, topic, at) VALUES (?, ?, ?)', id, kind, Date.now());
    return { ok: true, ...result };
  },

  /** subscription_billing_attempts/success, /failure or /challenged: the charge it belongs to (by its key) moves on. */
  async billingWebhook(payload, topic) {
    const key = trimmed(payload.idempotency_key, 200);
    let charge = key ? this.sql.exec('SELECT * FROM membership_charges WHERE idempotency_key = ?', key).toArray()[0] : null;
    if (!charge && payload.admin_graphql_api_id) charge = this.sql.exec('SELECT * FROM membership_charges WHERE attempt_gid = ?', String(payload.admin_graphql_api_id)).toArray()[0];
    if (!charge) return { unknown: key || payload.admin_graphql_api_id || null };
    const outcome = topic.endsWith('/success') ? { state: 'paid', orderId: payload.admin_graphql_api_order_id || null }
      : topic.endsWith('/failure') ? { state: 'failed', code: payload.error_code ? String(payload.error_code).toUpperCase() : 'UNEXPECTED_ERROR', message: payload.error_message || null }
        : { state: 'action', nextActionUrl: null };
    if (payload.admin_graphql_api_id && !charge.attempt_gid) this.write('UPDATE membership_charges SET attempt_gid = ? WHERE id = ?', String(payload.admin_graphql_api_id), charge.id);
    return this.chargeOutcome(charge.id, outcome);
  },

  /**
   * How a charge went, from its webhook or from asking Shopify. paid: the membership is paid up to the next cycle (and a
   * plan change takes effect), its damage charges are paid. failed: another try is set (Shopify's card update email
   * goes out on the first), or after the last one the membership ends. action: the member's bank wants a check; Shopify
   * emails them, and the result comes when they've done it. A charge already settled stays as it is.
   */
  async chargeOutcome(chargeId, outcome) {
    const first = this.chargeRow(chargeId);
    if (!first || ['paid', 'failed'].includes(first.status)) return { charge: chargeId, already: first?.status || null };
    const m = this.membershipRow(first.membership_id);
    if (!m) return { charge: chargeId, missing: first.membership_id };
    const admin = this.membershipsAdmin();
    let next = null;
    if (outcome.state === 'paid' && first.kind === 'renewal') {
      try {
        next = await this.cycleAfter(admin, m.id, first.cycle);
      } catch (error) {
        console.error('Lair: could not read the next billing cycle', error);
      }
    }
    let cardEmail = null;
    if (outcome.state === 'failed' && first.attempt === 1 && m.payment_method_id && admin.configured) {
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
    if (!charge || ['paid', 'failed'].includes(charge.status)) return { charge: chargeId, already: charge?.status || null };
    const row = this.membershipRow(charge.membership_id);
    const feeIds = parse(charge.fees, []);
    if (outcome.state === 'action') {
      this.write("UPDATE membership_charges SET status = 'challenged', next_action_url = ?, updated_at = ? WHERE id = ?", outcome.nextActionUrl || null, now, charge.id);
      return { charge: charge.id, status: 'challenged' };
    }
    if (outcome.state === 'paid') {
      this.write("UPDATE membership_charges SET status = 'paid', order_id = ?, completed_at = ?, updated_at = ? WHERE id = ?", outcome.orderId || null, now, now, charge.id);
      for (const id of feeIds) this.write("UPDATE damage_charges SET status = 'paid', resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'billing'", now, now, id);
      if (charge.kind === 'renewal') {
        const wasLate = row.status === 'past_due';
        const status = row.status === 'past_due' || row.status === 'ending' ? 'active' : row.status;
        // Cancelled while this renewal was being paid: they keep the month it paid for.
        const paidMonthEnds = next?.expectedAt ?? now + 30 * DAY;
        const cancelAt = row.status === 'cancelling' && (!row.cancel_at || row.cancel_at <= now) ? paidMonthEnds : row.cancel_at;
        this.write(
          `UPDATE memberships SET status = ?, tier = ?, next_cycle = ?, next_bill_at = ?, retry_at = NULL, failed_at = NULL, fail_count = 0, paid_through = ?,
             cancel_at = ?, updated_at = ? WHERE id = ?`,
          status, TIERS[charge.tier] ? charge.tier : row.tier, next?.index ?? charge.cycle + 1, next?.expectedAt ?? null, next?.expectedAt ?? null,
          cancelAt ?? null, now, row.id,
        );
        if (wasLate) this.tellPaymentSorted(this.membershipRow(row.id), charge, rules);
        if (row.status === 'cancelling' && row.cancel_at !== cancelAt) this.tellCancelled(this.membershipRow(row.id), rules);
      }
      return { charge: charge.id, status: 'paid' };
    }
    // failed
    this.write(
      "UPDATE membership_charges SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      outcome.code || null, trimmed(outcome.message, 300) || null, now, now, charge.id,
    );
    if (charge.kind === 'renewal' && row.status === 'cancelling') {
      // Cancelled while this renewal was being paid, and it didn't go through: no retries, it ends now (any damage
      // charges on it are billed on their own).
      for (const id of feeIds) this.write("UPDATE damage_charges SET status = 'due', charge_id = NULL, updated_at = ? WHERE id = ? AND status = 'billing'", now, id);
      this.write('UPDATE memberships SET cancel_at = ?, retry_at = NULL, updated_at = ? WHERE id = ?', now, now, row.id);
      return { charge: charge.id, status: 'failed', ending: true };
    }
    const failures = (row.fail_count || 0) + 1;
    const firstFailed = row.failed_at || now;
    const again = /FRAUD/.test(outcome.code || '') ? null : retryAt(firstFailed, failures);
    if (again && charge.kind === 'renewal' && ['active', 'past_due'].includes(row.status)) {
      this.write("UPDATE memberships SET status = 'past_due', fail_count = ?, failed_at = ?, retry_at = ?, updated_at = ? WHERE id = ?", failures, firstFailed, again, now, row.id);
      this.tellPaymentFailed(this.membershipRow(row.id), charge, { again, cardEmailSent: Boolean(cardEmail?.ok), code: outcome.code }, rules);
      return { charge: charge.id, status: 'failed', retryAt: again };
    }
    if (again && charge.kind === 'fees') {
      // A damage charge billed on its own (after cancelling) gets the same tries; the membership stays as it is.
      this.write('UPDATE memberships SET fail_count = ?, failed_at = ?, retry_at = ?, updated_at = ? WHERE id = ?', failures, firstFailed, again, now, row.id);
      return { charge: charge.id, status: 'failed', retryAt: again };
    }
    // The last try failed (or the bank flagged fraud): the membership ends and its unpaid damage charges go to staff.
    for (const id of feeIds) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ? AND status = 'billing'", now, id);
    const ending = charge.kind === 'renewal' || row.status === 'cancelling';
    this.write(
      `UPDATE memberships SET status = ?, end_reason = COALESCE(end_reason, ?), fail_count = ?, failed_at = ?, retry_at = NULL, updated_at = ? WHERE id = ?`,
      ending ? 'ending' : row.status, charge.kind === 'renewal' ? 'payment' : 'cancelled', failures, firstFailed, now, row.id,
    );
    this.tellPaymentGaveUp(this.membershipRow(row.id), charge, { code: outcome.code }, rules);
    return { charge: charge.id, status: 'failed', final: true };
  },

  /**
   * customer_payment_methods/update or /revoke: memberships on that card get their card details again, and one waiting
   * on a failed payment is tried again on the next maintenance run (a new card should work).
   */
  async paymentMethodChanged(payload, topic) {
    const pm = String(payload.admin_graphql_api_id || '');
    if (!pm) return { ignored: topic };
    const rows = this.sql.exec("SELECT * FROM memberships WHERE payment_method_id = ? AND status != 'ended'", pm).toArray();
    const results = [];
    for (const row of rows) results.push(await this.syncContract(row.id, { topic }));
    // --- no awaits from here on ---
    const now = Date.now();
    let retried = 0;
    if (topic.endsWith('/update')) {
      for (const row of rows) {
        const fresh = this.membershipRow(row.id);
        if (fresh?.status === 'past_due' && fresh.retry_at && fresh.retry_at > now) {
          this.write('UPDATE memberships SET retry_at = ?, updated_at = ? WHERE id = ?', now, now, fresh.id);
          retried += 1;
        }
      }
    }
    return { paymentMethod: pm, memberships: rows.length, retried, results };
  },

  /* ---------------- maintenance ---------------- */
  /**
   * The 10-minute run for memberships: webhooks in place (once a day), charges Shopify hasn't answered asked about,
   * claims that never reached Shopify sent again, damage charges past their notice made due, renewals and retries
   * billed (only with MEMBERSHIPS_BILLING on), and memberships that were cancelled or couldn't be paid ended.
   * Returns a summary for the status table. Never throws.
   */
  async membershipMaintenance(rules, now = Date.now(), { webhookUrl = null, force = false } = {}) {
    const admin = this.membershipsAdmin();
    const out = { configured: admin.configured, billing: this.membershipBillingOn() ? 'on' : 'off' };
    if (!admin.configured) return out;
    try {
      out.webhooks = await this.ensureMembershipWebhooks(webhookUrl, { force });
    } catch (error) {
      out.webhooks = { ok: false, reason: String(error.message || error).slice(0, 200) };
    }
    try {
      out.checked = await this.reconcileCharges(now);
      out.fees = this.feesFallDue(now);
      out.renewals = await this.fillRenewalDates();
      out.charged = this.membershipBillingOn() ? await this.chargeDue(rules, now) : [];
      if (!this.membershipBillingOn()) out.waiting = this.dueMemberships(Date.now()).length;
      out.ended = await this.endMemberships(rules, Date.now());
    } catch (error) {
      console.error('Lair: membership maintenance failed', error);
      out.error = String(error.message || error).slice(0, 300);
    }
    this.sql.exec('DELETE FROM membership_events WHERE at < ?', now - EVENT_KEEP_DAYS * DAY);
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
   * Charges Shopify hasn't answered: a claim that never got an attempt (the Worker stopped between the two) is sent
   * again with the same key, so Shopify bills it once; a pending one is asked about; a bank check left for days counts
   * as a failed try. Returns the charge ids looked at.
   */
  async reconcileCharges(now) {
    const admin = this.membershipsAdmin();
    const looked = [];
    const stale = this.sql.exec(
      "SELECT * FROM membership_charges WHERE status = 'claimed' AND attempt_gid IS NULL AND created_at < ? ORDER BY created_at LIMIT ?", now - CLAIM_STALE, CHECKS_A_RUN,
    ).toArray();
    for (const charge of stale) {
      looked.push(charge.id);
      await this.sendCharge(charge.id, admin);
    }
    const waiting = this.sql.exec(
      "SELECT * FROM membership_charges WHERE status IN ('pending', 'challenged') AND attempt_gid IS NOT NULL AND updated_at < ? ORDER BY updated_at LIMIT ?",
      now - RECONCILE_AFTER, CHECKS_A_RUN,
    ).toArray();
    for (const charge of waiting) {
      looked.push(charge.id);
      let state = null;
      try {
        state = await admin.attempt(charge.attempt_gid);
      } catch (error) {
        console.error('Lair: could not check a membership charge', error);
        continue;
      }
      if (state?.state === 'paid' || state?.state === 'failed') await this.chargeOutcome(charge.id, state);
      else if (state?.state === 'action' && charge.created_at < now - CHALLENGE_DAYS * DAY) await this.chargeOutcome(charge.id, { state: 'failed', code: 'AUTHENTICATION_REQUIRED', message: 'The bank check was never finished.' });
      else if (state?.state === 'action' && charge.status !== 'challenged') await this.chargeOutcome(charge.id, state);
      else this.write('UPDATE membership_charges SET updated_at = ? WHERE id = ?', Date.now(), charge.id);
    }
    return looked;
  },

  /** Damage charges whose notice ran out are due (they go on the next bill). No awaits. Returns how many. */
  feesFallDue(now) {
    const due = this.sql.exec("SELECT id FROM damage_charges WHERE status = 'notice' AND due_at <= ?", now).toArray();
    for (const f of due) this.write("UPDATE damage_charges SET status = 'due', updated_at = ? WHERE id = ? AND status = 'notice'", now, f.id);
    return due.length;
  },

  /** Memberships whose next bill date Shopify hasn't given yet are asked again. Returns how many were filled. */
  async fillRenewalDates() {
    const admin = this.membershipsAdmin();
    let filled = 0;
    const rows = this.sql.exec("SELECT * FROM memberships WHERE status IN ('active', 'past_due', 'cancelling') AND next_bill_at IS NULL LIMIT ?", CHECKS_A_RUN).toArray();
    for (const row of rows) {
      let next = null;
      try {
        if (row.next_cycle == null) {
          const contract = await admin.contract(row.id);
          next = contract ? await this.firstRenewal(admin, contract) : null;
        } else {
          next = (await admin.cycles(row.id, row.next_cycle, row.next_cycle)).find((c) => !c.billed && !c.skipped) || await this.cycleAfter(admin, row.id, row.next_cycle - 1);
        }
      } catch (error) {
        console.error('Lair: could not read billing cycles', error);
      }
      if (next) {
        this.write('UPDATE memberships SET next_cycle = ?, next_bill_at = ?, updated_at = ? WHERE id = ? AND next_bill_at IS NULL', next.index, next.expectedAt, Date.now(), row.id);
        filled += 1;
      }
    }
    return filled;
  },

  /**
   * Who's due a charge now: an active membership at its next bill date (not one cancelled to end by then), one waiting
   * on a failed payment whose next try is due, and a cancelled one with a damage charge due after its month ran out.
   * None with a charge still in flight. No awaits.
   */
  dueMemberships(now) {
    const open = (id) => this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND status IN ('claimed', 'pending', 'challenged')", id).toArray().length > 0;
    const rows = this.sql.exec(
      `SELECT * FROM memberships WHERE (status = 'active' AND next_bill_at IS NOT NULL AND next_bill_at <= ?)
         OR (status = 'past_due' AND retry_at IS NOT NULL AND retry_at <= ?)
         OR (status = 'cancelling' AND cancel_at IS NOT NULL AND cancel_at <= ? AND (retry_at IS NULL OR retry_at <= ?))
       ORDER BY COALESCE(retry_at, next_bill_at, cancel_at)`,
      now, now, now, now,
    ).toArray();
    return rows.filter((m) => !open(m.id) && m.next_cycle != null && (m.status !== 'cancelling' || this.dueFees(m.id, now).length > 0));
  },

  /** A membership's damage charges ready for a bill: due ones, and ones already on the cycle being retried. No awaits. */
  dueFees(membershipId, now) {
    return this.sql.exec("SELECT * FROM damage_charges WHERE membership_id = ? AND (status = 'billing' OR (status = 'due' AND due_at <= ?)) ORDER BY created_at", membershipId, now).toArray();
  },

  /**
   * Start a charge for each membership that's due (up to 20 a run): claim it (the charge row, and its damage charges),
   * put the damage charges on that cycle, then ask Shopify to bill it. Returns the charge ids started.
   */
  async chargeDue(rules, now) {
    const started = [];
    const admin = this.membershipsAdmin();
    for (const m of this.dueMemberships(now).slice(0, CHARGES_A_RUN)) {
      const charge = this.claimCharge(m.id, Date.now());
      if (!charge) continue;
      started.push(charge.id);
      const fees = parse(charge.fees, []);
      if (fees.length || charge.kind === 'fees') {
        const feeVariantId = this.feeVariantId();
        const rows = fees.map((id) => this.feeRow(id)).filter(Boolean);
        let edited = { ok: false, errors: [{ message: 'no damage charge product (run setup)' }] };
        if (feeVariantId) {
          try {
            edited = await admin.editCycle({
              contractId: m.id, cycle: charge.cycle, feeVariantId, dropPlan: charge.kind === 'fees',
              fees: rows.map((f) => ({ id: f.id, amount: f.amount, label: `${FEE_REASONS[f.reason] || f.reason}: ${f.title}${f.details ? ` (${f.details})` : ''}` })),
            });
          } catch (error) {
            edited = { ok: false, errors: [{ message: String(error.message || error) }] };
          }
        }
        if (!edited.ok && !this.dropChargeFees(charge.id, edited.errors, rules)) continue;
      }
      await this.sendCharge(charge.id, admin);
    }
    return started;
  },

  /**
   * Claim the next try at billing a membership's cycle: a charge row (attempt 1, or one more than the last try at that
   * cycle) with its idempotency key, its damage charges marked billing. A renewal's tier is the plan it bills (a plan
   * change takes effect when it's paid). Returns the charge row, or null when there's nothing to bill. No awaits.
   */
  claimCharge(membershipId, now) {
    const m = this.membershipRow(membershipId);
    if (!m || m.next_cycle == null) return null;
    if (this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND status IN ('claimed', 'pending', 'challenged')", m.id).toArray().length) return null;
    const kind = m.status === 'cancelling' ? 'fees' : 'renewal';
    const fees = this.dueFees(m.id, now);
    if (kind === 'fees' && !fees.length) return null;
    if (this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND cycle = ? AND status = 'paid'", m.id, m.next_cycle).toArray().length) return null;
    const last = this.sql.exec('SELECT MAX(attempt) AS n FROM membership_charges WHERE membership_id = ? AND cycle = ?', m.id, m.next_cycle).toArray()[0]?.n || 0;
    const attempt = last + 1;
    const tier = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    const amount = (kind === 'renewal' ? m.price ?? TIERS[tier].price : 0) + fees.reduce((sum, f) => sum + f.amount, 0);
    const id = makeId('mc');
    this.write(
      `INSERT INTO membership_charges (id, membership_id, cycle, attempt, idempotency_key, kind, status, amount, fees, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)`,
      id, m.id, m.next_cycle, attempt, chargeKey(m.id, m.next_cycle, attempt), kind, amount, JSON.stringify(fees.map((f) => f.id)), kind === 'renewal' ? tier : null, now, now,
    );
    for (const f of fees) this.write("UPDATE damage_charges SET status = 'billing', charge_id = ?, updated_at = ? WHERE id = ?", id, now, f.id);
    return this.chargeRow(id);
  },

  /**
   * Shopify wouldn't put the damage charges on the cycle: a renewal goes ahead without them (they wait, due, for the next
   * bill, and staff hear); a charge that was only damage is dropped. Returns whether to go on billing. No awaits.
   */
  dropChargeFees(chargeId, errors, rules) {
    const now = Date.now();
    const charge = this.chargeRow(chargeId);
    const feeIds = parse(charge.fees, []);
    const total = feeIds.reduce((sum, id) => sum + (this.feeRow(id)?.amount || 0), 0);
    for (const id of feeIds) this.write("UPDATE damage_charges SET status = 'due', charge_id = NULL, updated_at = ? WHERE id = ? AND status = 'billing'", now, id);
    const why = (errors || []).map((e) => e.message).filter(Boolean).join('; ') || 'Shopify said no';
    this.note({ membershipFees: { message: why.slice(0, 300), charge: chargeId, at: new Date(now).toISOString() } });
    if (charge.kind === 'fees') {
      this.write('DELETE FROM membership_charges WHERE id = ?', chargeId);
      return false;
    }
    this.write("UPDATE membership_charges SET fees = '[]', amount = ?, updated_at = ? WHERE id = ?", Math.max(0, charge.amount - total), now, chargeId);
    this.notifyStaff('Damage charges left off a library bill', {
      title: 'Damage charges left off a bill',
      intro: `Shopify wouldn't add the damage charges to a library bill, so the membership was billed without them. They'll go on the next bill. (${why})`,
      details: [['Membership', charge.membership_id], ['Charges', money(total)]],
    });
    return true;
  },

  /**
   * Ask Shopify to bill a claimed charge (again, with the same key, for a claim that never reached Shopify). A refusal
   * that can't change (the contract ended) ends the membership; Shopify being busy or down leaves the claim for the
   * next run; any other refusal counts as a failed try.
   */
  async sendCharge(chargeId, admin = this.membershipsAdmin()) {
    const charge = this.chargeRow(chargeId);
    if (!charge || charge.status !== 'claimed') return null;
    let result;
    try {
      result = await admin.bill({ contractId: charge.membership_id, cycle: charge.cycle, key: charge.idempotency_key });
    } catch (error) {
      console.error('Lair: could not start a membership charge', error);
      return { charge: charge.id, waiting: true };
    }
    // --- no awaits from here on ---
    const now = Date.now();
    const fresh = this.chargeRow(chargeId);
    if (!fresh || fresh.status !== 'claimed') return { charge: chargeId, already: fresh?.status || null };
    if (result.attemptId) {
      this.write("UPDATE membership_charges SET status = 'pending', attempt_gid = ?, updated_at = ? WHERE id = ?", result.attemptId, now, chargeId);
      return { charge: chargeId, status: 'pending' };
    }
    const codes = result.errors.map((e) => e.code);
    if (codes.includes('THROTTLED')) return { charge: chargeId, waiting: true };
    if (codes.some((c) => ['CONTRACT_TERMINATED', 'CONTRACT_NOT_FOUND'].includes(c))) {
      this.write("UPDATE membership_charges SET status = 'failed', error_code = ?, completed_at = ?, updated_at = ? WHERE id = ?", codes[0], now, now, chargeId);
      for (const id of parse(fresh.fees, [])) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ? AND status = 'billing'", now, id);
      this.write("UPDATE memberships SET status = 'ended', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, 'shopify:ended'), updated_at = ? WHERE id = ?", now, now, fresh.membership_id);
      return { charge: chargeId, ended: true };
    }
    this.write('UPDATE membership_charges SET updated_at = ? WHERE id = ?', now, chargeId);
    return this.chargeOutcome(chargeId, { state: 'failed', code: codes[0] || 'REFUSED', message: result.errors.map((e) => e.message).join('; ') });
  },

  /**
   * End what should end: a cancelled membership past its paid month with nothing left to bill (no charge in flight, no
   * damage charge in its notice, due or being billed) is cancelled in Shopify; one whose last payment try failed is
   * marked failed there. The member hears, and staff hear about games still at home. Returns the ids ended.
   */
  async endMemberships(rules, now) {
    const admin = this.membershipsAdmin();
    const ended = [];
    const rows = this.sql.exec(
      "SELECT * FROM memberships WHERE status = 'ending' OR (status = 'cancelling' AND cancel_at IS NOT NULL AND cancel_at <= ?) ORDER BY updated_at LIMIT ?", now, CHARGES_A_RUN,
    ).toArray();
    for (const row of rows) {
      if (this.sql.exec("SELECT 1 AS n FROM membership_charges WHERE membership_id = ? AND status IN ('claimed', 'pending', 'challenged')", row.id).toArray().length) continue;
      if (row.status === 'cancelling' && this.sql.exec("SELECT 1 AS n FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due', 'billing')", row.id).toArray().length) continue;
      const how = row.status === 'ending' && row.end_reason === 'payment' ? 'fail' : 'cancel';
      let result;
      try {
        result = await admin.endContract(row.id, how);
      } catch (error) {
        console.error('Lair: could not end a membership in Shopify', error);
        continue;
      }
      const terminated = result.errors.some((e) => e.code === 'CONTRACT_TERMINATED');
      if (result.errors.length && !terminated) {
        this.note({ membershipEnd: { membership: row.id, message: result.errors.map((e) => e.message).join('; ').slice(0, 300), at: new Date().toISOString() } });
        continue;
      }
      // --- no awaits from here on (for this one) ---
      const at = Date.now();
      const fresh = this.membershipRow(row.id);
      if (!fresh || fresh.status === 'ended') continue;
      this.write(
        "UPDATE memberships SET status = 'ended', shopify_status = ?, ended_at = ?, end_reason = COALESCE(end_reason, ?), retry_at = NULL, updated_at = ? WHERE id = ?",
        result.status || (how === 'fail' ? 'FAILED' : 'CANCELLED'), at, how === 'fail' ? 'payment' : 'cancelled', at, row.id,
      );
      this.settleEndedFees(row.id, at);
      if (how === 'cancel') this.tellMembershipEnded(this.membershipRow(row.id), rules);
      ended.push(row.id);
    }
    return ended;
  },

  /** A membership ended: its damage charges that never got billed go to staff to sort at the counter. No awaits. */
  settleEndedFees(membershipId, now) {
    const open = this.sql.exec("SELECT * FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due', 'billing')", membershipId).toArray();
    for (const f of open) this.write("UPDATE damage_charges SET status = 'unpaid', updated_at = ? WHERE id = ?", now, f.id);
    return open.length;
  },

  /* ---------------- members: change, cancel, keep, card ---------------- */
  /** The membership a member acts on: their current one (or, for resume, one still inside its paid month). */
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
   * games at a time change when that bill is paid, so moving up and back down before it can't skip paying). Returns
   * { membership }.
   */
  async changeMembership(input, who) {
    const m = this.ownMembership(who);
    const tier = String(input?.tier ?? '').trim().toLowerCase();
    if (!TIERS[tier]) throw new RuleError(MEMBERSHIP_MESSAGES.tier);
    if (m.status === 'past_due') throw new RuleError(MEMBERSHIP_MESSAGES.pastDue, 409);
    if (m.status !== 'active') throw new RuleError(MEMBERSHIP_MESSAGES.ending, 409);
    const billing = TIERS[m.billing_tier] ? m.billing_tier : m.tier;
    if (tier === billing) throw new RuleError(MEMBERSHIP_MESSAGES.same(TIERS[tier].name), 409);
    const plan = this.membershipPlans()?.plans?.[tier];
    if (!plan?.id || !m.line_id) throw new RuleError(MEMBERSHIP_MESSAGES.plansNotReady, 503);
    const price = Number.isInteger(plan.price) ? plan.price : TIERS[tier].price;
    let result;
    try {
      result = await this.membershipsAdmin().changePlan({ contractId: m.id, lineId: m.line_id, sellingPlanId: plan.id, sellingPlanName: TIERS[tier].name, price });
    } catch (error) {
      console.error('Lair: plan change failed', error);
      throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    }
    if (!result.ok) {
      if (result.errors.some((e) => e.code === 'HAS_FUTURE_EDITS')) throw new RuleError(MEMBERSHIP_MESSAGES.editsWaiting, 409);
      this.note({ membershipChange: { membership: m.id, message: result.errors.map((e) => e.message).join('; ').slice(0, 300), at: new Date().toISOString() } });
      throw new RuleError(MEMBERSHIP_MESSAGES.shopifyDown, 503);
    }
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    this.write('UPDATE memberships SET billing_tier = ?, selling_plan_id = ?, price = ?, plan_changed_at = ?, updated_at = ? WHERE id = ?', tier, plan.id, price, now, now, m.id);
    const fresh = this.membershipRow(m.id);
    this.tellPlanChanged(fresh, rules);
    return { membership: this.membershipForMember(who.customerId, now) };
  },

  /**
   * POST /me/membership/cancel: no more bills. A paid-up membership runs to the end of the month they've paid for (the
   * next bill date); any damage charge still owed is billed on its own then. One waiting on a failed payment ends now
   * (that month was never paid). Returns { membership }.
   */
  async cancelMembership(input, who) {
    const m = this.ownMembership(who);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const fresh = this.membershipRow(m.id);
    this.endBy(fresh, { by: 'member', now });
    this.tellCancelled(this.membershipRow(m.id), rules);
    return { membership: this.membershipForMember(who.customerId, now) };
  },

  /**
   * Set a membership to end (no awaits): 'end' (the default) at the end of the paid month; 'now' straight away (staff,
   * or a membership waiting on a failed payment). A charge in flight for an unpaid month is left to finish; if it's
   * paid, the paid month still runs out.
   */
  endBy(m, { by, now, when = 'end' }) {
    if (!['active', 'past_due', 'cancelling'].includes(m.status)) throw new RuleError(MEMBERSHIP_MESSAGES.notActive, 409);
    const inFlight = this.openCharge(m.id);
    if (when !== 'now' && m.status === 'active' && inFlight?.kind === 'renewal') {
      // A renewal is being paid right now: if it goes through they keep the month it paid for (cancel_at is set then);
      // if it fails, it ends straight away.
      this.write("UPDATE memberships SET status = 'cancelling', cancel_at = NULL, cancel_requested_at = ?, cancel_by = ?, updated_at = ? WHERE id = ?", now, by, now, m.id);
      return;
    }
    if (when === 'now' || m.status === 'past_due' || !m.next_bill_at) {
      for (const f of this.sql.exec("SELECT * FROM damage_charges WHERE membership_id = ? AND status = 'billing'", m.id).toArray()) {
        this.write("UPDATE damage_charges SET status = 'due', charge_id = NULL, updated_at = ? WHERE id = ?", now, f.id);
      }
      this.write(
        "UPDATE memberships SET status = 'cancelling', cancel_at = ?, cancel_requested_at = ?, cancel_by = ?, retry_at = NULL, fail_count = 0, failed_at = NULL, updated_at = ? WHERE id = ?",
        now, now, by, now, m.id,
      );
      return;
    }
    this.write('UPDATE memberships SET status = \'cancelling\', cancel_at = ?, cancel_requested_at = ?, cancel_by = ?, updated_at = ? WHERE id = ?', m.next_bill_at, now, by, now, m.id);
  },

  /** POST /me/membership/resume: keep a cancelled membership that hasn't run out yet. Returns { membership }. */
  async resumeMembership(input, who) {
    const m = this.ownMembership(who, { allowEnding: true });
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const fresh = this.membershipRow(m.id);
    if (fresh.status !== 'cancelling') throw new RuleError(MEMBERSHIP_MESSAGES.notCancelling, 409);
    if (!fresh.cancel_at || fresh.cancel_at <= now) throw new RuleError(MEMBERSHIP_MESSAGES.tooLate, 409);
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
   * POST /library/damage (staff): { customerId, loanId?, title?, reason, details?, amount (cents) }. The member gets an
   * itemised notice now; after 7 days (unless it's waived, disputed, or the bits come back) it goes on their next bill.
   * Returns { charge }.
   */
  async createDamageCharge(input, who) {
    this.requireStaff(who, ['library', 'money']);
    const rules = await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const customerId = trimmed(input?.customerId, 40);
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
      || this.membershipRows(member.customer_id).find((r) => ['cancelling', 'ending'].includes(r.status)) || null;
    const id = makeId('dc');
    const by = who.customerId ? `staff:${who.customerId}` : 'staff';
    this.write(
      `INSERT INTO damage_charges (id, customer_id, membership_id, loan_id, variant_id, title, reason, details, amount, status, due_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'notice', ?, ?, ?, ?)`,
      id, member.customer_id, m?.id || null, loan?.id || null, loan?.variant_id || null, title, reason, trimmed(input?.details, 300) || null, amount,
      now + FEE_NOTICE_DAYS * DAY, by, now, now,
    );
    const fee = this.feeRow(id);
    const emailed = this.tellDamage(fee, member, m, rules);
    if (emailed) this.write('UPDATE damage_charges SET emailed_at = ? WHERE id = ?', now, id);
    return { charge: { ...this.feeView(this.feeRow(id)), emailed, billable: Boolean(m) } };
  },

  /** GET /library/damage?status=open|all&customerId= (staff): damage charges, newest first, with who they're for. */
  async listDamageCharges(url, who) {
    this.requireStaff(who, ['library', 'money']);
    await this.rules();
    // --- no awaits from here on ---
    const status = url.searchParams.get('status') === 'all' ? 'all' : 'open';
    const customerId = trimmed(url.searchParams.get('customerId'), 40);
    const where = [status === 'open' ? "status IN ('notice', 'due', 'billing', 'disputed', 'unpaid')" : '1 = 1', customerId ? 'customer_id = ?' : '1 = 1'].join(' AND ');
    const rows = this.sql.exec(`SELECT * FROM damage_charges WHERE ${where} ORDER BY created_at DESC LIMIT 200`, ...(customerId ? [customerId] : [])).toArray();
    return {
      charges: rows.map((f) => {
        const member = this.memberRow(f.customer_id);
        return { ...this.feeView(f), customerId: f.customer_id, name: member?.name || member?.first_name || '', code: member?.code || '', membershipId: f.membership_id || null, by: f.created_by || null };
      }),
    };
  },

  /**
   * POST /library/damage/:id/update (staff, money): { action: 'waive' | 'reinstate' | 'amount', amount?, note? }.
   * waive: nothing to pay (the member hears). reinstate: back on (due again if its notice has run out). amount: a new
   * amount while it's still in its notice or disputed. A charge being paid right now can't change. Returns { charge }.
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
    const inFlight = f.status === 'billing' && f.charge_id && ['claimed', 'pending', 'challenged'].includes(this.chargeRow(f.charge_id)?.status);
    if (action === 'waive') {
      if (inFlight) throw new RuleError(MEMBERSHIP_MESSAGES.feeLocked, 409);
      if (!['notice', 'due', 'billing', 'disputed', 'unpaid'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      this.write("UPDATE damage_charges SET status = 'waived', charge_id = NULL, resolved_at = ?, resolved_by = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?", now, by, note, now, f.id);
      this.tellWaived(this.feeRow(f.id), rules);
    } else if (action === 'reinstate') {
      if (!['waived', 'disputed', 'unpaid'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      const next = f.due_at <= now ? 'due' : 'notice';
      this.write('UPDATE damage_charges SET status = ?, resolved_at = NULL, resolved_by = NULL, note = COALESCE(?, note), updated_at = ? WHERE id = ?', next, note, now, f.id);
    } else if (action === 'amount') {
      const amount = Number(input?.amount);
      if (!Number.isInteger(amount) || amount < FEE_MIN || amount > FEE_MAX) throw new RuleError(MEMBERSHIP_MESSAGES.feeAmount);
      if (!['notice', 'disputed'].includes(f.status)) throw new RuleError(MEMBERSHIP_MESSAGES.feeChange, 409);
      this.write('UPDATE damage_charges SET amount = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?', amount, note, now, f.id);
    } else {
      throw new RuleError(MEMBERSHIP_MESSAGES.feeAction);
    }
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
    this.endBy(m, { by: who.customerId ? `staff:${who.customerId}` : 'staff', now, when });
    this.tellCancelled(this.membershipRow(m.id), rules);
    return { membership: this.staffMembershipView(this.membershipRow(m.id), now) };
  },

  /** POST /memberships/:id/retry (staff, money): try a failed payment again on the next run (within 10 minutes). */
  async staffRetryMembership(id, who) {
    this.requireStaff(who, 'money');
    await this.rules();
    // --- no awaits from here on ---
    const now = Date.now();
    const m = this.membershipRow(trimmed(id, 40));
    if (!m) throw new RuleError(MEMBERSHIP_MESSAGES.noneStaff, 404);
    if (m.status !== 'past_due') throw new RuleError(MEMBERSHIP_MESSAGES.retryNotDue, 409);
    this.write('UPDATE memberships SET retry_at = ?, updated_at = ? WHERE id = ?', now, now, m.id);
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
      details: [['Plan', `${t.name}, ${money(m.price ?? t.price)} a month`], ['Games at a time', String(t.games)], ['Next bill', billDay(m.next_bill_at, rules.tz)], ['Card', cardWords(parse(m.card, null))]],
      outro: [
        'Reserve a game on its page in the library, or scan the box in the Lair to borrow it. Your member code is in My Lair.',
        `Look after the games, friend. Missing parts or damage are charged up to the game's RRP, and we always email you first and give you ${FEE_NOTICE_DAYS} days to bring the bits back or tell us we've got it wrong.`,
        'Change plans or cancel any time in My Lair.',
      ],
    });
    this.notifyStaff(`New library member: ${to.name || to.code || 'someone'} (${t.name})`, {
      title: 'A new library member',
      intro: `${to.name || 'Someone'} joined the library on ${t.name} (${plural(t.games, 'game', 'games')} at a time).`,
      details: [['Member', to.name], ['Member code', to.code], ['Plan', `${t.name}, ${money(m.price ?? t.price)} a month`], ['Email', to.email]],
    });
  },

  tellPaymentFailed(m, charge, { again, cardEmailSent }, rules) {
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, "Your library payment didn't go through", {
      title: "Your payment didn't go through",
      intro: [`Kia ora ${to.first},`, `We tried to take your ${money(charge.amount)} library payment, but it didn't go through.`],
      details: [['Amount', money(charge.amount)], ['Card', cardWords(parse(m.card, null))], ["We'll try again", billDay(again, rules.tz)]],
      outro: [
        cardEmailSent
          ? "Shopify has emailed you a secure link to update your card. Once it's updated, Gobgob tries again within the hour."
          : "Update your card in My Lair (Library), and Gobgob tries again within the hour.",
        "Until it's paid, borrowing new games is paused. You can keep the games you have.",
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

  tellPaymentGaveUp(m, charge, { code }, rules) {
    const to = this.membershipContact(m.customer_id);
    const t = TIERS[m.tier];
    const home = this.gamesAtHome(m.customer_id);
    if (charge.kind === 'renewal') {
      this.membershipMail(m.customer_id, 'Your library membership has ended', {
        title: 'Your membership has ended',
        intro: [`Kia ora ${to.first},`, `We couldn't take your library payment after ${plural(MAX_ATTEMPTS, 'try', 'tries')}, so your ${t?.name || ''} membership has ended.`.replace('  ', ' ')],
        details: home.length ? [['Games at home', home.join(', ')]] : [],
        outro: [
          ...(home.length ? ['Please bring back the games you have at home as soon as you can.'] : []),
          "Want to come back? Join again any time on the library page. Gobgob will keep your spot on the shelf warm.",
        ],
      });
    }
    this.notifyStaff(`Library payment failed for good: ${to.name || to.code || 'a member'}`, {
      title: 'A library payment that failed for good',
      intro: charge.kind === 'renewal'
        ? `${to.name || 'A member'}'s library payment failed ${plural(MAX_ATTEMPTS, 'time', 'times')}${/FRAUD/.test(code || '') ? ' (the bank flagged it as fraud)' : ''}, so their membership is ending.${home.length ? ' They still have games at home.' : ''}`
        : `${to.name || 'A member'}'s damage charge couldn't be taken. It's on the staff page under Damage to sort at the counter.`,
      details: [['Member', to.name], ['Member code', to.code], ['Amount', money(charge.amount)], ['Last error', code || ''], ['Games at home', home.join(', ')]],
    });
  },

  tellPlanChanged(m, rules) {
    const now = TIERS[m.tier];
    const next = TIERS[m.billing_tier];
    const to = this.membershipContact(m.customer_id);
    this.membershipMail(m.customer_id, `Your library plan changes to ${next.name}`, {
      title: `Moving to ${next.name}`,
      intro: [`Kia ora ${to.first}!`, `From your next bill on ${billDay(m.next_bill_at, rules.tz)}, you're on ${next.name}: ${plural(next.games, 'game', 'games')} at a time for ${money(m.price ?? next.price)} a month.`],
      outro: [now.key === next.key ? '' : `Until then you keep ${now.name} (${plural(now.games, 'game', 'games')} at a time).`, 'Changed your mind? Pick another plan in My Lair before then.'].filter(Boolean),
    });
  },

  tellCancelled(m, rules) {
    const t = TIERS[m.tier];
    const to = this.membershipContact(m.customer_id);
    const owed = this.sql.exec("SELECT COUNT(*) AS n FROM damage_charges WHERE membership_id = ? AND status IN ('notice', 'due', 'billing')", m.id).toArray()[0]?.n || 0;
    const ends = m.cancel_at && m.cancel_at > Date.now() + HOUR;
    this.membershipMail(m.customer_id, 'Your library membership is cancelled', {
      title: 'Membership cancelled',
      intro: [`Kia ora ${to.first},`, ends
        ? `Your ${t.name} membership runs until ${billDay(m.cancel_at, rules.tz)}, and there are no more bills after that.`
        : `Your ${t.name} membership has ended, and there are no more bills.`],
      outro: [
        ends ? 'Please bring back any games you have at home by then.' : 'Please bring back any games you have at home.',
        ...(owed ? ["Any damage charge still owed is billed on its own, without another month's fee."] : []),
        ...(ends ? ['Changed your mind? Keep your membership in My Lair before then.'] : []),
      ],
    });
  },

  tellMembershipEnded(m, rules) {
    const t = TIERS[m.tier];
    const to = this.membershipContact(m.customer_id);
    const home = this.gamesAtHome(m.customer_id);
    this.membershipMail(m.customer_id, 'Your library membership has ended', {
      title: 'Your membership has ended',
      intro: [`Thanks for borrowing with us, ${to.first}! Your ${t.name} membership has ended.`],
      details: home.length ? [['Games at home', home.join(', ')]] : [],
      outro: [...(home.length ? ['Please bring back the games you have at home as soon as you can.'] : []), 'Come back any time: join again on the library page.'],
    });
    if (home.length) {
      this.notifyStaff(`Library membership ended with games at home: ${to.name || to.code || 'a member'}`, {
        title: 'Games still out',
        intro: `${to.name || 'A member'}'s membership has ended, and they still have games at home.`,
        details: [['Member', to.name], ['Member code', to.code], ['Games at home', home.join(', ')], ['Email', to.email]],
      });
    }
  },

  /** The itemised notice for a new damage charge. Returns whether it went. No awaits. */
  tellDamage(fee, member, m, rules) {
    const to = this.membershipContact(fee.customer_id);
    const lost = fee.reason === 'lost';
    const when = billDay(fee.due_at, rules.tz);
    const bill = m?.next_bill_at && m.next_bill_at > fee.due_at && ['active', 'past_due'].includes(m.status) ? billDay(m.next_bill_at, rules.tz) : null;
    return this.membershipMail(fee.customer_id, lost ? `${fee.title} hasn't come back` : `About ${fee.title}: a charge for ${FEE_REASONS[fee.reason].toLowerCase()}`, {
      title: lost ? "A library game hasn't come back" : 'A library game came back with a problem',
      intro: [`Kia ora ${to.first},`, lost
        ? `${fee.title} hasn't come back to the library, so there's a charge to replace it.`
        : `${fee.title} came back with a problem${fee.details ? `: ${fee.details}` : ''}. There's a charge to put it right.`],
      details: [
        ['Game', fee.title], ["What's wrong", `${FEE_REASONS[fee.reason]}${fee.details ? `: ${fee.details}` : ''}`], ['Charge', money(fee.amount)],
        ['Goes on your bill', m ? (bill ? `${bill} (not before ${when})` : `Your next bill after ${when}`) : `Not before ${when}`],
      ],
      outro: [
        lost ? `Found it? Bring it back before ${when} and we'll cancel the charge.` : `Found the missing bits? Bring them in before ${when} and we'll cancel the charge.`,
        "Think we've got it wrong? Tell us in My Lair (Library) or reply to this email, and the charge waits while we sort it out.",
      ],
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
