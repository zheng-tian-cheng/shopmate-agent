import './reference/mock-api.ts';
// 当前浏览商品、已确认的购买条件、消息关联的商品三类状态分开保存（前端优化 P0-B）。
// 使用真实商品数据；指代解析是规则实现，不代表大模型的理解能力。
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerProductQuestion, findMentionedProducts, resolveProductReference } from '../lib/product-context.ts';
import { REAL_PRODUCTS } from './reference/catalog.ts';
import { getProduct, priceLabel } from '../lib/products.ts';
import type { ShopAction, ShopSession } from '../lib/session.ts';
import { buildRequestContext, initialSession, reduce } from '../lib/session.ts';

async function play(s: ShopSession, ...actions: ShopAction[]): Promise<ShopSession> { for (const action of actions) s = (await reduce(s, action)); return s; }
// 发送一句话并立即完成模拟请求
async function ask(s: ShopSession, text: string): Promise<ShopSession> {
  const sent = (await reduce(s, { type: 'sendText', text }));
  return (await reduce(sent, { type: 'textResolved', requestId: sent.assistant.pendingRequest!.id }));
}
const last = (s: ShopSession) => s.assistant.messages.at(-1)!;

test('从 Redmi Buds 6 详情页打开：传递准确的商品 ID；从首页打开：不绑定任何商品', async () => {
  const detail = (await play(initialSession(), { type: 'viewPage', productId: 'redmi-buds-6' }, { type: 'openAssistant', entry: 'detail', productId: 'redmi-buds-6' }));
  assert.equal(detail.viewedProductId, 'redmi-buds-6');
  assert.equal(buildRequestContext(detail).viewedProductId, 'redmi-buds-6');
  assert.deepEqual(detail.assistant.messages[0].productRefs, ['redmi-buds-6']);

  const home = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  assert.equal(home.viewedProductId, null);
  assert.equal(buildRequestContext(home).viewedProductId, null);
  assert.equal(home.assistant.messages[0].productRefs, undefined);

  const list = (await play(initialSession(), { type: 'openAssistant', entry: 'list' }));
  assert.equal(buildRequestContext(list).viewedProductId, null, '列表入口也不默认绑定商品');
});

test('切换到 OPPO Enco Air4 Pro：当前浏览商品更新，历史消息、商品关联和已确认条件都不变', async () => {
  let s = (await play(initialSession(), { type: 'viewPage', productId: 'redmi-buds-6' }, { type: 'openAssistant', entry: 'detail', productId: 'redmi-buds-6' },
    { type: 'uiChanges', label: '200 元以内', changes: [{ op: 'set', field: 'budget', kind: 'hard', value: 200 }] }));
  s = (await ask(s, '它的降噪怎么样'));
  assert.deepEqual(last(s).productRefs, ['redmi-buds-6']);
  assert.match(last(s).text, /Redmi Buds 6」：\n主动降噪：支持，最高 49dB 降噪深度/);
  const messagesBefore = s.assistant.messages;
  const conditionsBefore = s.assistant.state;

  s = (await reduce(s, { type: 'viewPage', productId: 'oppo-enco-air4-pro' }));
  assert.equal(s.viewedProductId, 'oppo-enco-air4-pro');
  assert.equal(s.assistant.messages, messagesBefore, '切换商品不改动任何历史消息');
  assert.equal(s.assistant.state, conditionsBefore, '切换商品不清空购买条件');

  s = (await ask(s, '它的降噪怎么样'));
  assert.deepEqual(last(s).productRefs, ['oppo-enco-air4-pro']);
  assert.match(last(s).text, /降噪深度达 49dB/);
  assert.deepEqual(s.assistant.messages.find(m => m.text.includes('Redmi Buds 6」'))!.productRefs, ['redmi-buds-6'], '之前的回答仍关联 Redmi Buds 6');
});

test('用户明确提到另一型号时以明确型号为准，不用当前浏览商品', async () => {
  let s = (await play(initialSession(), { type: 'viewPage', productId: 'redmi-buds-6' }, { type: 'openAssistant', entry: 'detail', productId: 'redmi-buds-6' }));
  s = (await ask(s, 'OPPO Enco Air4 Pro 的续航呢'));
  assert.deepEqual(last(s).productRefs, ['oppo-enco-air4-pro']);
  assert.match(last(s).text, /单次：降噪关 12 小时/);
  assert.equal(s.viewedProductId, 'redmi-buds-6', '提问不改变当前浏览商品');
});

