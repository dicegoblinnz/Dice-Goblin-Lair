// Cloudflare's SQLite (Durable Objects, and D1) is tighter than node's: at most 100 bound values a query (27 Oct 2026,
// the staff page's GM games failed on more) and at most 5 terms in one compound SELECT (29 Oct 2026: My Lair, the
// staff page's members and the counter's loyalty card failed on the stamps query's 8, measured on the Lair's own D1:
// 5 terms run, 6 say "too many terms in compound SELECT"). Every test file's stand-in SQL calls cloudflareSql, so a
// query Cloudflare would refuse fails the tests too.
export const MAX_BOUND_VALUES = 100;
export const MAX_COMPOUND_TERMS = 5;

/** Throws as Cloudflare's SQLite would for a query over its limits. */
export function cloudflareSql(query, bindings) {
  if (bindings.length > MAX_BOUND_VALUES) throw new Error(`too many SQL variables: ${bindings.length}`);
  const terms = compoundTerms(query);
  if (terms > MAX_COMPOUND_TERMS) throw new Error(`too many terms in compound SELECT (${terms})`);
}

/**
 * The most terms in any one compound SELECT of a query: SELECTs joined by UNION (ALL), INTERSECT or EXCEPT at the same
 * level of brackets. A SELECT in brackets (a subquery, or SELECT * FROM (…)) is a compound of its own, as SQLite counts
 * them. Words inside strings and comments never count.
 */
export function compoundTerms(query) {
  const text = String(query)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const terms = [1];
  let most = 1;
  for (const m of text.matchAll(/\(|\)|\b(?:UNION|INTERSECT|EXCEPT)\b/gi)) {
    if (m[0] === '(') terms.push(1);
    else if (m[0] === ')') {
      if (terms.length > 1) terms.pop();
    }
    else {
      terms[terms.length - 1] += 1;
      most = Math.max(most, terms[terms.length - 1]);
    }
  }
  return most;
}
