import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeOrigin, ConditionChange, ConditionState } from './reference/conditions.ts';
import { applyChanges, emptyState } from './reference/conditions.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { getProduct, setCatalogForTesting } from '../lib/products.ts';
import { evaluateProduct, matchesKeyword, searchProducts } from './reference/search.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

function stateOf(origin: ChangeOrigin, ...changes: ConditionChange[]): ConditionState {
  const result = applyChanges(emptyState(), changes, origin);
  assert.equal(result.rejected.length, 0);
  return result.state;
}
const ids = (state: ConditionState) => searchProducts(MOCK_PRODUCTS, state).map(m => m.product.id);

test('演示商品都明确标记为模拟数据', async () => {
  assert.ok(MOCK_PRODUCTS.length >= 6);
  assert.ok(MOCK_PRODUCTS.every(p => p.isMock === true && p.id.startsWith('mock-')));
  assert.ok(MOCK_PRODUCTS.every(p => p.price.verifiedAt === null));
});

test('规则一：预算上限按价格严格执行', async () => {
  assert.ok(ids(stateOf('ui', { op: 'set', field: 'budget', kind: 'hard', value: 259 })).includes('mock-01'));
  assert.ok(!ids(stateOf('ui', { op: 'set', field: 'budget', kind: 'hard', value: 258.99 })).includes('mock-01'));
});

test('规则二：要求主动降噪时，降噪资料缺失的商品不算满足', async () => {
  const state = stateOf('ui', { op: 'set', field: 'anc', kind: 'hard', value: true });
  assert.ok(!ids(state).includes('mock-06'));
  assert.ok(!ids(state).includes('mock-03'));
  assert.deepEqual(evaluateProduct(getProduct('mock-06')!, state).failures, [{ field: 'anc', reason: 'unknown' }]);
});

test('规则五：没有有效价格时不能声称符合预算，但未设预算时可以展示', async () => {
  const budget = stateOf('ui', { op: 'set', field: 'budget', kind: 'hard', value: 100000 });
  assert.ok(!ids(budget).includes('mock-07'));
  assert.deepEqual(evaluateProduct(getProduct('mock-07')!, budget).failures, [{ field: 'budget', reason: 'no-price' }]);
  const all = ids(emptyState());
  assert.equal(all.at(-1), 'mock-07');
  assert.ok(evaluateProduct(getProduct('mock-07')!, emptyState()).notes.includes('价格待核验'));
});

test('规则三：软偏好只影响排序，不排除商品', async () => {
  const soft = stateOf('ui', { op: 'set', field: 'anc', kind: 'soft', value: true });
  const result = searchProducts(MOCK_PRODUCTS, soft);
  assert.equal(result.length, MOCK_PRODUCTS.length);
  const firstWithout = result.findIndex(m => m.product.anc !== true);
  assert.ok(result.slice(firstWithout).every(m => m.product.anc !== true));
});

test('参考预算：越接近越靠前，超出部分在备注中写明', async () => {
  const state = stateOf('ui', { op: 'set', field: 'budget', kind: 'soft', value: 300 });
  const result = searchProducts(MOCK_PRODUCTS, state);
  assert.equal(result.length, MOCK_PRODUCTS.length);
  assert.equal(result[0].product.id, 'mock-05');
  assert.ok(result[0].evaluation.notes.includes('超出参考预算 ¥29'));
});

test('使用场景、未采纳的建议和待确认项都不参与筛选', async () => {
  const state = stateOf('interpreter',
    { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
    { op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '通勤' },
    { op: 'ask', field: 'budget', question: '上限还是参考？', rawText: '三百块钱', options: [
      { label: '上限', kind: 'hard', value: 100 }, { label: '参考', kind: 'soft', value: 100 },
    ] });
  assert.deepEqual(ids(state), ids(emptyState()));
});

test('规则六：没有结果时返回空列表，不放宽条件', async () => {
  const state = stateOf('ui',
    { op: 'set', field: 'budget', kind: 'hard', value: 200 },
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } });
  assert.deepEqual(ids(state), []);
});

test('商城关键词搜索：按名称、卖点、佩戴方式和降噪匹配，多个词需同时满足', async () => {
  const hits = (q: string) => MOCK_PRODUCTS.filter(p => matchesKeyword(p, q)).map(p => p.id);
  assert.deepEqual(hits(''), MOCK_PRODUCTS.map(p => p.id));
  assert.deepEqual(hits('头戴式'), ['mock-05']);
  assert.deepEqual(hits('降噪'), MOCK_PRODUCTS.filter(p => p.anc === true).map(p => p.id));
  assert.deepEqual(hits('半入耳式 降噪'), ['mock-07']);
  assert.deepEqual(hits('沙发'), []);
});
