import './reference/mock-api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeOrigin, ConditionChange, ConditionState } from './reference/conditions.ts';
import {
  ALLOWED_OPS, activeValue, applyChanges, confirmedConditions, describeCondition, emptyState, getCondition, validateState,
} from './reference/conditions.ts';

const ANC_SUGGESTION: ConditionChange = { op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: '通勤场景' };
const BUDGET_ASK: Extract<ConditionChange, { op: 'ask' }> = {
  op: 'ask', field: 'budget', question: '300 元是上限还是参考？', rawText: '三百块钱',
  options: [{ label: '上限', kind: 'hard', value: 300 }, { label: '参考', kind: 'soft', value: 300 }],
};

function run(state: ConditionState, origin: ChangeOrigin, ...changes: ConditionChange[]) {
  const result = applyChanges(state, changes, origin);
  assert.deepEqual(validateState(result.state), [], '每次变更后状态都必须满足不变量');
  return result;
}

test('三个维度分开记录：类别、状态、来源', async () => {
  const { state } = run(emptyState(), 'interpreter',
    { op: 'set', field: 'budget', kind: 'hard', value: 300 },
    { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' },
    ANC_SUGGESTION,
    { op: 'ask', field: 'wearingStyle', question: '要排除哪种佩戴方式？', rawText: '不要那种塞耳朵的', options: [
      { label: '排除入耳式', kind: 'hard', value: { exclude: ['入耳式'] } },
      { label: '尽量避开入耳式', kind: 'soft', value: { exclude: ['入耳式'] } },
    ] });
  const pick = (f: string) => state.conditions.find(c => c.field === f)!;
  assert.deepEqual([pick('budget').kind, pick('budget').status, pick('budget').source], ['hard', 'confirmed', 'user']);
  assert.deepEqual([pick('scene').kind, pick('scene').status, pick('scene').source], ['scene', 'confirmed', 'user']);
  assert.deepEqual([pick('anc').kind, pick('anc').status, pick('anc').source], ['hard', 'suggested', 'system']);
  assert.deepEqual([pick('wearingStyle').kind, pick('wearingStyle').status, pick('wearingStyle').source], [null, 'pending', 'user']);
});

test('系统建议和待确认项都不生效，且互相区分', async () => {
  const { state } = run(emptyState(), 'interpreter', ANC_SUGGESTION, BUDGET_ASK);
  assert.deepEqual(confirmedConditions(state), []);
  assert.equal(getCondition(state, 'anc')?.status, 'suggested');
  assert.equal(getCondition(state, 'budget')?.status, 'pending');
  assert.equal(getCondition(state, 'budget')?.kind, null);
});

test('解释器不能采纳建议、忽略建议或回答待确认项', async () => {
  const { state } = run(emptyState(), 'interpreter', ANC_SUGGESTION, BUDGET_ASK);
  for (const change of [
    { op: 'confirm', field: 'anc' }, { op: 'dismiss', field: 'anc' }, { op: 'resolve', field: 'budget', option: 0 },
  ] as ConditionChange[]) {
    const result = run(state, 'interpreter', change);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(result.state, state);
  }
});

test('每种发起方只能执行允许的操作', async () => {
  assert.deepEqual(ALLOWED_OPS.page, ['set']);
  assert.deepEqual(ALLOWED_OPS.system, ['suggest']);
  assert.equal(run(emptyState(), 'system', { op: 'set', field: 'anc', kind: 'hard', value: true }).rejected.length, 1);
  assert.equal(run(emptyState(), 'page', ANC_SUGGESTION).rejected.length, 1);
  assert.equal(run(emptyState(), 'ui', ANC_SUGGESTION).rejected.length, 1);
});

test('页面继承的条件来源为 page；用户修改后来源变为 user，类别不变', async () => {
  const inherited = run(emptyState(), 'page', { op: 'set', field: 'budget', kind: 'hard', value: 300 }).state;
  assert.equal(getCondition(inherited, 'budget')?.source, 'page');
  const updated = run(inherited, 'interpreter', { op: 'update', field: 'budget', value: 200 }).state;
  assert.deepEqual(getCondition(updated, 'budget'), { field: 'budget', status: 'confirmed', kind: 'hard', source: 'user', value: 200 });
});

test('采纳建议：默认按建议的类别生效，也可以改为偏好；来源仍是系统建议', async () => {
  const suggested = run(emptyState(), 'interpreter', ANC_SUGGESTION).state;
  const hard = run(suggested, 'ui', { op: 'confirm', field: 'anc' }).state;
  assert.deepEqual(getCondition(hard, 'anc'), { field: 'anc', status: 'confirmed', kind: 'hard', source: 'system', value: true, reason: '通勤场景' });
  const soft = run(suggested, 'ui', { op: 'confirm', field: 'anc', kind: 'soft' }).state;
  assert.equal(getCondition(soft, 'anc')?.kind, 'soft');
  assert.equal(run(suggested, 'ui', { op: 'confirm', field: 'anc', kind: 'scene' }).rejected.length, 1);
});

test('忽略建议后本次选购不再提出；用户仍可自己设置该条件', async () => {
  const dismissed = run(run(emptyState(), 'interpreter', ANC_SUGGESTION).state, 'ui', { op: 'dismiss', field: 'anc' }).state;
  assert.equal(getCondition(dismissed, 'anc'), undefined);
  assert.deepEqual(dismissed.dismissed, ['anc']);
  assert.equal(run(dismissed, 'system', ANC_SUGGESTION).rejected.length, 1);
  assert.equal(getCondition(run(dismissed, 'ui', { op: 'set', field: 'anc', kind: 'soft', value: true }).state, 'anc')?.status, 'confirmed');
});

test('系统建议不覆盖用户条件或待确认项，但可以替换旧建议', async () => {
  const userSet = run(emptyState(), 'ui', { op: 'set', field: 'anc', kind: 'soft', value: true }).state;
  assert.equal(run(userSet, 'system', ANC_SUGGESTION).rejected.length, 1);
  const pending = run(emptyState(), 'interpreter', BUDGET_ASK).state;
  assert.equal(run(pending, 'system', { op: 'suggest', field: 'budget', kind: 'soft', value: 259, reason: '相似款' }).rejected.length, 1);
  const first = run(emptyState(), 'system', { op: 'suggest', field: 'budget', kind: 'soft', value: 259, reason: '相似款 A' }).state;
  const second = run(first, 'system', { op: 'suggest', field: 'budget', kind: 'soft', value: 179, reason: '相似款 B' }).state;
  assert.equal(getCondition(second, 'budget')?.status, 'suggested');
  assert.equal(activeValue(second, 'budget'), 179);
});

test('待确认项：已有生效条件时不重新询问；选择不存在的选项被拒绝；选择后由用户确认生效', async () => {
  const budget = run(emptyState(), 'ui', { op: 'set', field: 'budget', kind: 'hard', value: 200 }).state;
  assert.equal(run(budget, 'interpreter', BUDGET_ASK).rejected.length, 1);
  const pending = run(emptyState(), 'interpreter', BUDGET_ASK).state;
  assert.equal(run(pending, 'ui', { op: 'resolve', field: 'budget', option: 5 }).rejected.length, 1);
  const resolved = run(pending, 'ui', { op: 'resolve', field: 'budget', option: 0 }).state;
  assert.deepEqual(getCondition(resolved, 'budget'), { field: 'budget', status: 'confirmed', kind: 'hard', source: 'user', value: 300 });
  assert.equal(run(emptyState(), 'interpreter', { ...BUDGET_ASK, options: [BUDGET_ASK.options[0]] }).rejected.length, 1);
});

test('修改只作用于已生效的条件；取消不存在的条件被拒绝', async () => {
  const suggested = run(emptyState(), 'system', { op: 'suggest', field: 'budget', kind: 'soft', value: 259, reason: '相似款' }).state;
  assert.equal(run(suggested, 'interpreter', { op: 'update', field: 'budget', value: 200 }).rejected.length, 1);
  assert.equal(run(emptyState(), 'ui', { op: 'remove', field: 'anc' }).rejected.length, 1);
});

test('值与类别校验', async () => {
  const bad: ConditionChange[] = [
    { op: 'set', field: 'budget', kind: 'hard', value: 0 },
    { op: 'set', field: 'budget', kind: 'hard', value: 100001 },
    { op: 'set', field: 'budget', kind: 'scene', value: 300 },
    { op: 'set', field: 'anc', kind: 'hard', value: 'yes' as unknown as boolean },
    { op: 'set', field: 'scene', kind: 'hard', value: '地铁通勤' },
    { op: 'set', field: 'scene', kind: 'scene', value: '  ' },
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: [] } },
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['骨传导' as unknown as '入耳式'] } },
    { op: 'set', field: 'color' as unknown as 'anc', kind: 'hard', value: true },
    { op: 'suggest', field: 'anc', kind: 'hard', value: true, reason: ' ' },
  ];
  const result = applyChanges(emptyState(), bad, 'interpreter');
  assert.equal(result.rejected.length, bad.length);
  assert.deepEqual(result.state, emptyState());
});

