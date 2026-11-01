import './reference/mock-api.ts';
// 商城搜索的品类判断与耳机搜索词拆解（前端优化 P1-B）。规则实现，不代表 AI 品类识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySearch, matchesHeadphoneQuery, parseHeadphoneQuery, sortByQuery } from './reference/search-intent.ts';
import { REAL_PRODUCTS } from './reference/catalog.ts';


const kind = (q: string) => classifySearch(q, REAL_PRODUCTS).kind;
const results = (q: string) => sortByQuery(REAL_PRODUCTS.filter(p => matchesHeadphoneQuery(p, parseHeadphoneQuery(q))).map(product => ({ product })), parseHeadphoneQuery(q)).map(m => m.product.id);

test('耳机相关搜索进入耳机流程；型号名也算耳机搜索', async () => {
  for (const q of ['降噪耳机', '300 元左右的降噪耳机', '头戴式耳机', '半入耳', 'FreeBuds 6i', 'Redmi Buds 6 Pro']) assert.equal(kind(q), 'headphones', q);
});

test('未开放品类不进入耳机列表，给出品类名', async () => {
  assert.deepEqual(classifySearch('沙发', REAL_PRODUCTS), { kind: 'unavailable', category: 'sofa', label: '家居沙发', query: '沙发' });
  assert.equal(kind('咖啡机'), 'unavailable');
  assert.equal(kind('露营装备'), 'unavailable');
});

test('没有品类线索的模糊需求不默认当作耳机；品牌名单独出现也先引导', async () => {
  for (const q of ['推荐一下', '预算 300', '华为', '送女朋友的礼物']) assert.equal(kind(q), 'unclear', q);
  assert.equal(kind('   '), 'empty');
});

test('耳机搜索词拆成条件：降噪、佩戴方式、预算上限或参考预算，型号里的数字不当预算', async () => {
  assert.deepEqual(parseHeadphoneQuery('300 元左右的降噪耳机'), { anc: true, wearing: null, budgetMax: null, budgetNear: 300, terms: [] });
  assert.deepEqual(parseHeadphoneQuery('200元以内 头戴式'), { anc: false, wearing: '头戴式', budgetMax: 200, budgetNear: null, terms: [] });
  assert.deepEqual(parseHeadphoneQuery('Redmi Buds 6 Pro'), { anc: false, wearing: null, budgetMax: null, budgetNear: null, terms: ['redmi', 'buds', '6', 'pro'] });
  assert.equal(parseHeadphoneQuery('半入耳耳机').wearing, '半入耳式');
});

test('搜索结果：佩戴方式或降噪未收录不算满足；“左右”按接近程度排序、不排除商品；无匹配时为空', async () => {
  assert.deepEqual(results('头戴式耳机').sort(), ['edifier-w800bt-free-anc', 'sony-wh-ch720n']);
  assert.deepEqual(results('半入耳'), ['redmi-buds-6s']);
  const near = results('300 元左右的降噪耳机');
  assert.equal(near.length, 12, '所有支持主动降噪的商品都在结果里');
  assert.deepEqual(near.slice(0, 2).sort(), ['honor-earbuds-x9', 'oppo-enco-air4-pro'], '299 元的两款最接近 300 元');
  assert.ok(!near.includes('qcy-melobuds-a30') && !near.includes('huawei-freebuds-se-3'));
  assert.ok(results('200 元以内 降噪').every(id => REAL_PRODUCTS.find(p => p.id === id)!.price.amount! <= 200));
  assert.deepEqual(results('索尼 降噪'), ['sony-wh-ch720n']);
  assert.deepEqual(results('不存在的型号 xyz'), []);
});
