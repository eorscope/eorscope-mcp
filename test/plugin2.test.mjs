// Phase 2 (audit/PLUGIN_CHATGPT_SPEC_2026-10-09.md, sections 3, 5 and 8 bis): structuredContent with a declared
// outputSchema on every tool, scheduled_changes and cost_next_year. Dated changes reach the snapshot only through
// audit/plugin_data/REVIEWED.json (empty for now), so the projection is checked on a test fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { createTools, loadSnapshot } from '../dist/tools.js';
import { OUTPUT_SCHEMAS } from '../dist/server.js';
import { computeScenario } from '../src/vendor/cost-engine.ts';

const snapshot = loadSnapshot();
const tools = createTools(snapshot, { utm: 'chatgpt' });
const fixture = JSON.parse(readFileSync(new URL('./fixtures/scheduled_fixture.json', import.meta.url), 'utf8'));
const { _comment, ...scheduled } = fixture;
const tracked = { ...snapshot, scheduled };
const ftools = createTools(tracked, { utm: 'chatgpt' });
const CENT = 0.005 + 1e-9;

// the declared schema, strict at the top level: a key a tool returns is a key the schema declares
const conforms = (name, out) => {
  const r = z.object(OUTPUT_SCHEMAS[name]).strict().safeParse(out);
  assert.ok(r.success, `${name}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`);
};

test('outputSchema: every tool output conforms, on the snapshot and on the fixture', () => {
  const offers = [{ country: 'PL', salary: 60000 }, { country: 'PT', salary: 45000 }];
  const calls = (t) => ({
    list_countries: t.listCountries(),
    employer_cost: t.employerCost({ country: 'DE', salary: 80000, include_notes: true }),
    compare_countries: t.compareCountries({ countries: ['DE', 'AE', 'GH'], salary_usd: 60000 }),
    max_salary_for_budget: t.maxSalaryForBudget({ country: 'DE', budget: 100000, eor_fee_usd_month: 400 }),
    employment_terms: t.employmentTerms({ country: 'BR' }),
    reconcile_quote: t.reconcileQuote({ country: 'PL', salary: 60000, lines: [{ label: 'Salary', amount: 5000, type: 'salary' }, { label: 'Mystery levy', amount: 30, type: 'employer_charge' }, { label: 'Fee', amount: 400, type: 'fee' }] }),
    compare_structures: t.compareStructures({ country: 'PL', eor_fee_usd_month: 400, entity_setup_usd: 15000, entity_annual_usd: 25000, contractor_fee_usd_month: 49 }),
    compare_offers: t.compareOffers({ offers }),
    fx_stress: t.fxStress({ country: 'BR', salary_local: 180000, budget_usd: 50000 }),
    contractor_rate_equivalent: t.contractorRateEquivalent({ country: 'DE', salary: 80000, eor_fee_usd_month: 500 }),
    scheduled_changes: t.scheduledChanges({ country: 'DE' }),
    cost_next_year: t.costNextYear({ country: 'DE', salary: 120000, on_date: '2027-07-01' }),
    show_ledger: t.showLedger({ country: 'DE', salary: 80000 }),
    show_compare: t.showCompare({ offers }),
  });
  for (const t of [tools, ftools]) {
    const outs = calls(t);
    assert.deepEqual(Object.keys(outs).sort(), Object.keys(OUTPUT_SCHEMAS).sort());
    for (const [name, o] of Object.entries(outs)) {
      conforms(name, o);
      assert.ok(o.summary.length > 20 && o.summary.length < 1500, `${name}: summary`);
    }
  }
  for (const c of snapshot.countries) {
    conforms('scheduled_changes', tools.scheduledChanges({ country: c.iso }));
    conforms('cost_next_year', tools.costNextYear({ country: c.iso }));
  }
  conforms('cost_next_year', ftools.costNextYear({ country: 'IE', salary: 35000 }));
});

