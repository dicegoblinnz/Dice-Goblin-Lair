// Talking to the Lair app: the Cloudflare Worker in this repository (src/), not through the shop's app proxy.
// Every call carries the POS session token (a JWT signed with the app's client secret), which the Worker checks.
// Routes: API contract v4, section 7.

/** Where the Lair app lives. */
export const LAIR_URL = 'https://dice-goblin-lair.dicegoblinnz.workers.dev';

const TIMEOUT_MS = 15000;

/** What staff see when the iPad can't get to the Lair app at all. */
export const OFFLINE = "Can't reach the Lair app. Check the iPad's internet and try again.";

/**
 * A failed call, with a message staff can act on.
 * kind: 'offline' | 'timeout' | 'login' | 'not-found' | 'busy' | 'server' | 'refused'
 */
export class LairError extends Error {
  /** @param {string} kind @param {string} message @param {number} [status] */
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'LairError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Today's roster: `{ day, now, groups }`, each group `{ key, kind, title, start, end, tables, rows }`.
 * @returns {Promise<import('./today.js').Today>}
 */
export async function getToday() {
  const data = await call('GET', '/pos/today', null, "The Lair app doesn't have the Today list yet. It needs its latest update.");
  return { ...data, groups: Array.isArray(data?.groups) ? data.groups : [] };
}

/**
 * Looks a code up without checking anyone in: a booking or sign-up `{ type, row, group }`, a member
 * `{ type: 'member', member, rows, tab, passes }` or a pass `{ type: 'pass', pass }`.
 * @param {string} code
 * @returns {Promise<any>}
 */
export function scanCode(code) {
  return call('POST', '/pos/scan', { code }, 'No booking, member or pass with that code.');
}

/**
 * Checks one person in. `pass` is a pass code, 'none' (don't use the booking's pass) or left out (use the
 * booking's saved pass, if any). Answers `{ row, lines, customer, pass, notice }`.
 * @param {{ id: string | number, type: string, pass?: string | null, force?: boolean }} input
 * @returns {Promise<any>}
 */
export function checkIn({ id, type, pass, force }) {
  /** @type {Record<string, unknown>} */
  const body = { id, type };
  if (pass) body.pass = pass;
  if (force) body.force = true;
  return call('POST', '/pos/checkin', body, "That booking isn't in the Lair app any more. Refresh the list.");
}

/**
 * Checks in everything a member has booked today. Answers `{ rows, lines, customer, notices }`.
 * @param {unknown} customerId
 * @returns {Promise<any>}
 */
export function checkInMember(customerId) {
  return call('POST', '/pos/checkin-member', { customerId }, 'The Lair app has no member with that number.');
}

/**
 * One share of a bill as a cart line (split the bill). `amount` is in cents; left out, it's one person's share.
 * Answers `{ row, line }`.
 * @param {{ id: string | number, type: string, amount?: number | null }} input
 * @returns {Promise<any>}
 */
export function shareBill({ id, type, amount }) {
  /** @type {Record<string, unknown>} */
  const body = { id, type };
  if (typeof amount === 'number' && amount > 0) body.amount = Math.round(amount);
  return call('POST', '/pos/share', body, "That booking isn't in the Lair app any more. Refresh the list.");
}

/**
 * Gives a pass use back: the sessions go back on the pass, and the booking owes what the pass covered. The same as
 * the staff page's undo. Answers `{ pass, row }`.
 * @param {string} useId from a check-in answer's `pass.useId`, or the pass's own `uses`
 * @returns {Promise<any>}
 */
export function undoPassUse(useId) {
  return call('POST', '/pos/pass-undo', { useId }, 'That pass use could not be found. Undo it on the staff page, under Passes.');
}

/**
 * Tells the Lair app a member's tab is in the cart (so they can't change it while they pay). Answers `{ tab }`.
 * @param {string | number} tabId
 * @returns {Promise<any>}
 */
export function tabAdded(tabId) {
  return call('POST', `/pos/tab/${encodeURIComponent(String(tabId))}/added`, {}, 'That tab is gone. Scan their member code again.');
}

/**
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {object | null} body
 * @param {string} notFound what to say for a 404 when the Lair app doesn't say anything useful
 */
async function call(method, path, body, notFound) {
  if (shopify.connectivity?.current?.value?.internetConnected === 'Disconnected') throw new LairError('offline', OFFLINE);
  /** @type {string | undefined} */
  let token;
  try {
    token = await shopify.session.getSessionToken();
  } catch {
    token = undefined;
  }
  if (!token) {
    throw new LairError(
      'login',
      "The account this POS is logged in with isn't allowed to use the Dice Goblin Lair app. Ask a manager to give it access in Shopify admin (Settings → Users), or log in to POS with the owner's account.",
    );
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Response} */
  let response;
  try {
    const request = fetch(`${LAIR_URL}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new LairError('timeout', "The Lair app didn't answer in time. Check the iPad's internet and try again."));
      }, TIMEOUT_MS);
    });
    response = /** @type {Response} */ (await Promise.race([request, timeout]));
  } catch (error) {
    if (error instanceof LairError) throw error;
    throw new LairError('offline', OFFLINE);
  } finally {
    clearTimeout(timer);
  }

  /** @type {any} */
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.ok) return data ?? {};
  throw errorFor(response.status, data, notFound);
}

/**
 * The Lair app's own sentence for a refusal wins; these only fill in when it doesn't say anything useful.
 * @param {number} status
 * @param {any} data
 * @param {string} notFound
 */
export function errorFor(status, data, notFound) {
  const raw = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : '';
  const said = raw.trim();
  if (status === 401 || (status === 403 && !said)) {
    return new LairError(
      'login',
      `${said ? `The Lair app said: "${said}" ` : "The Lair app didn't accept this POS login. "}Close Lair check-in and open it again. If it keeps happening, tell a manager.`,
      status,
    );
  }
  if (status === 404) return new LairError('not-found', said && !/^not found\.?$/i.test(said) ? said : notFound, status);
  if (status === 429) return new LairError('busy', said || 'Too many tries in a row. Wait a few seconds, then try again.', status);
  if (status >= 500) {
    return new LairError('server', `The Lair app had a problem (error ${status})${said ? `: ${said}` : ''}. Try again in a minute.`, status);
  }
  return new LairError('refused', said || `The Lair app said no (error ${status}).`, status);
}

/**
 * @typedef {{ title: string, message: string, tone: 'critical' | 'warning' | 'info', retry: boolean }} Problem
 *   What a banner says when something fails. retry: a "Try again" button makes sense.
 */

/**
 * The banner for a failed call.
 * @param {unknown} error
 * @returns {Problem}
 */
export function problemFor(error) {
  if (!(error instanceof LairError)) {
    const text = error instanceof Error && error.message ? error.message.trim().replace(/[.!]+$/, '') : '';
    return { title: 'Something went wrong', message: text ? `${text}. Try again.` : 'Try again.', tone: 'critical', retry: true };
  }
  const message = error.message;
  switch (error.kind) {
    case 'offline':
      // OFFLINE, split into the banner's heading and its sentence.
      return { title: "Can't reach the Lair app", message: "Check the iPad's internet and try again.", tone: 'critical', retry: true };
    case 'timeout':
      return { title: 'No answer from the Lair app', message, tone: 'critical', retry: true };
    case 'login':
      return { title: error.status ? "The Lair app didn't accept this POS login" : 'This POS login has no access', message, tone: 'critical', retry: false };
    case 'not-found':
      return { title: 'Not found', message, tone: 'warning', retry: false };
    case 'busy':
      return { title: 'Slow down a moment', message, tone: 'warning', retry: true };
    case 'server':
      return { title: 'The Lair app had a problem', message, tone: 'critical', retry: true };
    default:
      return { title: "That didn't work", message, tone: 'warning', retry: false };
  }
}
