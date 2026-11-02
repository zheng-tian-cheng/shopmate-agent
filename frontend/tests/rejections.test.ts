import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConditionChange, Rejection } from '../lib/conditions.ts';
import { rejectionNotes } from '../lib/conditions.ts';

// 后端拒绝的操作如何告诉用户：只说哪项没有处理；调用方式错误的技术原因不展示
const cool = { op: 'set', field: 'scene', kind: 'soft', value: '酷炫动感' } as unknown as ConditionChange;
const budget = (value: unknown, kind = 'soft') => ({ op: 'set', field: 'budget', kind, value }) as unknown as ConditionChange;

test('模型把没有对应字段的偏好写错：说明这项没有记下，不展示“条件类别与字段不匹配”', () => {
  const notes = rejectionNotes([budget(600)], [{ change: cool, reason: '条件类别与字段不匹配', code: 'invalid' }]);
  assert.deepEqual(notes, ['「酷炫动感」没有记下。']);
});

test('模型本轮已用同样的值改正：不再提', () => {
  const rejected: Rejection[] = [{ change: budget(600, 'scene'), reason: '条件类别与字段不匹配', code: 'invalid' }];
  assert.deepEqual(rejectionNotes([budget(600)], rejected), []);
});

test('认不出是哪项要求时，只给诚实的通用说明', () => {
  const odd = { op: 'set', field: 'color', kind: 'soft', value: { tone: 'dark' } } as unknown as ConditionChange;
  assert.deepEqual(rejectionNotes([], [{ change: odd, reason: '不支持的条件字段', code: 'invalid' }]), ['有一项要求没有记下。']);
});

test('业务规则不允许：说明哪项、为什么；旧接口没有 code 时同样处理', () => {
  const rejected: Rejection[] = [
    { change: budget(200000, 'hard'), reason: '预算需大于 0 且不超过 100000 元', code: 'rule' },
    { change: { op: 'dismiss', field: 'anc' }, reason: '没有可以忽略的建议' },
  ];
  assert.deepEqual(rejectionNotes([], rejected), ['「预算 ¥200000」没有记下：预算需大于 0 且不超过 100000 元。', '有一项操作没有执行：没有可以忽略的建议。']);
});

test('聊天里助手自己发起的建议被拒绝：用户没有提出，不提示；界面操作（找相似款）触发的照常说明', () => {
  const suggest = { op: 'suggest', field: 'budget', kind: 'soft', value: 259, reason: '价格接近' } as ConditionChange;
  const rejected: Rejection[] = [{ change: suggest, reason: '已有你设置或待确认的条件，系统建议不覆盖', code: 'rule' }];
  assert.deepEqual(rejectionNotes([], rejected, true), []);
  assert.deepEqual(rejectionNotes([], rejected), ['建议「预算 ¥259」没有加上：已有你设置或待确认的条件，系统建议不覆盖。']);
});

test('同一项被拒绝多次只说一次', () => {
  const twice: Rejection[] = [1, 2].map(() => ({ change: cool, reason: '条件类别与字段不匹配', code: 'invalid' }));
  assert.deepEqual(rejectionNotes([], twice), ['「酷炫动感」没有记下。']);
});
