// Plugin-directory package: listing pages, submission limits, ZIP output (scripts/package-submission.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGES, PLUGIN_DIR, factCheck, packageSubmission, unzip, validate } from '../scripts/package-submission.mjs';

const manifest = () => JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(PLUGIN_DIR, 'mcp.json'), 'utf8'));
const ui = (m) => m.extensions['com.openai'].interface;

test('submission: the manifest links the support, privacy and terms pages of mcp.eorscope.com', () => {
  const m = manifest();
  for (const [k, file] of Object.entries(PAGES)) {
    assert.equal(ui(m)[k], `https://mcp.eorscope.com/${file}`, k);
    const html = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, file);
    assert.match(html, /research@eorscope\.com/, file);
  }
  assert.equal(ui(m).websiteURL, 'https://eorscope.com/');
  assert.equal(Object.values(mcp.mcpServers)[0].url, 'https://mcp.eorscope.com/mcp');
});

test('submission: the manifest passes every offline rule and the fact check', () => {
  assert.deepEqual(validate(manifest(), mcp), []);
  assert.deepEqual(factCheck(manifest(), mcp), []);
  const i = ui(manifest());
  assert.ok([...i.displayName].length <= 30 && [...i.shortDescription].length <= 30 && [...i.longDescription].length <= 4000);
});

test('submission: limits are enforced (31-character subtitle, 4 test cases, missing privacy URL)', () => {
  const m = manifest();
  ui(m).shortDescription = 'x'.repeat(31);
  m.extensions['com.openai'].review.test_cases.positive.pop();
  delete ui(m).privacyPolicyURL;
  const errors = validate(m, mcp).join('\n');
  assert.match(errors, /shortDescription/);
  assert.match(errors, /positive: exactly 5/);
  assert.match(errors, /privacyPolicyURL/);
});

test('submission: no provider price and no @mention in the listing text', () => {
  const i = ui(manifest());
  const text = [i.shortDescription, i.longDescription, ...i.capabilities, ...i.defaultPrompt].join('\n');
  assert.doesNotMatch(text, /\$\s?\d|USD\s?\d+\s?(?:per|a|\/)\s?month|@/);
});

test('submission: npm run package:submission writes a ZIP that reads back with the manifest at its root', () => {
  const out = mkdtempSync(join(tmpdir(), 'eorscope-sub-'));
  const { file, entries, warnings } = packageSubmission(out);
  assert.deepEqual(readdirSync(out), ['eorscope-1.0.0.zip']);
  assert.deepEqual(entries, ['plugin.json', 'mcp.json', 'assets/logo.png']);
  const back = unzip(readFileSync(file));
  assert.deepEqual(back.map((e) => e.name), entries);
  const zipped = JSON.parse(back[0].data.toString('utf8'));
  assert.equal(ui(zipped).displayName, 'EOR Scope');
  // an empty demo URL is left out of the ZIP, never sent as "" (which would clear the dashboard value)
  if (!manifest().extensions['com.openai'].review.demo_recording_url) {
    assert.equal('demo_recording_url' in zipped.extensions['com.openai'].review, false);
    assert.equal(warnings.length, 1);
  }
});

test('privacy: the server code writes no request body or tool argument to the logs', () => {
  for (const f of ['src/http.ts', 'src/server.ts', 'src/tools.ts', 'src/widgets.ts', 'src/index.ts', 'api/mcp.ts']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const calls = src.match(/console\.\w+\([^\n]*/g) ?? [];
    // the only one: the local dev server's start-up line
    for (const c of calls) assert.match(c, /^console\.log\(`eorscope-mcp HTTP listening on/, `${f}: ${c}`);
  }
});