test('REVIEWED.json empty: every country is "not yet tracked", never "no change", and no projection is made', () => {
  // an empty REVIEWED.json, built here: the committed snapshot carries the reviewed countries
  const etools = createTools({ ...snapshot, scheduled: {} }, { utm: 'chatgpt' });
  for (const c of snapshot.countries) {
    const s = etools.scheduledChanges({ country: c.iso });
    const p = etools.costNextYear({ country: c.iso });
    for (const o of [s, p]) {
      assert.equal(o.tracking, 'not yet tracked', c.iso);
      assert.match(o.summary, /not yet tracked/, c.iso);
      assert.match(o.summary, /does not mean that nothing is scheduled/, c.iso);
      assert.doesNotMatch(JSON.stringify(o), /no change|unchanged/i, c.iso);
      assert.match(o.meta.page_url, new RegExp(`/employer-of-record/${c.slug}/\\?utm_source=chatgpt$`), c.iso);
      assert.match(o.meta.disclaimer, /not legal or tax advice/i);
      assert.match(o.meta.license, /CC BY 4\.0.*EOR Scope/);
    }
    assert.deepEqual(s.changes, []);
    assert.equal(p.projected, null);
    assert.equal(p.current.employer_cost.values.annual_usd, etools.employerCost({ country: c.iso }).employer_cost.values.annual_usd, c.iso);
  }
});

test('cost_next_year: a rate change and a ceiling change apply on their day, not the day before', () => {
  const de = snapshot.countries.find((c) => c.iso === 'DE');
  const rate = snapshot.fx.rates[de.currency];
  const salary = 120000; // above both ceilings
  const before = ftools.costNextYear({ country: 'DE', salary, on_date: '2026-12-31' });
  const on = ftools.costNextYear({ country: 'DE', salary, on_date: '2027-01-01' });
  const today = ftools.employerCost({ country: 'DE', salary });
  assert.equal(before.current.employer_cost.values.annual_usd, today.employer_cost.values.annual_usd);
  assert.equal(before.projected.difference_annual_usd, 0);
  assert.deepEqual(before.projected.changes_applied, []);
  assert.equal(before.projected.employer_cost.values.annual_usd, today.employer_cost.values.annual_usd);

  // 9.3 % -> 9.5 % on the 101 400 EUR pension ceiling, health ceiling 69 750 -> 76 500 EUR at 8.75 %
  const expected = (0.002 * 101400 + 0.0875 * (76500 - 69750)) / rate;
  assert.ok(Math.abs(on.projected.difference_annual_usd - expected) <= 0.02, `${on.projected.difference_annual_usd} vs ${expected}`);
  assert.deepEqual(on.projected.lines_changed.map((l) => l.id).sort(), ['krankenversicherung', 'rentenversicherung']);
  // the same as the site's engine on the country with the two changes written in
  const p = structuredClone(de);
  p.employer_contributions.find((k) => k.id === 'rentenversicherung').rate = 0.095;
  p.employer_contributions.find((k) => k.id === 'krankenversicherung').cap_annual_local = 76500;
  const eng = computeScenario({ countryIso: 'DE', salaryAnnualUsd: salary, headcount: 1, vendorIds: [] }, { countries: [p], vendors: [], fx: snapshot.fx });
  assert.ok(Math.abs(on.projected.employer_cost.values.annual_usd - eng.employerCostAnnualUsd) <= CENT);

  const applied = Object.fromEntries(on.projected.changes_applied.map((x) => [x.contribution_id ?? 'null', x]));
  assert.deepEqual(applied.rentenversicherung.applied_as, { rate: 0.095 });
  assert.deepEqual(applied.krankenversicherung.applied_as, { cap_annual_local: 76500 });
  assert.match(applied.krankenversicherung.date_note, /derived/);
  assert.match(applied.umlage_u2.no_figure, /no figure yet/);
  assert.match(applied.null.not_applied, /Not an employer contribution line/);
  assert.equal(applied.null.name, 'No matching ledger line');
  // in force before the country file's last review: already in the ledger, never applied again
  assert.equal(applied.pflegeversicherung, undefined);
  assert.equal(on.with_budget_announced, undefined, 'the announced change is from 1 July');
  assert.ok(on.flags.some((f) => /2027-01-01 date is derived/.test(f)));
  assert.ok(on.flags.some((f) => /Coverage partial/.test(f)));
  assert.match(on.summary, /2 enacted changes|4 enacted changes/);
});

test('cost_next_year: a change announced in a budget only in its own, flagged variant', () => {
  const de = snapshot.countries.find((c) => c.iso === 'DE');
  const rate = snapshot.fx.rates[de.currency];
  const jun = ftools.costNextYear({ country: 'DE', salary: 120000, on_date: '2027-06-30' });
  const jul = ftools.costNextYear({ country: 'DE', salary: 120000, on_date: '2027-07-01' });
  assert.equal(jun.with_budget_announced, undefined);
  assert.equal(jul.projected.employer_cost.values.annual_usd, jun.projected.employer_cost.values.annual_usd, 'enacted projection ignores the announcement');
  assert.match(jul.with_budget_announced.flag, /announced in a budget, not yet enacted/);
  assert.ok(Math.abs(jul.with_budget_announced.difference_annual_usd - jul.projected.difference_annual_usd - (0.002 * 101400) / rate) <= 0.02);
  assert.ok(jul.flags.some((f) => /inferred/.test(f)) && jul.flags.some((f) => /secondary source/.test(f)));
  assert.match(jul.summary, /announced in a budget is enacted as announced/);
});

