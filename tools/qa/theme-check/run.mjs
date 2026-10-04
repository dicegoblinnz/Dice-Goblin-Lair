import { themeCheckRun } from '@shopify/theme-check-node';
const root = process.argv[2];
const result = await themeCheckRun(root, undefined, () => {});
const offenses = result.offenses;
const bySev = {};
for (const o of offenses) {
  const sev = ['error', 'warning', 'info'][o.severity] || o.severity;
  bySev[sev] = (bySev[sev] || 0) + 1;
}
console.log('counts', JSON.stringify(bySev));
for (const o of offenses) {
  const sev = ['ERR', 'WARN', 'INFO'][o.severity] || o.severity;
  const file = o.uri.replace(/^file:\/\/.*dg-theme\//, '');
  console.log(`${sev} ${o.check} ${file}:${o.start?.line + 1} ${o.message.slice(0, 220)}`);
}
