// Brings into the package everything the build and the tests need from the eorscope.com site
// repository, so the package builds and tests on its own and never drifts from the site:
//   src/vendor/*.ts                     the site's engine, decision arithmetic and formatters, copied as they are
//   data/snapshot.json                  the site's data, with the date of the snapshot
//   test/fixtures/country_summary.csv   the site's published dataset, the reference for the tests
//   test/fixtures/providers.json        provider ids, names and plan ids, for the guard that keeps them out (tests only)
// This is the only step that reads outside the package. In a checkout of the package alone
// there is nothing to read: it says so and leaves the committed copies untouched.
//   snapshot.scheduled                  the dated changes of audit/plugin_data/{iso}.json, ONLY for the files
//                                       listed in audit/plugin_data/REVIEWED.json (filled by hand after review),
//                                       with their pending items (bills, proposals, awaited figures)
//   countries[].salary_payments         monthly salaries paid a year (schema v2), reviewed files only, checked
//                                       against audit/plugin_data/SALARY_ENGINE_MAP.json; nothing is written if a check fails
// Usage: node scripts/sync.mjs [--date YYYY-MM-DD] [--plugin-data <dir with REVIEWED.json>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(pkg, '..', '..');
const data = join(root, 'site', 'src', 'data');
const lib = join(root, 'site', 'src', 'lib');
const exporter = join(root, 'tools', 'export_dataset.py');
const dataset = join(root, 'dataset', 'eorscope-employer-costs', 'country_summary.csv');

if (![data, lib, exporter, dataset].some(existsSync)) {
  console.log('sync: the site repository is not around this package (no site/, tools/ or dataset/): nothing to sync, the committed copies are kept.');
  process.exit(0);
}
for (const p of [data, lib, exporter, dataset]) if (!existsSync(p)) throw new Error(`sync: ${p} is missing from the site repository`);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dir = (d) =>
  readdirSync(join(data, d))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => read(join(data, d, f)));
// every file is written at the end, once all the checks have passed: a failing sync leaves the package as it was
const writes = [];
const write = (path, content) => writes.push([path, content]);

const at = process.argv.indexOf('--date');
const snapshot_date = at > 0 ? process.argv[at + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot_date ?? '')) throw new Error('--date must be YYYY-MM-DD');

// 1. the engine and its formatters: the site's own files, never rewritten here. They are not
// under the MIT terms of the server code, and each copy says so (LICENSE, section 2).
const header = `// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
`;
for (const f of ['cost-engine.ts', 'decision.ts', 'format.ts', 'place-name.ts']) {
  write(join(pkg, 'src', 'vendor', f), header + readFileSync(join(lib, f), 'utf8'));
}

// 2. the reference the tests compare the built package with
write(join(pkg, 'test', 'fixtures', 'country_summary.csv'), readFileSync(dataset));
const vendors = dir('vendors');
// each provider's own domain (its site, cta_url): a source on it is the provider's own publication
const providerDomains = [...new Set(vendors.map((v) => new URL(v.cta_url).hostname.replace(/^www\./, '')))].sort();
write(
  join(pkg, 'test', 'fixtures', 'providers.json'),
  JSON.stringify({ ids: vendors.map((v) => v.id), names: vendors.map((v) => v.name), plan_ids: vendors.flatMap((v) => v.plans.map((p) => p.id)), domains: providerDomains }, null, 1) + '\n',
);
// A text that names a provider is withheld from the plugin (a provider's own figures and claims
// are theirs to publish): the country page keeps it. Names as written ("Remote", "Deel"), case-sensitive.
const escape = (n) => n.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const providerNames = [...new Set(vendors.flatMap((v) => [v.name, v.name.split(' ')[0], v.id[0].toUpperCase() + v.id.slice(1)]))];
const providerWord = new RegExp('\\b(' + providerNames.map(escape).join('|') + ')\\b');
const unlessProvider = (t) => (t == null || providerWord.test(t) ? null : t);
const onProviderDomain = (u) => {
  let h;
  try {
    h = new URL(u).hostname;
  } catch {
    return false;
  }
  return providerDomains.some((d) => h === d || h.endsWith(`.${d}`));
};
// a line (contribution or statutory extra) sourced on a provider's page, by the source's name or its domain:
// the plugin cites the country page instead, which keeps the provider's source
const relabel = (c, l) =>
  providerWord.test(l.source?.name ?? '') || onProviderDomain(l.source?.url)
    ? { ...l, source_is_provider: true, source: { name: `Secondary source, cited on the ${c.name} page`, url: `https://eorscope.com/employer-of-record/${c.slug}/`, checked_at: l.source?.checked_at } }
    : l;

