// Round 5 (e): birthday gifts, POST /members/:customerId/gift (staff). A gift with store credit, sessions, dice rolls, a
// product and an email does each part once: one storeCreditAccountCredit, a "Birthday gift" pass, the rolls on their
// account, one discountCodeBasicCreate for that customer and variant, and one email through Resend. A part Shopify
// refuses lands in problems ({ part, message }) and the others still go through.
import { proxy, fake, check, summary } from './client.mjs';

const VARIANT = '44114682347623';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = async () => (await fake('GET', 'calls')).length;
/** One gift, with what it did at the fake Shopify and Resend in the meantime */
async function give(customerId, body) {
  const callsFrom = await calls();
  const emailsFrom = (await fake('GET', 'emails')).length;
  const r = await proxy('POST', `members/${customerId}/gift`, { customer: '7001', body });
  await sleep(800); // the email goes out after the reply
  const made = (await fake('GET', 'calls')).slice(callsFrom);
  const emails = (await fake('GET', 'emails')).slice(emailsFrom);
  return { ...r, gift: r.data.gift, credits: made.filter((x) => x.op === 'Credit'), prizes: made.filter((x) => x.op === 'Prize'), emails };
}
const me = async (id) => (await proxy('GET', 'me', { customer: id })).data;
const staffPass = async (code) => (await proxy('GET', `passes?q=${encodeURIComponent(code)}&status=all`, { customer: '7001' })).data.passes?.find((p) => p.code === code) || null;

const notStaff = await proxy('POST', 'members/7102/gift', { customer: '7101', body: { rolls: 1 } });
check('a member can\'t give gifts (403)', notStaff.status === 403, notStaff.data);
const empty = await proxy('POST', 'members/7102/gift', { customer: '7001', body: { note: 'Nothing else' } });
check('a gift needs at least one part', empty.status >= 400 && empty.status < 500 && Boolean(empty.data.error), `${empty.status} ${empty.data.error}`);
const nobody = await proxy('POST', 'members/999999/gift', { customer: '7001', body: { rolls: 1 } });
check('no such member: 404', nobody.status === 404, nobody.data);

/* 1. Everything, for Kiri */
const kiriBefore = await me('7102');
const all = await give('7102', { credit: 7.5, sessions: 3, rolls: 2, productVariantId: VARIANT, productTitle: 'Snacks ($4 Snack)', note: 'Happy birthday from the Lair crew!', notify: true });
const g = all.gift || {};
check('the gift: every part, nothing went wrong', all.status === 200 && g.credit === 750 && g.sessions === 3 && g.rolls === 2 && /^HBD-/.test(g.product?.code || '') && g.product.title === 'Snacks ($4 Snack)' && Boolean(g.passCode) && g.emailed === true && Array.isArray(g.problems) && g.problems.length === 0, all.data);
check('store credit: one storeCreditAccountCredit, $7.50 to Kiri', all.credits.length === 1 && all.credits[0].variables.id === 'gid://shopify/Customer/7102' && all.credits[0].variables.creditInput.creditAmount.amount === '7.50', all.credits.map((c) => c.variables));
const d = all.prizes[0]?.variables?.discount || {};
check('the product: one discount code, 100% off that variant, only for Kiri, one use, for 30 days', all.prizes.length === 1 && d.code === g.product?.code && d.customerGets?.value?.percentage === 1 && d.customerGets.items?.products?.productVariantsToAdd?.[0] === `gid://shopify/ProductVariant/${VARIANT}` && d.context?.customers?.add?.[0] === 'gid://shopify/Customer/7102' && d.usageLimit === 1 && Math.abs(Date.parse(d.endsAt) - Date.now() - 30 * 86400000) < 3600000, d);
const pass = g.passCode ? await staffPass(g.passCode) : null;
check('the sessions: a "Birthday gift: 3 sessions" pass on Kiri\'s account', pass && pass.label === 'Birthday gift: 3 sessions' && pass.sessionsTotal === 3 && pass.source === 'birthday' && pass.holder.customerId === '7102' && pass.status === 'active', pass);
const kiriAfter = await me('7102');
check('the rolls: two more to roll in My Lair', kiriAfter.rolls?.available === (kiriBefore.rolls?.available || 0) + 2, [kiriBefore.rolls, kiriAfter.rolls]);
check('My Lair lists the pass and this year\'s gift', (kiriAfter.passes || []).some((p) => p.code === g.passCode && p.source === 'birthday') && (kiriAfter.gifts || []).some((x) => x.credit === 750 && x.sessions === 3 && x.rolls === 2 && x.product?.code === g.product?.code), kiriAfter.gifts);
const mail = all.emails[0] || {};
check('one email: "Happy birthday from Gobgob, Kiri!" with every part and both codes', all.emails.length === 1 && [].concat(mail.to).includes('kiri@example.com') && /Happy birthday from Gobgob, Kiri!/.test(mail.subject) && (mail.text || '').includes(g.product?.code) && (mail.text || '').includes(g.passCode) && /\$7\.50/.test(mail.text || '') && /2 extra rolls/.test(mail.text || '') && /Happy birthday from the Lair crew!/.test(mail.text || ''), { to: mail.to, subject: mail.subject, text: (mail.text || '').slice(0, 300) });
const listed = ((await proxy('GET', 'members?q=7102', { customer: '7001' })).data || []).find((m) => m.customerId === '7102');
check('the Members view: Kiri has had a gift this year', listed?.giftedThisYear === true, listed && listed.giftedThisYear);

