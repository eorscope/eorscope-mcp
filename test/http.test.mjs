// The built Streamable HTTP server (dist/http.js) on a local port, raw JSON-RPC over POST:
// initialize, tools/list (annotations and description lint), one tools/call per tool, GET refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
// the SDK's own JSON Schema validator: checks each structuredContent against the outputSchema as a client sees it
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
const SNAP = JSON.parse(readFileSync(new URL('../data/snapshot.json', import.meta.url), 'utf8'));
const UNTRACKED = SNAP.countries.map((c) => c.iso).find((iso) => !SNAP.scheduled[iso]);

const PORT = 18000 + (process.pid % 1000);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const DATA_TOOLS = ['compare_countries', 'compare_offers', 'compare_structures', 'contractor_rate_equivalent', 'cost_next_year', 'employer_cost', 'employment_terms', 'fx_stress', 'list_countries', 'max_salary_for_budget', 'reconcile_quote', 'scheduled_changes'];
const RENDER_TOOLS = { show_compare: 'ui://eorscope/compare-v2.html', show_ledger: 'ui://eorscope/ledger-v6.html' };
const TOOLS = [...DATA_TOOLS, ...Object.keys(RENDER_TOOLS)].sort();
const MIME = 'text/html;profile=mcp-app';
const ORIGIN = 'https://mcp.example.test';
const ajv = new Ajv({ strict: false, allErrors: true });
const outputSchemas = new Map();
let child;
let id = 0;

const rpc = async (method, params) => {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  assert.equal(res.status, 200, method);
  const body = await res.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
};
// every tool: structuredContent valid against its declared outputSchema, and a one-sentence text (summary + disclaimer)
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].text, `${r.structuredContent.summary} ${r.structuredContent.meta.disclaimer}`, name);
  assert.ok(r.content[0].text.length < 1500, `${name}: text of ${r.content[0].text.length} characters`);
  const validate = outputSchemas.get(name);
  assert.ok(validate, `${name}: no outputSchema`);
  assert.ok(validate(r.structuredContent), `${name}: ${ajv.errorsText(validate.errors)}`);
  return r.structuredContent;
};
const show = call;

before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL('../dist/http.js', import.meta.url))], { env: { ...process.env, PORT: String(PORT), MCP_PUBLIC_ORIGIN: ORIGIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server start timeout')), 10000);
  });
});
after(() => child?.kill());

test('initialize', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '0' } });
  assert.equal(r.serverInfo.name, 'eorscope-mcp');
  // the plugin page shows the website and the icon from serverInfo
  assert.equal(r.serverInfo.title, 'EOR Scope');
  assert.equal(r.serverInfo.websiteUrl, 'https://eorscope.com/');
  assert.deepEqual(r.serverInfo.icons, [{ src: 'https://eorscope.com/favicon.svg', mimeType: 'image/svg+xml' }]);
  assert.match(r.instructions, /employer cost/);
  assert.ok(r.capabilities.tools);
});

