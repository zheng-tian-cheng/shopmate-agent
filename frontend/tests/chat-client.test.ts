// 前端聊天客户端：请求内容、失败与重试、结果应用到最新状态。服务端用 fetch 替身，不调用 Gemini。
import './reference/catalog.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialSession } from '../lib/session.ts';
import type { ChatResult, ShopAction, ShopSession } from '../lib/session.ts';
import { createSessionController } from '../lib/session-controller.ts';

const reply = (body: Record<string, any>, extra: Partial<ChatResult> = {}): ChatResult => ({
  reply: '可以，先看看预算和佩戴方式。', state: body.state, applied: [], rejected: [],
  recommendations: null, matchCount: null, productRefs: [], compareIds: null, tools: [], ...extra,
});

function withFetch(handler: (body: Record<string, any>) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  const requests: Record<string, any>[] = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/api/chat'), `unexpected request ${url}`);
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return handler(body);
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

test('自由输入调用 /chat：带发送时的浏览商品；失败时条件不变，可重试，失败轮次不进入历史', async () => {
  let fail = true;
  const server = withFetch(body => fail
    ? Response.json({ error: { message: '免费额度已耗尽', code: 'QUOTA_EXHAUSTED', retryable: true } }, { status: 429 })
    : Response.json(reply(body)));
  try {
    let s = await reduce(initialSession(), { type: 'viewPage', productId: 'redmi-buds-6' });
    s = await reduce(s, { type: 'sendText', text: '我想给家人挑一副耳机，不知道先看什么' });
    const before = s.assistant.state;
    s = await reduce(s, { type: 'viewPage', productId: 'oppo-enco-air4' });
    s = await reduce(s, { type: 'textResolved', requestId: s.assistant.pendingRequest!.id });
    assert.equal(server.requests[0].viewedProductId, 'redmi-buds-6');
    assert.deepEqual(s.assistant.state, before);
    assert.equal(s.assistant.status, 'error');
    assert.match(s.assistant.messages.at(-1)!.text, /额度/);
    assert.equal(s.assistant.messages.at(-1)!.failed, true);

    fail = false;
    s = await reduce(s, { type: 'retry' });
    s = await reduce(s, { type: 'textResolved', requestId: s.assistant.pendingRequest!.id });
    assert.equal(s.assistant.status, 'idle');
    assert.equal(s.assistant.messages.at(-1)!.demo, false);
    const history = server.requests[1].history as { role: string; text: string; viewedProductId: string | null }[];
    assert.ok(!history.some(m => m.text.includes('额度')), '失败回复不发给模型');
    assert.ok(!history.some(m => m.role === 'user' && m.text.includes('家人')), '失败的那次提问不重复出现在历史里');
    assert.equal(server.requests[1].message, '我想给家人挑一副耳机，不知道先看什么');
    assert.equal(server.requests[1].viewedProductId, 'oppo-enco-air4', '重试按重试时正在看的商品发送');
  } finally { server.restore(); }
});

test('聊天结果：有要求没有处理时，详情用普通话说明，摘要显示数量，不出现技术原因', async () => {
  const budget = { field: 'budget', status: 'confirmed', kind: 'soft', source: 'user', value: 600 };
  const server = withFetch(body => Response.json(reply(body, {
    state: { ...body.state, category: 'headphones', conditions: [budget] },
    reply: '先按¥600左右找了几款。“酷炫”暂时没法用来筛选，你更在意外观还是听感？',
    applied: [{ op: 'set', field: 'budget', kind: 'soft', value: 600 }],
    rejected: [{ change: { op: 'set', field: 'scene', kind: 'soft', value: '酷炫动感' } as never, reason: '条件类别与字段不匹配', code: 'invalid' }],
  })));
  try {
    let s = await reduce(initialSession(), { type: 'sendText', text: '想要一副600元左右的酷炫动感映月耳机' });
    s = await reduce(s, { type: 'textResolved', requestId: s.assistant.pendingRequest!.id });
    const message = s.assistant.messages.at(-1)!;
    assert.equal(message.unhandled, 1);
    assert.ok(message.details!.includes('「酷炫动感」没有记下。'));
    assert.ok(![message.text, ...message.details!].some(t => /条件类别|字段|Schema|update_conditions/.test(t)));
    assert.deepEqual(s.assistant.state.conditions, [budget]);
  } finally { server.restore(); }
});

test('聊天结果：推荐理由按已生效条件生成，变更写入详情，比较放入对比栏；历史带每条消息当时的商品', async () => {
  const server = withFetch(body => {
    if (body.message === '300 以内') {
      const state = { ...body.state, category: 'headphones', conditions: [{ field: 'budget', status: 'confirmed', kind: 'hard', source: 'user', value: 300 }] };
      return Response.json(reply(body, { state, reply: '先看看这两款。', applied: [{ op: 'set', field: 'budget', kind: 'hard', value: 300 }],
        recommendations: [{ productId: 'redmi-buds-6', softMatched: [] }, { productId: 'oppo-enco-air4', softMatched: [] }], matchCount: 9,
        productRefs: ['redmi-buds-6', 'oppo-enco-air4'] }));
    }
    return Response.json(reply(body, { reply: '两款放在下面对比了。', compareIds: ['redmi-buds-6', 'oppo-enco-air4'], productRefs: ['redmi-buds-6', 'oppo-enco-air4'] }));
  });
  try {
    let s = await reduce(initialSession(), { type: 'viewPage', productId: 'huawei-freebuds-6i' });
    s = await reduce(s, { type: 'sendText', text: '300 以内' });
    s = await reduce(s, { type: 'textResolved', requestId: s.assistant.pendingRequest!.id });
    const answer = s.assistant.messages.at(-1)!;
    assert.deepEqual(answer.recommendations, [
      { productId: 'redmi-buds-6', reasons: ['预算 ≤ ¥300'] }, { productId: 'oppo-enco-air4', reasons: ['预算 ≤ ¥300'] },
    ]);
    assert.equal(answer.matchCount, 9);
    assert.ok(answer.details!.some(d => d.startsWith('已设置：预算 ≤ ¥300')));
    assert.ok(answer.details!.includes('按已生效的条件，商品库中有 9 款符合。'));

    s = await reduce(s, { type: 'viewPage', productId: 'sony-wh-ch720n' });
    s = await reduce(s, { type: 'sendText', text: '这两款有什么区别' });
    s = await reduce(s, { type: 'textResolved', requestId: s.assistant.pendingRequest!.id });
    assert.deepEqual(s.compareIds, ['redmi-buds-6', 'oppo-enco-air4']);
    const history = server.requests[1].history as { role: string; text: string; productRefs: string[]; viewedProductId: string | null }[];
    assert.deepEqual(history.find(m => m.text === '300 以内')!.viewedProductId, 'huawei-freebuds-6i', '历史消息保留发送时的商品');
    assert.deepEqual(history.find(m => m.text === '先看看这两款。')!.productRefs, ['redmi-buds-6', 'oppo-enco-air4']);
    assert.equal(server.requests[1].viewedProductId, 'sony-wh-ch720n');
  } finally { server.restore(); }
});

// 可手动完成的聊天请求：模拟 Gemini 需要等待几秒
function deferredRequest() {
  const calls: { session: ShopSession; finish: (action: ShopAction) => void }[] = [];
  const request = (session: ShopSession) => new Promise<ShopAction>(resolve => { calls.push({ session, finish: resolve }); });
  return { calls, request };
}
const resolvedWith = (session: ShopSession, text: string): ShopAction => ({
  type: 'chatResolved', requestId: session.assistant.pendingRequest!.id,
  result: { reply: text, state: session.assistant.state, applied: [], rejected: [], recommendations: null, matchCount: null, productRefs: [], compareIds: null, tools: [] },
});

test('等待回复期间可以浏览、关闭面板、调整列表筛选；回复到达后不覆盖这些操作', async () => {
  let state = initialSession();
  const { calls, request } = deferredRequest();
  const controller = createSessionController(s => { state = s; }, () => {}, reduce, request);
  await controller.dispatch({ type: 'openAssistant', entry: 'home' });
  await controller.dispatch({ type: 'sendText', text: '想买耳机' });
  const requestId = state.assistant.pendingRequest!.id;
  const pending = controller.dispatch({ type: 'textResolved', requestId });
  void controller.dispatch({ type: 'textResolved', requestId }); // 重复触发不会重复请求
  await controller.dispatch({ type: 'closeAssistant' });
  await controller.dispatch({ type: 'viewPage', productId: 'oppo-enco-air4' });
  await controller.dispatch({ type: 'setPageFilters', filters: { budgetMax: 200, ancRequired: false, excludeInEar: false } });
  assert.equal(calls.length, 1);
  calls[0].finish(resolvedWith(calls[0].session, '想先看预算还是降噪？'));
  await pending;
  assert.equal(state.assistant.messages.at(-1)!.text, '想先看预算还是降噪？');
  assert.equal(state.assistant.open, false);
  assert.equal(state.viewedProductId, 'oppo-enco-air4');
  assert.equal(state.pageFilters.budgetMax, 200);
  assert.equal(state.assistant.status, 'idle');
});

test('等待期间修改条件或切换品类：旧请求作废，迟到的回复不会覆盖新条件', async () => {
  let state = initialSession();
  const { calls, request } = deferredRequest();
  const controller = createSessionController(s => { state = s; }, () => {}, reduce, request);
  await controller.dispatch({ type: 'sendText', text: '想买耳机' });
  const pending = controller.dispatch({ type: 'textResolved', requestId: state.assistant.pendingRequest!.id });
  await controller.dispatch({ type: 'selectCategory', category: 'headphones' });
  assert.equal(calls.length, 1);
  calls[0].finish(resolvedWith(calls[0].session, '过期回复')); // 发送时的条件里品类还是空的
  await pending;
  assert.ok(!state.assistant.messages.some(m => m.text === '过期回复'));
  assert.equal(state.assistant.state.category, 'headphones');
  assert.equal(state.assistant.pendingRequest, null);
});