// 3. the data snapshot
// Totals a country declares as a floor ("at least") or a ceiling ("at most"). No field of the
// country schema carries this yet: the repository's one list is in tools/export_dataset.py.
const py = readFileSync(exporter, 'utf8');
const isoSet = (name) => {
  const m = py.match(new RegExp(`^${name}\\s*=\\s*\\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`${name} not found in tools/export_dataset.py`);
  return new Set(m[1].match(/[A-Z]{2}/g) ?? []);
};
const floor = isoSet('DECLARED_FLOOR');
const ceiling = isoSet('DECLARED_CEILING');

// 4. the dated changes, reviewed files only. A country absent here is "not yet tracked" in the tools.
const pd = process.argv.indexOf('--plugin-data');
const pluginData = pd > 0 ? process.argv[pd + 1] : join(root, 'audit', 'plugin_data');
const reviewedFile = join(pluginData, 'REVIEWED.json');
const reviewed = existsSync(reviewedFile) ? read(reviewedFile) : [];
if (!Array.isArray(reviewed)) throw new Error(`${reviewedFile} must be a JSON array of file names ("ie.json") or ISO codes ("IE")`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const scheduledFor = (iso, ids) => {
  const f = read(join(pluginData, `${iso.toLowerCase()}.json`));
  const bad = (what) => {
    throw new Error(`sync: audit/plugin_data/${iso.toLowerCase()}.json is listed in REVIEWED.json but ${what} (run tools/qa_plugin_data.py)`);
  };
  if (f.iso !== iso) bad(`its iso is ${f.iso}`);
  if (!DATE.test(f.researched_on ?? '')) bad('researched_on is not YYYY-MM-DD');
  if (!['complete', 'partial'].includes(f.coverage)) bad('coverage is not complete|partial');
  if (!Array.isArray(f.scheduled_changes)) bad('scheduled_changes is not a list');
  if (f.pending != null && !Array.isArray(f.pending)) bad('pending is not a list');
  return {
    researched_on: f.researched_on,
    coverage: f.coverage,
    // what is announced, proposed or awaited without a dated figure yet (schema v2): served as read, never applied
    pending: (f.pending ?? []).map((x, i) => {
      if (typeof x.status !== 'string' || typeof x.description !== 'string') bad(`pending[${i}] needs a status and a description`);
      if (providerWord.test(x.description)) bad(`pending[${i}].description names a provider`);
      return { status: x.status, description: x.description, contribution_id: x.contribution_id ?? null, source: { url: x.source?.url ?? null } };
    }),
    scheduled_changes: f.scheduled_changes.map((x, i) => {
      const at = `scheduled_changes[${i}]`;
      if (x.contribution_id != null && !ids.has(x.contribution_id)) bad(`${at}.contribution_id "${x.contribution_id}" is not a line of the country file`);
      if (!DATE.test(x.effective_from ?? '')) bad(`${at}.effective_from is not YYYY-MM-DD`);
      if (!['stated', 'inferred', 'derived'].includes(x.date_basis)) bad(`${at}.date_basis is not stated|inferred|derived`);
      if (!['enacted', 'budget_announced'].includes(x.status)) bad(`${at}.status is not enacted|budget_announced`);
      const keys = ['rate', 'cap_annual_local', 'threshold_weekly_local', 'floor_annual_local'];
      if (!x.change || keys.some((k) => !(k in x.change) || (x.change[k] !== null && typeof x.change[k] !== 'number'))) bad(`${at}.change must carry ${keys.join(', ')} as numbers or null`);
      const s = x.source ?? {};
      if (!s.url || !s.quote || !DATE.test(s.read_on ?? '') || !['official', 'secondary'].includes(s.kind)) bad(`${at}.source needs url, quote, read_on and kind official|secondary`);
      if (providerWord.test(s.quote)) bad(`${at}.source.quote names a provider`);
      return {
        contribution_id: x.contribution_id ?? null,
        effective_from: x.effective_from,
        date_basis: x.date_basis,
        change: Object.fromEntries(keys.map((k) => [k, x.change[k]])),
        status: x.status,
        ...(unlessProvider(x.note) && { note: x.note }),
        source: { url: s.url, quote: s.quote, read_on: s.read_on, kind: s.kind },
      };
    }),
  };
};

const fx = read(join(data, 'fx.json'));
const bounds = ['cap_annual_local', 'floor_annual_local', 'flat_annual_local', 'max_gross_annual_local', 'min_gross_annual_local'];

// Same defaults as the zod schemas in site/src/content.config.ts. Only what the engine computes
// with or a tool prints is kept: no FAQ, no search volume, no affiliate programme data.
// No provider data either: the providers' terms forbid redistributing their prices (0.2.0).
const countries = dir('countries').map((c) => {
  if (!fx.rates[c.currency]) throw new Error(`No FX rate for ${c.currency} (${c.iso})`);
  if (floor.has(c.iso) && ceiling.has(c.iso)) throw new Error(`${c.iso} is declared both a floor and a ceiling`);
  return {
    iso: c.iso,
    slug: c.slug,
    name: c.name,
    currency: c.currency,
    region: c.region,
    example_salary_usd: c.example_salary_usd,
    example_role: c.example_role,
    ...(c.example_place && { example_place: c.example_place }),
    ...(c.total_excludes && { total_excludes: c.total_excludes }),
    total_bound: floor.has(c.iso) ? 'floor' : ceiling.has(c.iso) ? 'ceiling' : null,
    assumptions: c.assumptions ?? [],
    employer_contributions: c.employer_contributions.map((k) => relabel(c, { ...Object.fromEntries(bounds.map((b) => [b, null])), ...k })),
    statutory_extras: (c.statutory_extras ?? []).map((e) => relabel(c, e)),
    thirteenth_month: c.thirteenth_month,
    paid_leave_days: c.paid_leave_days,
    // employment terms (employment_terms). Not kept: eor_onboarding_days and entity_notes, whose
    // sources and figures are providers' own publications.
    ...(c.leave_note && { leave_note: c.leave_note }),
    public_holidays: c.public_holidays ?? null,
    ...(c.holidays_note && { holidays_note: c.holidays_note }),
    probation_months_max: c.probation_months_max ?? null,
    ...(c.probation_note && { probation_note: c.probation_note }),
    notice_typical: unlessProvider(c.notice_typical),
    last_reviewed: c.last_reviewed,
  };
});
for (const iso of [...floor, ...ceiling]) if (!countries.some((c) => c.iso === iso)) throw new Error(`Declared bound for an unknown country: ${iso}`);

const scheduled = {};
for (const entry of reviewed) {
  const iso = String(entry).replace(/\.json$/i, '').toUpperCase();
  const c = countries.find((x) => x.iso === iso);
  if (!c) throw new Error(`sync: REVIEWED.json lists ${entry}, which is not a country of the site`);
  scheduled[iso] = scheduledFor(iso, new Set([...c.employer_contributions.map((k) => k.id), ...c.statutory_extras.map((e) => e.id)]));
}

// 5. the number of monthly salaries a year (schema v2): count = 12 + the salary_months of the statutory
// extra_month_payments, for the reviewed files only, checked against the engine's convention in
// SALARY_ENGINE_MAP.json (the statutory payments the ledger adds on top of the annual gross).
const engineMapFile = join(pluginData, 'SALARY_ENGINE_MAP.json');
const engineMap = existsSync(engineMapFile) ? read(engineMapFile) : {};
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const payment = (e) => ({ name: e.name, statutory: e.statutory === true, salary_months: e.salary_months ?? null, months: e.months ?? null, deadline: unlessProvider(e.deadline ?? null) });
const reviewedPayments = (c) => {
  const iso = c.iso.toLowerCase();
  const bad = (what) => {
    throw new Error(`sync: salary payments of ${c.iso} (audit/plugin_data/${iso}.json, SALARY_ENGINE_MAP.json): ${what}`);
  };
  const m = engineMap[iso];
  if (!m) bad('the country is not in SALARY_ENGINE_MAP.json');
  if (!Array.isArray(m.on_top_lines) || typeof m.on_top_months !== 'number') bad('on_top_lines must be a list and on_top_months a number');
  if ((m.on_top_lines.length === 0) !== (m.on_top_months === 0)) bad('on_top_lines and on_top_months disagree');
  for (const id of m.on_top_lines) {
    // a statutory extra counted in the total, or a contribution line carrying the payment as a rate (Dominican salario de Navidad, 1/12)
    const extra = c.statutory_extras.some((e) => e.id === id && e.in_total && e.value > 0);
    const contribution = c.employer_contributions.some((e) => e.id === id && e.rate > 0);
    if (!extra && !contribution) bad(`on_top_line "${id}" is neither a statutory extra counted in the total with a value above 0 nor a contribution line with a rate above 0`);
  }
  const in_gross_lines = m.in_gross_lines ?? [];
  if (!Array.isArray(in_gross_lines)) bad('in_gross_lines must be a list');
  for (const id of in_gross_lines) {
    const e = c.statutory_extras.find((x) => x.id === id);
    if (!e) bad(`in_gross_line "${id}" is not a statutory extra of the country file`);
    if (e.value !== 0) bad(`in_gross_line "${id}" has the value ${e.value}, not 0`);
    if (m.on_top_lines.includes(id)) bad(`"${id}" is both an on_top_line and an in_gross_line`);
  }
  const f = read(join(pluginData, `${iso}.json`));
  const s = f.salary_payments_source;
  // reviewed, but no source states the number of payments: not yet tracked
  if (s == null) return null;
  if (!s.url || !s.quote || !DATE.test(s.read_on ?? '') || !['official', 'secondary'].includes(s.kind)) bad('salary_payments_source needs url, quote, read_on and kind official|secondary');
  if (providerWord.test(s.quote)) bad('salary_payments_source.quote names a provider');
  const list = f.extra_month_payments ?? [];
  if (!Array.isArray(list)) bad('extra_month_payments is not a list');
  for (const e of list) if (e.salary_months != null && !(typeof e.salary_months === 'number' && e.salary_months >= 0)) bad(`"${e.name}": salary_months is not a number`);
  const statutory = list.filter((e) => e.statutory === true);
  const count = r4(12 + statutory.reduce((t, e) => t + (e.salary_months ?? 0), 0));
  const gross_months = r4(count - m.on_top_months);
  if (Math.abs(count - gross_months - m.on_top_months) > 0.001) bad(`count ${count} - gross_months ${gross_months} - on_top_months ${m.on_top_months} is not 0`);
  if (m.on_top_months < 0 || m.on_top_months > count - 12 + 0.001) bad(`on_top_months ${m.on_top_months} is not within the ${r4(count - 12)} statutory months paid beyond 12`);
  return {
    basis: 'statutory',
    count,
    gross_months,
    on_top_lines: m.on_top_lines,
    on_top_months: m.on_top_months,
    in_gross_lines,
    payments: statutory.map(payment),
    customary: list.filter((e) => e.statutory !== true).map(payment),
    source: { url: s.url, quote: s.quote, read_on: s.read_on, kind: s.kind },
  };
};
// any other country: 12 payments only where the country file has a sourced "no statutory 13th month" line
const notStatutory = (c) => {
  const e = c.statutory_extras.find((x) => x.id === 'thirteenth_month_not_statutory');
  if (!e) return null;
  const source = e.source_is_provider ? { name: `Secondary source, cited on the ${c.name} page`, url: `https://eorscope.com/employer-of-record/${c.slug}/`, checked_at: e.source?.checked_at } : e.source;
  return { basis: 'not_statutory', count: 12, gross_months: 12, on_top_lines: [], on_top_months: 0, in_gross_lines: [], payments: [], customary: [], source };
};
for (const c of countries) c.salary_payments = (scheduled[c.iso] ? reviewedPayments(c) : null) ?? notStatutory(c);

const git = (...a) => {
  try {
    return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'site/src/data', 'site/src/lib/cost-engine.ts', 'site/src/lib/format.ts', 'site/src/lib/place-name.ts');

const snapshot = {
  snapshot_date,
  source_commit: head ? head.slice(0, 12) + (dirty ? '-dirty' : '') : 'unknown',
  fx,
  countries,
  scheduled,
};
const json = JSON.stringify(snapshot);
write(join(pkg, 'data', 'snapshot.json'), json + '\n');
for (const [path, content] of writes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
console.log(`sync ${snapshot_date} (${snapshot.source_commit}): engine copied to src/vendor, ${countries.length} countries (${floor.size} floors, ${ceiling.size} ceilings), dated changes for ${Object.keys(scheduled).length} reviewed (${existsSync(reviewedFile) ? reviewedFile : 'no REVIEWED.json'}), snapshot ${(json.length / 1024).toFixed(0)} kB`);
