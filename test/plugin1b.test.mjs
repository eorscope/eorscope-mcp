// Phase 1b (audit/PLUGIN_CHATGPT_SPEC_2026-10-09.md, sections 3, 4 and 8 bis): compare_offers, fx_stress,
// contractor_rate_equivalent and the two render tools, checked against employer_cost (itself checked
// against the site's engine in plugin.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTools, loadSnapshot } from '../dist/tools.js';

const snapshot = loadSnapshot();
const tools = createTools(snapshot, { utm: 'chatgpt' });

test('compare_offers: one salary per country, totals = employer_cost, differences and ratios to the smallest total', () => {
  const pl = snapshot.countries.find((c) => c.iso === 'PL');
  const offers = [{ country: 'PL', salary: 240000, salary_currency: 'local' }, { country: 'Portugal', salary: 45000 }, { country: 'DE', salary: 300000 }];
  const o = tools.compareOffers({ offers });
  assert.deepEqual(o.offers.map((x) => x.iso), ['PL', 'PT', 'DE']);
  const each = offers.map((x) => tools.employerCost(x));
  o.offers.forEach((x, i) => {
    assert.equal(x.employer_cost.values.annual_usd, each[i].employer_cost.values.annual_usd, x.iso);
    assert.ok(Math.abs(x.total.annual_usd - (each[i].salary.annual_usd + each[i].employer_cost.values.annual_usd)) <= 0.01, x.iso);
    assert.ok(Math.abs(x.difference_from_smallest_annual_usd - (x.total.annual_usd - o.smallest_total.annual_usd)) <= 0.01, x.iso);
    assert.ok(Math.abs(x.ratio_to_smallest - x.total.annual_usd / o.smallest_total.annual_usd) <= 0.0005, x.iso);
    assert.deepEqual(x.ceilings_reached.map((l) => l.id), each[i].lines.filter((l) => l.capped).map((l) => l.id), x.iso);
  });
  assert.ok(Math.abs(o.offers[0].salary.annual_usd - 240000 / snapshot.fx.rates[pl.currency]) <= 0.01);
  assert.equal(Math.min(...o.offers.map((x) => x.difference_from_smallest_annual_usd)), 0);
  assert.ok(o.offers[2].ceilings_reached.length > 0, 'DE at 300k reaches a ceiling');
  // a declared bound is carried to the total and announced in the reading
  const b = tools.compareOffers({ offers: [{ country: 'AE', salary: 80000 }, { country: 'DE', salary: 80000 }] });
  assert.match(b.offers[0].total.annual, /^at least \$/);
  assert.match(b.reading, /declared bound/);
  assert.throws(() => tools.compareOffers({ offers: [{ country: 'DE', salary: 1 }, { country: 'Germany', salary: 2 }] }), /One offer per country/);
  assert.throws(() => tools.compareOffers({ offers: [{ country: 'DE', salary: 1 }] }), /2 to 6/);
});

test('fx_stress: official rate = employer_cost, moves symmetric and proportional, budget break point', () => {
  const br = snapshot.countries.find((c) => c.iso === 'BR');
  const rate = snapshot.fx.rates[br.currency];
  const o = tools.fxStress({ country: 'BR', salary_local: 180000, budget_usd: 50000 });
  const e = tools.employerCost({ country: 'BR', salary: 180000, salary_currency: 'local' });
  const base = e.salary.annual_usd + e.employer_cost.values.annual_usd;
  const at = (p) => o.scenarios.find((s) => s.local_currency_change_pct === p);
  assert.deepEqual(o.scenarios.map((s) => s.local_currency_change_pct), [-20, -10, -5, 0, 5, 10, 20]);
  assert.ok(Math.abs(at(0).annual_usd - base) <= 0.01);
  assert.equal(at(0).local_per_usd, Math.round(rate * 1e6) / 1e6);
  for (const p of [5, 10, 20]) {
    assert.ok(Math.abs(at(p).difference_annual_usd + at(-p).difference_annual_usd) <= 0.01, `±${p} symmetric`);
    assert.ok(Math.abs(at(p).annual_usd - base * (1 + p / 100)) <= 0.02, `+${p}`);
    assert.ok(Math.abs(at(p).local_per_usd * (1 + p / 100) - rate) <= 1e-5, `rate +${p}`);
  }
  // the cost in local currency does not move: annual_usd x local_per_usd is constant
  for (const s of o.scenarios) assert.ok(Math.abs(s.annual_usd * s.local_per_usd - base * rate) <= 0.05 * rate, `${s.local_currency_change_pct}`);
  assert.equal(o.exchange_rate.local_per_usd, rate);
  assert.ok(o.exchange_rate.date && o.exchange_rate.source);
  assert.equal(o.budget.holds_until_local_currency_change_pct, Math.round((50000 / base - 1) * 1000) / 10);
  for (const s of o.scenarios) assert.equal(s.within_budget, s.annual_usd <= 50000 + 0.01);
  assert.throws(() => tools.fxStress({ country: 'US', salary_local: 100000 }), /no exchange-rate exposure/);
});

