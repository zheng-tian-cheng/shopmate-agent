// 商品上下文与指代解析：第 1 阶段的规则实现，不是 LLM。
// 作用是把“当前浏览的商品”和“用户明确提到的型号”正确传给助手，并让历史消息固定关联当时的商品。
// 规则：用户明确提到某个型号时以该型号为准；只用“它/这款”等指代时用当前浏览商品；
// 没有当前商品或同时提到多款时请用户澄清，不猜测。

import type { Product } from './products.ts';
import { ancLabel, ancSpecLabel, batteryLabel, bluetoothLabel, priceLabel, wearingLabel, weightLabel } from './products.ts';

export type ProductReference =
  | { kind: 'explicit'; productId: string }
  | { kind: 'context'; productId: string }
  | { kind: 'ambiguous'; productIds: string[] }
  | { kind: 'unresolved' }
  | { kind: 'none' };

export type ProductField = 'price' | 'anc' | 'battery' | 'weight' | 'bluetooth' | 'wearing';

const normalize = (text: string) => text.toLowerCase().replace(/[\s\-_·（）()]/g, '');

// 指代当前商品的说法
const DEICTIC = /它|这款|这个|这副|这对|该款|这一款/;

// 用户能问到的字段及其常见说法（只覆盖商品数据里有的字段）
const FIELD_PATTERNS: [ProductField, RegExp][] = [
  ['price', /价格|多少钱|价钱|贵不贵|售价/],
  ['anc', /降噪|anc/i],
  ['battery', /续航|电池|用多久|能用多长/],
  ['weight', /重量|多重|重不重|轻不轻/],
  ['bluetooth', /蓝牙/],
  ['wearing', /佩戴|入耳|头戴|戴着/],
];

// 找出文本中明确提到的型号。按匹配长度从长到短取，避免“Redmi Buds 6 Pro”同时命中“Redmi Buds 6”。
export function findMentionedProducts(text: string, products: readonly Product[]): string[] {
  const haystack = normalize(text);
  const candidates = products.flatMap(p => [p.name, p.model ?? '']
    .map(normalize)
    .filter(key => key.length >= 4 && haystack.includes(key))
    .map(key => ({ id: p.id, key })));
  candidates.sort((a, b) => b.key.length - a.key.length);
  const covered: [number, number][] = [];
  const found: string[] = [];
  for (const { id, key } of candidates) {
    let from = 0;
    let hit = -1;
    while ((hit = haystack.indexOf(key, from)) !== -1) {
      const range: [number, number] = [hit, hit + key.length];
      if (!covered.some(([a, b]) => range[0] >= a && range[1] <= b)) {
        covered.push(range);
        if (!found.includes(id)) found.push(id);
      }
      from = hit + 1;
    }
  }
  return found;
}

export function resolveProductReference(text: string, viewedProductId: string | null, products: readonly Product[]): ProductReference {
  const mentioned = findMentionedProducts(text, products);
  if (mentioned.length === 1) return { kind: 'explicit', productId: mentioned[0] };
  if (mentioned.length > 1) return { kind: 'ambiguous', productIds: mentioned };
  if (DEICTIC.test(text)) return viewedProductId ? { kind: 'context', productId: viewedProductId } : { kind: 'unresolved' };
  return { kind: 'none' };
}

export function askedFields(text: string): ProductField[] {
  return FIELD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([field]) => field);
}

const UNKNOWN = '商品数据里没有这一项，我不能确认。';

function fieldLine(product: Product, field: ProductField): string {
  switch (field) {
    case 'price': return `价格：${priceLabel(product)}`;
    case 'anc': {
      if (product.anc === 'unknown') return `主动降噪：${UNKNOWN}`;
      return `主动降噪：${ancLabel(product)}${product.ancSpec ? `，${ancSpecLabel(product)}` : ''}`;
    }
    case 'battery': return `续航：${product.battery && product.battery.length === 0 ? UNKNOWN : batteryLabel(product)}`;
    case 'weight': return `重量：${product.weight && product.weight.length === 0 ? UNKNOWN : weightLabel(product)}`;
    case 'bluetooth': return `蓝牙版本：${product.bluetooth ? bluetoothLabel(product) : UNKNOWN}`;
    case 'wearing': return `佩戴方式：${product.wearingStyle === 'unknown' ? UNKNOWN : wearingLabel(product)}`;
  }
}

export interface ProductAnswer {
  text: string;
  productRefs: string[];
  details: string[];
}

// 回答关于某款商品参数的问题：只读取商品数据，不补充数据之外的事实。
// 返回 null 表示这句话没有提到任何商品，交给其他规则处理。
export function answerProductQuestion(text: string, viewedProductId: string | null, products: readonly Product[]): ProductAnswer | null {
  const ref = resolveProductReference(text, viewedProductId, products);
  const nameOf = (id: string) => products.find(p => p.id === id)?.name ?? id;
  if (ref.kind === 'none') return null;
  if (ref.kind === 'unresolved') {
    return {
      text: '你说的“它”是指哪一款？现在没有正在查看的商品。可以打开商品详情页再问，或直接说出型号，比如“Redmi Buds 6 的续航怎么样”。',
      productRefs: [],
      details: ['没有当前浏览商品，指代无法确定，未作回答。'],
    };
  }
  if (ref.kind === 'ambiguous') {
    return {
      text: `你提到了 ${ref.productIds.map(id => `「${nameOf(id)}」`).join('和')}，想先了解哪一款？也可以把它们加入对比，逐项查看。`,
      productRefs: ref.productIds,
      details: ['同时提到多款商品，先请你确认。'],
    };
  }
  const product = products.find(p => p.id === ref.productId);
  if (!product) return null;
  const fields = askedFields(text);
  const lead = ref.kind === 'explicit' ? `「${product.name}」` : `你正在看的「${product.name}」`;
  const lines = fields.length
    ? [`${lead}：`, ...fields.map(field => fieldLine(product, field))]
    : [`关于${lead}，我可以按商品数据回答价格、降噪、续航、重量、蓝牙版本和佩戴方式。更开放的问题要等接入大模型后才能回答。`];
  return {
    text: lines.join('\n'),
    productRefs: [product.id],
    details: [
      ref.kind === 'explicit' ? `按你提到的型号「${product.name}」回答。` : `按当前浏览的商品「${product.name}」理解“它”。`,
      '依据：商品数据中该型号的字段；规则匹配整理，未接入大模型。',
    ],
  };
}
