import './reference/mock-api.ts';
// 浏览购物灵感 ≠ 确认购买需求：灵感卡片只把示例填进输入框，用户发送后才写入购买条件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeValue, confirmedConditions, getCondition } from './reference/conditions.ts';
import { INSPIRATION_EXAMPLE, interpretDemo } from '../lib/demo-phrases.ts';
import type { ShopSession } from '../lib/session.ts';
import { initialSession, reduce } from '../lib/session.ts';

async function submit(s: ShopSession, text: string): Promise<ShopSession> {
  const sent = (await reduce(s, { type: 'sendText', text }));
  return (await reduce(sent, { type: 'textResolved', requestId: sent.assistant.pendingRequest!.id }));
}

test('普通打开助手不产生任何条件：首页没有品类和预算，列表未设筛选时也没有', async () => {
  const home = (await reduce(initialSession(), { type: 'openAssistant', entry: 'home' }));
  assert.equal(home.assistant.state.category, null);
  assert.deepEqual(home.assistant.state.conditions, []);
  const list = (await reduce(initialSession(), { type: 'openAssistant', entry: 'list' }));
  assert.deepEqual(list.assistant.state.conditions, []);
});

test('灵感卡片的示例只是待发送的文字：发送前和等待中都不写入购买条件', async () => {
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'home' }));
  const opened = structuredClone(s.assistant.state);
  assert.doesNotMatch(INSPIRATION_EXAMPLE, /必须|需要主动降噪/, '示例没有要求必须降噪');
  // 点卡片只改输入框（界面本地状态），没有任何会话动作；发送后、模拟等待期间条件仍为空
  s = (await reduce(s, { type: 'sendText', text: INSPIRATION_EXAMPLE }));
  assert.equal(s.assistant.status, 'loading');
  assert.deepEqual(s.assistant.state, opened);
});

test('确认发送示例后才应用：预算和场景生效，主动降噪只作为建议', async () => {
  let s = (await reduce(initialSession(), { type: 'openAssistant', entry: 'home' }));
  assert.notEqual(interpretDemo(INSPIRATION_EXAMPLE), null);
  s = (await submit(s, INSPIRATION_EXAMPLE));
  assert.equal(s.assistant.state.category, 'headphones');
  assert.deepEqual(confirmedConditions(s.assistant.state).map(c => [c.field, c.kind]), [['budget', 'hard'], ['scene', 'scene']]);
  assert.equal(activeValue(s.assistant.state, 'budget'), 300);
  assert.equal(getCondition(s.assistant.state, 'anc')?.status, 'suggested');
  assert.match(s.assistant.messages.at(-1)!.text, /要不要把「必须支持主动降噪」加进条件/);
});

test('之后修改预算只更新预算：已确认的降噪和场景保留，未采纳的建议也保留', async () => {
  let s = (await submit((await reduce(initialSession(), { type: 'openAssistant', entry: 'home' })), INSPIRATION_EXAMPLE));
  const withSuggestion = (await submit(s, '预算降到 200 元，其他不变'));
  assert.equal(activeValue(withSuggestion.assistant.state, 'budget'), 200);
  assert.equal(activeValue(withSuggestion.assistant.state, 'scene'), '地铁通勤');
  assert.equal(getCondition(withSuggestion.assistant.state, 'anc')?.status, 'suggested');

  s = (await reduce(s, { type: 'uiChanges', label: '设为必须', changes: [{ op: 'confirm', field: 'anc', kind: 'hard' }] }));
  s = (await submit(s, '预算降到 200 元，其他不变'));
  assert.deepEqual(confirmedConditions(s.assistant.state).map(c => [c.field, c.kind, c.field === 'budget' ? c.value : '']), [
    ['budget', 'hard', 200], ['scene', 'scene', ''], ['anc', 'hard', ''],
  ]);
});
