// The plugin bar (audit/PLUGIN_CHATGPT_SPEC_2026-10-09.md, section 7): parity with the site's engine
// and dataset at three salaries, budget round trip, and the guard that keeps providers out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTools, loadSnapshot } from '../dist/tools.js';
// the site's engine as copied by scripts/sync.mjs, run directly (Node strips the types)
import { computeScenario } from '../src/vendor/cost-engine.ts';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const summary = (() => {
  const [head, ...rows] = fixture('country_summary.csv').trim().split(/\r?\n/);
  const cols = head.split(',');
  // the columns used here (iso, example salary, monthly cost) never contain a comma
  return new Map(rows.map((r) => r.split(',')).map((r) => [r[0], Object.fromEntries(cols.map((c, i) => [c, r[i]]))]));
})();
const providers = JSON.parse(fixture('providers.json'));
const snapshot = loadSnapshot();
const tools = createTools(snapshot, { utm: 'chatgpt' });
const datasets = { countries: snapshot.countries, vendors: [], fx: snapshot.fx };
const r2 = (n) => Math.round(n * 100) / 100;
// the tools round half away from zero, as the site's dataset export does: half a cent is within reach
const CENT = 0.005 + 1e-9;
const FACTORS = [0.5, 1, 2];

test('76 countries, each in the published dataset', () => {
  assert.equal(snapshot.countries.length, 76);
  for (const c of snapshot.countries) assert.ok(summary.has(c.iso), c.iso);
});

for (const c of snapshot.countries) {
  test(`${c.iso}: employer_cost = engine at 3 salaries, = dataset at the example; budget round trip within $1`, () => {
    for (const f of FACTORS) {
      const salary = c.example_salary_usd * f;
      const out = tools.employerCost({ country: c.iso, salary });
      const eng = computeScenario({ countryIso: c.iso, salaryAnnualUsd: salary, headcount: 1, vendorIds: [] }, datasets);
      assert.ok(Math.abs(out.employer_cost.values.monthly_usd - eng.employerCostAnnualUsd / 12) <= CENT, `${f}x monthly`);
      assert.ok(Math.abs(out.employer_cost.values.annual_usd - eng.employerCostAnnualUsd) <= CENT, `${f}x annual`);
      const lines = eng.lines.filter((l) => l.kind !== 'salary');
      assert.deepEqual(out.lines.map((l) => l.id), lines.map((l) => l.id));
      out.lines.forEach((l, i) => assert.ok(Math.abs(l.monthly_usd - lines[i].monthlyUsd) <= CENT, `${f}x ${l.id}`));
      if (f === 1) assert.equal(out.employer_cost.values.monthly_usd, Number(summary.get(c.iso).employer_cost_usd_month));

      // max_salary_for_budget -> employer_cost gives the budget back, to the dollar, never above it
      const budget = r2(out.salary.annual_usd + out.employer_cost.values.annual_usd);
      const m = tools.maxSalaryForBudget({ country: c.iso, budget });
      const back = tools.employerCost({ country: c.iso, salary: m.max_salary.annual_usd });
      const total = back.salary.annual_usd + back.employer_cost.values.annual_usd;
      assert.ok(total <= budget + 0.01 && budget - total <= 1, `${f}x: budget ${budget}, back ${total}`);
      assert.ok(Math.abs(m.max_salary.annual_usd - salary) <= 1, `${f}x: salary ${salary}, found ${m.max_salary.annual_usd}`);
    }
  });
}

test('budget: monthly, local currency and an EOR fee give the same salary as the annual USD budget', () => {
  const de = snapshot.countries.find((c) => c.iso === 'DE');
  const year = tools.maxSalaryForBudget({ country: 'DE', budget: 120000, eor_fee_usd_month: 500 });
  const month = tools.maxSalaryForBudget({ country: 'DE', budget: 10000, budget_period: 'month', eor_fee_usd_month: 500 });
  const local = tools.maxSalaryForBudget({ country: 'DE', budget: 120000 * snapshot.fx.rates[de.currency], budget_currency: 'local', eor_fee_usd_month: 500 });
  assert.equal(month.max_salary.annual_usd, year.max_salary.annual_usd);
  assert.ok(Math.abs(local.max_salary.annual_usd - year.max_salary.annual_usd) <= 0.01);
  assert.equal(year.budget.salary_and_charges_annual_usd, 114000);
  assert.throws(() => tools.maxSalaryForBudget({ country: 'DE', budget: 1000, eor_fee_usd_month: 500 }), /leaves nothing/);
});

