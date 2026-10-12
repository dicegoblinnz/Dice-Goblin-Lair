import { themeCheckRun } from '@shopify/theme-check-node';
const root = process.argv[2];
const result = await themeCheckRun(root, undefined, () => {});
const offenses = result.offenses;
const bySev = {};
for (const o of offenses) {
  const sev = ['error', 'warning', 'info'][o.severity] || o.severity;
  bySev[sev] = (bySev[sev] || 0) + 1;
}
// Shopify refuses a file whose schema has a paragraph setting over 500 characters (FILE_VALIDATION_ERROR on upload;
// an upload by URL just leaves the old file there), which theme-check doesn't flag: count those as errors too
import fs from 'node:fs';
import path from 'node:path';
const PARAGRAPH_MAX = 500;
const long = [];
const walk = (x, file) => {
  if (Array.isArray(x)) x.forEach((v) => walk(v, file));
  else if (x && typeof x === 'object') {
    if (x.type === 'paragraph' && String(x.content || '').length > PARAGRAPH_MAX) long.push([file, String(x.content).length]);
    Object.values(x).forEach((v) => walk(v, file));
  }
};
for (const dir of ['sections', 'blocks']) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full).filter((n) => n.endsWith('.liquid'))) {
    const m = fs.readFileSync(path.join(full, name), 'utf8').match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
    if (m) try { walk(JSON.parse(m[1]), `${dir}/${name}`); } catch { /* theme-check reports bad JSON */ }
  }
}
const settings = path.join(root, 'config/settings_schema.json');
if (fs.existsSync(settings)) walk(JSON.parse(fs.readFileSync(settings, 'utf8')), 'config/settings_schema.json');
if (long.length) bySev.error = (bySev.error || 0) + long.length;
console.log('counts', JSON.stringify(bySev));
for (const [file, n] of long) console.log(`ERR SchemaParagraphLength ${file} a paragraph setting is ${n} characters (Shopify allows ${PARAGRAPH_MAX})`);
for (const o of offenses) {
  const sev = ['ERR', 'WARN', 'INFO'][o.severity] || o.severity;
  const file = o.uri.replace(/^file:\/\/.*dg-theme\//, '');
  console.log(`${sev} ${o.check} ${file}:${o.start?.line + 1} ${o.message.slice(0, 220)}`);
}
