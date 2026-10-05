// Round 6 (d), part 3: after r6-travel.py, Hana's Azul hold is past its time. Maintenance (here /setup, which the
// 10-minute cron also runs) expires it once and emails her; the copy is free again; My Lair says it ended.
// In run-all.sh, flow-r5-regulars' /setup runs maintenance first after the same restart, so the hold may already have
// expired when this starts: either way it expires once, with one email (counted from the end of flow-r6-holds).
import fs from 'node:fs';
import { proxy, fake, check, summary, WORKER } from './client.mjs';
import { sleep } from './r6-time.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('./r6-holds.json', import.meta.url)));
const status = async () => (await proxy('GET', `library/status?ids=${plan.variant}`)).data.games?.[plan.variant];
const endedMail = async () => (await fake('GET', 'emails')).slice(plan.emails || 0)
  .filter((e) => [].concat(e.to).includes(plan.email) && e.subject === `Your hold on ${plan.title} ended`);
const early = await status();
check('past its time, it counts as ended, maintenance or not (both copies free: the other was collected)', early?.held === 0 && early.available === 2, early);
const setup = await (await fetch(`${WORKER}/setup?key=test-setup-key`)).json();
await sleep(800);
const mails = await endedMail();
check('maintenance expires it, once: one "Your hold … ended" email', mails.length === 1, { thisRun: setup.libraryHolds || null, emails: mails.length });
check('Hana is emailed: her hold ended and it\'s back on the shelf', mails[0]?.text?.includes(`Your hold on ${plan.title} ended, so it's back on the shelf. Reserve it again any time.`), mails[0] && [mails[0].subject, mails[0].text.slice(0, 300)]);
const again = await (await fetch(`${WORKER}/setup?key=test-setup-key`)).json();
await sleep(500);
check('only once: the next run expires nothing more and sends nothing', !again.libraryHolds && (await endedMail()).length === 1, again.libraryHolds);
const holds = (await proxy('GET', 'me', { customer: plan.member })).data.holds || [];
check('My Lair: the hold shows as expired', holds.some((h) => h.id === plan.expiring && h.status === 'expired'), holds.map((h) => [h.title, h.status]));
const staffAll = (await proxy('GET', 'library/holds?status=all', { customer: '7001' })).data.holds || [];
const row = staffAll.find((h) => h.id === plan.expiring);
check('the staff list (all) has it as expired, ended at its until', row?.status === 'expired' && row.endedAt === row.until, row && [row.status, row.until, row.endedAt]);

process.exit(summary() ? 1 : 0);
