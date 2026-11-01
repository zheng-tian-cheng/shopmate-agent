// 商品数据：正式展示读取 data/products.json 中核实过的真实商品（字段来源见该文件）。
// 商品列表、详情页、助手推荐和比较都通过 catalog() / getProduct() 读取这一份数据，避免型号或价格不一致。
// 虚构商品只在 lib/mock-products.ts 中，供自动化测试通过 setCatalogForTesting() 切换使用。

import type { WearingStyle } from './conditions.ts';
import { formatYuan } from './conditions.ts';
import imageFile from '../../data/product-images.json' with { type: 'json' };

export type SourceKind = 'official' | 'media';

export interface SourceRef {
  id: string;
  title: string | null;
  publisher: string;
  kind: SourceKind;
  url: string;
  publishedAt: string | null;
  accessedAt: string;
  supports: string;
}

// 商品图片许可与商品数据分开登记（data/product-images.json）。
// licensed：准确型号的实拍照片；demo：按佩戴方式匹配的同类耳机示意图，不是该型号的照片。
export type ImageStatus = 'licensed' | 'demo' | 'reference-only' | 'missing';
// public：只显示许可明确的图片（公开展示）；local：本地开发时额外显示未授权的参考素材
export type ImageMode = 'public' | 'local';

export interface ImageEntry {
  status: ImageStatus;
  checkedAt: string;
  file?: string;
  alt?: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
  sourceUrl?: string;
  usage?: string;
  modifications?: string;
  demo?: string;
  searched?: string;
  referenceFile?: string | null;
}

// 多款商品共用的示意图；depicts 是图中耳机的佩戴方式，tws-case 为看不出佩戴方式的闭合充电盒
export interface DemoImage {
  file: string;
  depicts: WearingStyle | 'tws-case';
  alt: string;
  author: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  usage: string;
  modifications: string | null;
}

export interface ProductImage {
  src: string;
  alt: string;
  license: string;
  licenseUrl: string;
  author: string;
  sourceUrl: string;
  modifications: string | null;
  // true：商品示意图，界面必须标注“非该型号实拍”
  isDemo: boolean;
}

export interface OfficialLink {
  label: string;
  url: string;
}

// 续航：single 单次（耳机或头戴式整机），total 含充电盒，unspecified 来源未注明
export interface BatteryEntry {
  scope: 'single' | 'total' | 'unspecified';
  anc: 'off' | 'on' | 'unspecified';
  hours: number;
}

// 重量：earbud 单只耳机，total 整机，unspecified 来源未注明
export interface WeightEntry {
  scope: 'earbud' | 'total' | 'unspecified';
  grams: number;
}

export type SourcedField = 'price' | 'anc' | 'ancSpec' | 'wearingStyle' | 'battery' | 'weight' | 'bluetooth' | 'image';

export interface Product {
  id: string;
  isMock: boolean;
  brand: string | null;
  model: string | null;
  name: string;
  subtitle: string;
  wearingStyle: WearingStyle | 'unknown';
  anc: boolean | 'unknown';
  // 厂商或媒体标称的降噪深度，不代表实际降噪效果
  ancSpec?: string | null;
  price: { amount: number | null; type?: string | null; conditions: string; verifiedAt: string | null };
  // 列表卡片用的单次续航；真实商品由 battery 推出，口径以 battery 为准
  batteryHours: number | null;
  batteryConditions: string | null;
  battery?: BatteryEntry[];
  weightG: number | null;
  weightNote?: string | null;
  weight?: WeightEntry[];
  bluetooth?: string | null;
  tradeoff: string;
  tone: 'sage' | 'cream' | 'lilac' | 'sand' | 'mist' | 'stone' | 'rose';
  image?: ProductImage | null;
  imageStatus?: ImageStatus;
  referenceImage?: string | null;
  officialLink?: OfficialLink | null;
  sources?: Partial<Record<SourcedField, SourceRef[]>>;
  notes?: string[];
}

// data/products.json 的原始结构
export interface RawSource {
  title: string | null;
  publisher: string;
  kind: SourceKind;
  url: string;
  publishedAt: string | null;
  accessedAt: string;
  supports: string;
}

export interface RawProduct {
  id: string;
  brand: string;
  model: string;
  displayName: string;
  wearingStyle: WearingStyle | null;
  anc: boolean | null;
  ancSpec: string | null;
  priceCny: number | null;
  priceType: string | null;
  priceConditions: string;
  priceVerifiedAt: string | null;
  battery: BatteryEntry[];
  batteryConditions: string | null;
  weight: WeightEntry[];
  weightNote: string | null;
  bluetooth: string | null;
  officialLink: OfficialLink | null;
  fieldSources: Partial<Record<SourcedField, string[]>>;
  notes: string[];
}

export interface CatalogFile {
  schemaVersion: number;
  updatedAt: string;
  description: string;
  sources: Record<string, RawSource>;
  products: RawProduct[];
  // 已核验、本期不展示的型号：保留数据，不进入 catalog()
  reserve: RawProduct[];
}

