// The vectors of site/src/lib/cost-engine.test.ts, run through the tools of the built package.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTools } from '../dist/tools.js';

const src = { name: 'test', url: 'https://example.org/test', checked_at: '2026-09-02' };
const none = { cap_annual_local: null, floor_annual_local: null, flat_annual_local: null, max_gross_annual_local: null, min_gross_annual_local: null };
const country = {
  iso: 'ZZ', slug: 'testland', name: 'Testland', currency: 'ZZD', region: 'Europe', total_bound: null, last_reviewed: '2026-09-02',
  example_salary_usd: 60000, example_role: 'Engineer',
  assumptions: [{ id: 'basic_share_of_gross', label: 'Basic share', value: 0.5 }],
  employer_contributions: [
    { ...none, id: 'pension', name: 'Pension', rate: 0.1, base: 'gross', cap_annual_local: 100000, source: src },
    { ...none, id: 'fund', name: 'Fund on basic', rate: 0.12, base: 'basic', source: src },
    { ...none, id: 'levy', name: 'Flat levy', rate: 0, base: 'flat', flat_annual_local: 1000, source: src },
    { ...none, id: 'lowpay', name: 'Low-pay scheme', rate: 0.05, base: 'gross', max_gross_annual_local: 80000, source: src },
  ],
  statutory_extras: [
    { id: 'thirteenth', name: '13th month', kind: 'months', value: 1, in_total: true, source: src },
    { id: 'holiday', name: 'Holiday allowance', kind: 'percent', value: 8, in_total: true, source: src },
    { id: 'info', name: 'Profit share', kind: 'percent', value: 10, in_total: false, source: src },
  ],
  thirteenth_month: true, paid_leave_days: 20,
};
const plan = (pricing_model, price_usd_month) => ({ id: 'eor', name: 'EOR', scope: 'eor', pricing_model, price_usd_month, billing: 'monthly', annual_price_usd_month: null, min_term_months: null, deposit_policy: 'none', fx_markup_pct: null, addons: [], source: src });
const vendors = [
  { id: 'a', name: 'A', cta_url: 'https://a.example', affiliate_url: null, cta_label: 'Quote', countries_excluded: [], plans: [plan('list', 599)], last_reviewed: '2026-09-02' },
  { id: 'b', name: 'B', cta_url: 'https://b.example', affiliate_url: null, cta_label: 'Quote', countries_excluded: [], plans: [plan('quote', null)], last_reviewed: '2026-09-02' },
  { id: 'c', name: 'C', cta_url: 'https://c.example', affiliate_url: null, cta_label: 'Quote', countries_excluded: ['ZZ'], plans: [plan('list', 199)], last_reviewed: '2026-09-02' },
];
// 2 ZZD per USD so caps and flat amounts are exercised in local currency
const snap = (c = country) => ({ snapshot_date: '2026-09-02', source_commit: 'test', fx: { as_of: '2026-09-02', rates: { ZZD: 2 } }, countries: [c], vendors });
const tools = createTools(snap());
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('ledger: caps, basic base, flat amounts, gating and extras', () => {
  const r = tools.employerCost({ country: 'ZZ', salary: 60000 });
  const line = (id) => r.lines.find((l) => l.id === id);
  assert.equal(r.salary.annual_local, 'ZZD 120,000');
  close(line('pension').annual_usd, 5000);
  assert.equal(line('pension').capped, true);
  assert.equal(line('pension').base_cap_annual_local, 100000);
  close(line('fund').annual_usd, 3600);
  close(line('levy').annual_usd, 500);
  assert.equal(line('lowpay').skipped, true);
  assert.equal(line('lowpay').annual_usd, 0);
  close(line('thirteenth').annual_usd, 5000);
  close(line('holiday').annual_usd, 4800);
  assert.equal(line('info'), undefined);
  assert.deepEqual(r.not_in_total.map((e) => e.id), ['info']);
  close(r.employer_cost.values.annual_usd, 18900);
  close(r.employer_cost.values.pct_of_gross, 31.5);
  assert.equal(r.employer_cost.pct_of_gross, '31.5%');
  // salary + employer cost per month
  close(tools.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'a' }).salary_plus_statutory.values.monthly_usd, 6575);
});

test('low-pay scheme under the threshold, assumption override, local-currency salary', () => {
  for (const salary of [{ salary: 30000 }, { salary: 60000, salary_currency: 'local' }]) {
    const r = tools.employerCost({ country: 'Testland', ...salary, assumptions: { basic_share_of_gross: 1 } });
    const line = (id) => r.lines.find((l) => l.id === id);
    assert.equal(line('lowpay').skipped, undefined);
    close(line('lowpay').annual_usd, 1500);
    close(line('fund').annual_usd, 3600);
    assert.equal(r.assumptions[0].used, 1);
  }
});

