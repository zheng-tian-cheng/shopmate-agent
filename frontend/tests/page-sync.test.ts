import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConditionChange } from './reference/conditions.ts';
import { applyChanges, describeCondition, emptyState, getCondition } from './reference/conditions.ts';
import type { PageFilters } from './reference/page-sync.ts';
import { DEFAULT_PAGE_FILTERS, describePageFilters, projectToPageFilters, stateFromPageFilters } from './reference/page-sync.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { setCatalogForTesting } from '../lib/products.ts';
import { searchProducts } from './reference/search.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

const FILTERS: PageFilters = { budgetMax: 300, ancRequired: true, excludeInEar: true };

test('场景 A：列表筛选转换为已生效的硬约束，来源为 page', async () => {
  const state = stateFromPageFilters(FILTERS);
  assert.deepEqual(state.conditions.map(c => [c.field, c.status, c.kind, c.source]), [
    ['budget', 'confirmed', 'hard', 'page'],
    ['anc', 'confirmed', 'hard', 'page'],
    ['wearingStyle', 'confirmed', 'hard', 'page'],
  ]);
  assert.deepEqual(stateFromPageFilters(DEFAULT_PAGE_FILTERS), emptyState());
});

test('列表筛选和助手使用同一套筛选规则', async () => {
  const fromPage = stateFromPageFilters({ budgetMax: 260, ancRequired: true, excludeInEar: false });
  const fromAssistant = applyChanges(emptyState(), [
    { op: 'set', field: 'anc', kind: 'hard', value: true },
    { op: 'set', field: 'budget', kind: 'hard', value: 260 },
  ], 'interpreter').state;
  const ids = (s: typeof fromPage) => searchProducts(MOCK_PRODUCTS, s).map(m => m.product.id);
  assert.deepEqual(ids(fromPage), ids(fromAssistant));
});

test('场景 B：只把已生效的硬约束写回列表，其余列为无法映射', async () => {
  const changes: ConditionChange[] = [
    { op: 'set', field: 'budget', kind: 'hard', value: 200 },
    { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
    { op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '通勤' },
  ];
  const state = applyChanges(emptyState(), changes, 'interpreter').state;
  const { filters, unmapped } = projectToPageFilters(state);
  assert.deepEqual(filters, { budgetMax: 200, ancRequired: false, excludeInEar: false });
  assert.deepEqual(unmapped.map(describeCondition), ['场景：地铁通勤', '必须支持主动降噪']);
  assert.equal(getCondition(state, 'anc')?.status, 'suggested');
});

test('偏好类条件无法映射为列表筛选', async () => {
  const state = applyChanges(emptyState(), [
    { op: 'set', field: 'budget', kind: 'soft', value: 300 },
    { op: 'set', field: 'anc', kind: 'soft', value: true },
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['头戴式'] } },
  ], 'ui').state;
  const { filters, unmapped } = projectToPageFilters(state);
  assert.deepEqual(filters, DEFAULT_PAGE_FILTERS);
  assert.equal(unmapped.length, 3);
});

test('列表筛选 → 助手 → 列表 往返不变', async () => {
  assert.deepEqual(projectToPageFilters(stateFromPageFilters(FILTERS)), { filters: FILTERS, unmapped: [] });
  assert.deepEqual(describePageFilters(FILTERS), ['预算 ≤ ¥300', '必须支持主动降噪', '排除入耳式']);
});
