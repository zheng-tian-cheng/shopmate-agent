// 商城搜索：判断搜的是哪个品类，并把耳机搜索词拆成可筛选的条件。
// 第 1 阶段只用少量明确的品类词路由，不是 AI 品类识别；接入大模型前不扩充成大词表。
// 规则：只开放蓝牙耳机；搜到未开放品类给出提示，不跳到耳机列表；没有品类线索的模糊需求先引导，不默认当作耳机。

import type { CategoryId } from './categories.ts';
import { CATEGORIES } from './categories.ts';
import type { WearingStyle } from './conditions.ts';
import { findMentionedProducts } from './product-context.ts';
import type { Product } from './products.ts';

// 每个品类的明确品类词（只放能确定品类的词，品牌名不算：同一品牌可能卖手机或家电）
const CATEGORY_TERMS: Record<CategoryId, RegExp> = {
  headphones: /耳机|耳麦|耳塞|降噪|头戴|入耳|tws|earbuds?|headphones?|freebuds|enco/i,
  sofa: /沙发|家居|床垫|椅子|餐桌|书桌/,
  appliances: /家电|咖啡机|空调|冰箱|洗衣机|电饭煲|吸尘器|扫地机|微波炉/,
  outdoors: /露营|帐篷|户外|登山|徒步|睡袋|天幕/,
};

export type SearchIntent =
  | { kind: 'empty' }
  | { kind: 'headphones'; query: string }
  | { kind: 'unavailable'; category: CategoryId; label: string; query: string }
  | { kind: 'unclear'; query: string };

export function classifySearch(raw: string, products: readonly Product[]): SearchIntent {
  const query = raw.trim();
  if (!query) return { kind: 'empty' };
  const other = (Object.keys(CATEGORY_TERMS) as CategoryId[])
    .find(id => id !== 'headphones' && CATEGORY_TERMS[id].test(query));
  if (other) return { kind: 'unavailable', category: other, label: CATEGORIES[other].label, query };
  if (CATEGORY_TERMS.headphones.test(query) || findMentionedProducts(query, products).length > 0) return { kind: 'headphones', query };
  return { kind: 'unclear', query };
}

// 耳机搜索词：拆出降噪、佩戴方式和预算，剩下的词用来匹配品牌或型号
export interface HeadphoneQuery {
  anc: boolean;
  wearing: WearingStyle | null;
  budgetMax: number | null;
  budgetNear: number | null;
  terms: string[];
}

const FILLER = /耳机|耳麦|耳塞|蓝牙|无线|真无线|推荐|一下|想要|想买|买个|买|一款|一副|一个|款|的|有|带|支持|预算|tws/gi;

export function parseHeadphoneQuery(raw: string): HeadphoneQuery {
  let text = raw.toLowerCase();
  let budgetMax: number | null = null;
  let budgetNear: number | null = null;
  // 只把明确是钱数的数字当预算（带“元/块/以内/左右”或前面有“预算”），型号里的数字（如 Buds 6）不算
  const max = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)?\s*(?:以内|以下|之内)/);
  if (max) { budgetMax = Number(max[1]); text = text.replace(max[0], ' '); }
  const near = budgetMax === null
    ? text.match(/预算\s*(\d+(?:\.\d+)?)\s*(?:元|块)?\s*(?:左右|上下)?|(\d+(?:\.\d+)?)\s*(?:元|块)\s*(?:左右|上下)?|(\d+(?:\.\d+)?)\s*(?:左右|上下)/)
    : null;
  if (near) { budgetNear = Number(near[1] ?? near[2] ?? near[3]); text = text.replace(near[0], ' '); }
  const anc = /降噪|anc/.test(text);
  text = text.replace(/主动降噪|降噪|anc/g, ' ');
  let wearing: WearingStyle | null = null;
  if (/半入耳/.test(text)) wearing = '半入耳式';
  else if (/头戴/.test(text)) wearing = '头戴式';
  else if (/入耳/.test(text)) wearing = '入耳式';
  text = text.replace(/半入耳式?|头戴式?|入耳式?/g, ' ');
  const terms = text.replace(FILLER, ' ').split(/[\s,，。、]+/).filter(Boolean);
  return { anc, wearing, budgetMax, budgetNear, terms };
}

export function describeHeadphoneQuery(q: HeadphoneQuery): string[] {
  return [
    q.anc ? '主动降噪' : null,
    q.wearing,
    q.budgetMax !== null ? `${q.budgetMax} 元以内` : null,
    q.budgetNear !== null ? `${q.budgetNear} 元左右（按接近程度排序）` : null,
    ...q.terms.map(t => `“${t}”`),
  ].filter((x): x is string => Boolean(x));
}

