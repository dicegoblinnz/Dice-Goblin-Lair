// Dice Goblin Lair — the email layout: one clean, mobile-friendly HTML email with a plain-text copy.
//
// Every email is a "Dice Goblin" header, a big title, a few short paragraphs, an optional details table (bold labels),
// an optional button, a sign-off and a footer with the shop's address, phone and hours. Styles are inline because
// most email apps strip <style> blocks. No images, so nothing breaks when an email app blocks them.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { page: '#f4efe8', card: '#ffffff', ink: '#221b17', muted: '#6b5d52', head: '#16110f', goblin: '#46d06c', button: '#1f7a3d', line: '#e8dfd4', quote: '#faf6f0' };

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Escaped text with its line breaks kept */
const lines = (text) => escapeHtml(text).replace(/\r?\n/g, '<br>');
const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((p) => String(p ?? '').trim()).filter(Boolean);
/** Only http(s) links become buttons */
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : null);

/* ---------- opening hours, for footers: "Mon–Fri 4pm–midnight, Sat 10am–midnight, Sun 10am–10pm" ---------- */
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

export function clockLabel(minutes) {
  const m = ((Number(minutes) % 1440) + 1440) % 1440;
  if (m === 0) return 'midnight';
  if (m === 720) return 'midday';
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${h % 12 || 12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** Days with the same hours are grouped: { mon: [960, 1440], ... } → "Mon–Fri 4pm–midnight, …" */
export function hoursSummary(hours) {
  const groups = [];
  for (const [key, label] of DAYS) {
    const h = hours?.[key];
    const text = h ? `${clockLabel(h[0])}–${clockLabel(h[1])}` : 'closed';
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = label;
    else groups.push({ from: label, to: label, text });
  }
  return groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.text}`).join(', ');
}

/**
 * Build one email.
 *   title      the big heading
 *   preheader  the grey line email apps show after the subject (defaults to the first paragraph)
 *   intro      paragraph(s) under the title
 *   quote      a block of someone else's words (a GM's message), shown as typed
 *   details    [[label, value], …] for the details table; rows without a value are left out
 *   button     { label, url }
 *   outro      paragraph(s) after the details
 *   signoff    the closing line(s); Gobgob signs by default
 *   footer     { name, address, phone, hours }
 * Returns { html, text }.
 */
export function renderEmail({ title, preheader, intro, quote, details = [], button, outro, signoff, footer = {} }) {
  const before = list(intro);
  const after = list(outro);
  const rows = (details || []).filter((row) => row && String(row[1] ?? '').trim()).map(([label, value]) => [String(label), String(value).trim()]);
  const link = button && safeUrl(button.url) ? { label: String(button.label || 'Open'), url: safeUrl(button.url) } : null;
  const signed = list(signoff ?? 'See you at the Lair!\nGobgob, the Dice Goblin goblin');
  const foot = [footer.name || 'Dice Goblin Lair', footer.address, [footer.phone, footer.hours].filter(Boolean).join(' · ')].filter(Boolean);
  const said = String(quote ?? '').trim();

  const p = (text, extra = '') => `<p style="margin:0 0 14px;font:16px/1.55 ${FONT};color:${C.ink};${extra}">${lines(text)}</p>`;
  const html = `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${escapeHtml(preheader || before[0] || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${C.card};border-radius:14px;overflow:hidden;">
<tr><td style="background:${C.head};padding:18px 24px;font:800 20px/1.2 ${FONT};color:${C.goblin};letter-spacing:0.02em;">Dice Goblin</td></tr>
<tr><td style="padding:28px 24px 10px;">
<h1 style="margin:0 0 16px;font:800 28px/1.2 ${FONT};color:${C.ink};">${escapeHtml(title)}</h1>
${before.map((t) => p(t)).join('\n')}
${said ? `<div style="margin:4px 0 18px;padding:14px 16px;background:${C.quote};border-left:4px solid ${C.button};border-radius:6px;font:16px/1.55 ${FONT};color:${C.ink};">${lines(said)}</div>` : ''}
${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;border-collapse:collapse;">
${rows.map(([label, value]) => `<tr><td style="padding:10px 12px 10px 0;border-top:1px solid ${C.line};font:700 15px/1.45 ${FONT};color:${C.ink};vertical-align:top;width:36%;">${escapeHtml(label)}</td><td style="padding:10px 0;border-top:1px solid ${C.line};font:15px/1.45 ${FONT};color:${C.ink};vertical-align:top;">${lines(value)}</td></tr>`).join('\n')}
</table>` : ''}
${link ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr><td style="border-radius:999px;background:${C.button};"><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:14px 26px;font:700 16px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(link.label)}</a></td></tr></table>` : ''}
${after.map((t) => p(t)).join('\n')}
${signed.map((t) => p(t, 'margin-top:4px;')).join('\n')}
</td></tr>
<tr><td style="padding:18px 24px 24px;border-top:1px solid ${C.line};font:13px/1.55 ${FONT};color:${C.muted};">${foot.map(escapeHtml).join('<br>')}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const width = Math.max(0, ...rows.map(([label]) => label.length));
  const text = [
    String(title).toUpperCase(),
    ...before,
    said ? said.split(/\r?\n/).map((l) => `> ${l}`).join('\n') : null,
    rows.length ? rows.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value.replace(/\r?\n/g, `\n${' '.repeat(width + 2)}`)}`).join('\n') : null,
    link ? `${link.label}: ${link.url}` : null,
    ...after,
    signed.join('\n'),
    `--\n${foot.join('\n')}`,
  ].filter(Boolean).join('\n\n');
  return { html, text: `${text}\n` };
}
