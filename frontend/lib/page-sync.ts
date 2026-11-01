// 商品列表筛选与助手条件之间的映射（PRD V0.8 第 5.3 节，场景 A、B）。
// 列表筛选本身也转换成 ConditionState，再交给同一个 searchProducts，避免两套筛选规则。

import type { ActiveCondition, Condition, ConditionChange, ConditionState } from './conditions.ts';
import { applyChanges, emptyState, formatYuan, getCondition } from './conditions.ts';

export interface PageFilters {
  budgetMax: number | null;
  ancRequired: boolean;
  excludeInEar: boolean;
}

export const DEFAULT_PAGE_FILTERS: PageFilters = { budgetMax: null, ancRequired: false, excludeInEar: false };

export function pageFiltersToChanges(filters: PageFilters): ConditionChange[] {
  const changes: ConditionChange[] = [];
  if (filters.budgetMax !== null) changes.push({ op: 'set', field: 'budget', kind: 'hard', value: filters.budgetMax });
  if (filters.ancRequired) changes.push({ op: 'set', field: 'anc', kind: 'hard', value: true });
  if (filters.excludeInEar) changes.push({ op: 'set', field: 'wearingStyle', kind: 'hard', value: { exclude: ['入耳式'] } });
  return changes;
}

// 场景 A：从列表打开助手时继承列表的筛选，来源标记为 page。
export async function stateFromPageFilters(filters: PageFilters): Promise<ConditionState> {
  return (await applyChanges(emptyState(), pageFiltersToChanges(filters), 'page')).state;
}

function isMapped(condition: Condition): condition is ActiveCondition {
  if (condition.status !== 'confirmed' || condition.kind !== 'hard') return false;
  if (condition.field === 'budget') return true;
  if (condition.field === 'anc') return condition.value === true;
  if (condition.field === 'wearingStyle') {
    const exclude = (condition.value as { exclude: string[] }).exclude;
    return exclude.length === 1 && exclude[0] === '入耳式';
  }
  return false;
}

// 场景 B：用户点击“应用到商品列表”时，把能映射的已生效硬约束写回列表；
// 列表筛选完全以助手的已生效硬约束为准，其余条件（场景、偏好、建议、待确认）列为无法映射。
export function projectToPageFilters(state: ConditionState): { filters: PageFilters; unmapped: Condition[] } {
  const budget = getCondition(state, 'budget');
  const anc = getCondition(state, 'anc');
  const wearing = getCondition(state, 'wearingStyle');
  const filters: PageFilters = {
    budgetMax: budget && isMapped(budget) ? (budget.value as number) : null,
    ancRequired: Boolean(anc && isMapped(anc)),
    excludeInEar: Boolean(wearing && isMapped(wearing)),
  };
  return { filters, unmapped: state.conditions.filter(c => !isMapped(c)) };
}

export function describePageFilters(filters: PageFilters): string[] {
  const parts: string[] = [];
  if (filters.budgetMax !== null) parts.push(`预算 ≤ ${formatYuan(filters.budgetMax)}`);
  if (filters.ancRequired) parts.push('必须支持主动降噪');
  if (filters.excludeInEar) parts.push('排除入耳式');
  return parts;
}
