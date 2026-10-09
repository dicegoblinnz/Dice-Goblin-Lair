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