test('basic share is bounded to [0, 1] whatever the input says', () => {
  const fund = (share) => tools.employerCost({ country: 'ZZ', salary: 30000, assumptions: { basic_share_of_gross: share } }).lines.find((l) => l.id === 'fund').annual_usd;
  close(fund(7), fund(1));
  close(fund(1e9), fund(1));
  assert.equal(fund(-3), 0);
  close(fund(NaN), fund(1));
});

test('an assumption the country does not offer is refused', () => {
  assert.throws(() => tools.employerCost({ country: 'ZZ', assumptions: { employee_is_citizen_or_pr: 0 } }), /cannot be changed/);
  const fixed = createTools(snap({ ...country, assumptions: [{ ...country.assumptions[0], adjustable: false }] }));
  assert.throws(() => fixed.employerCost({ country: 'ZZ', assumptions: { basic_share_of_gross: 1 } }), /cannot be changed/);
});

test('providers per headcount: list price, quote only, excluded country', () => {
  const a = tools.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'a', headcount: 3 });
  close(a.total.values.monthly_usd, (6575 + 599) * 3);
  close(a.total.values.annual_usd, (6575 + 599) * 36);
  assert.ok(Math.abs(a.total.values.fee_share_pct - (599 / 7174) * 100) < 1e-4);
  assert.equal(a.total.monthly, '$21,522');
  const b = tools.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'b', headcount: 3 });
  assert.equal(b.total.monthly, 'quote only');
  assert.equal(b.provider.fee_per_month, 'quote only');
  assert.equal(b.provider.pricing_model, 'quote');
  assert.equal('values' in b.total, false);
  const c = tools.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'c', headcount: 3 });
  assert.equal(c.provider.available, false);
  assert.equal(c.total.monthly, 'not available');
  assert.equal('values' in c.total, false);
});

test('band contributions are charged only on the slice between floor and cap', () => {
  const band = createTools(snap({
    ...country,
    employer_contributions: [{ ...none, id: 'tier2', name: 'Second-tier pension', rate: 0.04, base: 'band', cap_annual_local: 100000, floor_annual_local: 20000, source: src }],
    statutory_extras: [],
  }));
  const cost = (salary) => band.employerCost({ country: 'ZZ', salary }).employer_cost.values.annual_usd;
  close(cost(60000), 1600);
  assert.equal(cost(5000), 0);
  close(cost(20000), 400);
});

test('headcount is clamped to 1-50 and nothing is NaN', () => {
  const r = tools.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'a', headcount: 999 });
  assert.equal(r.headcount, 50);
  assert.ok(Number.isFinite(r.total.values.monthly_usd));
  for (const l of tools.employerCost({ country: 'ZZ', salary: 60000 }).lines) assert.ok(Number.isFinite(l.monthly_usd));
});

test('unknown country, unknown provider, missing FX rate', () => {
  assert.throws(() => tools.employerCost({ country: 'XX', salary: 1 }), /Unknown country/);
  assert.throws(() => tools.totalHiringCost({ country: 'ZZ', provider: 'nobody' }), /Unknown provider/);
  const noFx = createTools({ ...snap(), fx: { as_of: 'x', rates: {} } });
  assert.throws(() => noFx.employerCost({ country: 'ZZ', salary: 1 }), /No FX rate/);
});

test('a declared floor or ceiling is written into every figure', () => {
  const floor = createTools(snap({ ...country, total_bound: 'floor' }));
  const r = floor.employerCost({ country: 'ZZ', salary: 60000 });
  assert.equal(r.employer_cost.pct_of_gross, 'at least 31.5%');
  assert.equal(r.employer_cost.monthly, 'at least $1,575');
  assert.equal(r.employer_cost.annual, 'at least $18,900');
  assert.match(r.summary, /costs at least \$1,575 a month in statutory employer charges \(at least \+31\.5% of gross\)/);
  assert.equal(floor.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'a' }).total.monthly, 'at least $7,174');
  assert.equal(floor.listCountries().countries[0].employer_cost_at_example, 'at least 31.5%');
  const ceiling = createTools(snap({ ...country, total_bound: 'ceiling' }));
  assert.equal(ceiling.employerCost({ country: 'ZZ', salary: 60000 }).employer_cost.monthly, 'at most $1,575');
  assert.equal(ceiling.totalHiringCost({ country: 'ZZ', salary: 60000, provider: 'a' }).total.monthly, 'at most $7,174');
});