test('reconcile_quote: the gap is the fee lines, the charges over the ledger and the salary-line difference', () => {
  const e = tools.employerCost({ country: 'PL', salary: 60000 });
  const [first, ...rest] = e.lines;
  const lines = [
    { label: 'Gross salary', amount: 5000 + 120, type: 'salary' },
    { label: first.name, amount: first.monthly_usd + 10, type: 'employer_charge' },
    ...rest.slice(1).map((l) => ({ label: `line ${l.id}`, statutory_id: l.id, amount: l.monthly_usd, type: 'employer_charge' })),
    { label: 'Management fee', amount: 450, type: 'fee' },
    { label: 'Mystery levy', amount: 30, type: 'employer_charge' },
  ];
  const o = tools.reconcileQuote({ country: 'PL', salary: 60000, lines });
  assert.equal(o.gap_breakdown.fee_lines, 450);
  assert.equal(o.gap_breakdown.salary_line_difference, 120);
  assert.ok(Math.abs(o.gap_breakdown.employer_charges_over_statutory - (10 + 30 - rest[0].monthly_usd)) <= 0.02);
  assert.ok(Math.abs(o.per_month_usd.gap_over_statutory - (450 + 120 + 10 + 30 - rest[0].monthly_usd)) <= 0.02);
  assert.equal(o.lines[0].difference_monthly_usd, 10);
  assert.deepEqual(o.missing_from_quote.map((l) => l.id), rest[0].monthly_usd > 0 ? [rest[0].id] : []);
  assert.deepEqual(o.not_in_statutory_ledger, [{ label: 'Mystery levy', monthly_usd: 30 }]);
  assert.throws(() => tools.reconcileQuote({ country: 'PL', salary: 60000, lines: [{ label: 'x', amount: 1, type: 'employer_charge', statutory_id: 'nope' }] }), /Unknown statutory_id/);
});

test('reconcile_quote: one global employer-charge line is compared with the statutory total, no line reported missing', () => {
  // the owner's ChatGPT test of 09/10: DE, 5,900 a month (70,800 a year), charges 1,350, fee 560, all in EUR
  const lines = [
    { label: 'Salary', amount: 5900, type: 'salary' },
    { label: 'Employer social contributions', amount: 1350, type: 'employer_charge' },
    { label: 'EOR fee', amount: 560, type: 'fee' },
  ];
  const o = tools.reconcileQuote({ country: 'DE', salary: 70800, salary_currency: 'local', amounts_currency: 'local', lines });
  const rate = snapshot.fx.rates.EUR;
  assert.equal(o.quote_detail, 'aggregate');
  assert.deepEqual(o.missing_from_quote, []);
  assert.deepEqual(o.not_in_statutory_ledger, []);
  assert.deepEqual(o.aggregate_lines.map((l) => l.label), ['Employer social contributions']);
  const owed = o.lines.filter((l) => !l.skipped && l.expected_monthly_usd > 0);
  assert.deepEqual(o.expected_breakdown.map((l) => l.id), owed.map((l) => l.id));
  assert.ok(Math.abs(o.expected_breakdown.reduce((s, l) => s + l.expected_monthly_usd, 0) - o.per_month_usd.expected_statutory_charges) <= 0.05);
  assert.ok(Math.abs(o.gap_breakdown.employer_charges_over_statutory * rate - 47) <= 2, `${o.gap_breakdown.employer_charges_over_statutory * rate} EUR`);
  assert.ok(Math.abs(o.gap_breakdown.salary_line_difference) <= 0.01);
  assert.match(o.summary, /one total/);
  // a detailed quote keeps the line-by-line reading
  const e = tools.employerCost({ country: 'DE', salary: 70800, salary_currency: 'local' });
  const detailed = tools.reconcileQuote({ country: 'DE', salary: 70800, salary_currency: 'local', lines: [{ label: 'x', statutory_id: e.lines[0].id, amount: e.lines[0].monthly_usd, type: 'employer_charge' }] });
  assert.equal(detailed.quote_detail, 'detailed');
  assert.equal(detailed.expected_breakdown, undefined);
  assert.ok(detailed.missing_from_quote.length > 0);
});

test('compare_structures: same arithmetic as the site, break-even from the entity costs entered', () => {
  const e = tools.employerCost({ country: 'PL', salary: 50000 });
  const o = tools.compareStructures({ country: 'PL', salary: 50000, headcount: 3, years: 3, eor_fee_usd_month: 500, entity_setup_usd: 20000, entity_annual_usd: 30000, contractor_fee_usd_month: 49 });
  const pay = 50000 / 12;
  const charges = e.employer_cost.values.annual_usd / 12;
  assert.ok(Math.abs(o.per_month_usd.eor - (pay + charges + 500) * 3) <= 0.02);
  assert.equal(o.per_month_usd.contractor, r2((pay + 49) * 3));
  assert.equal(o.break_even.headcount, Math.ceil((20000 / 3 + 30000) / 6000));
  assert.equal(o.cumulative_usd.length, 5);
  assert.equal(tools.compareStructures({ country: 'PL', eor_fee_usd_month: 500 }).break_even.headcount, null);
});

