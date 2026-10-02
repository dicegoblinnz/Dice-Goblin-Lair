// Talking to the Lair app: the Cloudflare Worker in this repository (src/), not through the shop's app proxy.
// Every call carries the POS session token (a JWT signed with the app's client secret), which the Worker checks.

/** Where the Lair app lives. */
export const LAIR_URL = 'https://dice-goblin-lair.dicegoblinnz.workers.dev';

const TIMEOUT_MS = 15000;

/**
 * A failed call, with a message staff can act on.
 * kind: 'offline' | 'network' | 'timeout' | 'login' | 'not-found' | 'busy' | 'server' | 'refused'
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
 * Look up or check in a booking or sign-up.
 * `preview: true` asks the Lair app to look the code up without checking anyone in. An older Lair app ignores it
 * and checks in straight away; the screen copes with both (the answer's `checkedIn` says what happened).
 * @param {{ code: string, preview?: boolean, force?: boolean }} body
 * @returns {Promise<import('./codes.js').CheckInAnswer>}
 */
export function checkIn(body) {
  return post('/pos/checkin', body, `No booking or sign-up with the code ${body.code}.`);
}

/**
 * Look up a member card. Answers { customerId, name, rolls }.
 * @param {string} code DGC-<customer id>
 * @returns {Promise<{ customerId?: unknown, name?: string, rolls?: unknown }>}
 */
export function lookUpMember(code) {
  return post('/pos/member', { code }, `No member with the card ${code}.`);
}

/**
 * @param {string} path
 * @param {object} body
 * @param {string} notFound what to say when the Lair app doesn't know the code
 */
async function post(path, body, notFound) {
  if (shopify.connectivity?.current?.value?.internetConnected === 'Disconnected') {
    throw new LairError('offline', 'This POS is offline. Check the Wi-Fi, then try again.');
  }
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
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Response} */
  let response;
  try {
    const request = fetch(`${LAIR_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new LairError('timeout', "The Lair app didn't answer in time. Check the Wi-Fi, then try again."));
      }, TIMEOUT_MS);
    });
    response = /** @type {Response} */ (await Promise.race([request, timeout]));
  } catch (error) {
    if (error instanceof LairError) throw error;
    throw new LairError('network', "Couldn't reach the Lair app. Check the Wi-Fi, then try again.");
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

  const said = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : '';
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new LairError(
      'login',
      `The Lair app didn't accept this POS login${said ? ` ("${said}")` : ''}. Close Lair check-in and open it again. If it keeps happening, tell a manager.`,
      status,
    );
  }
  if (status === 404) throw new LairError('not-found', said || notFound, status);
  if (status === 429) throw new LairError('busy', said || 'Too many tries in a row. Wait a few seconds, then try again.', status);
  if (status >= 500) {
    throw new LairError('server', `The Lair app had a problem (error ${status})${said ? `: ${said}` : ''}. Try again in a minute.`, status);
  }
  throw new LairError('refused', said || `The Lair app said no (error ${status}).`, status);
}
