import './reference/mock-api.ts';
// 模拟购物会话：用 reducer 逐步走完整条模拟流程（第 1 阶段只验收模拟交互，不代表 LLM/RAG 能力）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeValue, getCondition, validateState } from './reference/conditions.ts';
import { projectToPageFilters } from './reference/page-sync.ts';
import { MOCK_PRODUCTS } from '../lib/mock-products.ts';
import { getProduct, setCatalogForTesting } from '../lib/products.ts';
import { quickOptions } from '../lib/quick-options.ts';
import { evaluateProduct, searchProducts } from './reference/search.ts';
import type { ShopAction, ShopSession } from '../lib/session.ts';
import { initialSession, reduce } from '../lib/session.ts';

// 这些用例针对业务规则，使用固定的虚构测试商品，不依赖真实商品数据
setCatalogForTesting(MOCK_PRODUCTS);

async function play(session: ShopSession, ...actions: ShopAction[]): Promise<ShopSession> {
  for (const action of actions) {
    session = (await reduce(session, action));
    assert.deepEqual(validateState(session.assistant.state), []);
  }
  return session;
}

// 发送文字并立即完成模拟请求
async function send(session: ShopSession, text: string): Promise<ShopSession> {
  const sent = (await play(session, { type: 'sendText', text }));
  return (await play(sent, { type: 'textResolved', requestId: sent.assistant.pendingRequest!.id }));
}

const lastMessage = (s: ShopSession) => s.assistant.messages.at(-1)!.text;
const resultIds = (s: ShopSession) => searchProducts(MOCK_PRODUCTS, s.assistant.state).map(m => m.product.id);

test('场景 A：从列表打开助手，继承列表筛选，来源标记为商品列表', async () => {
  const s = (await play(initialSession(),
    { type: 'setPageFilters', filters: { budgetMax: 300, ancRequired: false, excludeInEar: false } },
    { type: 'openAssistant', entry: 'list' }));
  assert.equal(s.assistant.open, true);
  assert.equal(getCondition(s.assistant.state, 'budget')?.source, 'page');
  assert.match(lastMessage(s), /已沿用商品列表的筛选条件：预算 ≤ ¥300/);
});

test('场景 C（P0）：关闭后列表条件变化，重新打开不覆盖助手条件', async () => {
  let s = (await play(initialSession(),
    { type: 'setPageFilters', filters: { budgetMax: 300, ancRequired: false, excludeInEar: false } },
    { type: 'openAssistant', entry: 'list' },
    { type: 'closeAssistant' },
    { type: 'setPageFilters', filters: { budgetMax: 150, ancRequired: true, excludeInEar: false } },
    { type: 'openAssistant', entry: 'list' }));
  assert.equal(activeValue(s.assistant.state, 'budget'), 300);
  assert.equal(getCondition(s.assistant.state, 'anc'), undefined);
  s = (await play(s, { type: 'closeAssistant' }));
  assert.equal(s.assistant.open, false);
  assert.equal(activeValue(s.assistant.state, 'budget'), 300);
});

test('从详情页打开：记录当前商品，不继承列表筛选', async () => {
  const s = (await play(initialSession(),
    { type: 'setPageFilters', filters: { budgetMax: 300, ancRequired: true, excludeInEar: false } },
    { type: 'openAssistant', entry: 'detail', productId: 'mock-01' }));
  assert.equal(s.viewedProductId, 'mock-01');
  assert.deepEqual(s.assistant.state.conditions, []);
  assert.match(lastMessage(s), /候选 A · 静听/);
});

test('文字输入经过模拟等待；迟到的旧结果被忽略', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }, { type: 'sendText', text: '300 元以内，地铁通勤，需要主动降噪' }));
  assert.equal(s.assistant.status, 'loading');
  const staleId = s.assistant.pendingRequest!.id;
  assert.deepEqual((await play(s, { type: 'sendText', text: '再发一句' })), s, '等待中不能重复提交');
  s = (await play(s, { type: 'uiChanges', label: '200 元以内', changes: quickOptions(s.assistant.state)[0].changes }));
  assert.equal(s.assistant.pendingRequest, null);
  assert.ok(s.assistant.messages.some(m => m.text.includes('已作废')));
  const after = (await play(s, { type: 'textResolved', requestId: staleId }));
  assert.deepEqual(after, s);
  assert.equal(activeValue(after.assistant.state, 'budget'), 200);
  assert.equal(getCondition(after.assistant.state, 'anc'), undefined);
});

test('开始新选购：作废等待中的请求，清空助手条件，不改动列表筛选', async () => {
  const filters = { budgetMax: 260, ancRequired: false, excludeInEar: false };
  let s = (await play(initialSession(), { type: 'setPageFilters', filters }, { type: 'openAssistant', entry: 'list' }));
  s = (await send(s, '不要入耳式，其他不变'));
  s = (await play(s, { type: 'sendText', text: '取消主动降噪要求' }));
  const staleId = s.assistant.pendingRequest!.id;
  s = (await play(s, { type: 'reset' }));
  assert.equal(s.assistant.pendingRequest, null);
  assert.deepEqual(s.pageFilters, filters);
  assert.deepEqual(s.assistant.state.conditions.map(c => [c.field, c.source]), [['budget', 'page']]);
  assert.match(s.assistant.messages[0].text, /已开始新的选购/);
  assert.deepEqual((await play(s, { type: 'textResolved', requestId: staleId })), s);
});