/* 2. Shopify refuses the store credit: the rest still goes */
await fake('POST', 'set', { failCredit: true });
const noCredit = await give('7104', { credit: 5, sessions: 2, productVariantId: VARIANT, productTitle: 'Snacks ($4 Snack)', notify: true });
await fake('POST', 'set', { failCredit: false });
const g2 = noCredit.gift || {};
check('credit refused: one problem, { part: "credit", message }', noCredit.status === 200 && g2.problems?.length === 1 && g2.problems[0].part === 'credit' && /store credit didn't go on/.test(g2.problems[0].message), g2.problems);
check('the other parts went through: the pass, the product code, the email', Boolean(g2.passCode) && /^HBD-/.test(g2.product?.code || '') && g2.emailed === true && noCredit.prizes.length === 1 && noCredit.emails.length === 1, { passCode: g2.passCode, product: g2.product, emailed: g2.emailed });
check('Shopify was asked for the credit once', noCredit.credits.length === 1, noCredit.credits.length);
check('the email says the credit will go on at the counter', /We'll pop it on your account at the counter/.test(noCredit.emails[0]?.text || ''), (noCredit.emails[0]?.text || '').slice(0, 300));

/* 3. Shopify refuses the discount code: the rest still goes */
await fake('POST', 'set', { failDiscount: true });
const samBefore = await me('7101');
const noCode = await give('7101', { rolls: 1, productVariantId: VARIANT, productTitle: 'Snacks ($4 Snack)', notify: false });
await fake('POST', 'set', { failDiscount: false });
const g3 = noCode.gift || {};
check('code refused: one problem, { part: "product", message }, no code', noCode.status === 200 && g3.problems?.length === 1 && g3.problems[0].part === 'product' && /couldn't make the code/.test(g3.problems[0].message) && g3.product?.code === null, { problems: g3.problems, product: g3.product });
check('the roll still went on, and no email (notify off)', (await me('7101')).rolls?.available === (samBefore.rolls?.available || 0) + 1 && g3.emailed === false && noCode.emails.length === 0, g3);

/* 4. No email on file: the email part says so */
await proxy('GET', `me?name=${encodeURIComponent('Ari Moana')}`, { customer: '7107' });
const noEmail = await give('7107', { rolls: 1, notify: true });
check('no email on file: { part: "email" } in problems, the roll still went on', noEmail.status === 200 && noEmail.gift?.problems?.length === 1 && noEmail.gift.problems[0].part === 'email' && noEmail.gift.rolls === 1 && noEmail.emails.length === 0, noEmail.gift);

process.exit(summary() ? 1 : 0);
