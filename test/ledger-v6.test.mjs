// Ledger widget v6 (09/10): amounts in the currency of the input by default (Local / USD switch), the salary field in the
// currency and period the salary was given in, and the statutory payments already inside the gross (PT, GR, ES) shown
// as "Included in the gross salary", never as "Not in the total". The widget code is the HTML actually served, run on a
// minimal DOM with window.openai.toolOutput injected, as the host would.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createTools, loadSnapshot } from '../dist/tools.js';
import { OUTPUT_SCHEMAS } from '../dist/server.js';
import { LEDGER_HTML, LEDGER_URI } from '../src/widgets.ts';

const tools = createTools(loadSnapshot());
const conforms = (out) => {
  const r = z.object(OUTPUT_SCHEMAS.show_ledger).strict().safeParse(out);
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)));
};

class El {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], attrs: {}, on: {}, style: {}, t: '' }); }
  set textContent(v) { this.children = []; this.t = String(v); }
  get textContent() { return this.t + this.children.map((c) => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, f) { this.on[k] = f; }
  select() {}
  all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all(pred, out); return out; }
}
const mount = (toolOutput) => {
  const root = new El('main');
  const posted = [];
  const saved = [];
  const document = { getElementById: () => root, createElement: (t) => new El(t), createTextNode: (t) => Object.assign(new El('#text'), { t }), documentElement: { setAttribute() {} } };
  const window = { parent: { postMessage: (m) => posted.push(m) }, addEventListener() {}, openai: { toolOutput, setWidgetState: (s) => saved.push({ ...s }) } };
  const code = LEDGER_HTML.slice(LEDGER_HTML.indexOf('<script>') + 8, LEDGER_HTML.lastIndexOf('</script>'));
  new Function('window', 'document', 'navigator', 'setTimeout', 'ResizeObserver', code)(window, document, {}, () => 0, undefined);
  const text = () => root.textContent;
  const label = () => root.all((e) => e.tagName === 'label' && e.htmlFor === 's')[0].textContent;
  const input = () => root.all((e) => e.tagName === 'input')[0];
  const button = (name) => root.all((e) => e.tagName === 'button' && e.textContent === name)[0];
  return { root, text, label, input, button, posted, saved };
};

test('ledger URI is v6', () => assert.equal(LEDGER_URI, 'ui://eorscope/ledger-v6.html'));

test('Portugal, EUR 3,500 a month: EUR by default, a monthly EUR field, the 13th and 14th month included in the gross', () => {
  const out = tools.showLedger({ country: 'PT', salary: 3500, salary_currency: 'local', salary_period: 'month' });
  conforms(out);
  assert.deepEqual(out.salary_input, { salary: 3500, salary_currency: 'local', salary_period: 'month' });
  assert.deepEqual(out.included_in_gross_salary.lines.map((l) => l.id), ['subsidios_ferias_e_natal']);
  assert.equal(out.included_in_gross_salary.months, 2);
  assert.equal(out.included_in_gross_salary.payments_per_year, 14);
  assert.ok(!out.not_in_total.some((e) => e.id === 'subsidios_ferias_e_natal'));
  assert.match(out.summary, /Included in the gross salary: Holiday and Christmas subsidies \(13th and 14th month\) \(2 of the 14 monthly payments\)/);
  const w = mount(out);
  assert.equal(w.label(), 'Gross monthly salary, EUR');
  assert.equal(w.input().value, 3500);
  assert.equal(w.button('EUR').attrs['aria-pressed'], 'true');
  assert.equal(w.button('USD').attrs['aria-pressed'], 'false');
  assert.match(w.text(), /Amounts in EUR per month, at [\d.]+ EUR per USD/);
  assert.match(w.text(), /Gross salary EUR 49,000 a year \(\$/);
  const rate = out.salary.fx.local_per_usd;
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(out.employer_cost.values.monthly_usd * rate);
  assert.ok(w.text().includes(total), `${total} in ${w.text().slice(0, 300)}`);
  assert.match(w.text(), /Included in the gross salary: Holiday and Christmas subsidies \(13th and 14th month\) \(2 of the 14 monthly payments\)\./);
  assert.doesNotMatch(w.text(), /Not in the total: Holiday/);
  const last = w.saved.at(-1);
  assert.equal(last.show, 'local');
  assert.equal(last.in_per, 'month');
  // switch to USD: same figures, in USD
  w.button('USD').on.click();
  assert.match(w.text(), /Amounts in USD per month\./);
  assert.ok(w.text().includes(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(out.employer_cost.values.monthly_usd)));
  assert.equal(w.saved.at(-1).show, 'USD');
  // recalculation calls the tool again in the input's currency and period
  w.input().value = '4000';
  w.root.all((e) => e.tagName === 'form')[0].on.submit({ preventDefault() {} });
  const call = w.posted.find((m) => m.method === 'tools/call');
  assert.deepEqual(call.params, { name: 'show_ledger', arguments: { country: 'PT', salary: 4000, salary_currency: 'local', salary_period: 'month' } });
  // CSV: the USD columns unchanged, local columns added at the end
  assert.match(LEDGER_HTML, /"checked_at"\]\.concat\(x\?\["monthly_"\+c\.currency\.toLowerCase\(\),"annual_"\+c\.currency\.toLowerCase\(\)\]/);
});

test('Greece and Spain: the statutory payments inside the gross are labelled as such, never "not in the total"', () => {
  for (const [iso, id] of [['GR', 'dora_kai_epidoma_adeias'], ['ES', 'pagas_extra']]) {
    const out = tools.employerCost({ country: iso, salary: 3000, salary_currency: 'local', salary_period: 'month' });
    assert.deepEqual(out.included_in_gross_salary.lines.map((l) => l.id), [id]);
    assert.ok(!out.not_in_total.some((e) => e.id === id));
    assert.equal(tools.employmentTerms({ country: iso }).statutory_extras.find((e) => e.id === id).in_gross_salary, true);
  }
});

test('Germany, EUR 60,000 a year: EUR by default, an annual EUR field, nothing included in the gross', () => {
  const out = tools.showLedger({ country: 'DE', salary: 60000, salary_currency: 'local' });
  conforms(out);
  assert.equal(out.included_in_gross_salary, undefined);
  const w = mount(out);
  assert.equal(w.label(), 'Gross annual salary, EUR');
  assert.equal(w.input().value, 60000);
  assert.equal(w.button('EUR').attrs['aria-pressed'], 'true');
  assert.match(w.text(), /Amounts in EUR per year/);
  assert.match(w.text(), /Gross salary EUR 60,000 a year/);
});

test('a salary given in USD: USD by default and a USD field', () => {
  const out = tools.showLedger({ country: 'PT', salary: 50000 });
  const w = mount(out);
  assert.equal(w.label(), 'Gross annual salary, USD');
  assert.equal(w.input().value, 50000);
  assert.equal(w.button('USD').attrs['aria-pressed'], 'true');
  assert.match(w.text(), /Gross salary \$50,000\.00 a year/);
  assert.match(w.text(), /Amounts in USD per year\./);
});
