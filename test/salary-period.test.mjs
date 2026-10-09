// Monthly salaries (09/10): a salary given a month is converted by the plugin itself with the country's statutory
// number of payments (audit/plugin_data schema v2, scripts/sync.mjs), less the payments the ledger adds as lines of
// its own (SALARY_ENGINE_MAP.json), so the 13th or 14th month is neither forgotten nor counted twice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createTools, loadSnapshot } from '../dist/tools.js';
import { OUTPUT_SCHEMAS } from '../dist/server.js';

const snapshot = loadSnapshot();
const tools = createTools(snapshot);
const country = (iso) => snapshot.countries.find((c) => c.iso === iso);
const conforms = (name, out) => {
  const r = z.object(OUTPUT_SCHEMAS[name]).strict().safeParse(out);
  assert.ok(r.success, `${name}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`);
};

// Portugal as it reads once reviewed: 14 statutory payments, both inside the annual gross (the ledger carries them at zero)
const PT = {
  basis: 'statutory',
  count: 14,
  gross_months: 14,
  on_top_lines: [],
  on_top_months: 0,
  payments: [{ name: 'Subsidio de Natal and subsidio de ferias', statutory: true, salary_months: 2, months: [12], deadline: '15 Dec' }],
  customary: [],
  source: { url: 'https://diariodarepublica.pt/dr/legislacao-consolidada/lei/2009-34546475', quote: 'subsidio de Natal de valor igual a um mes de retribuicao', read_on: '2026-10-09', kind: 'official' },
};
const withPT = { ...snapshot, countries: snapshot.countries.map((c) => (c.iso === 'PT' ? { ...c, salary_payments: PT } : c)) };
const ptTools = createTools(withPT);

test('salary_period "month": Portugal 3,200 a month is 14 payments, an annual gross of 44,800', () => {
  const o = ptTools.employerCost({ country: 'PT', salary: 3200, salary_currency: 'local', salary_period: 'month' });
  assert.equal(o.salary_basis.annual_gross_used, 44800);
  assert.equal(o.salary_basis.payments_per_year, 14);
  assert.equal(o.salary_basis.payments_from, 'statutory');
  assert.equal(o.salary_basis.composition, 'EUR 3,200 a month × 14 statutory payments = EUR 44,800 a year');
  assert.equal(o.salary.annual_local, 'EUR 44,800');
  assert.match(o.summary, /Salary basis: EUR 3,200 a month × 14 statutory payments/);
  const year = ptTools.employerCost({ country: 'PT', salary: 44800, salary_currency: 'local' });
  assert.deepEqual(o.employer_cost, year.employer_cost);
  assert.equal(year.salary_basis, undefined);
  conforms('employer_cost', o);
  // the ledger widget is the same call
  const l = ptTools.showLedger({ country: 'PT', salary: 3200, salary_currency: 'local', salary_period: 'month' });
  assert.equal(l.salary_basis.composition, o.salary_basis.composition);
});

test('Brazil 10,000 a month: 120,000 of annual gross, the 13th salary and the vacation third added by the ledger', () => {
  const o = tools.employerCost({ country: 'BR', salary: 10000, salary_currency: 'local', salary_period: 'month' });
  assert.equal(o.salary_basis.annual_gross_used, 120000);
  assert.equal(o.salary_basis.payments_per_year, 13.3333);
  assert.equal(o.salary_basis.gross_months, 12);
  assert.equal(o.salary.annual_local, 'BRL 120,000');
  const ids = o.lines.map((l) => l.id);
  for (const id of ['decimo_terceiro', 'ferias_terco_constitucional']) assert.ok(ids.includes(id) && o.lines.find((l) => l.id === id).annual_usd > 0, id);
  // one month of salary: the 13th is not also inside the gross
  const rate = snapshot.fx.rates.BRL;
  assert.ok(Math.abs(o.lines.find((l) => l.id === 'decimo_terceiro').annual_usd - 10000 / rate) < 0.01);
  assert.deepEqual(o.employer_cost, tools.employerCost({ country: 'BR', salary: 120000, salary_currency: 'local' }).employer_cost);
  assert.match(o.salary_basis.composition, /× 13\.33 statutory payments: 12 in the annual gross/);
});

test('Mexico: the aguinaldo is half a month, added by the ledger', () => {
  const o = tools.employerCost({ country: 'MX', salary: 20000, salary_currency: 'local', salary_period: 'month' });
  assert.equal(o.salary_basis.payments_per_year, 12.5);
  assert.equal(o.salary_basis.on_top_months, 0.5);
  assert.equal(o.salary_basis.annual_gross_used, 240000);
});