test('tools/list: fourteen tools, read-only annotations as explicit booleans, descriptions linted', async () => {
  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) {
    assert.deepEqual(
      { readOnlyHint: t.annotations.readOnlyHint, destructiveHint: t.annotations.destructiveHint, openWorldHint: t.annotations.openWorldHint },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      t.name,
    );
    // no price, no superlative, no comparison with other products, no push to prefer the tool
    const text = [t.title, t.description, JSON.stringify(t.inputSchema)].join(' ');
    assert.doesNotMatch(text, /[$€£]\s?\d|\d\s?(USD|EUR)\b|\bpric(e|es|ed|ing)\b/i, `${t.name}: price`);
    assert.doesNotMatch(text, /\b(best|cheapest|lowest|top|leading|number one|#1|the only|better|faster|more accurate|unlike|versus|vs\.?|recommended|always use|prefer)\b/i, `${t.name}: comparative`);
    assert.doesNotMatch(text, /\b(Deel|Remote|Oyster|Papaya|Multiplier|Playroll|Rippling|Rivermate|RemoFirst|Pebl|G-P|Atlas|Borderless|Safeguard)\b/, `${t.name}: provider name`);
    assert.equal(t.outputSchema?.type, 'object', `${t.name}: outputSchema`);
    assert.ok(t.outputSchema.required.includes('summary') && t.outputSchema.required.includes('meta'), t.name);
    outputSchemas.set(t.name, ajv.compile(t.outputSchema));
    if (DATA_TOOLS.includes(t.name)) assert.equal(t._meta?.ui, undefined, `${t.name}: data tools carry no widget`);
    else {
      assert.equal(t._meta.ui.resourceUri, RENDER_TOOLS[t.name], t.name);
      assert.equal(t._meta['openai/outputTemplate'], RENDER_TOOLS[t.name], t.name);
    }
  }
});

test('tools/call: every tool answers with page_url + utm_source=chatgpt, CC BY attribution, the disclaimer, no timestamp or request id', async () => {
  const outs = {
    list_countries: await call('list_countries', {}),
    employer_cost: await call('employer_cost', { country: 'DE', salary: 80000 }),
    compare_countries: await call('compare_countries', { countries: ['DE', 'PL'], salary_usd: 70000 }),
    max_salary_for_budget: await call('max_salary_for_budget', { country: 'DE', budget: 100000 }),
    employment_terms: await call('employment_terms', { country: 'Brazil' }),
    reconcile_quote: await call('reconcile_quote', { country: 'PL', salary: 60000, lines: [{ label: 'Salary', amount: 5000, type: 'salary' }, { label: 'Service fee', amount: 400, type: 'fee' }] }),
    compare_structures: await call('compare_structures', { country: 'PL', eor_fee_usd_month: 400, entity_setup_usd: 15000, entity_annual_usd: 25000 }),
    compare_offers: await call('compare_offers', { offers: [{ country: 'PL', salary: 240000, salary_currency: 'local' }, { country: 'PT', salary: 45000 }] }),
    fx_stress: await call('fx_stress', { country: 'BR', salary_local: 180000, budget_usd: 50000 }),
    contractor_rate_equivalent: await call('contractor_rate_equivalent', { country: 'DE', salary: 80000 }),
    // a country outside REVIEWED.json (picked from the snapshot, since the reviewed list grows): the "not yet tracked" path
    scheduled_changes: await call('scheduled_changes', { country: UNTRACKED }),
    cost_next_year: await call('cost_next_year', { country: UNTRACKED, salary: 60000, on_date: '2027-03-01' }),
    show_ledger: await show('show_ledger', { country: 'DE', salary: 80000 }),
    show_compare: await show('show_compare', { offers: [{ country: 'PL', salary: 60000 }, { country: 'PT', salary: 45000 }, { country: 'ES', salary: 50000 }, { country: 'IE', salary: 70000 }] }),
  };
  assert.deepEqual(Object.keys(outs).sort(), TOOLS);
  assert.match(outs.show_ledger.scenario_url, /^https:\/\/eorscope\.com\/eor-cost-calculator\/\?c=DE&s=80000&n=1&utm_source=chatgpt$/);
  assert.deepEqual(outs.show_ledger.lines, (await call('employer_cost', { country: 'DE', salary: 80000 })).lines);
  // a country outside REVIEWED.json: not yet tracked, never "no change"
  for (const o of [outs.scheduled_changes, outs.cost_next_year]) {
    assert.equal(o.tracking, 'not yet tracked');
    assert.match(o.summary, /not yet tracked/);
    assert.doesNotMatch(JSON.stringify(o), /no change/i);
  }
  assert.equal(outs.show_compare.display, 'fullscreen');
  for (const [name, o] of Object.entries(outs)) {
    assert.match(o.meta.page_url, /^https:\/\/eorscope\.com\/employer-of-record\/([a-z-]+\/)?\?utm_source=chatgpt$/, name);
    assert.match(o.meta.license, /CC BY 4\.0.*EOR Scope/, name);
    assert.match(o.meta.disclaimer, /cost comparison, not legal or tax advice/i, name);
    assert.doesNotMatch(JSON.stringify(o), /"(timestamp|generated_at|created_at|request_id|requestId|session_id|uuid)"|\d{4}-\d{2}-\d{2}T\d{2}:/, name);
  }
  const back = await call('employer_cost', { country: 'DE', salary: outs.max_salary_for_budget.max_salary.annual_usd });
  assert.ok(Math.abs(back.salary.annual_usd + back.employer_cost.values.annual_usd - 100000) <= 1);
});

test('widget: each data tool names its render call, and the render tool accepts those arguments as they are', async () => {
  const cost = await call('employer_cost', { country: 'Germany', salary: 80000, include_notes: true });
  assert.deepEqual(cost.widget.arguments, { country: 'DE', salary: 80000, salary_currency: 'USD' });
  assert.equal(cost.widget.tool, 'show_ledger');
  assert.match(cost.widget.note, /show_ledger renders this breakdown as an interactive table from these arguments/);
  const ledger = await show('show_ledger', cost.widget.arguments);
  assert.deepEqual(ledger.lines.map((l) => [l.id, l.annual_usd]), cost.lines.map((l) => [l.id, l.annual_usd]));
  assert.equal(ledger.display, undefined);
  // example salary: no salary in the arguments either
  assert.equal('salary' in (await call('employer_cost', { country: 'PL' })).widget.arguments, false);

  const offers = await call('compare_offers', { offers: [{ country: 'Poland', salary: 240000, salary_currency: 'local' }, { country: 'PT', salary: 45000 }] });
  assert.equal(offers.widget.tool, 'show_compare');
  assert.deepEqual(offers.widget.arguments, { offers: [{ country: 'PL', salary: 240000, salary_currency: 'local' }, { country: 'PT', salary: 45000, salary_currency: 'USD' }] });
  const shown = await show('show_compare', offers.widget.arguments);
  assert.deepEqual(shown.offers.map((o) => o.total.annual_usd), offers.offers.map((o) => o.total.annual_usd));

  const countries = await call('compare_countries', { countries: ['DE', 'Poland'], salary_usd: 70000 });
  assert.deepEqual(countries.widget.arguments, { offers: [{ country: 'DE', salary: 70000, salary_currency: 'USD' }, { country: 'PL', salary: 70000, salary_currency: 'USD' }] });
  const both = await show('show_compare', countries.widget.arguments);
  assert.deepEqual(both.offers.map((o) => o.employer_cost.values.annual_usd), countries.countries.map((c) => c.employer_cost.values.annual_usd));
  // show_compare takes at most 6 offers: no render call above
  assert.equal((await call('compare_countries', { countries: ['DE', 'PL', 'PT', 'ES', 'IE', 'FR', 'IT'], salary_usd: 70000 })).widget, undefined);
});

test('resources: the two widgets,MIME text/html;profile=mcp-app, no network origin, under 30 kB each', async () => {
  const { resources } = await rpc('resources/list', {});
  assert.deepEqual(resources.map((r) => r.uri).sort(), Object.values(RENDER_TOOLS).sort());
  for (const uri of Object.values(RENDER_TOOLS)) {
    const { contents: [c] } = await rpc('resources/read', { uri });
    assert.equal(c.mimeType, MIME);
    assert.ok(Buffer.byteLength(c.text) < 30 * 1024, `${uri}: ${Buffer.byteLength(c.text)} bytes`);
    assert.deepEqual(c._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.equal(c._meta.ui.domain, ORIGIN, `${uri}: domain from MCP_PUBLIC_ORIGIN`);
    assert.equal(c._meta['openai/widgetDomain'], ORIGIN, uri);
    assert.deepEqual(c._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
    // self-contained: no external script, style, font or fetch; data written as text, never as HTML
    assert.doesNotMatch(c.text, /<script[^>]+src=|<link[^>]+href=|@import|@font-face|fetch\(|XMLHttpRequest|innerHTML|eval\(/);
    for (const m of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/open-link', 'window.openai']) assert.ok(c.text.includes(m), `${uri}: ${m}`);
    assert.ok(c.text.includes('#0B6E4F') && c.text.includes('prefers-color-scheme:dark') && c.text.includes(':focus-visible'), uri);
  }
  const ledger = (await rpc('resources/read', { uri: RENDER_TOOLS.show_ledger })).contents[0].text;
  for (const m of ['setWidgetState', 'Copy as CSV', 'checked_at', 'ceiling reached', 'aria-pressed']) assert.ok(ledger.includes(m), `ledger: ${m}`);
  const compare = (await rpc('resources/read', { uri: RENDER_TOOLS.show_compare })).contents[0].text;
  assert.ok(compare.includes('ui/request-display-mode'), 'compare: fullscreen request');
});

test('GET is refused: stateless, POST only', async () => {
  const res = await fetch(URL_);
  assert.equal(res.status, 405);
});
