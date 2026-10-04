// The built package against the site's published dataset: same percentages, same printed
// rounding, same declared floors and ceilings, for every country.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTools, loadSnapshot } from '../dist/tools.js';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// the site's published dataset, copied here by scripts/sync.mjs
const summary = parseCsv(readFileSync(new URL('./fixtures/country_summary.csv', import.meta.url), 'utf8'));
const snapshot = loadSnapshot();
const tools = createTools(snapshot);
const unbound = (s) => s.replace(/^(at least|at most) /, '');
const everyString = (o, out = []) => {
  if (typeof o === 'string') out.push(o);
  else if (o && typeof o === 'object') for (const v of Object.values(o)) everyString(v, out);
  return out;
};

test('the dataset and the snapshot cover the same 76 countries', () => {
  assert.equal(summary.length, 76);
  assert.deepEqual(snapshot.countries.map((c) => c.iso).sort(), summary.map((r) => r.iso).sort());
});

for (const row of summary) {
  test(`${row.iso} ${row.country}: employer_cost matches country_summary.csv`, () => {
    const r = tools.employerCost({ country: row.iso });
    const cost = r.employer_cost;
    // same engine, same rounding: equal to the last digit, no tolerance
    assert.equal(cost.values.pct_of_gross, Number(row.employer_cost_pct));
    assert.equal(Number(unbound(cost.pct_of_gross).replace('%', '')), Number(row.employer_cost_pct_printed));
    assert.equal(cost.values.monthly_usd, Number(row.employer_cost_usd_month));
    assert.equal(r.salary.annual_usd, Number(row.example_salary_usd));
    if (row.basic_share_of_gross !== '') {
      const share = r.assumptions.find((a) => a.id === 'basic_share_of_gross')?.value ?? 1;
      assert.equal(Math.min(1, Math.max(0, share)), Number(row.basic_share_of_gross));
    }

    // a declared floor or ceiling is in the figure itself, in every sentence that carries it
    const words = row.total_declared_floor === 'true' ? 'at least' : row.total_declared_ceiling === 'true' ? 'at most' : null;
    assert.equal(cost.values.bound, words);
    for (const s of [cost.pct_of_gross, cost.monthly, cost.annual]) assert.equal(/^(at least|at most)/.exec(s)?.[0] ?? null, words, s);
    if (words) assert.match(r.summary, new RegExp(`costs ${words} \\$[\\d,]+ a month .*\\(${words} \\+[\\d.]+%`));
    else assert.doesNotMatch(r.summary, /at least|at most/);

    // exchange rate and its date, by regime
    if (row.currency === 'USD') assert.equal(r.salary.fx, undefined);
    else {
      assert.equal(r.salary.fx.local_per_usd, Number(row.fx_local_per_usd));
      assert.equal(r.salary.fx.date, row.fx_date);
    }

    // every line is sourced and dated
    assert.ok(r.lines.length > 0);
    for (const l of r.lines) {
      assert.match(l.source.url, /^https?:\/\//);
      assert.match(l.source.checked_at, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.equal(r.country.last_reviewed, row.last_reviewed);
    assert.equal(r.employer_cost.excludes ?? '', row.total_excludes);
    // the dataset also derives a place from an assumption (Germany: "outside Saxony"); the site
    // prints one only when the country file names it, and so does this package
    if (r.country.priced_for) assert.equal(r.country.priced_for, row.example_place);

    const slug = snapshot.countries.find((c) => c.iso === row.iso).slug;
    assert.deepEqual(r.meta, {
      snapshot_date: snapshot.snapshot_date,
      page_url: `https://eorscope.com/employer-of-record/${slug}/`,
      methodology_url: 'https://eorscope.com/methodology/',
      disclaimer: 'Cost comparison, not legal or tax advice.',
      license: 'Data: CC BY 4.0, attribution "EOR Scope, eorscope.com".',
    });
    // the same country by name, and the same salary given in local currency
    assert.equal(tools.employerCost({ country: row.country }).employer_cost.values.pct_of_gross, cost.values.pct_of_gross);
    if (row.currency !== 'USD') {
      const viaLocal = tools.employerCost({ country: row.iso, salary: Number(row.example_salary_usd) * Number(row.fx_local_per_usd), salary_currency: 'local' });
      assert.ok(Math.abs(viaLocal.employer_cost.values.pct_of_gross - cost.values.pct_of_gross) <= 0.0001);
    }
  });
}

test('declared floors and ceilings: the dataset lists, and "at least" in every figure of a floor', () => {
  const flagged = (col) => summary.filter((r) => r[col] === 'true').map((r) => r.iso).sort();
  assert.deepEqual(flagged('total_declared_floor'), ['AE', 'AR', 'BD', 'CL', 'CR', 'DO', 'EC', 'IL', 'LK', 'PE', 'QA', 'SA', 'UY']);
  assert.deepEqual(flagged('total_declared_ceiling'), ['GH', 'NG']);
  assert.deepEqual(snapshot.countries.filter((c) => c.total_bound === 'floor').map((c) => c.iso).sort(), flagged('total_declared_floor'));
  assert.deepEqual(snapshot.countries.filter((c) => c.total_bound === 'ceiling').map((c) => c.iso).sort(), flagged('total_declared_ceiling'));
  const listed = tools.listCountries().countries;
  for (const iso of ['EC', 'SA', 'BD']) {
    const r = tools.employerCost({ country: iso });
    assert.match(r.employer_cost.pct_of_gross, /^at least \d+\.\d%$/);
    assert.match(r.employer_cost.monthly, /^at least \$[\d,]+$/);
    assert.match(r.employer_cost.annual, /^at least \$[\d,]+$/);
    assert.equal(r.employer_cost.values.bound, 'at least');
    assert.match(r.summary, /costs at least \$[\d,]+ a month in statutory employer charges \(at least \+\d+\.\d% of gross\)/);
    assert.match(listed.find((c) => c.iso === iso).employer_cost_at_example, /^at least /);
    assert.match(tools.compareCountries({ countries: [iso, 'DE'], salary_usd: 50000 }).countries[0].employer_cost.monthly, /^at least \$/);
  }
});

test('an exact zero is an answer in words, a small floor stays a number', () => {
  const am = tools.employerCost({ country: 'AM' }).employer_cost;
  assert.equal(am.values.pct_of_gross, 0);
  assert.equal(am.monthly, 'none');
  assert.match(tools.employerCost({ country: 'Armenia' }).summary, /costs nothing a month/);
  assert.match(tools.employerCost({ country: 'AE' }).employer_cost.monthly, /^at least \$\d+$/);
});

test('Mexico: IMSS, INFONAVIT and the state payroll tax are charged on the integrated base (31.0%)', () => {
  const mx = snapshot.countries.find((c) => c.iso === 'MX');
  const factors = mx.employer_contributions.filter((k) => k.base !== 'flat').map((k) => k.base_factor ?? 1);
  assert.equal(factors.filter((f) => f === 1.049315).length, 9);
  assert.equal(factors.filter((f) => f === 1.049867).length, 1);
  const r = tools.employerCost({ country: 'MX' }).employer_cost;
  assert.equal(r.pct_of_gross, '31.0%');
  assert.ok(Math.abs(r.values.pct_of_gross - 30.9955) < 1e-4);
});

test('countries only: no provider data in the snapshot or the tools (publisher terms forbid redistribution)', () => {
  assert.equal('vendors' in snapshot, false);
  assert.deepEqual(Object.keys(tools).sort(), ['compareCountries', 'employerCost', 'listCountries']);
  assert.doesNotMatch(JSON.stringify(snapshot), /price_usd|affiliate_url|cta_url/);
});

test('compare_countries keeps the order requested and carries each bound', () => {
  const r = tools.compareCountries({ countries: ['Germany', 'AE', 'uk', 'GH'], salary_usd: 80000 });
  assert.deepEqual(r.countries.map((c) => c.iso), ['DE', 'AE', 'GB', 'GH']);
  assert.match(r.countries[1].employer_cost.monthly, /^at least \$/);
  assert.match(r.countries[3].employer_cost.pct_of_gross, /^at most /);
  assert.equal(r.countries[0].employer_cost.values.pct_of_gross, tools.employerCost({ country: 'DE', salary: 80000 }).employer_cost.values.pct_of_gross);
  assert.throws(() => tools.compareCountries({ countries: ['DE', 'Germany'], salary_usd: 80000 }), /2 to 10/);
  assert.throws(() => tools.compareCountries({ countries: ['DE', 'Atlantis'], salary_usd: 80000 }), /Unknown country/);
});

test('no rank and no superlative in what the tools write', () => {
  const outputs = [
    tools.listCountries(),
    tools.compareCountries({ countries: snapshot.countries.slice(0, 10).map((c) => c.iso), salary_usd: 60000 }),
    // the sentences the tools write; ledger lines carry the site's data verbatim
    ...snapshot.countries.map((c) => { const r = tools.employerCost({ country: c.iso }); return { summary: r.summary, employer_cost: r.employer_cost }; }),
  ];
  // keys that carry the site's own data verbatim are checked on the site, not here
  const written = outputs.flatMap((o) => everyString({ ...o, salary: undefined }));
  for (const s of written) assert.doesNotMatch(s, /\b(cheapest|lowest|highest|most expensive|the only|best|rank(ed|s)? (first|\d))\b/i, s);
  assert.equal(JSON.stringify(outputs).includes('"$0"'), false);
});