export interface ImageFile {
  schemaVersion: number;
  updatedAt: string;
  description: string;
  demoImages: Record<string, DemoImage>;
  images: Record<string, ImageEntry>;
}

// 商品数据缺口（不含图片，图片许可单独核验）
const GAP_CHECKS: [(raw: RawProduct) => boolean, string][] = [
  [raw => raw.wearingStyle === null, '佩戴方式'],
  [raw => raw.anc === null, '主动降噪'],
  [raw => raw.battery.length === 0, '续航'],
  [raw => raw.weight.length === 0, '重量'],
];

export function dataGaps(raw: RawProduct): string[] {
  return GAP_CHECKS.filter(([missing]) => missing(raw)).map(([, label]) => label);
}

// 卡片上的单次续航：优先降噪关，其次未注明，最后降噪开；没有单次数据时为空
export function headlineBattery(entries: readonly BatteryEntry[]): number | null {
  const single = entries.filter(e => e.scope === 'single');
  for (const anc of ['off', 'unspecified', 'on'] as const) {
    const hit = single.find(e => e.anc === anc);
    if (hit) return hit.hours;
  }
  return null;
}

function headlineWeight(entries: readonly WeightEntry[]): number | null {
  for (const scope of ['earbud', 'total', 'unspecified'] as const) {
    const hit = entries.find(e => e.scope === scope);
    if (hit) return hit.grams;
  }
  return null;
}

export function currentImageMode(): ImageMode {
  return process.env.NEXT_PUBLIC_IMAGE_MODE === 'local' ? 'local' : 'public';
}

// 公开模式只返回许可明确的图片（准确型号照片或示意图）；本地模式额外允许参考素材（仍标为未授权）
export function resolveImage(
  entry: ImageEntry | undefined, mode: ImageMode, demoImages: Record<string, DemoImage> = {},
): { image: ProductImage | null; referenceImage: string | null; status: ImageStatus } {
  if (!entry) return { image: null, referenceImage: null, status: 'missing' };
  if (entry.status === 'licensed' && entry.file) {
    return {
      status: 'licensed',
      referenceImage: null,
      image: {
        src: entry.file, alt: entry.alt ?? '', license: entry.license ?? '', licenseUrl: entry.licenseUrl ?? '',
        author: entry.author ?? '', sourceUrl: entry.sourceUrl ?? '', modifications: entry.modifications ?? null, isDemo: false,
      },
    };
  }
  const demo = entry.status === 'demo' && entry.demo ? demoImages[entry.demo] : undefined;
  if (demo) {
    return {
      status: 'demo',
      referenceImage: null,
      image: {
        src: demo.file, alt: demo.alt, license: demo.license, licenseUrl: demo.licenseUrl,
        author: demo.author, sourceUrl: demo.sourceUrl, modifications: demo.modifications, isDemo: true,
      },
    };
  }
  if (entry.status === 'demo') return { image: null, referenceImage: null, status: 'missing' };
  const reference = mode === 'local' && entry.status === 'reference-only' && entry.referenceFile
    ? `/reference-images/${entry.referenceFile}`
    : null;
  return { image: null, referenceImage: reference, status: entry.status };
}

// 卡片上的 1–2 个核心信息：只放已收录的佩戴方式和降噪；都没有时用单次续航
function keySpecs(wearingStyle: WearingStyle | 'unknown', anc: boolean | 'unknown', singleHours: number | null): string {
  const parts = [
    wearingStyle === 'unknown' ? null : wearingStyle,
    anc === true ? '主动降噪' : anc === false ? '无主动降噪' : null,
  ].filter(Boolean);
  if (parts.length < 2 && singleHours !== null) parts.push(`单次续航 ${singleHours} 小时`);
  return parts.join(' · ');
}

export function toProduct(
  raw: RawProduct, sources: Record<string, RawSource>, imageEntry?: ImageEntry, mode: ImageMode = 'public',
  demoImages: Record<string, DemoImage> = {},
): Product {
  const wearingStyle = raw.wearingStyle ?? 'unknown';
  const anc = raw.anc ?? 'unknown';
  const gaps = dataGaps(raw);
  const resolved: Partial<Record<SourcedField, SourceRef[]>> = {};
  for (const [field, ids] of Object.entries(raw.fieldSources) as [SourcedField, string[]][]) {
    resolved[field] = ids.filter(id => sources[id]).map(id => ({ id, ...sources[id] }));
  }
  return {
    id: raw.id,
    isMock: false,
    brand: raw.brand,
    model: raw.model,
    name: raw.displayName,
    subtitle: keySpecs(wearingStyle, anc, headlineBattery(raw.battery)),
    wearingStyle,
    anc,
    ancSpec: raw.ancSpec,
    price: { amount: raw.priceCny, type: raw.priceType, conditions: raw.priceConditions, verifiedAt: raw.priceVerifiedAt },
    batteryHours: headlineBattery(raw.battery),
    batteryConditions: raw.batteryConditions,
    battery: raw.battery,
    weightG: headlineWeight(raw.weight),
    weightNote: raw.weightNote,
    weight: raw.weight,
    bluetooth: raw.bluetooth,
    tradeoff: gaps.length ? `资料缺口：${gaps.join('、')}未核实。价格以来源口径为准，非实时售价。` : '价格以来源口径为准，非实时售价。',
    tone: 'stone',
    ...(() => { const r = resolveImage(imageEntry, mode, demoImages); return { image: r.image, referenceImage: r.referenceImage, imageStatus: r.status }; })(),
    officialLink: raw.officialLink,
    sources: resolved,
    notes: raw.notes,
  };
}