test('模拟请求失败：条件不变，可以重试', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }, { type: 'toggleFailNext' }));
  s = (await send(s, '300 元以内，地铁通勤，需要主动降噪'));
  assert.equal(s.assistant.status, 'error');
  assert.deepEqual(s.assistant.state.conditions, []);
  assert.equal(s.assistant.failNext, false);
  const retried = (await play(s, { type: 'retry' }));
  s = (await play(retried, { type: 'textResolved', requestId: retried.assistant.pendingRequest!.id }));
  assert.equal(s.assistant.status, 'idle');
  assert.equal(activeValue(s.assistant.state, 'budget'), 300);
});

test('不在固定话术内的输入和不支持的品类：条件不变，并如实说明', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '帮我挑一副适合跑步的'));
  assert.ok(lastMessage(s).length > 0); // Unit transport is a frozen demo fixture; real NLU tested separately.
  s = (await send(s, '我想买沙发'));
  assert.match(lastMessage(s), /只支持蓝牙耳机/);
  assert.deepEqual(s.assistant.state.conditions, []);
});

test('聊天接口回复不再标记为固定话术模拟回复', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '地铁通勤用，300 以内'));
  assert.ok(s.assistant.messages.filter(m => m.role === 'assistant').every(m => !m.demo));
  assert.ok(s.assistant.messages.filter(m => m.role === 'user').every(m => !m.demo));
});

test('找相似款：只提出建议，不覆盖用户已设置的条件', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' },
    { type: 'uiChanges', label: '300 元以内', changes: [{ op: 'set', field: 'budget', kind: 'hard', value: 300 }] },
    { type: 'findSimilar', productId: 'mock-01' }));
  assert.equal(s.viewedProductId, 'mock-01');
  assert.equal(getCondition(s.assistant.state, 'anc')?.status, 'suggested');
  assert.equal(activeValue(s.assistant.state, 'budget'), 300);
  assert.match(lastMessage(s), /系统建议不覆盖/);
  s = (await play(s, { type: 'uiChanges', label: '不需要', changes: [{ op: 'dismiss', field: 'anc' }] }));
  s = (await play(s, { type: 'findSimilar', productId: 'mock-04' }));
  assert.equal(getCondition(s.assistant.state, 'anc'), undefined, '忽略过的建议不再提出');
});

test('对比栏：最多两款，超出时提示', async () => {
  const s = (await play(initialSession(),
    { type: 'toggleCompare', productId: 'mock-01' },
    { type: 'toggleCompare', productId: 'mock-02' },
    { type: 'toggleCompare', productId: 'mock-03' }));
  assert.deepEqual(s.compareIds, ['mock-01', 'mock-02']);
  assert.ok(s.notice);
  assert.equal((await play(s, { type: 'dismissNotice' })).notice, null);
});

test('完整模拟流程：列表 → 助手 → 确认建议 → 比较 → 改预算 → 应用到列表', async () => {
  // 1. 在列表设置 300 元以内，打开助手，继承预算
  let s = (await play(initialSession(),
    { type: 'setPageFilters', filters: { budgetMax: 300, ancRequired: false, excludeInEar: false } },
    { type: 'openAssistant', entry: 'list' }));

  // 2. 说出通勤场景：降噪只作为建议，不生效
  s = (await send(s, '我每天坐地铁通勤'));
  assert.equal(getCondition(s.assistant.state, 'anc')?.status, 'suggested');
  assert.deepEqual(resultIds(s), ['mock-02', 'mock-06', 'mock-03', 'mock-01']);

  // 3. 用户确认把降噪设为必须条件后才参与筛选
  s = (await play(s, { type: 'uiChanges', label: '采纳建议：必须支持主动降噪', changes: [{ op: 'confirm', field: 'anc', kind: 'hard' }] }));
  assert.deepEqual(resultIds(s), ['mock-02', 'mock-01']);

  // 4. 选两款比较
  s = (await play(s, { type: 'toggleCompare', productId: 'mock-02' }, { type: 'toggleCompare', productId: 'mock-01' }));
  assert.deepEqual(s.compareIds, ['mock-02', 'mock-01']);

  // 5. 预算改为 200，其他条件保留；已在对比中的 259 元商品标记为不再符合
  s = (await send(s, '预算降到 200 元，其他不变'));
  assert.equal(activeValue(s.assistant.state, 'budget'), 200);
  assert.equal(getCondition(s.assistant.state, 'anc')?.status, 'confirmed');
  assert.equal(activeValue(s.assistant.state, 'scene'), '地铁通勤');
  assert.deepEqual(resultIds(s), ['mock-02']);
  assert.equal(evaluateProduct(getProduct('mock-01')!, s.assistant.state).eligible, false);
  assert.match(lastMessage(s), /其他条件不变/);
  assert.ok(s.assistant.messages.at(-1)!.details!.includes('其他条件保持不变。'));

  // 6. 应用到商品列表：硬约束写回，场景无法映射并说明
  s = (await play(s, { type: 'applyToList' }));
  assert.deepEqual(s.pageFilters, { budgetMax: 200, ancRequired: true, excludeInEar: false });
  assert.deepEqual(s.pageFilters, projectToPageFilters(s.assistant.state).filters);
  assert.match(lastMessage(s), /无法应用到列表筛选.*场景：地铁通勤/);
});

