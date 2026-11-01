import './reference/mock-api.ts';
import { CATALOG_FILE, REAL_PRODUCTS } from './reference/catalog.ts';
// 正式商品数据（data/products.json）的校验：每个已填写的字段都要有可核查的来源，且数值能在来源说明中找到；
// 未核实的字段保持为空（界面显示“未知”），展示数据中不得混入虚构商品。图片许可另见 image-licenses.test.ts。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, emptyState, WEARING_STYLES } from './reference/conditions.ts';
import { compareProducts } from '../lib/compare.ts';
import type { RawProduct, SourcedField } from '../lib/products.ts';
import { batteryLabel, catalog, getProduct, priceLabel, weightLabel } from '../lib/products.ts';
import { searchProducts } from './reference/search.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const { sources, products, reserve } = CATALOG_FILE;
const ALL: RawProduct[] = [...products, ...reserve];

// 有值即必须有来源的字段
const FIELD_VALUES: [SourcedField, (p: RawProduct) => boolean][] = [
  ['price', p => p.priceCny !== null],
  ['anc', p => p.anc !== null],
  ['ancSpec', p => p.ancSpec !== null],
  ['wearingStyle', p => p.wearingStyle !== null],
  ['battery', p => p.battery.length > 0],
  ['weight', p => p.weight.length > 0],
  ['bluetooth', p => p.bluetooth !== null],
];

const supportsOf = (p: RawProduct, field: SourcedField) => (p.fieldSources[field] ?? []).map(id => sources[id]?.supports ?? '').join('\n');
const budgetState = (amount: number) => applyChanges(emptyState(), [{ op: 'set', field: 'budget', kind: 'hard', value: amount }], 'ui').state;

