// The golden prompt set (test/golden_prompts.json) is data for a discovery evaluation replayed in ChatGPT;
// here only its shape is checked: labels, both languages, and every expected tool exists.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OUTPUT_SCHEMAS } from '../dist/server.js';

const { prompts } = JSON.parse(readFileSync(new URL('./golden_prompts.json', import.meta.url), 'utf8'));
const tools = Object.keys(OUTPUT_SCHEMAS);

test('golden prompts: direct, indirect and negative, fr and en, each expected tool exists', () => {
  assert.ok(prompts.length >= 40, `${prompts.length} prompts`);
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length, 'unique ids');
  for (const p of prompts) {
    assert.ok(['direct', 'indirect', 'negative'].includes(p.kind), p.id);
    assert.ok(['fr', 'en'].includes(p.lang), p.id);
    assert.ok(p.prompt.length > 10, p.id);
    if (p.kind === 'negative') assert.equal(p.expected_tool, 'none', p.id);
    else assert.ok(tools.includes(p.expected_tool), `${p.id}: unknown tool ${p.expected_tool}`);
  }
  for (const kind of ['direct', 'indirect', 'negative']) for (const lang of ['fr', 'en']) assert.ok(prompts.some((p) => p.kind === kind && p.lang === lang), `${kind}/${lang}`);
  // the quote of the owner's 09/10 test is in the set, and every tool is expected at least once
  assert.ok(prompts.some((p) => p.expected_tool === 'reconcile_quote' && p.kind === 'indirect' && /devis/.test(p.prompt)));
  // monthly salaries (09/10): the model passes them as given, with salary_period "month"
  const monthly = (p) => JSON.stringify(p.expected_arguments ?? {}).includes('"salary_period":"month"');
  assert.ok(prompts.filter(monthly).length >= 3, 'three monthly-salary prompts');
  for (const t of tools) assert.ok(prompts.some((p) => p.expected_tool === t), `no prompt for ${t}`);
});