test('连续修改与关闭重开完整保留历史消息，只有主动重开选购才清空', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '300 元左右，最好有降噪'));
  const first = structuredClone(s.assistant.messages);
  s = (await send(s, '不要入耳式，其他不变'));
  s = (await send(s, '预算改为 400 元'));
  assert.deepEqual(s.assistant.messages.slice(0, first.length), first);
  const history = structuredClone(s.assistant.messages);
  s = (await play(s, { type: 'closeAssistant' }, { type: 'openAssistant', entry: 'list' }));
  assert.deepEqual(s.assistant.messages, history);
  assert.equal(new Set(history.map(m => m.id)).size, history.length);
  s = (await play(s, { type: 'reset' }));
  assert.ok(s.assistant.messages.every(m => !history.some(old => old.id === m.id)));
});

test('回复是对话式的：技术性的变更记录放进详情，商品数量不作为主要内容', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '300 元以内，地铁通勤，需要主动降噪'));
  const reply = s.assistant.messages.at(-1)!;
  assert.match(reply.text, /记下了：预算 ≤ ¥300、场景：地铁通勤、必须支持主动降噪/);
  assert.match(reply.text, /先看看这几款/);
  assert.doesNotMatch(reply.text, /款符合|已设置|演示商品中有/);
  assert.ok(reply.details!.some(d => d.startsWith('已设置：')));
  assert.ok(reply.details!.some(d => d.includes('商品库中有 2 款符合')));
  assert.equal(reply.matchCount, 2);
  assert.deepEqual(reply.recommendations, [
    { productId: 'mock-02', reasons: ['预算 ≤ ¥300', '必须支持主动降噪'] },
    { productId: 'mock-01', reasons: ['预算 ≤ ¥300', '必须支持主动降噪'] },
  ]);
});

test('每轮推荐保存为快照：条件变化后，之前展示过的推荐仍留在聊天记录中', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '300 元以内，地铁通勤，需要主动降噪'));
  const firstTurn = structuredClone(s.assistant.messages.at(-1)!);
  s = (await send(s, '预算降到 200 元，其他不变'));
  const secondTurn = s.assistant.messages.at(-1)!;
  assert.deepEqual(s.assistant.messages.find(m => m.id === firstTurn.id), firstTurn);
  assert.deepEqual(secondTurn.recommendations!.map(r => r.productId), ['mock-02']);
  assert.match(secondTurn.text, /好的，改为预算 ≤ ¥200。\n其他条件不变。/);
});

test('只新增建议或待确认项时不重复展示推荐；用户采纳后才展示新的推荐', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '我每天坐地铁通勤'));
  const suggestionTurn = s.assistant.messages.at(-1)!;
  assert.match(suggestionTurn.text, /要不要把「必须支持主动降噪」加进条件/);
  assert.equal(suggestionTurn.recommendations, undefined, '只有使用场景时没有参与筛选的条件');
  s = (await play(s, { type: 'uiChanges', label: '设为必须', changes: [{ op: 'confirm', field: 'anc', kind: 'hard' }] }));
  const confirmTurn = s.assistant.messages.at(-1)!;
  assert.match(confirmTurn.text, /「必须支持主动降噪」已作为必须条件加入/);
  assert.equal(confirmTurn.matchCount, 5);
  assert.equal(confirmTurn.recommendations!.length, 3);
});

test('没有符合的商品时如实说明，不放宽条件，也不附推荐', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  s = (await send(s, '300 元以内，地铁通勤，需要主动降噪'));
  s = (await send(s, '预算改为 100 元'));
  const reply = s.assistant.messages.at(-1)!;
  assert.match(reply.text, /暂时没有合适的款式。我不会自动放宽条件/);
  assert.deepEqual(reply.recommendations, []);
  assert.equal(activeValue(s.assistant.state, 'budget'), 100);
});

test('只设置使用场景时不重复给出推荐（场景不参与筛选）', async () => {
  let s = (await play(initialSession(),
    { type: 'setPageFilters', filters: { budgetMax: 300, ancRequired: false, excludeInEar: false } },
    { type: 'openAssistant', entry: 'list' }));
  s = (await send(s, '我每天坐地铁通勤'));
  const reply = s.assistant.messages.at(-1)!;
  assert.equal(reply.recommendations, undefined);
  assert.match(reply.text, /^记下了：场景：地铁通勤。\n地铁环境噪音较大/);
});
