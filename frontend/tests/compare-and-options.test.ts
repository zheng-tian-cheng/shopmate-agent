import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, emptyState, getCondition } from './reference/conditions.ts';
import { MAX_COMPARE, compareProducts, toggleCompare } from '../lib/compare.ts';
import { formFromState, formToChanges } from '../lib/condition-form.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { getProduct, setCatalogForTesting } from '../lib/products.ts';
import { MAX_QUICK_OPTIONS, quickOptions } from '../lib/quick-options.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

test('两款比较：同一维度逐行对比，数据集中没有的项显示“暂未收录”', async () => {
  const rows = compareProducts(getProduct('mock-01')!, getProduct('mock-06')!);
  const row = (label: string) => rows.find(r => r.label === label)!;
  assert.deepEqual(rows.map(r => r.label), ['价格', '佩戴方式', '主动降噪', '降噪深度（标称）', '续航', '重量', '蓝牙版本']);
  assert.deepEqual(row('主动降噪').values, ['支持', '暂未收录']);
  assert.equal(row('续航').values[1], '暂未收录');
  assert.deepEqual(row('降噪深度（标称）').values, ['暂未收录', '暂未收录'], '虚构商品没有标称降噪深度');
  assert.equal(row('佩戴方式').differs, false);
  assert.equal(row('主动降噪').differs, true);
  assert.equal(compareProducts(getProduct('mock-07')!, getProduct('mock-02')!)[0].values[0], '价格待核验');
});

test('对比栏最多两款，重复点击移除', async () => {
  let ids: string[] = [];
  ids = toggleCompare(ids, 'mock-01').ids;
  ids = toggleCompare(ids, 'mock-02').ids;
  const full = toggleCompare(ids, 'mock-03');
  assert.equal(MAX_COMPARE, 2);
  assert.deepEqual(full.ids, ['mock-01', 'mock-02']);
  assert.ok(full.error);
  assert.deepEqual(toggleCompare(ids, 'mock-01'), { ids: ['mock-02'], error: null });
});

test('快捷选项：每轮最多 4 个，不重复已有条件（含建议和待确认项）', async () => {
  const initial = quickOptions(emptyState());
  assert.equal(initial.length, MAX_QUICK_OPTIONS);
  assert.deepEqual(initial.map(o => o.label), ['200 元以内', '300 元以内', '必须主动降噪', '最好有降噪']);
  const state = applyChanges(emptyState(), [
    { op: 'set', field: 'budget', kind: 'hard', value: 300 },
    { op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '通勤' },
  ], 'interpreter').state;
  assert.deepEqual(quickOptions(state).map(o => o.field), ['wearingStyle', 'scene']);
});

test('快捷选项由界面直接生成变更，硬约束和偏好区分清楚', async () => {
  const [, , hard, soft] = quickOptions(emptyState());
  const afterHard = applyChanges(emptyState(), hard.changes, 'ui').state;
  const afterSoft = applyChanges(emptyState(), soft.changes, 'ui').state;
  assert.equal(getCondition(afterHard, 'anc')?.kind, 'hard');
  assert.equal(getCondition(afterSoft, 'anc')?.kind, 'soft');
});

test('修改条件表单：只为改动过的字段生成变更', async () => {
  const state = applyChanges(emptyState(), [
    { op: 'set', field: 'budget', kind: 'hard', value: 300 },
    { op: 'set', field: 'anc', kind: 'hard', value: true },
    { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
  ], 'ui').state;
  const form = formFromState(state);
  assert.deepEqual(form, { budget: '300', budgetKind: 'hard', anc: 'hard', excludeInEar: false, scene: '地铁通勤' });
  assert.deepEqual(formToChanges(form, state), { changes: [], error: null });
  assert.deepEqual(formToChanges({ ...form, budget: '200' }, state).changes, [{ op: 'set', field: 'budget', kind: 'hard', value: 200 }]);
  assert.deepEqual(formToChanges({ ...form, budgetKind: 'soft' }, state).changes, [{ op: 'set', field: 'budget', kind: 'soft', value: 300 }]);
  assert.deepEqual(formToChanges({ ...form, budget: '', anc: 'any', scene: '' }, state).changes, [
    { op: 'remove', field: 'budget' }, { op: 'remove', field: 'anc' }, { op: 'remove', field: 'scene' },
  ]);
  assert.deepEqual(formToChanges({ ...form, excludeInEar: true }, state).changes, [
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } },
  ]);
});

test('修改条件表单：非法预算不生成任何变更；未生效的建议不出现在表单里', async () => {
  const state = applyChanges(emptyState(), [{ op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '通勤' }], 'interpreter').state;
  assert.equal(formFromState(state).anc, 'any');
  assert.deepEqual(formToChanges({ ...formFromState(state) }, state).changes, []);
  const bad = formToChanges({ ...formFromState(state), budget: '-1' }, state);
  assert.deepEqual(bad.changes, []);
  assert.ok(bad.error);
});
