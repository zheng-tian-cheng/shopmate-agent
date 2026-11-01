// 结构化筛选（PRD V0.8 规则一、二、三、五、六）。商品列表页和助手共用这一份规则。
// 只有已生效（confirmed）的条件参与：硬约束决定能否入选，软偏好只影响排序，使用场景不参与筛选。

import type { ActiveCondition, ConditionField, ConditionState, ConditionValue, WearingStyle } from './conditions.ts';
import { confirmedConditions, formatYuan } from './conditions.ts';
import type { Product } from '../../lib/products.ts';

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

type SearchableProduct = Pick<Product, 'id' | 'price' | 'anc' | 'wearingStyle'>;

export function checkCondition(product: SearchableProduct, field: ConditionField, value: ConditionValue): CheckResult {
  switch (field) {
    case 'budget':
      return product.price.amount === null ? 'unknown' : product.price.amount <= (value as number);
    case 'anc':
      return product.anc === 'unknown' ? 'unknown' : product.anc === value;
    case 'wearingStyle':
      // 佩戴方式未知时不能视为满足“排除某种佩戴方式”（规则二）
      return product.wearingStyle === 'unknown' ? 'unknown' : !(value as { exclude: WearingStyle[] }).exclude.includes(product.wearingStyle);
    case 'scene':
      return true;
  }
}

function softBudget(state: ConditionState): ActiveCondition | undefined {
  return confirmedConditions(state).find(c => c.field === 'budget' && c.kind === 'soft');
}

export function evaluateProduct(product: SearchableProduct, state: ConditionState): Evaluation {
  const failures: Evaluation['failures'] = [];
  const softMatched: ConditionField[] = [];
  const notes: string[] = [];
  for (const condition of confirmedConditions(state)) {
    if (condition.kind === 'scene') continue;
    const result = checkCondition(product, condition.field, condition.value);
    if (condition.kind === 'hard') {
      if (result !== true) {
        failures.push({
          field: condition.field,
          reason: result === false ? 'not-satisfied' : condition.field === 'budget' ? 'no-price' : 'unknown',
        });
      }
    } else if (condition.field === 'budget') {
      const amount = product.price.amount;
      const target = condition.value as number;
      if (amount !== null && amount > target) notes.push(`超出参考预算 ${formatYuan(Math.round((amount - target) * 100) / 100)}`);
    } else if (result === true) {
      softMatched.push(condition.field);
    }
  }
  if (product.price.amount === null) notes.push('价格待核验');
  if (product.anc === 'unknown') notes.push('降噪资料缺失');
  return { eligible: state.category === 'headphones' && failures.length === 0, failures, softMatched, notes };
}

// 返回全部合格商品并排序：满足的偏好越多越靠前；有参考预算时越接近越靠前；否则按价格从低到高。
// 没有结果时返回空数组，不放宽任何条件。
export function searchProducts<P extends SearchableProduct>(products: readonly P[], state: ConditionState): { product: P; evaluation: Evaluation }[] {
  const target = softBudget(state)?.value as number | undefined;
  const priceKey = (p: SearchableProduct) => {
    const amount = p.price.amount;
    if (amount === null) return Number.POSITIVE_INFINITY;
    return target === undefined ? amount : Math.abs(amount - target);
  };
  return products
    .map(product => ({ product, evaluation: evaluateProduct(product, state) }))
    .filter(m => m.evaluation.eligible)
    .sort((a, b) =>
      b.evaluation.softMatched.length - a.evaluation.softMatched.length
      || priceKey(a.product) - priceKey(b.product)
      || (a.product.price.amount ?? Number.POSITIVE_INFINITY) - (b.product.price.amount ?? Number.POSITIVE_INFINITY)
      || a.product.id.localeCompare(b.product.id));
}

// 商城搜索框：按名称、卖点、佩戴方式和降噪关键字做简单匹配，不属于购买条件，不进入助手。
export function matchesKeyword(product: Pick<Product, 'name' | 'subtitle' | 'wearingStyle' | 'anc'> & { brand?: string | null }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [product.brand ?? '', product.name, product.subtitle, product.wearingStyle === 'unknown' ? '' : product.wearingStyle, product.anc === true ? '主动降噪 降噪 anc' : '']
    .join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}