test('payments_per_year overrides the count: Philippines 14 payments, 13 in the gross and the 13th-month pay as a line', () => {
  const o = tools.employerCost({ country: 'PH', salary: 50000, salary_currency: 'local', salary_period: 'month', payments_per_year: 14 });
  assert.equal(o.salary_basis.gross_months, 13);
  assert.equal(o.salary_basis.annual_gross_used, 650000);
  assert.equal(o.salary_basis.payments_from, 'your input');
  assert.equal(o.salary_basis.statutory_payments, 13);
  assert.equal(o.salary_basis.flag, undefined);
  assert.equal(tools.employerCost({ country: 'PH', salary: 50000, salary_currency: 'local', salary_period: 'month' }).salary_basis.annual_gross_used, 600000);
  assert.match(tools.employerCost({ country: 'PH', salary: 50000, salary_currency: 'local', salary_period: 'month', payments_per_year: 12 }).salary_basis.flag, /below the 13 statutory/);
});

test('a country whose payments are not tracked: 12 payments and a flag asking for payments_per_year', () => {
  const c = snapshot.countries.find((x) => !x.salary_payments);
  const o = tools.employerCost({ country: c.iso, salary: 5000, salary_period: 'month' });
  assert.equal(o.salary_basis.payments_per_year, 12);
  assert.equal(o.salary_basis.statutory_payments, null);
  assert.equal(o.salary_basis.annual_gross_used, 60000);
  assert.match(o.salary_basis.flag, /not yet tracked.*payments_per_year/);
  const p = tools.employerCost({ country: c.iso, salary: 5000, salary_period: 'month', payments_per_year: 13 });
  assert.equal(p.salary_basis.annual_gross_used, 65000);
  assert.equal(p.salary_basis.flag, undefined);
});

test('salary_period "year" is the default and unchanged; payments_per_year alone is refused', () => {
  const o = tools.employerCost({ country: 'DE', salary: 80000 });
  assert.equal(o.salary_basis, undefined);
  assert.doesNotMatch(o.summary, /Salary basis/);
  assert.throws(() => tools.employerCost({ country: 'DE', salary: 80000, payments_per_year: 13 }), /salary_period "month"/);
  assert.throws(() => tools.employerCost({ country: 'DE', salary_period: 'month' }), /monthly salary/);
});

test('every tool that takes a salary takes a monthly one', () => {
  const m = { salary: 10000, salary_currency: 'local', salary_period: 'month' };
  const br = 'BRL 120,000';
  assert.equal(tools.reconcileQuote({ country: 'BR', ...m, lines: [{ label: 'Fee', amount: 500, type: 'fee' }] }).salary.annual_local, br);
  assert.equal(tools.compareStructures({ country: 'BR', ...m, eor_fee_usd_month: 500 }).salary.annual_local, br);
  assert.equal(tools.contractorRateEquivalent({ country: 'BR', ...m }).salary.annual_local, br);
  assert.equal(tools.costNextYear({ country: 'BR', ...m }).salary.annual_local, br);
  const fx = tools.fxStress({ country: 'BR', salary_local: 10000, salary_period: 'month' });
  assert.equal(fx.salary_annual_local, br);
  assert.equal(fx.salary_basis.annual_gross_used, 120000);
  conforms('fx_stress', fx);
  const offers = ptTools.compareOffers({ offers: [{ country: 'PT', salary: 3200, salary_currency: 'local', salary_period: 'month' }, { country: 'BR', ...m }] });
  assert.deepEqual(offers.offers.map((x) => x.salary.annual_local), ['EUR 44,800', br]);
  const cc = ptTools.compareCountries({ countries: ['PT', 'ES'], salary_usd: 4000, salary_period: 'month' });
  assert.equal(cc.salary_monthly_usd, 4000);
  assert.deepEqual(cc.countries.map((x) => x.salary_annual_usd), [56000, 56000]);
  conforms('compare_countries', cc);
  conforms('cost_next_year', tools.costNextYear({ country: 'BR', ...m }));
});

test('max_salary_for_budget: the monthly salary the gross stands for, paid 14 times in Portugal', () => {
  const o = ptTools.maxSalaryForBudget({ country: 'PT', budget: 60000, budget_currency: 'local' });
  const mm = o.max_monthly_salary;
  assert.equal(mm.gross_months, 14);
  assert.equal(mm.payments_per_year, 14);
  assert.ok(Math.abs(mm.monthly_usd * 14 - o.max_salary.annual_usd) < 0.15);
  assert.match(mm.composition, /^EUR [\d,]+ a month × 14 statutory payments = EUR [\d,]+ a year$/);
  conforms('max_salary_for_budget', o);
  const br = tools.maxSalaryForBudget({ country: 'BR', budget: 200000, budget_currency: 'local' }).max_monthly_salary;
  assert.equal(br.gross_months, 12);
  assert.equal(br.payments_per_year, 13.3333);
});