test('型号匹配取最长：“Redmi Buds 6 Pro”不会被识别成 Redmi Buds 6；同时提到两款时请用户确认', async () => {
  assert.deepEqual(findMentionedProducts('Redmi Buds 6 Pro 的价格', REAL_PRODUCTS), ['redmi-buds-6-pro']);
  assert.deepEqual(findMentionedProducts('redmi buds 6s 怎么样', REAL_PRODUCTS), ['redmi-buds-6s']);
  assert.deepEqual(resolveProductReference('Enco Air4 和 Enco Air4 Pro 哪个好', 'redmi-buds-6', REAL_PRODUCTS),
    { kind: 'ambiguous', productIds: ['oppo-enco-air4-pro', 'oppo-enco-air4'] });
  assert.deepEqual(resolveProductReference('推荐一款通勤耳机', 'redmi-buds-6', REAL_PRODUCTS), { kind: 'none' }, '没有指代也没有型号时不强行关联当前商品');
});

test('没有当前浏览商品时，“它”无法确定：请用户澄清，不猜测、不改条件', async () => {
  let s = (await play(initialSession(), { type: 'openAssistant', entry: 'home' }));
  const before = s.assistant.state;
  s = (await ask(s, '它的续航怎么样'));
  assert.match(last(s).text, /是指哪一款/);
  assert.deepEqual(last(s).productRefs, []);
  assert.equal(s.assistant.state, before);
});

test('请求带的是发送时的上下文：等待期间切换商品，回答仍针对发送时正在看的商品', async () => {
  let s = (await play(initialSession(), { type: 'viewPage', productId: 'huawei-freebuds-6i' }, { type: 'openAssistant', entry: 'detail', productId: 'huawei-freebuds-6i' }));
  s = (await reduce(s, { type: 'sendText', text: '它的续航怎么样' }));
  const id = s.assistant.pendingRequest!.id;
  assert.equal(s.assistant.pendingRequest!.context.viewedProductId, 'huawei-freebuds-6i');
  s = (await reduce(s, { type: 'viewPage', productId: 'sony-wh-ch720n' }));
  s = (await reduce(s, { type: 'textResolved', requestId: id }));
  assert.deepEqual(last(s).productRefs, ['huawei-freebuds-6i']);
  assert.match(last(s).text, /含充电盒：降噪关 35 小时/);
});

test('回答只用商品数据：每款商品的价格与数据一致，数据里没有的字段明确说不能确认', async () => {
  for (const p of REAL_PRODUCTS) {
    const answer = answerProductQuestion(`${p.name} 多少钱`, null, REAL_PRODUCTS)!;
    assert.deepEqual(answer.productRefs, [p.id], `${p.name} 被识别成了其他型号`);
    assert.ok(answer.text.includes(`价格：${priceLabel(p)}`), `${p.name} 价格不一致`);
  }
  const pro = answerProductQuestion('它有多重', 'redmi-buds-6-pro', REAL_PRODUCTS)!;
  assert.match(pro.text, /重量：商品数据里没有这一项，我不能确认/);
  const qcy = answerProductQuestion('它的降噪怎么样', 'qcy-melobuds-a30', REAL_PRODUCTS)!;
  assert.match(qcy.text, /主动降噪：商品数据里没有这一项/, 'QCY 的主动降噪未核实，不能说成支持');
  assert.ok(getProduct('qcy-melobuds-a30'));
});

test('固定话术仍按原规则改条件；商品提问不改变任何条件', async () => {
  let s = (await play(initialSession(), { type: 'viewPage', productId: 'redmi-buds-6' }, { type: 'openAssistant', entry: 'detail', productId: 'redmi-buds-6' }));
  s = (await ask(s, '300 元以内，地铁通勤，需要主动降噪'));
  const conditions = s.assistant.state;
  assert.equal(conditions.conditions.length, 3);
  s = (await ask(s, '它的蓝牙版本是多少'));
  assert.equal(s.assistant.state, conditions);
  assert.match(last(s).text, /蓝牙版本：商品数据里没有这一项/);
});