test('cost_next_year: a weekly threshold moves the gross band edge of the line (x 52)', () => {
  const ie = snapshot.countries.find((c) => c.iso === 'IE');
  const rate = snapshot.fx.rates[ie.currency];
  const salary = 30000 / rate; // 30 000 EUR: above 552 x 52 = 28 704, below 600 x 52 = 31 200
  const o = ftools.costNextYear({ country: 'IE', salary, on_date: '2027-01-01' });
  const applied = o.projected.changes_applied;
  assert.deepEqual(applied.map((x) => x.applied_as), [{ max_gross_annual_local: 31200 }, { min_gross_annual_local: 31200 }]);
  assert.ok(applied.every((x) => /x 52/.test(x.calculation)));
  const p = structuredClone(ie);
  p.employer_contributions.find((k) => k.id === 'employer_prsi_reduced').max_gross_annual_local = 31200;
  p.employer_contributions.find((k) => k.id === 'employer_prsi_full').min_gross_annual_local = 31200;
  const eng = computeScenario({ countryIso: 'IE', salaryAnnualUsd: salary, headcount: 1, vendorIds: [] }, { countries: [p], vendors: [], fx: snapshot.fx });
  assert.ok(Math.abs(o.projected.employer_cost.values.annual_usd - eng.employerCostAnnualUsd) <= CENT);
  assert.notEqual(o.projected.difference_annual_usd, 0);
});

test('scheduled_changes: dated changes in date order with status, date basis and source; tracked with no change found says so', () => {
  const o = ftools.scheduledChanges({ country: 'DE' });
  assert.equal(o.tracking, 'tracked');
  assert.equal(o.coverage, 'partial');
  assert.deepEqual(o.changes.map((x) => x.effective_from), [...o.changes.map((x) => x.effective_from)].sort());
  for (const x of o.changes) assert.ok(x.status && x.date_basis && x.source.url && x.source.quote && x.source.read_on && x.source.kind);
  assert.equal(o.changes.find((x) => x.contribution_id === 'pflegeversicherung').in_force_at_last_review, true);
  assert.match(o.summary, /6 dated changes recorded, 5 enacted and 1 announced in a budget/);
  assert.match(o.summary, /coverage partial/);
  const empty = createTools({ ...snapshot, scheduled: { PL: { researched_on: '2026-10-09', coverage: 'complete', scheduled_changes: [] } } }).scheduledChanges({ country: 'PL' });
  assert.match(empty.summary, /no dated change found in the sources read/);
  assert.throws(() => ftools.costNextYear({ country: 'DE', on_date: '2027-02-30' }), /calendar date/);
  const def = ftools.costNextYear({ country: 'DE' });
  assert.equal(def.on_date, `${Number(snapshot.snapshot_date.slice(0, 4)) + 1}-01-01`);
});

test('phase 2 outputs: no rank, no superlative, no provider name in the sentences written', () => {
  const s = [ftools.costNextYear({ country: 'DE', salary: 120000, on_date: '2027-07-01' }), ftools.scheduledChanges({ country: 'DE' }), tools.costNextYear({ country: 'BR' })].flatMap((o) => [o.summary, o.reading, ...(o.flags ?? [])]);
  for (const x of s) assert.doesNotMatch(x, /\b(cheapest|lowest|highest|most expensive|the only|best|rank(ed|s)?|Deel|Remote|Oyster|Papaya)\b/i, x);
});

test('reviewed snapshot: South Korea on 2027-03-01 applies the enacted 5% employer pension step, capped by the NPS ceiling', () => {
  const p = tools.costNextYear({ country: 'KR', salary: 60000, on_date: '2027-03-01' });
  assert.equal(p.tracking, 'tracked');
  const now = p.current.employer_cost.values.annual_usd;
  const then = p.projected.employer_cost.values.annual_usd;
  // +0.25 point of the capped base (KRW 6,590,000 a month): about $142 a year at the snapshot FX
  assert.ok(then > now && then - now < 200, `${now} -> ${then}`);
  assert.equal(p.projected.changes_applied.length >= 1, true);
});
