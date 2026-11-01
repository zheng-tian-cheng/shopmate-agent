import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, confirmedConditions, emptyState, getCondition } from './reference/conditions.ts';
import { DEMO_NOTICE, DEMO_PHRASES, interpretDemo } from '../lib/demo-phrases.ts';

test('固定话术的标识写明未接入 LLM', async () => {
  assert.match(DEMO_NOTICE, /固定话术/);
  assert.match(DEMO_NOTICE, /未接入 LLM/);
});

test('列出的每一句都能识别，忽略标点和空格', async () => {
  for (const phrase of DEMO_PHRASES) assert.notEqual(interpretDemo(phrase), null, phrase);
  assert.notEqual(interpretDemo(' 地铁通勤用 300以内。'), null);
  assert.equal(interpretDemo('地铁通勤用，300 以内，要白色'), null);
});

test('固定话术只提出变更，从不替用户采纳建议或回答待确认项', async () => {
  for (const phrase of DEMO_PHRASES) {
    const result = interpretDemo(phrase);
    if (result?.type !== 'changes') continue;
    assert.ok(result.changes.every(c => ['set', 'update', 'remove', 'suggest', 'ask'].includes(c.op)), phrase);
    // 修改、取消需要已有条件，在空状态下被拒绝是预期行为；其余变更都应合法
    const rejected = applyChanges(emptyState(), result.changes, 'interpreter').rejected;
    assert.equal(rejected.filter(r => r.change.op !== 'update' && r.change.op !== 'remove').length, 0, phrase);
  }
});

test('“地铁通勤”推导出的降噪只是建议，不会变成硬约束', async () => {
  const result = interpretDemo('地铁通勤用，300 以内');
  assert.ok(result?.type === 'changes');
  const state = applyChanges(emptyState(), result.changes, 'interpreter').state;
  assert.equal(getCondition(state, 'anc')?.status, 'suggested');
  assert.deepEqual(confirmedConditions(state).map(c => c.field), ['budget', 'scene']);
});

test('“三百块钱”没有说明是上限还是参考，记为待确认，不擅自归类', async () => {
  const result = interpretDemo('地铁通勤用，三百块钱');
  assert.ok(result?.type === 'changes');
  const budget = getCondition(applyChanges(emptyState(), result.changes, 'interpreter').state, 'budget');
  assert.equal(budget?.status, 'pending');
  assert.equal(budget?.kind, null);
});

test('“300 元左右，最好有降噪”记为偏好', async () => {
  const result = interpretDemo('300 元左右，最好有降噪');
  assert.ok(result?.type === 'changes');
  const state = applyChanges(emptyState(), result.changes, 'interpreter').state;
  assert.deepEqual(state.conditions.map(c => [c.field, c.kind]), [['budget', 'soft'], ['anc', 'soft']]);
});

test('不支持的品类单独返回，不产生条件变更', async () => {
  assert.deepEqual(interpretDemo('我想买沙发'), { type: 'unsupported-category', category: '沙发' });
});

test('返回的是副本，修改不会影响话术规则', async () => {
  const first = interpretDemo(DEMO_PHRASES[0]);
  assert.ok(first?.type === 'changes');
  first.changes.length = 0;
  const second = interpretDemo(DEMO_PHRASES[0]);
  assert.ok(second?.type === 'changes' && second.changes.length === 3);
});
