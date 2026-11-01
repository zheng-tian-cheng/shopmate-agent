// 商品数据核验报告：逐款列出关键字段是否已核实及来源类型，并汇总价位分布和图片状态。用法：npm run data:report
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../../data/products.json', import.meta.url), 'utf8'));
const FIELDS = [
  ['价格', p => p.priceCny, 'price'],
  ['主动降噪', p => p.anc, 'anc'],
  ['降噪深度', p => p.ancSpec, 'ancSpec'],
  ['佩戴方式', p => p.wearingStyle, 'wearingStyle'],
  ['续航', p => (p.battery.length ? p.battery : null), 'battery'],
  ['重量', p => (p.weight.length ? p.weight : null), 'weight'],
  ['蓝牙', p => p.bluetooth, 'bluetooth'],
  ['官方资料链接', p => p.officialLink, null],
];

const kindLabel = ids => [...new Set((ids ?? []).map(id => (data.sources[id]?.kind === 'official' ? '官方' : '媒体')))].join('+');
const row = p => [p.displayName, `¥${p.priceCny ?? '?'}（${p.priceType ?? '未注明'}）`, ...FIELDS.slice(1).map(([, read, key]) => {
  const value = read(p);
  if (value === null) return '未知';
  return key ? `✓(${kindLabel(p.fieldSources[key])})` : '✓';
})].join(' | ');

console.log(`商品数据 ${data.updatedAt} · 展示 ${data.products.length} 款 · 保留 ${data.reserve.length} 款 · ${Object.keys(data.sources).length} 条来源\n`);
console.log(['商品', ...FIELDS.map(([label]) => label)].join(' | '));
data.products.forEach(p => console.log(row(p)));

const bands = [['150–199 元', 150, 199], ['200–299 元', 200, 299], ['300–500 元', 300, 500], ['500 元以上', 501, Infinity]];
console.log(`\n价位分布：${bands.map(([label, lo, hi]) => `${label} ${data.products.filter(p => p.priceCny >= lo && p.priceCny <= hi).length} 款`).join('，')}`);
const core = FIELDS.filter(([label]) => ['主动降噪', '佩戴方式', '续航', '重量'].includes(label));
const complete = data.products.filter(p => core.every(([, read]) => read(p) !== null));
console.log(`降噪、佩戴方式、续航、重量 4 项都已核实：${complete.length} 款；其余缺口见上表“未知”。`);
console.log(`\n已核验、本期不展示：${data.reserve.map(p => `${p.displayName}（¥${p.priceCny}）`).join('、')}`);

// 图片许可单独核验
const imageFile = JSON.parse(readFileSync(new URL('../../data/product-images.json', import.meta.url), 'utf8'));
const STATUS = { licensed: '准确型号照片', demo: '商品示意图', 'reference-only': '仅本地参考（未授权）', missing: '缺失（占位图）' };
console.log('\n商品图片');
for (const p of data.products) {
  const e = imageFile.images[p.id];
  const demo = e?.status === 'demo' ? imageFile.demoImages[e.demo] : null;
  const credit = demo ? ` | ${demo.depicts} · ${demo.license} · ${demo.author}` : e?.license ? ` | ${e.license} · ${e.author}` : '';
  console.log(`${p.displayName} | ${STATUS[e?.status] ?? '未登记'}${credit}`);
}
const counts = data.products.reduce((acc, p) => { const s = imageFile.images[p.id]?.status; return { ...acc, [s]: (acc[s] ?? 0) + 1 }; }, {});
console.log(Object.entries(STATUS).map(([k, label]) => `${label} ${counts[k] ?? 0} 款`).join(' · '));