test('contractor_rate_equivalent: default working days from the country file; day and hour rates give the annual cost back', () => {
  for (const c of snapshot.countries.filter((x) => x.public_holidays != null)) {
    const o = tools.contractorRateEquivalent({ country: c.iso });
    const e = tools.employerCost({ country: c.iso });
    const annual = e.salary.annual_usd + e.employer_cost.values.annual_usd;
    const days = 260 - c.paid_leave_days - c.public_holidays;
    assert.equal(o.working_days.value, days, c.iso);
    assert.ok(Math.abs(o.annual_cost.usd - annual) <= 0.01, c.iso);
    assert.ok(Math.abs(o.equivalent_rate.day_usd * days - annual) <= days * 0.005 + 0.01, `${c.iso} day`);
    assert.ok(Math.abs(o.equivalent_rate.hour_usd * 8 * days - annual) <= days * 8 * 0.005 + 0.01, `${c.iso} hour`);
  }
  const o = tools.contractorRateEquivalent({ country: 'DE', salary: 80000, eor_fee_usd_month: 500, paid_leave_days: 30, public_holidays: 10, hours_per_day: 7.5 });
  assert.equal(o.working_days.value, 220);
  assert.equal(o.working_days.paid_leave_days.from, 'your input');
  const e = tools.employerCost({ country: 'DE', salary: 80000 });
  assert.ok(Math.abs(o.equivalent_rate.day_usd - (80000 + e.employer_cost.values.annual_usd + 6000) / 220) <= 0.005);
  assert.ok(Math.abs(o.equivalent_rate.hour_usd - o.equivalent_rate.day_usd / 7.5) <= 0.01);
  assert.equal(tools.contractorRateEquivalent({ country: 'DE', working_days: 200 }).working_days.value, 200);
  const missing = snapshot.countries.find((c) => c.public_holidays == null);
  assert.throws(() => tools.contractorRateEquivalent({ country: missing.iso }), /pass public_holidays or working_days/);
  assert.equal(tools.contractorRateEquivalent({ country: missing.iso, public_holidays: 12 }).working_days.value, 260 - missing.paid_leave_days - 12);
  assert.match(o.caveats.join(' '), /legal question this tool does not answer/);
  assert.match(tools.contractorRateEquivalent({ country: 'AE' }).equivalent_rate.bound, /at least/);
});

test('render tools: the ledger is employer_cost plus the site scenario link and the salary input; the comparison is compare_offers plus its display mode', () => {
  const a = { country: 'DE', salary: 80000 };
  const { scenario_url, salary_input, ...ledger } = tools.showLedger(a);
  assert.deepEqual(salary_input, { salary: 80000, salary_currency: 'USD', salary_period: 'year' });
  assert.deepEqual(ledger, tools.employerCost(a));
  assert.equal(scenario_url, 'https://eorscope.com/eor-cost-calculator/?c=DE&s=80000&n=1&utm_source=chatgpt');
  const offers = [{ country: 'PL', salary: 60000 }, { country: 'PT', salary: 45000 }];
  const { display, ...cmp } = tools.showCompare({ offers });
  assert.equal(display, 'inline');
  assert.deepEqual(cmp, tools.compareOffers({ offers }));
  assert.equal(tools.showCompare({ offers: [...offers, { country: 'ES', salary: 1 }, { country: 'IE', salary: 1 }] }).display, 'fullscreen');
});

test('new outputs: no rank and no superlative in the sentences written', () => {
  const s = [
    tools.compareOffers({ offers: [{ country: 'PL', salary: 60000 }, { country: 'AE', salary: 60000 }, { country: 'GH', salary: 60000 }] }),
    tools.fxStress({ country: 'IN', salary_local: 3000000, budget_usd: 50000 }),
    tools.contractorRateEquivalent({ country: 'BR' }),
  ].flatMap((o) => [o.summary, o.reading, ...(o.caveats ?? [])].filter(Boolean));
  for (const x of s) assert.doesNotMatch(x, /\b(cheapest|lowest|highest|most expensive|the only|best|rank(ed|s)?)\b/i, x);
});