// ---------------------------------------------------------------- the guard
const PROVIDER_KEYS = ['vendors', 'plans', 'price_usd_month', 'annual_price_usd_month', 'affiliate_url', 'cta_url', 'cta_label', 'fx_markup_pct', 'deposit_policy', 'countries_excluded', 'eor_onboarding_days', 'entity_notes'];
const names = [...new Set(providers.names.flatMap((n) => [n, n.split(' ')[0]]).concat(providers.ids.map((i) => i[0].toUpperCase() + i.slice(1))))];
const nameRe = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('|')})\\b`);
const ids = new Set([...providers.ids, ...providers.plan_ids]);
const walk = (o, fn, key = '') => {
  if (Array.isArray(o)) o.forEach((v) => walk(v, fn, key));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { fn(k, v); walk(v, fn, k); }
  else fn(key, o);
};
const noProviderData = (o, label) =>
  walk(o, (k, v) => {
    assert.ok(!PROVIDER_KEYS.includes(k), `${label}: key ${k}`);
    if (typeof v === 'string') assert.ok(!ids.has(v), `${label}: provider id "${v}" at ${k}`);
  });

test('guard: no provider id, plan id or price field in the snapshot', () => {
  assert.ok(providers.ids.length >= 10 && providers.plan_ids.length >= 10);
  noProviderData(snapshot, 'snapshot');
});

test('guard: no line of the snapshot is sourced on a provider domain without the "Secondary source" relabel', () => {
  assert.ok(providers.domains.includes('deel.com') && providers.domains.length >= 10);
  const onProvider = (u) => {
    try {
      const h = new URL(u).hostname;
      return providers.domains.some((d) => h === d || h.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  const relabelled = [];
  for (const c of snapshot.countries) {
    for (const l of [...c.employer_contributions, ...c.statutory_extras]) {
      assert.ok(!onProvider(l.source?.url), `${c.iso} ${l.id}: source.url ${l.source?.url} is a provider's page`);
      assert.doesNotMatch(l.source?.name ?? '', nameRe, `${c.iso} ${l.id}: source.name names a provider`);
      if (!l.source_is_provider) continue;
      relabelled.push(`${c.iso}.${l.id}`);
      assert.deepEqual(l.source, { name: `Secondary source, cited on the ${c.name} page`, url: `https://eorscope.com/employer-of-record/${c.slug}/`, checked_at: l.source.checked_at }, `${c.iso} ${l.id}`);
    }
  }
  // the two lines the judge found on deel.com (09/10): Spain's AT y EP and Denmark's occupational injury insurance
  for (const id of ['ES.at_ep', 'DK.arbejdsskadeforsikring']) assert.ok(relabelled.includes(id), id);
});

test('guard: no provider data in any output, and no provider name in the new tools', () => {
  for (const c of snapshot.countries) {
    const outs = {
      employer_cost: tools.employerCost({ country: c.iso, include_notes: true }),
      employment_terms: tools.employmentTerms({ country: c.iso }),
      max_salary_for_budget: tools.maxSalaryForBudget({ country: c.iso, budget: c.example_salary_usd * 1.5 }),
      reconcile_quote: tools.reconcileQuote({ country: c.iso, salary: c.example_salary_usd, lines: [{ label: 'Salary', amount: c.example_salary_usd / 12, type: 'salary' }, { label: 'Social charges', amount: 500, type: 'employer_charge' }, { label: 'Service fee', amount: 400, type: 'fee' }] }),
      compare_structures: tools.compareStructures({ country: c.iso, eor_fee_usd_month: 400, entity_setup_usd: 15000, entity_annual_usd: 25000 }),
      compare_offers: tools.compareOffers({ offers: [{ country: c.iso, salary: c.example_salary_usd }, { country: c.iso === 'DE' ? 'PL' : 'DE', salary: 70000 }] }),
      ...(c.currency !== 'USD' && { fx_stress: tools.fxStress({ country: c.iso, salary_local: c.example_salary_usd * snapshot.fx.rates[c.currency], budget_usd: c.example_salary_usd * 1.3 }) }),
      contractor_rate_equivalent: tools.contractorRateEquivalent({ country: c.iso, public_holidays: c.public_holidays ?? 10, eor_fee_usd_month: 400 }),
      show_ledger: tools.showLedger({ country: c.iso }),
      show_compare: tools.showCompare({ offers: [{ country: c.iso, salary: c.example_salary_usd }, { country: c.iso === 'DE' ? 'PL' : 'DE', salary: 70000 }] }),
    };
    for (const [tool, o] of Object.entries(outs)) {
      noProviderData(o, `${c.iso} ${tool}`);
      // the ledger carries the site's line labels and source names verbatim, checked on the site
      if (!['employer_cost', 'show_ledger'].includes(tool)) assert.doesNotMatch(JSON.stringify(o), nameRe, `${c.iso} ${tool} names a provider`);
    }
  }
  noProviderData(tools.listCountries(), 'list_countries');
  noProviderData(tools.compareCountries({ countries: ['DE', 'IN', 'BR'], salary_usd: 60000 }), 'compare_countries');
});
