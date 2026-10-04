// Brings into the package everything the build and the tests need from the eorscope.com site
// repository, so the package builds and tests on its own and never drifts from the site:
//   src/vendor/*.ts                     the site's engine and formatters, copied as they are
//   data/snapshot.json                  the site's data, with the date of the snapshot
//   test/fixtures/country_summary.csv   the site's published dataset, the reference for the tests
// This is the only step that reads outside the package. In a checkout of the package alone
// there is nothing to read: it says so and leaves the committed copies untouched.
// Usage: node scripts/sync.mjs [--date YYYY-MM-DD]
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
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const at = process.argv.indexOf('--date');
const snapshot_date = at > 0 ? process.argv[at + 1] : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot_date ?? '')) throw new Error('--date must be YYYY-MM-DD');

// 1. the engine and its formatters: the site's own files, never rewritten here. They are not
// under the MIT terms of the server code, and each copy says so (LICENSE, section 2).
const header = `// Copied from the eorscope.com site by scripts/sync.mjs, do not edit.
// Copyright EOR Scope. All rights reserved. Distributed with this package only: you may run it
// as part of eorscope-mcp, not extract, modify or redistribute it separately. See LICENSE.
`;
for (const f of ['cost-engine.ts', 'format.ts', 'place-name.ts']) {
  write(join(pkg, 'src', 'vendor', f), header + readFileSync(join(lib, f), 'utf8'));
}

// 2. the reference the tests compare the built package with
write(join(pkg, 'test', 'fixtures', 'country_summary.csv'), readFileSync(dataset));

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
    employer_contributions: c.employer_contributions.map((k) => ({ ...Object.fromEntries(bounds.map((b) => [b, null])), ...k })),
    statutory_extras: c.statutory_extras ?? [],
    thirteenth_month: c.thirteenth_month,
    paid_leave_days: c.paid_leave_days,
    last_reviewed: c.last_reviewed,
  };
});
for (const iso of [...floor, ...ceiling]) if (!countries.some((c) => c.iso === iso)) throw new Error(`Declared bound for an unknown country: ${iso}`);

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
};
const json = JSON.stringify(snapshot);
write(join(pkg, 'data', 'snapshot.json'), json + '\n');
console.log(`sync ${snapshot_date} (${snapshot.source_commit}): engine copied to src/vendor, ${countries.length} countries (${floor.size} floors, ${ceiling.size} ceilings), snapshot ${(json.length / 1024).toFixed(0)} kB`);
