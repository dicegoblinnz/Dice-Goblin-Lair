// Round 5 (d): the staff Members view, GET /members?q=&sort=spend|recent|owing&owing=1. Sorted lists (spend this year
// then all time, last visit, what they owe), only those who owe, and search by name, email, member code (typed any
// way) or customer ID. Run after flow-r5-regulars.mjs, so some members owe for a weekly game.
import { proxy, check, summary } from './client.mjs';

const list = async (query) => {
  const r = await proxy('GET', `members${query ? `?${query}` : ''}`, { customer: '7001' });
  return { status: r.status, rows: Array.isArray(r.data) ? r.data : [], data: r.data };
};
const sorted = (rows, cmp) => rows.every((x, i) => i === 0 || cmp(rows[i - 1], x) <= 0);
const names = (rows) => rows.map((m) => m.name || m.customerId);
const FIELDS = ['customerId', 'name', 'email', 'code', 'birthday', 'spendYear', 'spendTotal', 'lastSeen', 'owed', 'owedCount', 'openTab', 'pendingPrizes', 'giftedThisYear'];

const notStaff = await proxy('GET', 'members', { customer: '7101' });
check('a member can\'t list members (403)', notStaff.status === 403, notStaff.data);

/* sorts */
const bySpend = await list('sort=spend');
check('sort=spend: everyone (up to 100), each with the contract\'s fields', bySpend.status === 200 && bySpend.rows.length >= 6 && bySpend.rows.length <= 100 && bySpend.rows.every((m) => FIELDS.every((f) => f in m)), bySpend.rows[0] && FIELDS.filter((f) => !(f in bySpend.rows[0])));
check('sort=spend: most spent in the last 12 months first, then all time', sorted(bySpend.rows, (a, b) => (b.spendYear - a.spendYear) || (b.spendTotal - a.spendTotal)) && bySpend.rows[0].spendYear > 0, bySpend.rows.map((m) => [m.name, m.spendYear, m.spendTotal]));
const byRecent = await list('sort=recent');
check('sort=recent: last seen first', byRecent.rows.length === bySpend.rows.length && sorted(byRecent.rows, (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)), byRecent.rows.map((m) => [m.name, m.lastSeen]));
const byOwing = await list('sort=owing');
const owes = (m) => m.owed + m.openTab;
check('sort=owing: most owed (owed seats plus open tab) first', sorted(byOwing.rows, (a, b) => owes(b) - owes(a)) && owes(byOwing.rows[0]) > 0, byOwing.rows.map((m) => [m.name, m.owed, m.openTab]));
const plain = await list('');
check('no sort: the same members', plain.rows.length === bySpend.rows.length, plain.rows.length);

/* owing=1 */
const owing = await list('owing=1&sort=owing');
check('owing=1: only members who owe, most first', owing.rows.length > 0 && owing.rows.every((m) => owes(m) > 0) && sorted(owing.rows, (a, b) => owes(b) - owes(a)), owing.rows.map((m) => [m.name, m.owed, m.openTab]));
check('owing=1: everyone who owes, nobody missed', owing.rows.length === bySpend.rows.filter((m) => owes(m) > 0).length, [owing.rows.length, bySpend.rows.filter((m) => owes(m) > 0).length]);
check('the owed regulars show what they owe and for how many sessions', ['7102', '7104', '7106'].every((id) => {
  const m = owing.rows.find((x) => x.customerId === id);
  return m && m.owed === 1500 && m.owedCount === 1;
}), owing.rows.map((m) => [m.customerId, m.owed, m.owedCount]));

/* search */
const kiri = bySpend.rows.find((m) => m.customerId === '7102');
const byName = await list('q=kiri');
check('search by first name', byName.rows.some((m) => m.customerId === '7102') && byName.rows.every((m) => /kiri/i.test(`${m.name} ${m.email}`)), names(byName.rows));
const bySurname = await list('q=Tane');
check('search by surname (any case)', bySurname.rows.length === 1 && bySurname.rows[0].customerId === '7104', names(bySurname.rows));
const byEmail = await list('q=tui%40example');
check('search by email', byEmail.rows.length === 1 && byEmail.rows[0].customerId === '7106', names(byEmail.rows));
for (const typed of [kiri.code, kiri.code.toLowerCase().replace(/-/g, ''), kiri.code.toLowerCase().replace(/-/g, ' ')]) {
  const r = await list(`q=${encodeURIComponent(typed)}`);
  check(`search by member code typed "${typed}"`, r.rows[0]?.customerId === '7102', names(r.rows));
}
const byId = await list('q=7104');
check('search by customer ID: that member first', byId.rows[0]?.customerId === '7104', names(byId.rows));
const searchSorted = await list('q=example&sort=spend');
check('a search with a sort: the matches in that order', searchSorted.rows.length >= 4 && searchSorted.rows.every((m) => /example/.test(m.email)) && sorted(searchSorted.rows, (a, b) => (b.spendYear - a.spendYear) || (b.spendTotal - a.spendTotal)), searchSorted.rows.map((m) => [m.name, m.spendYear]));
const none = await list('q=zzqqxx');
check('nothing matches: an empty list', none.status === 200 && none.rows.length === 0, none.data);
const pct = await list(`q=${encodeURIComponent('%')}`);
check('a % in the search is just a character (matches nobody here)', pct.status === 200 && pct.rows.length === 0, names(pct.rows));

process.exit(summary() ? 1 : 0);
