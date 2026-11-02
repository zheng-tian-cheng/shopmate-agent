// Requires a running FastAPI. No mocked fetch or test-only runtime services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, loadCatalog, loadProduct, search, compare } from '../lib/api.ts';
import { applyChanges, emptyState } from '../lib/conditions.ts';
import type { ConditionChange, ChangeOrigin, ConditionState, ApplyResult } from '../lib/conditions.ts';
import { searchProducts as referenceSearch } from './reference/search.ts';
import { reduce, initialSession } from '../lib/session.ts';
const contract = JSON.parse(readFileSync(new URL('../../contracts/condition-cases.json', import.meta.url), 'utf8'));
const products = await loadCatalog();

test('HTTP catalog, detail and comparison preserve identity and measurements', async () => {
  assert.equal(products.length, 15);
  for (const p of products) assert.deepEqual(await loadProduct(p.id), p);
  assert.deepEqual(await compare(products.slice(0, 2).map(p => p.id)), products.slice(0, 2));
  await assert.rejects(loadProduct('missing'), /商品不存在/);
});
for (const c of contract.applyCases) test(`HTTP contract: ${c.name}`, async () => {
  let state = emptyState();
  const rejected: string[] = [];
  for (const step of c.steps) {
    const result = await applyChanges(state, step.changes as ConditionChange[], step.origin as ChangeOrigin);
    state = result.state;
    rejected.push(...result.rejected.map(r => r.change.op));
  }
  assert.deepEqual(state.conditions, c.expect.conditions);
  assert.deepEqual(state.dismissed, c.expect.dismissed);
  assert.deepEqual(rejected, c.expect.rejectedOps);
});
for (const c of contract.searchCases) test(`Real catalog Python/TS parity: ${c.name}`, async () => {
  const state: ConditionState = { ...emptyState(), conditions: c.conditions };
  assert.deepEqual((await search(state)).matches.map(m => m.product.id), referenceSearch(products, state).map(m => m.product.id));
});
test('real asynchronous UI session retains ANC and history when budget changes', async () => {
  let s = await reduce(initialSession(), { type: 'openAssistant', entry: 'list' });
  s = await reduce(s, { type: 'uiChanges', label: '预算和降噪', changes: [
    { op: 'set', field: 'budget', kind: 'hard', value: 300 }, { op: 'set', field: 'anc', kind: 'hard', value: true },
  ] });
  s = await reduce(s, { type: 'uiChanges', label: '改预算', changes: [{ op: 'update', field: 'budget', value: 200 }] });
  assert.equal(s.assistant.state.conditions.find(c => c.field === 'anc')?.status, 'confirmed');
  assert.equal(s.assistant.messages.filter(m => m.recommendations).length, 2);
  assert.ok((await search(s.assistant.state)).matches.every(m => m.product.price.amount! <= 200 && m.product.anc === true));
});
