import './reference/mock-api.ts';
// 原有的 4 个规则测试，迁移到新的条件结构（lib/conditions.ts）后保留原断言含义。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConditionState } from './reference/conditions.ts';
import { activeValue, applyChanges, emptyState } from './reference/conditions.ts';
import { DEMO_PHRASES as examples, interpretDemo } from '../lib/demo-phrases.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { setCatalogForTesting } from '../lib/products.ts';
import { searchProducts } from './reference/search.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

function say(state: ConditionState, text: string): ConditionState {
  const result = interpretDemo(text);
  assert.ok(result && result.type === 'changes');
  return applyChanges(state, result.changes, 'interpreter').state;
}
const ids = (state: ConditionState) => searchProducts(MOCK_PRODUCTS, state).map(m => m.product.id);
const values = (state: ConditionState) =>
  Object.fromEntries(state.conditions.map(c => [c.field, c.status === 'pending' ? 'pending' : c.value]));

test('预算修改保留 ANC 和通勤场景', async () => {
  const first = say(emptyState(), examples[0]);
  const next = say(first, examples[1]);
  assert.deepEqual(values(next), { budget: 200, scene: '地铁通勤', anc: true });
  assert.deepEqual(ids(next), ['mock-02']);
  assert.equal(activeValue(first, 'budget'), 300);
});

test('排除入耳式与 ANC 冲突时返回零结果，不放宽条件', async () => {
  const c = say(say(emptyState(), examples[0]), examples[2]);
  assert.equal(ids(c).length, 0);
  assert.equal(activeValue(c, 'anc'), true);
  const relaxed = say(c, examples[3]);
  assert.deepEqual(ids(relaxed), ['mock-03']);
  assert.equal(activeValue(relaxed, 'budget'), 300);
});

test('未知表达和夹带额外条件不被部分理解', async () => {
  assert.equal(interpretDemo('预算 300 元，必须支持无线充电'), null);
  assert.equal(interpretDemo(examples[4] + '，不要白色'), null);
  const initial = emptyState();
  const snapshot = structuredClone(initial);
  applyChanges(initial, [{ op: 'set', field: 'budget', kind: 'hard', value: 300 }], 'ui');
  assert.deepEqual(initial, snapshot);
});

test('预算边界、未知预算与低预算', async () => {
  const budget = (n: number) => applyChanges(emptyState(), [{ op: 'set', field: 'budget', kind: 'hard', value: n }], 'ui').state;
  assert.deepEqual(ids(budget(179)), ['mock-02']);
  assert.equal(ids(budget(178)).length, 0);
  assert.equal(ids(emptyState()).length, MOCK_PRODUCTS.length);
});