test('被拒绝的变更不影响同一批次中其他合法变更；未提及的字段不变', async () => {
  const start = run(emptyState(), 'ui', { op: 'set', field: 'scene', kind: 'scene', value: '地铁通勤' }).state;
  const result = run(start, 'interpreter',
    { op: 'update', field: 'budget', value: 200 },
    { op: 'set', field: 'anc', kind: 'hard', value: true });
  assert.equal(result.rejected.length, 1);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(getCondition(result.state, 'scene'), getCondition(start, 'scene'));
});

test('不修改输入；应用后再改动原变更对象不影响状态', async () => {
  const start = emptyState();
  const snapshot = structuredClone(start);
  const change = { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } } as ConditionChange & { value: { exclude: string[] } };
  const { state } = applyChanges(start, [change], 'ui');
  change.value.exclude.push('头戴式');
  assert.deepEqual(start, snapshot);
  assert.deepEqual(activeValue(state, 'wearingStyle'), { exclude: ['入耳式'] });
});

test('validateState 能发现违反不变量的状态', async () => {
  const broken = {
    ...emptyState(),
    conditions: [
      { field: 'anc', status: 'suggested', kind: 'hard', source: 'user', value: true, reason: 'x' },
      { field: 'budget', status: 'pending', kind: 'hard', source: 'user', question: 'q', rawText: 'r', options: [] },
      { field: 'anc', status: 'confirmed', kind: 'hard', source: 'user', value: true },
    ],
  } as unknown as ConditionState;
  const errors = validateState(broken);
  assert.ok(errors.some(e => e.includes('建议只能来自系统')));
  assert.ok(errors.some(e => e.includes('不能预先归类')));
  assert.ok(errors.some(e => e.includes('多个条件')));
});

test('条件的文字描述', async () => {
  const { state } = run(emptyState(), 'ui',
    { op: 'set', field: 'budget', kind: 'soft', value: 203.74 },
    { op: 'set', field: 'anc', kind: 'hard', value: true },
    { op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } });
  assert.deepEqual(state.conditions.map(describeCondition), ['预算 ¥203.74 左右', '必须支持主动降噪', '排除入耳式']);
});
