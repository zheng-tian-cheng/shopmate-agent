import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../lib/api.ts';
import { emptyState } from '../lib/conditions.ts';
import type { ConditionState } from '../lib/conditions.ts';
// This file deliberately refuses a production backend: no accidental Gemini quota use.
assert.equal((await api<{ model: string }>('/test-mode')).model, 'fixture');
interface Reply { reply: string; state: ConditionState; recommendations: { productId: string }[] | null; compareIds: string[] | null; tools: { name: string }[] }
test('HTTP chat fixture: multi-turn budget, suggestions, compare and ambiguity', async () => {
  const first = await api<Reply>('/chat', { message: '我想买耳机，300 元以内，主要坐地铁。', state: emptyState(null) });
  assert.equal(first.state.category, 'headphones');
  assert.equal(first.state.conditions.find(c => c.field === 'anc')?.status, 'suggested');
  const second = await api<Reply>('/chat', { message: '预算改成 200，其他不变。', state: first.state });
  assert.deepEqual(second.state.conditions.filter(c => c.field !== 'budget'), first.state.conditions.filter(c => c.field !== 'budget'));
  assert.ok(second.recommendations!.length > 0);
  const compared = await api<Reply>('/chat', { message: 'Redmi Buds 6 和 OPPO Enco Air4 有什么区别？', state: second.state });
  assert.deepEqual(compared.compareIds, ['redmi-buds-6', 'oppo-enco-air4']);
  assert.match(compared.reply, /¥199/);
  assert.match(compared.reply, /¥169/);
  const question = await api<Reply>('/chat', { message: '那它的续航怎么样？', state: second.state,
    history: [{ role: 'assistant', text: compared.reply, productRefs: compared.compareIds }] });
  assert.match(question.reply, /你是指/);
});