test('employment_terms exposes the number of salary payments', () => {
  const o = tools.employmentTerms({ country: 'BR' });
  assert.equal(o.salary_payments.tracking, 'tracked');
  assert.equal(o.salary_payments.count, 13.3333);
  assert.deepEqual(o.salary_payments.on_top_lines, ['decimo_terceiro', 'ferias_terco_constitucional']);
  assert.ok(o.salary_payments.source.url.startsWith('https://'));
  conforms('employment_terms', o);
  const c = snapshot.countries.find((x) => !x.salary_payments);
  assert.equal(tools.employmentTerms({ country: c.iso }).salary_payments.tracking, 'not yet tracked');
});

test('Chile: pending proposals are listed, and flag the projection when they bear on a dated change in the window', () => {
  const s = tools.scheduledChanges({ country: 'CL' });
  assert.ok(s.pending.some((x) => x.status === 'proposal' && x.contribution_id === 'cotizacion_empleador_pensiones'));
  conforms('scheduled_changes', s);
  const later = tools.costNextYear({ country: 'CL', salary: 40000, on_date: '2029-09-01' });
  assert.ok(later.flags.some((f) => /pending proposal, not enacted/.test(f)), JSON.stringify(later.flags));
  // nothing dated on that line before 2027-08-01: no flag
  assert.ok(!tools.costNextYear({ country: 'CL', salary: 40000, on_date: '2027-01-01' }).flags.some((f) => /pending/.test(f)));
});

// ------------------------------------------------------------------ sync: the checks that refuse a bad file
const pkg = fileURLToPath(new URL('..', import.meta.url));
const site = existsSync(join(pkg, '..', '..', 'site', 'src', 'data'));
const source = { url: 'https://example.org/law', quote: 'one month of pay', read_on: '2026-10-09', kind: 'official' };
const sync = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'eorscope-sync-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
    const before = readFileSync(join(pkg, 'data', 'snapshot.json'), 'utf8');
    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'sync.mjs'), '--date', snapshot.snapshot_date, '--plugin-data', dir], { encoding: 'utf8' });
    assert.equal(readFileSync(join(pkg, 'data', 'snapshot.json'), 'utf8'), before, 'a failing sync writes nothing');
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const file = (iso, extra) => ({ iso, researched_on: '2026-10-09', coverage: 'complete', scheduled_changes: [], pending: [], extra_month_payments: extra, salary_payments_source: source });
const br = file('BR', [{ name: '13th salary', statutory: true, salary_months: 1 }]);

test('sync refuses: a reviewed country missing from SALARY_ENGINE_MAP.json', { skip: !site }, () => {
  const r = sync({ 'REVIEWED.json': ['br'], 'br.json': br, 'SALARY_ENGINE_MAP.json': {} });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BR.*not in SALARY_ENGINE_MAP/);
});

