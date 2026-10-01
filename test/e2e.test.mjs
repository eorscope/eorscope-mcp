// End to end: the built server over stdio, raw JSON-RPC, one call per tool.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
let child;
let buffer = '';
let stderr = '';
const waiting = new Map();
let nextId = 1;

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method}: no answer in 10 s. stderr: ${stderr}`)), 10000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
const call = async (name, args) => {
  const msg = await request('tools/call', { name, arguments: args });
  assert.equal(msg.error, undefined, JSON.stringify(msg.error));
  return msg.result;
};
const json = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
};
const stamped = (o, page) => {
  assert.match(o.meta.snapshot_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(o.meta.page_url, page);
  assert.equal(o.meta.methodology_url, 'https://eorscope.com/methodology/');
  assert.match(o.meta.disclaimer, /cost comparison, not legal or tax advice/i);
};

before(() => {
  child = spawn(process.execPath, [fileURLToPath(new URL(`../${pkg.bin['eorscope-mcp']}`, import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line); // anything on stdout that is not JSON-RPC fails here
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
});
after(() => child.kill());

test('initialize', async () => {
  const { result } = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  assert.deepEqual(result.serverInfo, { name: 'eorscope-mcp', version: pkg.version });
  assert.ok(result.capabilities.tools);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

test('tools/list: five tools, each with a description and an input schema', async () => {
  const { result } = await request('tools/list', {});
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['compare_countries', 'employer_cost', 'list_countries', 'provider_fees', 'total_hiring_cost']);
  for (const t of result.tools) {
    assert.ok(t.description.length > 40);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.doesNotMatch(t.description, /cheapest|lowest|best|the only/i);
  }
  const schema = (name) => result.tools.find((t) => t.name === name).inputSchema;
  assert.deepEqual(schema('employer_cost').required, ['country']);
  assert.deepEqual(schema('total_hiring_cost').required.sort(), ['country', 'provider']);
  assert.equal(schema('compare_countries').properties.countries.maxItems, 10);
});

test('list_countries', async () => {
  const o = json(await call('list_countries', {}));
  assert.equal(o.count, 76);
  assert.equal(o.countries.length, 76);
  stamped(o, 'https://eorscope.com/employer-of-record/');
  assert.equal(json(await call('list_countries', { region: 'europe' })).countries.every((c) => c.region === 'Europe'), true);
});

test('employer_cost', async () => {
  const o = json(await call('employer_cost', { country: 'India' }));
  assert.equal(o.country.iso, 'IN');
  assert.match(o.employer_cost.pct_of_gross, /^\d+\.\d%$/);
  assert.ok(o.lines.every((l) => l.source.url && l.source.checked_at));
  stamped(o, 'https://eorscope.com/employer-of-record/india/');
  const local = json(await call('employer_cost', { country: 'AE', salary: 240000, salary_currency: 'local', include_notes: true }));
  assert.match(local.employer_cost.monthly, /^at least \$/);
  assert.ok(local.lines.some((l) => l.notes));
});

test('compare_countries', async () => {
  const o = json(await call('compare_countries', { countries: ['DE', 'Poland', 'QA'], salary_usd: 70000 }));
  assert.deepEqual(o.countries.map((c) => c.iso), ['DE', 'PL', 'QA']);
  assert.match(o.countries[2].employer_cost.pct_of_gross, /^at least /);
  stamped(o, 'https://eorscope.com/employer-of-record/');
});

test('provider_fees', async () => {
  const o = json(await call('provider_fees', {}));
  assert.equal(o.providers.length, 14);
  assert.equal(o.providers.find((p) => p.id === 'rippling').eor.fee_per_month, 'quote only');
  stamped(o, 'https://eorscope.com/employer-of-record-cost/');
  const one = json(await call('provider_fees', { provider: 'Deel', country: 'Myanmar' }));
  assert.equal(one.providers.length, 1);
  assert.equal(one.providers[0].available_in.available, false);
});

test('total_hiring_cost', async () => {
  const o = json(await call('total_hiring_cost', { country: 'mexico', provider: 'Remote', salary: 50000, headcount: 2 }));
  assert.equal(o.headcount, 2);
  assert.match(o.total.monthly, /^\$[\d,]+$/);
  assert.equal(o.provider.fee_usd_month, 699);
  stamped(o, 'https://eorscope.com/employer-of-record/mexico/');
  const quote = json(await call('total_hiring_cost', { country: 'FR', provider: 'Safeguard Global' }));
  assert.equal(quote.total.monthly, 'quote only');
});

test('a bad request is an error result, not a crash', async () => {
  const unknown = await call('employer_cost', { country: 'Atlantis' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown country/);
  const invalid = await request('tools/call', { name: 'compare_countries', arguments: { countries: ['DE'], salary_usd: 1 } });
  assert.ok(invalid.error || invalid.result.isError);
  assert.equal(json(await call('list_countries', {})).count, 76);
});

test('package metadata: registry name, versions, link budget', () => {
  const server = JSON.parse(read('server.json'));
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.version, pkg.version);
  assert.deepEqual(server.packages.map((p) => [p.registryType, p.identifier, p.version, p.transport.type]), [['npm', pkg.name, pkg.version, 'stdio']]);
  assert.ok(server.description.length <= 100);
  assert.equal(pkg.repository.url, `git+${server.repository.url}.git`);
  // a README loaded with links to the site has already earned the portfolio a GitHub flag:
  // four links at most, and the documentation pages carry the same four, not one more
  const links = (text) => (text.match(/https:\/\/eorscope\.com\/[a-z/-]*/g) ?? []).sort();
  const readme = links(read('README.md'));
  assert.ok(readme.length <= 4);
  assert.deepEqual(links(read('docs/index.mdx') + read('docs/tools.mdx')), readme);
  assert.equal(JSON.parse(read('docs.json')).name, pkg.name);
});

test('licence: three sets of terms, and the engine copies say which one is theirs', () => {
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE');
  assert.ok(pkg.files.includes('LICENSE') && pkg.files.includes('LICENSE-DATA'));
  const licence = read('LICENSE');
  for (const part of ['1. SERVER CODE: MIT', '2. COST ENGINE: ALL RIGHTS RESERVED', '3. DATA: CC BY 4.0']) assert.ok(licence.includes(part), part);
  for (const f of ['cost-engine.ts', 'format.ts', 'place-name.ts']) {
    assert.match(read(`src/vendor/${f}`), /^\/\/ Copied from the eorscope\.com site by scripts\/sync\.mjs, do not edit\.\r?\n\/\/ Copyright EOR Scope\. All rights reserved\./);
  }
  for (const f of ['dist/index.js', 'dist/tools.js']) assert.match(read(f), /Copyright EOR Scope, all rights reserved/);
  assert.ok(read('dist/index.js').startsWith('#!/usr/bin/env node'));
});
