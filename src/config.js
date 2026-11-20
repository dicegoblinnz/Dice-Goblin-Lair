// Dice Goblin Lair — settings that live outside the code.
//
// The Shopify app's client ID and secret, the setup key, the theme to read settings from and the email keys
// are kept in the D1 database "dice-goblin-lair-config" (table `config`, bound as CONFIG), so they can be
// changed without touching the code or the Cloudflare dashboard. A Worker variable or secret with the same
// name always wins over the database.
//
// The app also writes what it last saw (Shopify login, payment webhook, rooms and hours) into the `status`
// table, so anyone with access to the Cloudflare account can check its health without opening a URL.

export const CONFIG_KEYS = [
  'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SETUP_KEY', 'THEME_ID',
  'RESEND_API_KEY', 'FROM_EMAIL', 'REPLY_TO', 'STAFF_EMAIL', 'JSON_ONLY',
  // Library memberships (src/memberships.js): the Lair Memberships app's credentials (keep the secret a Worker secret),
  // the membership product its plans go on, the damage charge product's variant, the switch that lets it charge cards
  // ('on'; anything else and it only keeps its records up to date), and Simplee's tags ('off' once everyone has moved
  // across: until then someone with no Lair membership borrows on their Simplee tags).
  'MEMBERSHIPS_CLIENT_ID', 'MEMBERSHIPS_CLIENT_SECRET', 'MEMBERSHIPS_PRODUCT_ID', 'MEMBERSHIPS_FEE_VARIANT_ID', 'MEMBERSHIPS_BILLING',
  'MEMBERSHIPS_SIMPLEE_TAGS',
  // Round 17, Help me pick: 'off' stops Workers AI tagging new library games; PICK_AI_MODEL names another model for it
  'PICK_AI', 'PICK_AI_MODEL',
  // Round 17: postal library swaps' postage by area, in cents (JSON); the website's rates when it isn't set
  'LIBRARY_POSTAGE',
  // Round 19: where the weekly numbers go on Monday morning (an email address), 'off' for nowhere; STAFF_EMAIL when unset
  'REPORT_EMAIL',
  // Round 36: where the owner's email about a till sale with a discount past 20% goes: one email address, or 'off' for
  // nowhere. With nothing set it goes to the shop owner's own address as Shopify has it (Settings, Store details). It's
  // the owner's alone: it never goes to STAFF_EMAIL.
  'DISCOUNT_EMAIL',
  // Round 40: the walk-ins list's password (src/walkins.js), at least 24 characters: Google Ads' Data Manager reads
  // /ads/walkins.csv with the username google and this password. Never in the code: the repository is public.
  'ADS_FEED_KEY',
  // 17 Nov 2026 (contract v45-guard): Cloudflare Turnstile, the robot check on the website's forms for anyone not
  // logged in. Off until both are set. The site key is public (the page shows it); keep the secret a Worker secret.
  // GUEST_NIGHT_CAP: the most bookings and sign-ups made without an account for any one day (20 when unset; 'off')
  'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'GUEST_NIGHT_CAP',
  // Round 48 (contract v48-delivery): GoSweetSpot, the courier account delivery is priced from. GSS_ACCESS_KEY is a
  // Worker secret only: never in this table or GitHub. GSS_SITE_ID is the account's site number. GSS_COST_HAS_GST: 'yes'
  // if GoSweetSpot's Cost already has GST in it (unset: GST is added). With no key, delivery stays at the flat rates.
  'GSS_ACCESS_KEY', 'GSS_SITE_ID', 'GSS_COST_HAS_GST',
];
const TTL = 60_000;
let cache = null;

/** Config from D1, cached for a minute per Worker instance. Never throws: on errors the last good copy is used. */
export async function loadConfig(env) {
  if (cache && Date.now() - cache.at < TTL) return cache.values;
  let values = cache?.values || {};
  if (env.CONFIG) {
    try {
      const { results } = await env.CONFIG.prepare('SELECT key, value FROM config').all();
      values = Object.fromEntries(results.filter((r) => CONFIG_KEYS.includes(r.key)).map((r) => [r.key, r.value]));
    } catch (error) {
      console.error('Lair: could not read the config database', error);
    }
  }
  cache = { at: Date.now(), values };
  return values;
}

/** env with config filled in: Worker variables and secrets first, then the database. */
export async function withConfig(env) {
  const values = await loadConfig(env);
  const merged = { ...env };
  for (const key of CONFIG_KEYS) if (!merged[key] && values[key]) merged[key] = values[key];
  return merged;
}

/** Record what the app last saw, for health checks. Never throws. */
export async function recordStatus(env, entries) {
  if (!env.CONFIG) return;
  try {
    const at = new Date().toISOString();
    const statement = env.CONFIG.prepare(
      'INSERT INTO status (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at',
    );
    await env.CONFIG.batch(Object.entries(entries).map(([key, value]) => statement.bind(key, typeof value === 'string' ? value : JSON.stringify(value), at)));
  } catch (error) {
    console.error('Lair: could not record status', error);
  }
}

/** For tests */
export function resetConfigCache() {
  cache = null;
}
