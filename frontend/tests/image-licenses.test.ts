import './reference/mock-api.ts';
// 商品图片许可（data/product-images.json）的校验，与商品数据核验分开。
// 公开展示只用许可明确的图片：准确型号照片，或按佩戴方式匹配、明确标注的商品示意图；
// 未授权的参考素材只在本地开发模式显示，且不放在会被发布的目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { REAL_PRODUCTS, CATALOG_FILE } from './reference/catalog.ts';
import { IMAGE_FILE, resolveImage } from '../lib/products.ts';
import type { ImageEntry, RawProduct } from '../lib/products.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const entries = IMAGE_FILE.images;
const demos = IMAGE_FILE.demoImages;
const ALL: RawProduct[] = [...CATALOG_FILE.products, ...CATALOG_FILE.reserve];
const LICENSE_FIELDS = ['file', 'alt', 'author', 'license', 'licenseUrl', 'sourceUrl', 'usage'] as const;

test('每款商品（含保留列表）都登记了图片状态，且只有四种状态', async () => {
  assert.deepEqual(Object.keys(entries).sort(), ALL.map(p => p.id).sort());
  for (const [id, e] of Object.entries(entries)) {
    assert.ok(['licensed', 'demo', 'reference-only', 'missing'].includes(e.status), `${id} 状态`);
    assert.match(e.checkedAt, ISO_DATE, `${id} 核验日期`);
  }
});

test('许可明确的图片（准确型号照片和示意图）：作者、许可、许可链接、来源、使用要求齐全，文件存在于公开目录', async () => {
  const sets: [string, Partial<Record<(typeof LICENSE_FIELDS)[number], string>>][] = [
    ...Object.entries(entries).filter(([, e]) => e.status === 'licensed'),
    ...Object.entries(demos),
  ];
  for (const [id, e] of sets) {
    for (const key of LICENSE_FIELDS) assert.ok(e[key]?.trim(), `${id} 缺少 ${key}`);
    assert.match(e.licenseUrl!, /^https:\/\/creativecommons\.org\//, `${id} 许可链接`);
    assert.match(e.sourceUrl!, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/, `${id} 来源`);
    assert.ok(existsSync(new URL(`../public${e.file}`, import.meta.url)), `${id} 图片文件不存在`);
  }
});

test('示意图按佩戴方式匹配：佩戴方式未核实的只能用看不出佩戴方式的充电盒图，且来源提到充电盒', async () => {
  const sources = CATALOG_FILE.sources;
  for (const p of ALL) {
    const e = entries[p.id];
    if (e.status !== 'demo') continue;
    const demo = demos[e.demo ?? ''];
    assert.ok(demo, `${p.id} 引用了不存在的示意图 ${e.demo}`);
    if (p.wearingStyle !== null) {
      assert.equal(demo.depicts, p.wearingStyle, `${p.id} 示意图的佩戴方式与商品不一致`);
    } else {
      assert.equal(demo.depicts, 'tws-case', `${p.id} 佩戴方式未核实，不能用显示佩戴方式的示意图`);
      const text = Object.values(p.fieldSources).flat().map(id => sources[id].supports).join('\n');
      assert.match(text, /充电盒|耳机盒|耳机舱|耳机仓|真无线/, `${p.id} 来源没有提到充电盒或真无线，不能用充电盒示意图`);
    }
    assert.match(demo.alt, /示意图/, `${e.demo} 的替代文本要说明是示意图`);
  }
  // 每款展示商品一张图，不与其他商品重复；登记的示意图都要用上
  const shown = CATALOG_FILE.products.map(p => entries[p.id].demo).filter(Boolean);
  assert.equal(new Set(shown).size, shown.length, '不同商品使用了同一张示意图');
  const used = new Set(Object.values(entries).map(e => e.demo).filter(Boolean));
  assert.deepEqual([...Object.keys(demos)].filter(k => !used.has(k)), [], '有登记但未使用的示意图');
  for (const [id, demo] of Object.entries(demos)) assert.ok(demo.modifications?.trim(), `${id} 要记录对原图做了哪些修改`);
});

test('参考素材只能放在不提交、不发布的目录；缺失的商品不能带图片文件', async () => {
  const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^frontend\/reference-images\/$/m, '参考素材目录必须在 .gitignore 中');
  for (const [id, e] of Object.entries(entries)) {
    if (e.status === 'reference-only') assert.match(e.referenceFile ?? '', /^[a-z0-9-]+\.(jpg|jpeg|png|webp)$/, `${id} 参考文件名`);
    if (e.status === 'missing') assert.ok(!e.file && !e.referenceFile && !e.demo, `${id} 缺失状态不应有图片`);
    if (e.status === 'demo') assert.ok(!e.file, `${id} 示意图不能登记成准确型号照片`);
  }
});

test('公开模式绝不显示参考素材；示意图在公开模式显示并标记为示意图', async () => {
  const reference: ImageEntry = { status: 'reference-only', checkedAt: '2026-11-01', referenceFile: 'demo.jpg' };
  assert.deepEqual(resolveImage(reference, 'public'), { image: null, referenceImage: null, status: 'reference-only' });
  assert.deepEqual(resolveImage(reference, 'local'), { image: null, referenceImage: '/reference-images/demo.jpg', status: 'reference-only' });
  assert.equal(resolveImage({ status: 'missing', checkedAt: '2026-11-01' }, 'local').referenceImage, null);
  // 引用了不存在的示意图时退回占位，不显示任何图片
  assert.deepEqual(resolveImage({ status: 'demo', demo: 'nope', checkedAt: '2026-11-01' }, 'public', demos), { image: null, referenceImage: null, status: 'missing' });
  // 默认（公开展示）构建的商品里没有任何参考素材；示意图一律带 isDemo
  assert.ok(REAL_PRODUCTS.every(p => p.referenceImage === null));
  for (const p of REAL_PRODUCTS) {
    assert.equal(p.image !== null, p.imageStatus === 'licensed' || p.imageStatus === 'demo', `${p.id} 图片状态`);
    if (p.image) assert.equal(p.image.isDemo, p.imageStatus === 'demo', `${p.id} 示意图标记`);
  }
});