export const IMAGE_FILE = imageFile as ImageFile;
let current: readonly Product[] = [];
export function installCatalog(products: readonly Product[]): void { current = products; }

export function catalog(): readonly Product[] {
  return current;
}

// 仅供自动化测试：切换到虚构商品等测试数据。界面代码不调用。
export function setCatalogForTesting(products: readonly Product[]): void {
  current = products;
}

export function getProduct(id: string): Product | undefined {
  return current.find(p => p.id === id);
}

// 商品数据集中没有这一项时的统一说法（不代表不支持）
export const NOT_LISTED = '暂未收录';

export function priceLabel(product: Product): string {
  return product.price.amount === null ? '价格待核验' : formatYuan(product.price.amount);
}

export function ancLabel(product: Product): string {
  return product.anc === 'unknown' ? NOT_LISTED : product.anc ? '支持' : '不支持';
}

export function wearingLabel(product: Product): string {
  return product.wearingStyle === 'unknown' ? NOT_LISTED : product.wearingStyle;
}

const BATTERY_SCOPE: Record<BatteryEntry['scope'], string> = { single: '单次', total: '含充电盒', unspecified: '口径未注明' };
const BATTERY_ANC: Record<BatteryEntry['anc'], string> = { off: '降噪关 ', on: '降噪开 ', unspecified: '' };

// 例：“单次：降噪关 8 小时 / 降噪开 5 小时；含充电盒：降噪关 35 小时 / 降噪开 20 小时”
export function batteryLabel(product: Product): string {
  const entries = product.battery;
  if (!entries) {
    if (product.batteryHours === null) return NOT_LISTED;
    return `${product.batteryHours} 小时${product.batteryConditions ? `（${product.batteryConditions}）` : ''}`;
  }
  if (entries.length === 0) return NOT_LISTED;
  const groups = (['single', 'total', 'unspecified'] as const)
    .map(scope => [scope, entries.filter(e => e.scope === scope)] as const)
    .filter(([, list]) => list.length > 0)
    .map(([scope, list]) => `${BATTERY_SCOPE[scope]}：${list.map(e => `${BATTERY_ANC[e.anc]}${e.hours} 小时`).join(' / ')}`);
  return `${groups.join('；')}${product.batteryConditions ? `（${product.batteryConditions}）` : ''}`;
}

// 列表和推荐卡片上的简短续航
export function batteryBrief(product: Product): string {
  if (product.batteryHours !== null) return `单次 ${product.batteryHours} 小时`;
  const other = product.battery?.[0];
  if (!other) return NOT_LISTED;
  return `${BATTERY_SCOPE[other.scope]} ${other.hours} 小时`;
}

const WEIGHT_SCOPE: Record<WeightEntry['scope'], string> = { earbud: '单耳 ', total: '整机 ', unspecified: '' };

export function weightLabel(product: Product): string {
  const entries = product.weight;
  if (!entries) {
    if (product.weightG === null) return NOT_LISTED;
    return `${product.weightG} g${product.weightNote ? `（${product.weightNote}）` : ''}`;
  }
  if (entries.length === 0) return NOT_LISTED;
  const text = entries.map(e => `${WEIGHT_SCOPE[e.scope]}${e.grams} g${e.scope === 'unspecified' ? '（未注明单耳或整机）' : ''}`).join('；');
  return `${text}${product.weightNote && !entries.every(e => e.scope === 'unspecified') ? `（${product.weightNote}）` : ''}`;
}

export function ancSpecLabel(product: Product): string {
  return product.ancSpec ? `${product.ancSpec}（标称值，不代表实际降噪效果）` : NOT_LISTED;
}

export function bluetoothLabel(product: Product): string {
  return product.bluetooth ? `蓝牙 ${product.bluetooth}` : NOT_LISTED;
}

// 详情页的续航分行显示：每种口径一行，测试条件单独放在下方
export function batteryLines(product: Product): string[] {
  const entries = product.battery;
  if (!entries) return product.batteryHours === null ? [] : [`${product.batteryHours} 小时`];
  return (['single', 'total', 'unspecified'] as const)
    .map(scope => [scope, entries.filter(e => e.scope === scope)] as const)
    .filter(([, list]) => list.length > 0)
    .map(([scope, list]) => `${BATTERY_SCOPE[scope]}　${list.map(e => `${BATTERY_ANC[e.anc]}${e.hours} 小时`).join(' / ')}`);
}

export function priceTypeLabel(product: Product): string {
  return product.price.type ?? (product.isMock ? '模拟价格' : '未注明');
}
