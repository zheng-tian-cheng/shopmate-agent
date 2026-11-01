import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, emptyState, validateState } from './reference/conditions.ts';
import { formFromState, formToChanges } from '../lib/condition-form.ts';
import { quickOptions } from '../lib/quick-options.ts';
import { initialSession, isSnapshotCurrent, reduce } from '../lib/session.ts';
import { searchProducts } from './reference/search.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { setCatalogForTesting } from '../lib/products.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

test('首页未选品类：只有通用条件，不提供耳机快捷选项或推荐', async () => {
  const s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'home' }));
  assert.equal(s.assistant.state.category, null);
  assert.ok(quickOptions(s.assistant.state).every(o => o.field === 'budget' || o.field === 'scene'));
  assert.deepEqual(searchProducts(MOCK_PRODUCTS, s.assistant.state), []);
  const result = applyChanges(s.assistant.state, [{ op: 'set', field: 'anc', kind: 'hard', value: true }], 'ui');
  assert.equal(result.rejected.length, 1);
  const form = { ...formFromState(s.assistant.state), anc: 'hard' as const, excludeInEar: true };
  assert.deepEqual(formToChanges(form, s.assistant.state).changes, []);
});

test('退出耳机品类保留预算和历史，清除专属条件、建议、场景和比较项', async () => {
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'list' }));
  s = (await reduce(s, { type: 'uiChanges', label: '条件', changes: [
    { op: 'set', field: 'budget', kind: 'hard', value: 300 },
    { op: 'set', field: 'anc', kind: 'hard', value: true },
    { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
  ] }));
  s = (await reduce(s, { type: 'toggleCompare', productId: 'mock-01' }));
  const messages = structuredClone(s.assistant.messages);
  s = (await reduce(s, { type: 'selectCategory', category: null }));
  assert.deepEqual(s.assistant.state.conditions.map(c => c.field), ['budget']);
  assert.deepEqual(s.assistant.state.dismissed, []);
  assert.deepEqual(s.compareIds, []);
  assert.deepEqual(s.assistant.messages, messages);
  assert.deepEqual(validateState(s.assistant.state), []);
  const oldFilters = s.pageFilters;
  assert.deepEqual((await reduce(s, { type: 'applyToList' })).pageFilters, oldFilters);
  s = (await reduce(s, { type: 'selectCategory', category: 'headphones' }));
  assert.deepEqual(s.assistant.state.conditions.map(c => c.field), ['budget']);
});

test('未开放品类不能进入选购，也不会生成耳机结果', async () => {
  const s = initialSession();
  for (const category of ['sofa', 'appliances', 'outdoors'] as const) {
    assert.deepEqual((await reduce(s, { type: 'selectCategory', category })), s);
    assert.deepEqual(searchProducts(MOCK_PRODUCTS, emptyState(category)), []);
    assert.notDeepEqual(validateState(emptyState(category)), []);
  }
});

test('切换品类取消等待中的旧输入，迟到响应不能重新加入耳机条件', async () => {
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'list' }));
  s = (await reduce(s, { type: 'sendText', text: '300 元以内，地铁通勤，需要主动降噪' }));
  const requestId = s.assistant.pendingRequest!.id;
  s = (await reduce(s, { type: 'selectCategory', category: null }));
  assert.deepEqual((await reduce(s, { type: 'textResolved', requestId })), s);
});

test('首页开场白是通用购物助手；主动选择耳机时在聊天中说明，并保留预算', async () => {
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'home' }));
  assert.match(s.assistant.messages[0].text, /今天想买点什么/);
  assert.doesNotMatch(s.assistant.messages[0].text, /只能完整体验蓝牙耳机。说说你的需求/);
  s = (await reduce(s, { type: 'uiChanges', label: '预算', changes: [{ op: 'set', field: 'budget', kind: 'hard', value: 300 }] }));
  const before = s.assistant.messages.length;
  s = (await reduce(s, { type: 'selectCategory', category: 'headphones' }));
  assert.equal(s.assistant.state.category, 'headphones');
  assert.equal(s.assistant.messages.length, before + 1);
  assert.match(s.assistant.messages.at(-1)!.text, /我们来挑蓝牙耳机。已保留你的预算：预算 ≤ ¥300/);
  assert.equal((await reduce(s, { type: 'selectCategory', category: 'headphones' })), s, '重复选择同一品类不重复留言');
});

test('只有最后一轮、且与当前条件下的结果一致的推荐才算当前推荐', async () => {
  const send = async (state: ReturnType<typeof initialSession>, text: string) => {
    const sent = (await reduce(state, { type: 'sendText', text }));
    return (await reduce(sent, { type: 'textResolved', requestId: sent.assistant.pendingRequest!.id }));
  };
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'list' }));
  s = (await send(s, '300 元以内，地铁通勤，需要主动降噪'));
  const first = s.assistant.messages.at(-1)!;
  assert.equal(isSnapshotCurrent(first, s.assistant, searchProducts(MOCK_PRODUCTS, s.assistant.state)), true);
  s = (await send(s, '预算降到 200 元，其他不变'));
  const second = s.assistant.messages.at(-1)!;
  assert.equal(isSnapshotCurrent(first, s.assistant, searchProducts(MOCK_PRODUCTS, s.assistant.state)), false);
  assert.equal(isSnapshotCurrent(second, s.assistant, searchProducts(MOCK_PRODUCTS, s.assistant.state)), true);
  // 取消全部筛选条件后没有新快照，最后一轮也不再代表当前结果
  s = (await reduce(s, { type: 'uiChanges', label: '清空', changes: [{ op: 'remove', field: 'budget' }, { op: 'remove', field: 'anc' }] }));
  assert.equal(isSnapshotCurrent(second, s.assistant, searchProducts(MOCK_PRODUCTS, s.assistant.state)), false);
  // 切换品类后旧快照都只作为历史
  s = (await reduce(s, { type: 'selectCategory', category: null }));
  assert.ok(s.assistant.messages.every(m => !isSnapshotCurrent(m, s.assistant, searchProducts(MOCK_PRODUCTS, s.assistant.state))));
});