test('数据文件结构：版本、更新时间，商品 ID 唯一且不是虚构商品，展示与保留列表不重叠', async () => {
  assert.equal(CATALOG_FILE.schemaVersion, 2);
  assert.match(CATALOG_FILE.updatedAt, ISO_DATE);
  const ids = ALL.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, '商品 ID 重复（包括保留列表）');
  for (const p of ALL) {
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${p.id} 格式`);
    assert.ok(!p.id.startsWith('mock-'), `${p.id} 不能是虚构商品`);
    assert.ok(p.brand.trim() && p.model.trim() && p.displayName.trim(), `${p.id} 缺少品牌或型号`);
    assert.doesNotMatch(p.displayName, /候选/, `${p.id} 使用了虚构名称`);
  }
  const models = ALL.map(p => `${p.brand}|${p.model}`);
  assert.equal(new Set(models).size, models.length, '同一型号出现了多条记录');
});

test('来源格式：链接、类型、日期和支持字段说明齐全，且每条来源都被引用', async () => {
  const used = new Set(ALL.flatMap(p => Object.values(p.fieldSources).flat()));
  for (const [id, s] of Object.entries(sources)) {
    assert.match(s.url, /^https:\/\//, `${id} 链接`);
    assert.ok(['official', 'media'].includes(s.kind), `${id} 类型`);
    assert.match(s.accessedAt, ISO_DATE, `${id} 访问日期`);
    assert.ok(s.publishedAt === null || ISO_DATE.test(s.publishedAt), `${id} 发布日期`);
    assert.ok(s.publisher.trim() && s.supports.trim(), `${id} 发布方或支持字段说明`);
    assert.ok(used.has(id), `${id} 没有被任何字段引用`);
  }
});

test('每个已填写的字段都有存在的来源；未核实的字段为空', async () => {
  for (const p of ALL) {
    for (const [field, hasValue] of FIELD_VALUES) {
      const refs = p.fieldSources[field] ?? [];
      refs.forEach(ref => assert.ok(sources[ref], `${p.id}.${field} 引用了不存在的来源 ${ref}`));
      if (hasValue(p)) assert.ok(refs.length > 0, `${p.id}.${field} 有值但没有来源`);
      else assert.equal(refs.length, 0, `${p.id}.${field} 为空却登记了来源`);
    }
    if (p.wearingStyle !== null) assert.ok(WEARING_STYLES.includes(p.wearingStyle), `${p.id} 佩戴方式`);
    assert.ok(p.anc === null || typeof p.anc === 'boolean', `${p.id} 主动降噪`);
    if (p.anc === false) assert.equal(p.ancSpec, null, `${p.id} 不支持主动降噪却有降噪深度`);
  }
});

test('数值与来源对得上：价格、降噪深度、续航、重量、蓝牙版本都能在来源说明中找到', async () => {
  for (const p of ALL) {
    if (p.priceCny !== null) {
      assert.ok(supportsOf(p, 'price').includes(String(p.priceCny)), `${p.id} 价格 ${p.priceCny} 在来源中找不到`);
      assert.ok(p.priceType && p.priceConditions.includes(p.priceType), `${p.id} 价格说明要写明来源口径“${p.priceType}”`);
      assert.ok(p.priceConditions.includes(String(p.priceCny)), `${p.id} 价格说明与价格不一致`);
      assert.match(p.priceVerifiedAt ?? '', ISO_DATE, `${p.id} 价格核验日期`);
    }
    const db = p.ancSpec?.match(/(\d+)dB/)?.[1];
    if (p.ancSpec !== null) assert.ok(db && supportsOf(p, 'ancSpec').includes(`${db}dB`), `${p.id} 降噪深度在来源中找不到`);
    for (const e of p.battery) {
      assert.ok(e.hours > 0 && supportsOf(p, 'battery').includes(String(e.hours)), `${p.id} 续航 ${e.hours} 小时在来源中找不到`);
    }
    for (const e of p.weight) {
      assert.ok(e.grams > 0 && supportsOf(p, 'weight').includes(String(e.grams)), `${p.id} 重量 ${e.grams} 在来源中找不到`);
    }
    if (p.bluetooth !== null) assert.ok(supportsOf(p, 'bluetooth').includes(p.bluetooth), `${p.id} 蓝牙版本在来源中找不到`);
  }
});

test('续航和重量的口径写清楚：同一口径不重复，界面文案带上口径', async () => {
  for (const p of ALL) {
    const keys = p.battery.map(e => `${e.scope}|${e.anc}`);
    assert.equal(new Set(keys).size, keys.length, `${p.id} 续航口径重复`);
    assert.equal(new Set(p.weight.map(e => e.scope)).size, p.weight.length, `${p.id} 重量口径重复`);
  }
  const freebuds = getProduct('huawei-freebuds-6i')!;
  assert.equal(batteryLabel(freebuds), '单次：降噪关 8 小时 / 降噪开 5 小时；含充电盒：降噪关 35 小时 / 降噪开 20 小时');
  assert.equal(weightLabel(freebuds), '单耳 5.4 g（约）');
  assert.match(weightLabel(getProduct('sony-wf-c510')!), /未注明单耳或整机/);
  assert.match(weightLabel(getProduct('sony-wh-ch720n')!), /^整机 192 g/);
  assert.equal(batteryLabel(getProduct('redmi-buds-6-pro')!), '暂未收录');
});

test('官方产品资料链接：有则必须是 https 链接；没有核对过的为空', async () => {
  for (const p of ALL) {
    if (p.officialLink === null) continue;
    assert.match(p.officialLink.url, /^https:\/\//, `${p.id} 官方链接`);
    assert.ok(p.officialLink.label.trim(), `${p.id} 官方链接说明`);
  }
});

test('本期展示 15 款，价位分布为 150–199 元 4 款、200–299 元 5 款、300–500 元 4 款、500 元以上 2 款', async () => {
  assert.equal(products.length, 15);
  const prices = products.map(p => p.priceCny);
  assert.ok(prices.every(p => p !== null), '展示商品都有价格');
  const count = (lo: number, hi: number) => prices.filter(p => p! >= lo && p! <= hi).length;
  assert.deepEqual([count(150, 199), count(200, 299), count(300, 500), count(501, Infinity)], [4, 5, 4, 2]);
  assert.ok(reserve.every(p => !products.some(q => q.id === p.id)), '保留列表的型号不展示');
});

test('品牌和佩戴方式有多样性', async () => {
  assert.ok(new Set(products.map(p => p.brand)).size >= 8, '至少 8 个品牌');
  const styles = new Set(products.map(p => p.wearingStyle));
  for (const s of ['入耳式', '半入耳式', '头戴式'] as const) assert.ok(styles.has(s), `缺少${s}`);
});

test('正式展示只使用真实商品，且所有页面读取同一份数据；保留列表不进入检索', async () => {
  assert.equal(catalog(), REAL_PRODUCTS);
  assert.equal(REAL_PRODUCTS.length, products.length);
  assert.ok(REAL_PRODUCTS.every(p => !p.isMock));
  for (const r of reserve) assert.equal(getProduct(r.id), undefined, `${r.id} 不应出现在商品列表`);
  for (const p of REAL_PRODUCTS) {
    assert.equal(getProduct(p.id), p, '详情页和推荐卡片取到的是同一条记录');
    const raw = products.find(r => r.id === p.id)!;
    assert.equal(p.price.amount, raw.priceCny);
    assert.equal(compareProducts(p, p)[0].values[0].startsWith(priceLabel(p)), true, '比较表与列表价格一致');
  }
});

test('同系列相似型号是不同记录，价格和参数来源不混用（规则八）', async () => {
  const groups = [['redmi-buds-6', 'redmi-buds-6s', 'redmi-buds-6-pro'], ['oppo-enco-air4', 'oppo-enco-air4-pro']];
  for (const ids of groups) {
    const raws = ids.map(id => products.find(p => p.id === id));
    assert.ok(raws.every(Boolean), `${ids.join('/')} 都应展示`);
    for (const field of ['price', 'battery'] as const) {
      const refs = raws.map(r => JSON.stringify(r!.fieldSources[field] ?? []));
      const filled = refs.filter(r => r !== '[]');
      assert.equal(new Set(filled).size, filled.length, `${ids.join('/')} 的${field}来源不能共用`);
    }
  }
  assert.notEqual(getProduct('redmi-buds-6')!.price.amount, getProduct('redmi-buds-6-pro')!.price.amount);
  assert.notEqual(getProduct('oppo-enco-air4')!.price.amount, getProduct('oppo-enco-air4-pro')!.price.amount);
});

test('预算上限 200 / 300 / 400 / 500：只返回有价格且不超预算的商品，边界价格算满足', async () => {
  const expected: Record<number, number> = { 200: 4, 300: 9, 400: 11, 500: 13 };
  for (const [amount, total] of Object.entries(expected).map(([a, t]) => [Number(a), t])) {
    const matches = searchProducts(REAL_PRODUCTS, budgetState(amount));
    assert.equal(matches.length, total, `预算 ${amount} 元`);
    assert.ok(matches.every(m => m.product.price.amount !== null && m.product.price.amount <= amount), `预算 ${amount} 元出现超预算商品`);
  }
  assert.ok(searchProducts(REAL_PRODUCTS, budgetState(299)).some(m => m.product.price.amount === 299), '299 元在 299 元预算内');
});

test('业务规则在真实数据上成立：未知不算满足', async () => {
  const noInEar = applyChanges(emptyState(), [{ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } }], 'ui').state;
  const ids = searchProducts(REAL_PRODUCTS, noInEar).map(m => m.product.id).sort();
  assert.deepEqual(ids, ['edifier-w800bt-free-anc', 'redmi-buds-6s', 'sony-wh-ch720n'], '佩戴方式未知的商品不能算作“不是入耳式”');
  const ancHard = applyChanges(emptyState(), [{ op: 'set', field: 'anc', kind: 'hard', value: true }], 'ui').state;
  const ancIds = searchProducts(REAL_PRODUCTS, ancHard).map(m => m.product.id);
  for (const id of ['huawei-freebuds-se-3', 'qcy-melobuds-a30', 'sony-wf-c510']) assert.ok(!ancIds.includes(id), `${id} 不能算作支持主动降噪`);
  assert.equal(ancIds.length, 12);
});
