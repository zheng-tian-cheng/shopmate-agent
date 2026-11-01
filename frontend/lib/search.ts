// 结构化筛选（PRD V0.8 规则一、二、三、五、六）。商品列表页和助手共用这一份规则。
// 只有已生效（confirmed）的条件参与：硬约束决定能否入选，软偏好只影响排序，使用场景不参与筛选。

import type { ActiveCondition, ConditionField, ConditionState, ConditionValue, WearingStyle } from './conditions.ts';
import { confirmedConditions, formatYuan } from './conditions.ts';
import type { Product } from './products.ts';

export type CheckResult = true | false | 'unknown';

export interface Evaluation {
  eligible: boolean;
  failures: { field: ConditionField; reason: 'not-satisfied' | 'unknown' | 'no-price' }[];
  softMatched: ConditionField[];
  notes: string[];
}

export interface Match {
  product: Product;
  evaluation: Evaluation;
}

export async function searchProducts(_products: readonly Product[], state: ConditionState): Promise<Match[]> {
  const { search } = await import('./api.ts');
  return (await search(state)).matches;
}

// 商城搜索框：按名称、卖点、佩戴方式和降噪关键字做简单匹配，不属于购买条件，不进入助手。
export function matchesKeyword(product: Pick<Product, 'name' | 'subtitle' | 'wearingStyle' | 'anc'> & { brand?: string | null }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [product.brand ?? '', product.name, product.subtitle, product.wearingStyle === 'unknown' ? '' : product.wearingStyle, product.anc === true ? '主动降噪 降噪 anc' : '']
    .join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}