test('sync refuses: an on_top_line that is not a statutory extra with a value', { skip: !site }, () => {
  const r = sync({ 'REVIEWED.json': ['br'], 'br.json': br, 'SALARY_ENGINE_MAP.json': { br: { on_top_lines: ['fgts_multa_rescisoria'], on_top_months: 1 } } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /on_top_line "fgts_multa_rescisoria"/);
});

test('sync refuses: more months on top of the gross than the statutory payments beyond 12', { skip: !site }, () => {
  const r = sync({ 'REVIEWED.json': ['br'], 'br.json': br, 'SALARY_ENGINE_MAP.json': { br: { on_top_lines: ['decimo_terceiro'], on_top_months: 1.3333 } } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /on_top_months 1\.3333 is not within the 1 statutory months/);
});

test('sync refuses: on_top_lines and on_top_months that disagree', { skip: !site }, () => {
  const r = sync({ 'REVIEWED.json': ['br'], 'br.json': br, 'SALARY_ENGINE_MAP.json': { br: { on_top_lines: [], on_top_months: 1 } } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /disagree/);
});

test('sync refuses: an in_gross_line missing from the country file, or carried with a value', { skip: !site }, () => {
  const pt = file('PT', [{ name: 'Subsidio de Natal', statutory: true, salary_months: 1 }, { name: 'Subsidio de ferias', statutory: true, salary_months: 1 }]);
  const missing = sync({ 'REVIEWED.json': ['pt'], 'pt.json': pt, 'SALARY_ENGINE_MAP.json': { pt: { on_top_lines: [], on_top_months: 0, in_gross_lines: ['nope'] } } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /in_gross_line "nope" is not a statutory extra/);
  const es = file('ES', [{ name: 'Pagas extraordinarias', statutory: true, salary_months: 2 }]);
  const valued = sync({ 'REVIEWED.json': ['es'], 'es.json': es, 'SALARY_ENGINE_MAP.json': { es: { on_top_lines: [], on_top_months: 0, in_gross_lines: ['severance_objective_dismissal'] } } });
  assert.notEqual(valued.status, 0);
  assert.match(valued.stderr, /in_gross_line "severance_objective_dismissal" has the value 20, not 0/);
});

// 09/10: a monthly quote in Spain (14 payments, inside the annual gross) shows one monthly payment, not the annual gross / 12
test('reconcile_quote: Spain, 4,000 EUR a month, monthly quote: the salary line is compared with 4,000, both readings stated', () => {
  const lines = [
    { label: 'Salary', amount: 4000, type: 'salary' },
    { label: 'Employer charges', amount: 1250, type: 'employer_charge' },
    { label: 'Fee', amount: 599, type: 'fee' },
  ];
  const o = tools.reconcileQuote({ country: 'ES', salary: 4000, salary_currency: 'local', salary_period: 'month', amounts_currency: 'local', period: 'month', lines });
  conforms('reconcile_quote', o);
  assert.equal(o.salary_basis.gross_months, 14);
  assert.equal(o.per_month_local.currency, 'EUR');
  assert.equal(o.per_month_local.expected_salary, 4000);
  assert.equal(o.gap_breakdown.salary_line_difference, 0);
  assert.equal(o.salary_line.extra_payments.months, 2);
  assert.equal(Math.round(o.salary_line.if_spread_over_12_months.expected_salary_usd * snapshot.fx.rates.EUR), 4667);
  // amounts in the currency given, the USD in brackets; both readings of the quote stated, no proration rule invented
  assert.match(o.summary, /^Spain, EUR 56,000 \(\$[\d,]+\) gross a year/);
  assert.match(o.summary, /EUR 0 \(\$0\) on the salary line/);
  assert.match(o.summary, /compared with the monthly salary of EUR 4,000 \(\$[\d,]+\), one of 14 payments a year/);
  assert.match(o.summary, /monthly average of EUR 667 \(\$[\d,]+\), and the employer charges on them, are owed outside these lines/);
  assert.match(o.summary, /averaged over 12 months/);
  assert.match(o.summary, /spreads the extra payments over 12 months, its salary line should be EUR 4,667/);
  assert.doesNotMatch(o.summary, /-\$764 on the salary line/);
  assert.match(o.missing_note, /annual amount \/ 12 \(averaged over the year/);
  // a yearly quote or a 12-payment country: unchanged
  assert.equal(tools.reconcileQuote({ country: 'ES', salary: 56000, salary_currency: 'local', amounts_currency: 'local', lines }).salary_line, undefined);
  assert.equal(tools.reconcileQuote({ country: 'DE', salary: 5000, salary_currency: 'local', salary_period: 'month', amounts_currency: 'local', lines }).salary_line, undefined);
});

test('amounts given in local currency come back in it, the USD in brackets; USD input stays in USD', () => {
  const lead = /EUR [\d,]+ \(\$[\d,]+\)/;
  const ec = tools.employerCost({ country: 'ES', salary: 4000, salary_currency: 'local', salary_period: 'month' });
  conforms('employer_cost', ec);
  assert.match(ec.summary, /^One employee in Spain at EUR 56,000 \(\$[\d,]+\) gross a year costs about EUR [\d,]+ \(\$[\d,]+\) a month/);
  assert.match(ec.employer_cost.monthly, lead);
  const mx = tools.maxSalaryForBudget({ country: 'ES', budget: 8000, budget_currency: 'local', budget_period: 'month' });
  conforms('max_salary_for_budget', mx);
  assert.match(mx.summary, /^In Spain, EUR 96,000 \(\$[\d,]+\) a year pays a gross salary of up to EUR [\d,]+ \(\$[\d,]+\) a year/);
  assert.equal(mx.budget.annual_local, 'EUR 96,000');
  const ny = tools.costNextYear({ country: 'ES', salary: 56000, salary_currency: 'local' });
  conforms('cost_next_year', ny);
  assert.match(ny.summary, /^Spain at EUR 56,000 \(\$[\d,]+\) gross a year: statutory employer charges of EUR [\d,]+ \(\$[\d,]+\) a year today/);
  assert.match(ny.current.employer_cost.annual, lead);
  for (const s of [tools.employerCost({ country: 'ES', salary: 60000 }).summary, tools.maxSalaryForBudget({ country: 'ES', budget: 90000 }).summary, tools.costNextYear({ country: 'ES', salary: 60000 }).summary]) {
    assert.doesNotMatch(s, /EUR/);
  }
});
